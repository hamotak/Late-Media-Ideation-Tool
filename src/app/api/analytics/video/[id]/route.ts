import { NextResponse } from "next/server";
import { getCached, getSetting, setCached, getVideo } from "@/lib/db";
import {
  fetchVideoAnalytics,
  YtAnalyticsError,
  type VideoAnalyticsBundle,
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
  /** "all" — since 2005-01-01 → today−2. The API silently zeroes out
   * dates before the video existed, so this safely covers the full
   * lifetime of any video. */
  all: "all",
};

const CACHE_TTL_SEC = 6 * 3600;

type Payload = {
  connected: boolean;
  period: string;
  analytics: VideoAnalyticsBundle | null;
  error?: string;
};

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const video = getVideo(id);
  if (!video) {
    return NextResponse.json({ error: "video not found" }, { status: 404 });
  }

  // Route by the *video's* channel id, not the active channel. Multi-
  // channel users hit this page with an active channel that may be
  // different from the channel that owns the video — using the active
  // channel's OAuth token would silently 403 (or, more annoyingly,
  // return zero rows because YT Analytics' default `ids=channel==MINE`
  // resolves to a different account that doesn't own this video).
  // Fall back to the active / global slot only if the video has no
  // channel_id stored locally (very old seed rows).
  const activeChannelId =
    getSetting("youtube.activeChannelId") || getSetting("youtube.channelId");
  const videoChannelId = video.channel_id ?? activeChannelId ?? null;
  const tokens = getOAuthTokens(videoChannelId);
  if (!tokens?.refresh_token) {
    return NextResponse.json({
      connected: false,
      period: "28d",
      analytics: null,
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

  // Cache key now keyed on the video's owner channel (not the active
  // one) so switching active-channel doesn't accidentally serve a
  // different channel's cache, and so videos owned by the same channel
  // share a single bucket regardless of who's "active". v3 bumps past
  // the previous (active-channel-keyed) v2 entries.
  const cacheChannelId = videoChannelId ?? "no-channel";
  const cacheKey = `analytics.video.v3.${cacheChannelId}.${id}.${periodKey}`;
  if (url.searchParams.get("nocache") !== "1") {
    const cached = getCached<Payload>(cacheKey);
    if (cached) return NextResponse.json(cached);
  }

  try {
    const analytics = await fetchVideoAnalytics(id, periodSpec, videoChannelId);
    const payload: Payload = { connected: true, period: periodKey, analytics };
    setCached(cacheKey, payload, CACHE_TTL_SEC);
    return NextResponse.json(payload);
  } catch (err) {
    if (err instanceof YtAnalyticsError) {
      log.error("yt-analytics", `Video analytics fetch failed: ${err.message}`, err, {
        videoId: id,
        period: periodKey,
        status: err.status,
      });
      return NextResponse.json(
        {
          connected: true,
          period: periodKey,
          analytics: null,
          error: err.message,
        } satisfies Payload,
        { status: err.status >= 400 && err.status < 600 ? err.status : 500 }
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
