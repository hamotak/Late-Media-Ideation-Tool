import { NextResponse } from "next/server";
import {
  titleLengthBuckets,
  titleWordStats,
  topVsBottomTitles,
} from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/formula-analyzer
 *
 * One-shot aggregate payload for the /formula-analyzer page.
 * Three sections:
 *   - titleWordStats: ranked words with uses, avg views, success rate.
 *   - titleLengthBuckets: avg views per word-count bucket.
 *   - topVsBottom: 10 best + 10 worst videos side by side.
 */
export async function GET() {
  const wordStats = titleWordStats({ minUses: 2, topN: 50 });
  const lengthBuckets = titleLengthBuckets();
  const topBottom = topVsBottomTitles();
  return NextResponse.json({
    wordStats,
    lengthBuckets,
    topBottom,
  });
}
