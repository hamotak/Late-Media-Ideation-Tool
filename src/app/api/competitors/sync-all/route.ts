import { NextResponse } from "next/server";
import { listCompetitors } from "@/lib/db";
import { syncCompetitor } from "@/lib/competitor-sync";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
// Up to 10 competitors × ~30s each. 600s ceiling on Railway, so we keep
// some slack for Apify queueing if multiple sync requests stack up.
export const maxDuration = 300;

/**
 * POST /api/competitors/sync-all — kick off a fresh sync for every
 * tracked competitor in sequence. We deliberately serialise rather
 * than parallelise because Apify rate-limits per actor and parallel
 * runs would just queue anyway, with worse error attribution.
 */
export async function POST() {
  const competitors = listCompetitors();
  const results: Array<{
    id: number;
    ok: boolean;
    videosInserted?: number;
    newAlerts?: number;
    error?: string;
  }> = [];

  for (const c of competitors) {
    try {
      const r = await syncCompetitor(c.id);
      results.push({
        id: c.id,
        ok: true,
        videosInserted: r.videosInserted,
        newAlerts: r.newAlerts,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "sync failed";
      log.warn("competitors", `Bulk sync skipped ${c.id}: ${msg}`);
      results.push({ id: c.id, ok: false, error: msg });
    }
  }

  return NextResponse.json({
    total: competitors.length,
    succeeded: results.filter((r) => r.ok).length,
    results,
  });
}
