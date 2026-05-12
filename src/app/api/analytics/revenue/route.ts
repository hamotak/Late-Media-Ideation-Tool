import { NextResponse } from "next/server";
import { getCached, getSetting, getVideo, setCached } from "@/lib/db";
import {
  fetchChannelRevenue,
  YtAnalyticsError,
  getRevenueAccessFlag,
  type RevenueBundle,
} from "@/lib/yt-analytics";
import { getOAuthTokens } from "@/lib/google-oauth";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 60;

const PERIODS: Record<string, number | "all"> = {
  "7d": 7,
  "28d": 28,
  "90d": 90,
  "365d": 365,
  all: "all",
};

const CACHE_TTL_SEC = 6 * 3600;

type Payload = {
  connected: boolean;
  /** "allowed" — we got data; "denied" — last call returned 403 (Manager
   * tier or non-monetised channel); "unknown" — never tried yet. */
  revenueAccess: "allowed" | "denied" | "unknown";
  period: string;
  revenue: RevenueBundle | null;
  error?: string;
};

export async function GET(req: Request) {
  // Active channel decides which OAuth slot we read tokens from.
  // Per-channel slot first; fall back to global slot for installs that
  // pre-date multi-account support.
  const activeChannelId = getSetting("youtube.activeChannelId") || getSetting("youtube.channelId");
  const tokens = getOAuthTokens(activeChannelId);
  if (!tokens?.refresh_token) {
    return NextResponse.json({
      connected: false,
      revenueAccess: "unknown",
      period: "28d",
      revenue: null,
    } satisfies Payload);
  }

  const url = new URL(req.url);
  const periodKey = url.searchParams.get("period") ?? "28d";
  const periodSpec = PERIODS[periodKey];
  if (periodSpec === undefined) {
    return NextResponse.json(
      { error: `Invalid period. Use one of: ${Object.keys(PERIODS).join(", ")}` },
      { status: 400 }
    );
  }

  // Per-channel revenueAccess flag — channel A being denied no longer
  // taints channel B (the bug the user reported).
  if (
    getRevenueAccessFlag(activeChannelId ?? undefined) === "denied" &&
    url.searchParams.get("force") !== "1"
  ) {
    return NextResponse.json({
      connected: true,
      revenueAccess: "denied",
      period: periodKey,
      revenue: null,
    } satisfies Payload);
  }

  // Channel id in cache key — same reasoning as overview/audience.
  const channelId = getSetting("youtube.channelId") ?? "no-channel";
  // v2: payload shape changed when topVideos started carrying title +
  // thumbnail + locally-overridden views. Old v1 cache entries would
  // render as `{ title: undefined }` rows — bumping the version forces
  // a refetch on the next call after deploy.
  const cacheKey = `analytics.revenue.v2.${channelId}.${periodKey}`;
  if (url.searchParams.get("nocache") !== "1") {
    const cached = getCached<Payload>(cacheKey);
    if (cached) return NextResponse.json(cached);
  }

  try {
    // Pass channelId explicitly so runReport picks the matching
    // per-channel OAuth tokens (different Google account per channel
    // is supported via `google.oauth.tokens.<channelId>`).
    const revenue = await fetchChannelRevenue(
      periodSpec,
      channelId !== "no-channel" ? channelId : undefined
    );
    // YT Analytics often returns 0 views for monetary top-earners (the
    // monetary report and the public-stats report are computed off
    // different pipelines). Override with the cached lifetime view count
    // from our local DB and fold in the human title — much better UX
    // than the raw videoId. Falls through gracefully for any video that
    // wasn't synced yet.
    revenue.topVideos = revenue.topVideos.map((v) => {
      const local = getVideo(v.videoId);
      return {
        ...v,
        title: local?.title ?? v.title,
        thumbnail: local?.thumbnail_url ?? v.thumbnail ?? null,
        // Prefer local lifetime-views if the API returned 0; keep the
        // API value if it's non-zero (it's period-scoped which is
        // arguably more accurate when present).
        views: v.views > 0 ? v.views : (local?.views ?? 0),
      };
    });
    const payload: Payload = {
      connected: true,
      revenueAccess: "allowed",
      period: periodKey,
      revenue,
    };
    setCached(cacheKey, payload, CACHE_TTL_SEC);
    return NextResponse.json(payload);
  } catch (err) {
    if (err instanceof YtAnalyticsError) {
      const denied = err.status === 403 || err.status === 401;
      log.error("yt-analytics", `Revenue fetch failed: ${err.message}`, err, {
        period: periodKey,
        status: err.status,
      });
      return NextResponse.json(
        {
          connected: true,
          revenueAccess: denied
            ? "denied"
            : getRevenueAccessFlag(activeChannelId ?? undefined),
          period: periodKey,
          revenue: null,
          error: err.message,
        } satisfies Payload,
        { status: denied ? 200 : err.status }
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
