import { NextResponse } from "next/server";
import { getCached, getSetting, getVideo, setCached } from "@/lib/db";
import {
  fetchChannelOverview,
  fetchTopVideos,
  YtAnalyticsError,
  getRevenueAccessFlag,
  type OverviewBundle,
  type TopVideoRow,
} from "@/lib/yt-analytics";
import { getOAuthTokens } from "@/lib/google-oauth";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Allowed period strings → period spec. Studio offers 7/28/90/365 by
 * default plus a 14-day power-user option and an "all time" view; we
 * mirror that. The "all" sentinel resolves to since-2005-01-01 inside
 * the wrapper. */
const PERIODS: Record<string, number | "all"> = {
  "7d": 7,
  "14d": 14,
  "28d": 28,
  "90d": 90,
  "365d": 365,
  all: "all",
};

/** TTL for the cache. Analytics data updates ~daily anyway, so ~6h gives
 * us snappy reloads without showing stale stats for too long. Re-syncing
 * the channel doesn't invalidate this — the data comes from Google, not
 * our own DB.  */
const CACHE_TTL_SEC = 6 * 3600;

type Payload = {
  connected: boolean;
  /** "allowed" / "denied" / "unknown" — matches the sticky flag set by
   * the API wrapper when revenue queries 403. */
  revenueAccess: "allowed" | "denied" | "unknown";
  period: string;
  overview: OverviewBundle | null;
  topVideos: TopVideoRow[];
  error?: string;
};

export async function GET(req: Request) {
  // Per-channel OAuth: pick whichever slot matches the active channel
  // (falls back to the global / legacy slot when the channel doesn't
  // have its own tokens yet).
  const activeChannelId =
    getSetting("youtube.activeChannelId") || getSetting("youtube.channelId");
  const tokens = getOAuthTokens(activeChannelId);
  if (!tokens?.refresh_token) {
    const stub: Payload = {
      connected: false,
      revenueAccess: "unknown",
      period: "28d",
      overview: null,
      topVideos: [],
    };
    return NextResponse.json(stub);
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

  // Cache key MUST include the bound channel id — otherwise switching
  // channels (or re-binding to a different one) serves stale data from
  // the previous channel until the 6h TTL expires. "no-channel" is a
  // distinct bucket for the rare case where someone hits this endpoint
  // before binding a channel.
  const channelId = getSetting("youtube.channelId") ?? "no-channel";
  // v2: payload's topVideos rows now carry title + thumbnail folded in
  // from local DB (Studio shows raw IDs otherwise — terrible UX). Bump
  // forces a refetch on existing installs after deploy.
  const cacheKey = `analytics.overview.v2.${channelId}.${periodKey}`;
  const cached = getCached<Payload>(cacheKey);
  if (cached && url.searchParams.get("nocache") !== "1") {
    return NextResponse.json(cached);
  }

  try {
    // Run overview + top videos in parallel — they hit different report
    // endpoints and Google handles the concurrency fine.
    const [overview, topVideos] = await Promise.all([
      fetchChannelOverview(periodSpec),
      fetchTopVideos(periodSpec, 10, "views").catch((err) => {
        // Top videos isn't critical — if it fails, log and return empty.
        log.warn("yt-analytics", "fetchTopVideos failed (non-fatal)", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [] as TopVideoRow[];
      }),
    ]);

    // Fold local title + thumbnail into each top-video row so the UI can
    // render readable rows instead of raw IDs. The analytics report
    // returns videoId/views/watch metrics — we already have the rest of
    // the metadata cached locally from the YT Data API sync.
    const enrichedTopVideos = topVideos.map((v) => {
      const local = getVideo(v.videoId);
      return {
        ...v,
        title: local?.title,
        thumbnail: local?.thumbnail_url ?? null,
      };
    });

    const payload: Payload = {
      connected: true,
      revenueAccess: getRevenueAccessFlag(activeChannelId ?? undefined),
      period: periodKey,
      overview,
      topVideos: enrichedTopVideos,
    };
    setCached(cacheKey, payload, CACHE_TTL_SEC);
    return NextResponse.json(payload);
  } catch (err) {
    if (err instanceof YtAnalyticsError) {
      log.error("yt-analytics", `Overview fetch failed: ${err.message}`, err, {
        period: periodKey,
        status: err.status,
      });
      return NextResponse.json(
        {
          connected: true,
          revenueAccess: getRevenueAccessFlag(activeChannelId ?? undefined),
          period: periodKey,
          overview: null,
          topVideos: [],
          error: err.message,
        } as Payload,
        { status: err.status >= 400 && err.status < 600 ? err.status : 500 }
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error("yt-analytics", `Overview fetch crashed: ${message}`, err, { period: periodKey });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
