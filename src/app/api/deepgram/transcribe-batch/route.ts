import { NextResponse } from "next/server";
import {
  createTranscriptionJob,
  getActiveTranscriptionJob,
  getIntegration,
  getSetting,
  listVideosMissingTranscript,
  recordDeepgramUsage,
  updateTranscriptionJob,
  upsertTranscript,
} from "@/lib/db";
import { estimateCostCents, transcribeYouTubeVideo } from "@/lib/deepgram";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Default concurrency — safe for Deepgram trial/credit tier (5 concurrent).
 * Lets us do 3 in parallel → ~3x speedup over serial, with a comfortable
 * margin under the tier limit. Configurable via settings in future. */
const DEFAULT_CONCURRENCY = 3;

/**
 * GET — return a cost preview for the user's current unboxed state so the
 * confirmation modal can show "N videos · M hours · ~$X" before they commit.
 * Does NOT start anything.
 */
export async function GET() {
  const missing = listVideosMissingTranscript();
  const totalSeconds = missing.reduce((sum, v) => sum + (v.duration_seconds ?? 0), 0);
  const estimatedCostCents = missing.reduce(
    (sum, v) => sum + estimateCostCents(v.duration_seconds ?? 0),
    0
  );
  const active = getActiveTranscriptionJob();
  return NextResponse.json({
    missing: missing.length,
    totalSeconds,
    estimatedCostCents,
    videos: missing.slice(0, 5).map((v) => ({
      id: v.id,
      title: v.title,
      durationSeconds: v.duration_seconds ?? 0,
    })),
    activeJob: active ?? null,
  });
}

/**
 * POST — kick off the batch. Returns immediately with the jobId; the
 * background async task does the work. UI polls /api/deepgram/jobs/latest
 * for live progress.
 */
export async function POST() {
  const apiKey = getIntegration("deepgram")?.api_key;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Deepgram API key is not configured. Add it in Integrations." },
      { status: 400 }
    );
  }

  // Don't start a second batch on top of a running one — the UI should
  // prevent this, but be defensive on the server too.
  const existing = getActiveTranscriptionJob();
  if (existing) {
    return NextResponse.json(
      { error: "A transcription batch is already running.", jobId: existing.id },
      { status: 409 }
    );
  }

  // Mutual exclusion with the sync route — a sync could be purging or
  // inserting videos right now, and interleaving batch transcript writes
  // against that is exactly what corrupted the DB last time.
  if (getSetting("sync.inProgress") === "1") {
    return NextResponse.json(
      { error: "A channel sync is currently running. Wait for it to finish before transcribing." },
      { status: 409 }
    );
  }

  const missing = listVideosMissingTranscript();
  if (missing.length === 0) {
    return NextResponse.json({ error: "No videos missing a transcript." }, { status: 400 });
  }

  const jobId = createTranscriptionJob(missing.length);
  log.info("deepgram", "Batch transcription job started", {
    jobId,
    videoCount: missing.length,
  });

  // Fire and forget. `void` tells ESLint and readers "yes, we mean to not
  // await this — the response goes back now, the batch runs in background".
  void runBatch(jobId, apiKey, missing);

  return NextResponse.json({ ok: true, jobId, total: missing.length });
}

async function runBatch(
  jobId: number,
  apiKey: string,
  videos: { id: string; title: string; duration_seconds: number | null }[]
): Promise<void> {
  // Simple queue + N workers pattern. Workers pull from the shared list by
  // index, advance the shared counters, persist after each item so the UI
  // polling sees live progress.
  let cursor = 0;
  let done = 0;
  let failed = 0;
  let costCentsTotal = 0;
  let lastError: string | null = null;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= videos.length) return;
      const v = videos[i];
      updateTranscriptionJob(jobId, { current_video_id: v.id });
      try {
        const result = await transcribeYouTubeVideo(v.id, apiKey);
        upsertTranscript(v.id, result.text, result.language);
        recordDeepgramUsage({
          videoId: v.id,
          durationSeconds: result.durationSeconds,
          costCents: result.costCents,
          model: result.model,
        });
        done++;
        costCentsTotal += result.costCents;
      } catch (err) {
        failed++;
        lastError = err instanceof Error ? err.message : String(err);
        log.warn("deepgram", `Batch item failed: ${v.id}`, {
          jobId,
          videoId: v.id,
          error: lastError,
        });
      }
      // Flush progress to DB after each item — UI picks it up on next poll.
      updateTranscriptionJob(jobId, {
        done,
        failed,
        cost_cents: costCentsTotal,
        last_error: lastError,
      });
    }
  };

  const workers = Array.from({ length: DEFAULT_CONCURRENCY }, () => worker());
  try {
    await Promise.all(workers);
    updateTranscriptionJob(jobId, {
      status: failed === videos.length ? "failed" : "completed",
      completed_at: Math.floor(Date.now() / 1000),
      current_video_id: null,
    });
    log.info("deepgram", "Batch transcription job finished", {
      jobId,
      done,
      failed,
      costCents: costCentsTotal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateTranscriptionJob(jobId, {
      status: "failed",
      completed_at: Math.floor(Date.now() / 1000),
      last_error: msg,
      current_video_id: null,
    });
    log.error("deepgram", `Batch transcription job crashed: ${msg}`, err, { jobId });
  }
}
