import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  getCompetitor,
  getCompetitorVideosByIds,
  getIntegration,
  getOutlierExplanation,
  getSetting,
  getTranscript,
  setSetting,
  upsertOutlierExplanation,
} from "@/lib/db";
import { providerModelId } from "@/lib/ai-provider-types";
import { extractSection, LEVERS, loadMentorMethod } from "@/lib/mentor-method";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 60;

// One Claude call per video per 24h. Cached responses bypass this
// entirely — they cost nothing to serve and shouldn't lock the user out.
const RATE_LIMIT_WINDOW_SEC = 24 * 60 * 60;

function fmtDuration(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtDate(ts: number | null | undefined): string {
  if (!ts) return "unknown";
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    videoId?: unknown;
    competitorId?: unknown;
  };
  const videoId = typeof body.videoId === "string" ? body.videoId.trim() : "";
  const competitorId = Number(body.competitorId);
  if (!videoId) {
    return NextResponse.json({ error: "videoId required" }, { status: 400 });
  }
  if (!Number.isFinite(competitorId)) {
    return NextResponse.json(
      { error: "competitorId required (number)" },
      { status: 400 }
    );
  }

  // Cache hit — return immediately, no rate-limit check, no Claude call.
  const cached = getOutlierExplanation(videoId);
  if (cached) {
    return NextResponse.json({
      videoId: cached.videoId,
      levers: cached.levers,
      explanation: cached.explanation,
      cached: true,
      generatedAt: cached.generatedAt,
    });
  }

  // Video sanity check via the bulk-by-ids helper (handles one id fine).
  const [video] = getCompetitorVideosByIds([videoId]);
  if (!video) {
    return NextResponse.json({ error: "video not found" }, { status: 404 });
  }
  if (video.competitorId !== competitorId) {
    return NextResponse.json(
      { error: "competitorId does not match this video's row" },
      { status: 400 }
    );
  }
  const competitor = getCompetitor(competitorId);
  if (!competitor) {
    return NextResponse.json({ error: "competitor not found" }, { status: 404 });
  }

  // Rate limit (only for non-cached calls — caller might be opening the
  // same panel rapidly while Claude works).
  const rateKey = `analyze_ai.outlier_explain.last_run.${videoId}`;
  const last = Number(getSetting(rateKey) ?? "0");
  const now = Math.floor(Date.now() / 1000);
  if (last > 0 && now - last < RATE_LIMIT_WINDOW_SEC) {
    const retryAfterSec = RATE_LIMIT_WINDOW_SEC - (now - last);
    return NextResponse.json(
      { error: "Explain is rate-limited per video (1 per 24h)", retryAfterSec },
      { status: 429 }
    );
  }

  const apiKey = getIntegration("claude")?.api_key;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Claude API key not configured. Add it on the Integrations page." },
      { status: 400 }
    );
  }

  // Transcript is almost always absent for competitor videos (the
  // transcripts table FKs the user's own videos, not competitor_videos).
  // The prompt is built to handle title-only reasoning gracefully.
  const transcript = getTranscript(videoId);
  const transcriptBlock = transcript?.text
    ? `# Transcript (first ~8K chars)\n${transcript.text.slice(0, 8000)}`
    : "(no transcript available — competitor_videos do not carry transcripts; reasoning will be title-only)";

  const md = loadMentorMethod();
  const sec2 = extractSection(md, 2);
  const sec9 = extractSection(md, 9);

  const systemPrompt = [
    "You are analyzing a single YouTube video that significantly outperformed its own channel's median. Your task: identify which 2–3 \"what made it work\" levers from the taxonomy below the video leans on, and write a brief plain-English explanation grounded in the title (and transcript snippet if provided). Be specific; do not list every plausible lever — pick the dominant 2–3.",
    "",
    "From MENTOR_METHOD.md §2 (Outliers — the engine):",
    sec2 || "(section unavailable)",
    "",
    "From MENTOR_METHOD.md §9 (The \"what made it work\" lever taxonomy):",
    sec9 || "(section unavailable)",
    "",
    `Allowed lever names (use these exact strings, case-sensitive, in the JSON output): ${LEVERS.map((l) => `"${l}"`).join(", ")}.`,
    "",
    "Return ONLY a JSON object. No prose, no markdown, no code fence.",
    "Shape: { \"levers\": string[2-3], \"explanation\": string }",
    "The explanation must be 2–3 sentences, plain English, no fluff. Cite the specific phrase or number from the title that triggers each lever.",
  ].join("\n");

  const userBody = [
    `# Outlier video`,
    `- Competitor: ${competitor.title ?? "(unknown)"} (${competitor.handle ?? "no handle"}, tier: ${competitor.tier})`,
    `- Title: ${video.title}`,
    `- Views: ${video.views.toLocaleString("en-US")}`,
    `- Published: ${fmtDate(video.publishedAt)}`,
    `- Duration: ${fmtDuration(video.durationSeconds)}`,
    ``,
    transcriptBlock,
  ].join("\n");

  let levers: string[] = [];
  let explanation = "";
  const model = providerModelId("claude");
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model,
      max_tokens: 800,
      temperature: 0.3,
      system: systemPrompt,
      messages: [{ role: "user", content: userBody }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    const parsed = parseExplanation(text);
    if (!parsed) {
      log.warn(
        "claude",
        `Outlier-explain ${videoId}: could not parse JSON. Raw: ${text.slice(0, 200)}`
      );
      return NextResponse.json(
        { error: "AI returned malformed JSON. Try again." },
        { status: 502 }
      );
    }
    levers = parsed.levers;
    explanation = parsed.explanation;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Claude call failed";
    log.error("claude", `Outlier-explain ${videoId}: ${msg}`, err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  upsertOutlierExplanation({
    videoId,
    competitorId,
    levers,
    explanation,
    model,
  });
  // Rate-limit timestamp only after success, so a Claude failure doesn't
  // lock the user out for 24h.
  setSetting(rateKey, String(now));

  log.info(
    "claude",
    `Outlier-explain ${videoId}: cached ${levers.length} levers from ${model}`
  );

  return NextResponse.json({
    videoId,
    levers,
    explanation,
    cached: false,
    generatedAt: now,
  });
}

/**
 * Tolerant JSON parser. Strips optional ```json fences and matches the
 * first balanced { ... } block. Validates the 2-key shape and that
 * levers are from the allowed taxonomy.
 */
function parseExplanation(
  raw: string
): { levers: string[]; explanation: string } | null {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const rawLevers = Array.isArray(obj.levers) ? obj.levers : [];
  const levers = rawLevers
    .filter((v): v is string => typeof v === "string")
    .filter((s) => (LEVERS as readonly string[]).includes(s));
  const explanation = typeof obj.explanation === "string" ? obj.explanation.trim() : "";
  if (levers.length === 0 || explanation.length === 0) return null;
  // Cap at 3 to enforce "pick the dominant 2-3" even if Claude returned more.
  return { levers: levers.slice(0, 3), explanation };
}
