import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  getCompetitorVideosByIds,
  getIntegration,
  getSetting,
  listAllChannels,
  setSetting,
} from "@/lib/db";
import { providerModelId } from "@/lib/ai-provider-types";
import {
  extractSection,
  isLever,
  LEVERS,
  loadMentorMethod,
} from "@/lib/mentor-method";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 60;

// Ideation is more expensive than the explain endpoint — both in tokens
// (5–10 ideas × ~150 tokens each + the methodology context) and in user
// expectation (they want a fresh batch each time, not a cached one). So
// no result-cache, but rate-limited 1/5min per channel.
const RATE_LIMIT_WINDOW_SEC = 5 * 60;

type IdeasProposal = {
  topic: string;
  suggestedTitle: string;
  angle: string;
  confidence: number;
  sourceOutlierVideoId: string;
};

function fmtRelative(ts: number | null | undefined): string {
  if (!ts) return "unknown";
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo ago`;
  return `${Math.floor(diff / (86400 * 365))}y ago`;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    userChannelId?: unknown;
    outlierVideoIds?: unknown;
  };
  const userChannelId =
    typeof body.userChannelId === "string" ? body.userChannelId.trim() : "";
  if (!userChannelId) {
    return NextResponse.json(
      { error: "userChannelId required" },
      { status: 400 }
    );
  }
  const all = listAllChannels();
  const channel = all.find((c) => c.id === userChannelId);
  if (!channel) {
    return NextResponse.json(
      { error: `Unknown userChannelId: ${userChannelId}` },
      { status: 404 }
    );
  }
  const rawIds = Array.isArray(body.outlierVideoIds) ? body.outlierVideoIds : [];
  const outlierVideoIds = rawIds
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .slice(0, 20);
  if (outlierVideoIds.length === 0) {
    return NextResponse.json(
      { error: "outlierVideoIds required (1–20)" },
      { status: 400 }
    );
  }

  // Rate limit.
  const rateKey = `analyze_ai.ideas.last_run.${userChannelId}`;
  const last = Number(getSetting(rateKey) ?? "0");
  const now = Math.floor(Date.now() / 1000);
  if (last > 0 && now - last < RATE_LIMIT_WINDOW_SEC) {
    const retryAfterSec = RATE_LIMIT_WINDOW_SEC - (now - last);
    return NextResponse.json(
      {
        error: "Idea generation is rate-limited per channel (1 per 5min)",
        retryAfterSec,
      },
      { status: 429 }
    );
  }

  const apiKey = getIntegration("claude")?.api_key;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "Claude API key not configured. Add it on the Integrations page.",
      },
      { status: 400 }
    );
  }

  const outlierRows = getCompetitorVideosByIds(outlierVideoIds);
  if (outlierRows.length === 0) {
    return NextResponse.json(
      { error: "None of the supplied outlier video ids exist in the DB." },
      { status: 400 }
    );
  }
  // Each row carries its competitor's median view count via the
  // outliers endpoint earlier in the round-trip — but the bulk lookup
  // here only has the per-row data. We re-fetch the channel medians for
  // the unique competitor set below, then merge into the rendered line.
  // (Simpler than asking the client to round-trip the medians too.)
  const uniqueCompetitorIds = Array.from(
    new Set(outlierRows.map((r) => r.competitorId))
  );
  const medians = new Map<number, number>();
  if (uniqueCompetitorIds.length > 0) {
    // The competitorMedianViews helper exists for this; reuse it.
    // Imported lazily to keep the import block tight.
    const { competitorMedianViews } = await import("@/lib/db");
    for (const cid of uniqueCompetitorIds) {
      medians.set(cid, competitorMedianViews(cid));
    }
  }

  const md = loadMentorMethod();
  const sec1 = extractSection(md, 1);
  const sec7 = extractSection(md, 7);
  const sec9 = extractSection(md, 9);

  const systemPrompt = [
    "You are proposing 5–10 new video ideas for a YouTube creator, grounded in their existing channel context AND in real outlier videos that just over-performed in their competitive set. Every idea you propose must be traceable to a specific outlier — don't invent topics out of thin air.",
    "",
    "From MENTOR_METHOD.md §1 (Competitor mapping — the B&S Method):",
    sec1 || "(section unavailable)",
    "",
    "From MENTOR_METHOD.md §7 (Ideation — synthesizing the inputs):",
    sec7 || "(section unavailable)",
    "",
    "From MENTOR_METHOD.md §9 (The \"what made it work\" lever taxonomy):",
    sec9 || "(section unavailable)",
    "",
    `# Allowed angle values (use these exact strings in the "angle" field)`,
    LEVERS.map((l) => `"${l}"`).join(", "),
    "",
    "# Rules",
    "1. Propose 5–10 ideas. Quality over quantity — if only 5 are strong, return 5.",
    "2. Each idea must reference exactly one outlier from the SAMPLE block as its source.",
    "3. The suggested title must apply a methodology-grounded title format to the topic — NOT a literal copy of the source outlier's title. The user's channel voice (below) wins style ties.",
    "4. The \"angle\" is one lever from the taxonomy above — the dominant lever the source outlier leans on, applied to the new topic.",
    "5. Confidence (0.0–1.0): higher when the source outlier has a high multiplier AND the topic naturally fits the user's channel context. Lower when the lever is borrowed across far-niche tiers without modification.",
    "6. Authority-tier and Breakthrough-tier outliers carry more weight than Adjacent/Far. Far-tier outliers are best for thumbnail/structure inspiration, not topic reuse.",
    "",
    "Return ONLY a JSON object. No prose, no markdown, no code fence.",
    "Shape:",
    "{",
    '  "ideas": [',
    "    {",
    '      "topic": string,',
    '      "suggestedTitle": string,',
    '      "angle": string,',
    '      "confidence": number,',
    '      "sourceOutlierVideoId": string',
    "    }",
    "  ]",
    "}",
  ].join("\n");

  // Channel context.
  type ChannelCtx = {
    niche?: string;
    positioning?: string;
    audience?: string;
    voice?: string;
    external_sources?: string;
  };
  const ctx = channel as unknown as ChannelCtx;

  const userBody = [
    "# USER CHANNEL CONTEXT",
    `- Niche: ${ctx.niche || "(empty)"}`,
    `- Positioning: ${ctx.positioning || "(empty)"}`,
    `- Audience: ${ctx.audience || "(empty)"}`,
    `- Voice: ${ctx.voice || "(empty)"}`,
    `- External sources: ${ctx.external_sources || "(empty)"}`,
    "",
    `# OUTLIER SAMPLE (${outlierRows.length} videos currently visible on the user's Outliers page)`,
    ...outlierRows.map((r) => {
      const median = medians.get(r.competitorId) ?? 0;
      const mult = median > 0 ? (r.views / median).toFixed(1) : "?";
      return `- [${r.videoId}] "${r.title}" — ${r.competitorTitle ?? "(unknown)"} (${r.tier}) — ${mult}× median (${median.toLocaleString("en-US")} median, ${r.views.toLocaleString("en-US")} views) — ${fmtRelative(r.publishedAt)}`;
    }),
  ].join("\n");

  const model = providerModelId("claude");
  let ideas: IdeasProposal[] = [];
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model,
      max_tokens: 2500,
      temperature: 0.7,
      system: systemPrompt,
      messages: [{ role: "user", content: userBody }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    const parsed = parseIdeas(text, new Set(outlierRows.map((r) => r.videoId)));
    if (!parsed || parsed.length === 0) {
      log.warn(
        "claude",
        `Outlier-ideas ${userChannelId}: could not parse ideas. Raw: ${text.slice(0, 200)}`
      );
      return NextResponse.json(
        { error: "AI returned malformed JSON. Try again." },
        { status: 502 }
      );
    }
    ideas = parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Claude call failed";
    log.error("claude", `Outlier-ideas ${userChannelId}: ${msg}`, err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  setSetting(rateKey, String(now));
  log.info(
    "claude",
    `Outlier-ideas ${userChannelId}: returned ${ideas.length} ideas (${outlierRows.length} outliers in sample)`
  );

  return NextResponse.json({ ideas, generatedAt: now, model });
}

/**
 * Parse + validate Claude's JSON. Rejects ideas whose sourceOutlierVideoId
 * isn't in the supplied outlier sample (Claude sometimes hallucinates ids
 * even when told to pick from the list). Clamps confidence to [0, 1] and
 * drops ideas with unknown angle values.
 */
function parseIdeas(raw: string, knownIds: Set<string>): IdeasProposal[] | null {
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
  const rawIdeas = (parsed as { ideas?: unknown }).ideas;
  if (!Array.isArray(rawIdeas)) return null;
  const ideas: IdeasProposal[] = [];
  for (const raw of rawIdeas) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const topic = typeof r.topic === "string" ? r.topic.trim() : "";
    const suggestedTitle =
      typeof r.suggestedTitle === "string" ? r.suggestedTitle.trim() : "";
    const angle = typeof r.angle === "string" ? r.angle.trim() : "";
    const confidence =
      typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0;
    const sourceOutlierVideoId =
      typeof r.sourceOutlierVideoId === "string"
        ? r.sourceOutlierVideoId.trim()
        : "";
    if (
      !topic ||
      !suggestedTitle ||
      !isLever(angle) ||
      !sourceOutlierVideoId ||
      !knownIds.has(sourceOutlierVideoId)
    ) {
      continue;
    }
    ideas.push({
      topic,
      suggestedTitle,
      angle,
      confidence,
      sourceOutlierVideoId,
    });
  }
  return ideas;
}
