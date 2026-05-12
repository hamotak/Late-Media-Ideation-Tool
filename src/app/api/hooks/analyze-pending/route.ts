import { NextResponse } from "next/server";
import { listVideosPendingHookAnalysis } from "@/lib/db";
import { analyzeVideoHook } from "@/lib/hook-analyzer";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
// Up to N videos × ~5s each. 300s is the Railway request ceiling; we
// pace at most 50 per request so a runaway catalogue can't time out.
export const maxDuration = 300;

const BATCH_SIZE = 50;

/**
 * POST /api/hooks/analyze-pending
 *
 * Sweeps through every video that has a transcript but no hook
 * analysis yet, runs Claude on each in sequence, and returns a
 * summary of what worked and what didn't. Serial (not parallel)
 * to keep Anthropic rate limits sane and to make per-video logs
 * legible.
 */
export async function POST() {
  const pending = listVideosPendingHookAnalysis(BATCH_SIZE);
  const started = Date.now();
  const results: Array<{ videoId: string; ok: boolean; reason?: string }> = [];

  for (const v of pending) {
    try {
      const r = await analyzeVideoHook(v.id);
      if (r.ok) {
        results.push({ videoId: v.id, ok: true });
      } else {
        results.push({ videoId: v.id, ok: false, reason: r.reason });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      log.warn("hooks", `Batch hook analysis errored on ${v.id}: ${msg}`);
      results.push({ videoId: v.id, ok: false, reason: msg });
    }
  }

  return NextResponse.json({
    queued: pending.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    durationMs: Date.now() - started,
    results,
  });
}
