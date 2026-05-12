import { NextResponse } from "next/server";
import { competitorGapAnalysis } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/competitors/gaps?topN=25
 *
 * Returns words frequent in competitor TOP videos that DON'T appear
 * in the user's own catalogue, sorted by aggregate competitor views.
 * These are the "gaps" the dashboard's Gap Analysis tab surfaces.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const topN = Math.min(50, Math.max(5, Number(url.searchParams.get("topN") ?? 25)));
  const gaps = competitorGapAnalysis({ topN });
  return NextResponse.json({ gaps });
}
