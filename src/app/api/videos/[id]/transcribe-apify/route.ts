import { NextResponse } from "next/server";
import {
  getActiveTranscriptionJob,
  getIntegration,
  getSetting,
  getVideo,
  upsertTranscript,
} from "@/lib/db";
import { apifyYouTubeTranscript } from "@/lib/apify";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
// Apify actor runs can take ~30-60s on a typical talking-head video,
// and we serialise — keep room for one full attempt.
export const maxDuration = 180;

/**
 * POST /api/videos/:id/transcribe-apify
 *
 * Pulls a YouTube transcript through Apify's residential-proxy
 * actor (pintostudio~youtube-transcript-scraper). Costs roughly
 * $0.02 per video against the user's Apify monthly credit
 * ($5 included on the Free plan; paid plans larger).
 *
 * This is the auto-magic path that survives YouTube's datacenter-IP
 * block — Apify's runners egress through residential IPs Google
 * doesn't blacklist. We never touch audio bytes ourselves; Apify
 * hands us back the transcript text directly.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const video = getVideo(id);
  if (!video) {
    return NextResponse.json({ error: "video not found" }, { status: 404 });
  }

  const apifyKey = getIntegration("apify")?.api_key;
  if (!apifyKey) {
    return NextResponse.json(
      {
        error:
          "Apify API token is not configured. Add it in Integrations — the Free plan includes $5 / month of credit (≈250 transcripts).",
      },
      { status: 400 }
    );
  }

  // Same mutual exclusion guard the other transcribe routes use.
  const activeJob = getActiveTranscriptionJob();
  if (activeJob) {
    return NextResponse.json(
      {
        error:
          "A batch transcription is currently running. Wait for it to finish before transcribing a single video.",
        jobId: activeJob.id,
      },
      { status: 409 }
    );
  }
  if (getSetting("sync.inProgress") === "1") {
    return NextResponse.json(
      { error: "A channel sync is currently running. Try again in a few seconds." },
      { status: 409 }
    );
  }

  const startedAt = Date.now();
  try {
    const results = await apifyYouTubeTranscript(
      [`https://www.youtube.com/watch?v=${id}`],
      apifyKey
    );
    const hit = results.find(
      (r) => r.transcript && r.transcript.length >= 50
    );
    if (!hit?.transcript) {
      return NextResponse.json(
        {
          error:
            "Apify ran but returned no usable transcript. The video may have no captions, be region-locked, or be private.",
          unavailable: true,
        },
        { status: 404 }
      );
    }
    upsertTranscript(id, hit.transcript, hit.language ?? null);
    log.info("apify-transcript", "Video transcribed via Apify", {
      videoId: id,
      language: hit.language ?? null,
      textChars: hit.transcript.length,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({
      ok: true,
      videoId: id,
      language: hit.language ?? null,
      textLength: hit.transcript.length,
      source: "apify",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error("apify-transcript", `Apify transcription failed: ${message}`, err, {
      videoId: id,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
