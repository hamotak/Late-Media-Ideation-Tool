import { NextResponse } from "next/server";
import {
  hookFormulaStats,
  hookOverallStats,
  listVideosPendingHookAnalysis,
} from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/hooks/dashboard
 *
 * One-shot payload for the Hook Lab Dashboard tab: top-line counts,
 * per-formula stats for the bar chart, and a count of videos still
 * waiting for analysis (drives the "Analyze All Pending" button).
 */
export async function GET() {
  const overall = hookOverallStats();
  const formulas = hookFormulaStats();
  const pending = listVideosPendingHookAnalysis(500).length;
  return NextResponse.json({
    overall,
    formulas,
    pending,
  });
}
