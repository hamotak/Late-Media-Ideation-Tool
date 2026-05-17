import { NextResponse } from "next/server";
import { getCached, getSetting, setCached } from "@/lib/db";
import {
  fetchChannelAudience,
  YtAnalyticsError,
  type ChannelAudienceBundle,
} from "@/lib/yt-analytics";
import { getOAuthTokens } from "@/lib/google-oauth";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 60;

const PERIODS: Record<string, number | "all"> = {
  "28d": 28,
  "90d": 90,
  "365d": 365,
  all: "all",
};

const CACHE_TTL_SEC = 6 * 3600;

type Payload = {
  connected: boolean;
  period: string;
  audience: ChannelAudienceBundle | null;
  error?: string;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  // Caller can override the active-channel scope via ?channelId=X. Used by
  // /channel-info?focus=X so the audience matches the row the user clicked,
  // not whatever channel is globally active. Omit → falls back to active.
  const requestedChannelId = url.searchParams.get("channelId");
  const activeChannelId =
    getSetting("youtube.activeChannelId") || getSetting("youtube.channelId");
  const scopedChannelId = requestedChannelId || activeChannelId;

  const tokens = getOAuthTokens(scopedChannelId);
  if (!tokens?.refresh_token) {
    return NextResponse.json({
      connected: false,
      period: "28d",
      audience: null,
    } satisfies Payload);
  }

  const periodKey = url.searchParams.get("period") ?? "28d";
  const periodSpec = PERIODS[periodKey];
  if (periodSpec === undefined) {
    return NextResponse.json(
      { error: `Invalid period. Use one of: ${Object.keys(PERIODS).join(", ")}` },
      { status: 400 }
    );
  }

  // Channel id in cache key prevents stale data leaking across rebinds —
  // AND across multiple focused channels viewed in the same session.
  const cacheChannelId = scopedChannelId ?? "no-channel";
  const cacheKey = `analytics.audience.${cacheChannelId}.${periodKey}`;
  if (url.searchParams.get("nocache") !== "1") {
    const cached = getCached<Payload>(cacheKey);
    if (cached) return NextResponse.json(cached);
  }

  try {
    const audience = await fetchChannelAudience(
      periodSpec,
      scopedChannelId ?? undefined
    );
    const payload: Payload = { connected: true, period: periodKey, audience };
    setCached(cacheKey, payload, CACHE_TTL_SEC);
    return NextResponse.json(payload);
  } catch (err) {
    if (err instanceof YtAnalyticsError) {
      log.error("yt-analytics", `Audience fetch failed: ${err.message}`, err, {
        period: periodKey,
        status: err.status,
      });
      return NextResponse.json(
        {
          connected: true,
          period: periodKey,
          audience: null,
          error: err.message,
        } satisfies Payload,
        { status: err.status >= 400 && err.status < 600 ? err.status : 500 }
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
