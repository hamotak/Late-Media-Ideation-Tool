import { NextResponse } from "next/server";
import {
  COMPETITOR_TIERS,
  isCompetitorTier,
  listAllChannels,
  outliersForUserChannel,
} from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/outliers
 *
 * Query params:
 *   userChannelId: required. Either a known channel id, or the literal
 *                  "all" to scan across every user channel's competitors.
 *   window:        7 | 30 | 90 (days). Default 30.
 *   minMultiplier: number ≥ 1. Default 3.
 *   tiers:         comma-separated subset of authority|breakthrough|adjacent|far.
 *                  Default all four.
 *
 * Returns at most 50 outlier rows sorted by multiplier DESC then views DESC,
 * plus totals for the filter header (totalScanned + competitorsCovered).
 *
 * Per MENTOR_METHOD §2: an outlier is a video whose views exceed
 * `minMultiplier × that competitor's own median over the same window`.
 * Competitors with < 5 videos in the window are skipped (the median
 * collapses on tiny samples).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawUserChannelId = url.searchParams.get("userChannelId");
  if (!rawUserChannelId) {
    return NextResponse.json(
      { error: "userChannelId required (a channel id or the literal 'all')" },
      { status: 400 }
    );
  }
  const userChannelId =
    rawUserChannelId === "all"
      ? null
      : (() => {
          const all = listAllChannels();
          return all.some((c) => c.id === rawUserChannelId)
            ? rawUserChannelId
            : undefined;
        })();
  if (userChannelId === undefined) {
    return NextResponse.json(
      { error: `Unknown userChannelId: ${rawUserChannelId}` },
      { status: 400 }
    );
  }

  const windowDays = (() => {
    const raw = Number(url.searchParams.get("window") ?? 30);
    if (raw === 7 || raw === 30 || raw === 90) return raw;
    return 30;
  })();

  const minMultiplier = (() => {
    const raw = Number(url.searchParams.get("minMultiplier") ?? 3);
    if (!Number.isFinite(raw) || raw < 1) return 3;
    return raw;
  })();

  const tiersParam = url.searchParams.get("tiers");
  const tiers = tiersParam
    ? tiersParam.split(",").map((s) => s.trim()).filter(isCompetitorTier)
    : [...COMPETITOR_TIERS];
  if (tiers.length === 0) {
    return NextResponse.json(
      { error: `tiers must include at least one of: ${COMPETITOR_TIERS.join(", ")}` },
      { status: 400 }
    );
  }

  const result = outliersForUserChannel({
    userChannelId,
    windowDays,
    minMultiplier,
    tiers,
  });

  return NextResponse.json(result);
}
