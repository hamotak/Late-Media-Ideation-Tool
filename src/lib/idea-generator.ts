import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  db,
  getCached,
  getCompetitorVideosByIds,
  getIntegration,
  listAllChannels,
  listChannelMemory,
  listMyWinners,
  resolveChannelDescription,
  setCached,
  type Channel,
} from "./db";
import { exaSearch, type ExaResult } from "./exa";
import { getFormatsForChannel } from "./outlier-formats";
import { listOutliersForActiveChannel } from "./outliers";
import { log } from "./logger";
import {
  extractSubredditMentions,
  fetchTopAcrossSubs,
  type RedditPost,
} from "./reddit";

// ---------------------------------------------------------------------------
// Numbered-titles-only pipeline (2026-05 strip).
//
// We trust Opus 4.7 with full channel context and full creative freedom.
// The model receives:
//   - the full channel description + ideation rules (uncapped)
//   - banned topics from channel_memory
//   - top competitor outliers in the requested window
//   - top own-channel winners (≥3× own median)
//   - all extracted trending formats with examples
//   - the channel's last 20 own uploads for frequency awareness
//
// The model returns 3–5 plain titles. The Haiku Logical-Fit validator is
// retired — Opus self-validates with thinking budget 6000. The cluster
// gate, the topic-vs-format-source pair check, and the catalog-tag
// machinery are gone. JS post-filters left: length 50–80, banned words,
// banned topics, originality (exact-copy check), topic frequency.
//
// Compose retry: up to MAX_COMPOSE_PASSES turns. Each retry sends the
// prior rejected titles + reasons back to Opus and asks for fresh
// candidates. Hard cap: 5 Opus calls per ideation turn (no Haiku).
//
// Output to the chat agent: a plain `titles: string[]` array. The agent
// renders them as a numbered list and nothing else. Per-idea source
// attribution + rationale (when the model includes them) are written to
// app_logs as [diag] ideation_internals so HAmo can grep for debug.
// ---------------------------------------------------------------------------

const OUTLIER_MIN_MULTIPLIER = 1.5;
const OUTLIER_WINDOW_DAYS = 28;
const OUTLIER_SOURCE_LIMIT = 30;
const OWN_WINNER_MIN_MULTIPLIER = 3.0;
const OWN_WINNER_LOOKBACK_DAYS = 365;
const OWN_WINNER_LIMIT = 10;
const OWN_RECENT_LIMIT = 20;

const FORMAT_CANDIDATE_LIMIT = 8;

const TITLE_LEN_IDEAL_MIN = 50;
const TITLE_LEN_IDEAL_MAX = 70;
const TITLE_LEN_HARD_MAX = 80;
const TITLE_LEN_DROP_FLOOR = 35;

const MIN_TITLES_TO_SHIP = 3;
const MAX_TITLES_TO_SHIP = 5;
const MAX_COMPOSE_PASSES = 5;

const BANNED_WORDS_RE =
  /(\bcinematic\b|\bsensory\b|\bvisceral\b|\bprofound\b|\bdesolate expanse\b|\bhumanity has ever charted\b|\bhumanity has ever mapped\b|\binexorable\b|\bvastest\b|\bthe most absolute\b|\bphysically impossible\b)/i;

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","of","in","on","for","to","with",
  "is","are","was","were","be","been","this","that","these","those","i",
  "you","he","she","it","we","they","my","your","his","her","its","our",
  "their","do","does","did","done","have","has","had","not","no","yes",
  "at","by","from","as","than","then","so","very","what","when","where",
  "why","how","who","which","there","here","just","like","get","got",
  "make","made","will","would","can","could","should","shall","may",
  "might","one","two","three","new","video","videos","about","into",
  "over","out","off","up","down",
]);

const IDEATION_THINKING_BUDGET: number = (() => {
  const raw = Number(process.env.ANTHROPIC_THINKING_BUDGET_IDEATION);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 6000;
})();

const OPUS_COMPOSE_MODEL = "claude-opus-4-7";
const COMPOSE_MAX_TOKENS = 8000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DroppedIdea = {
  proposedTitle: string;
  reason:
    | "title_too_long"
    | "title_too_short"
    | "banned_word"
    | "banned_topic"
    | "exact_copy_of_source"
    | "topic_overused"
    | "title_dup"
    | "no_real_source";
  detail?: string;
};

// One "event" the model can cite. Sourced from Reddit (top weekly posts
// in the channel's subreddits) and Exa (NASA/arxiv/ESA news queries).
// Each carries a short eventId the model emits in sourceEventIds[] per
// title so the explain-idea follow-up can resolve URLs without round-
// tripping the bundle.
export type EventCard = {
  eventId: string;
  source: "reddit" | "web";
  title: string;
  url: string;
  snippet: string;
  // Sub-source detail — subreddit name for Reddit, domain for web.
  context: string;
  publishedAt: number | null; // unix seconds; null when source lacks a date
};

export type ProposedIdea = {
  proposedTitle: string;
  // Optional model-emitted diag fields. They are NEVER surfaced on the
  // initial render (numbered titles only). The explain-idea follow-up
  // path surfaces sourceEvents resolved to URLs.
  sourceTopicVideoId?: string | null;
  sourceFormatId?: number | null;
  coherenceRationale?: string | null;
  // Real-event citations the model assigned to this title. ≥1 entry
  // required when the research bundle is non-empty (else dropped with
  // reason "no_real_source"). Resolved against the bundle so the agent
  // can render URLs directly on the explain follow-up.
  sourceEventIds?: string[];
  sourceEvents?: EventCard[];
};

export type Idea = ProposedIdea;

// Per-gate attrition counters surfaced alongside ideas:[] when the
// pipeline produces zero survivors.
export type PipelineFailure = {
  outliers_pulled: number;
  formats_pulled: number;
  own_winners_pulled: number;
  research_events_pulled: number;
  passes_run: number;
  compose_total_returned: number;
  post_filter_survivors: number;
  fail_reason: string;
};

export type GenerateIdeasResult =
  | {
      ok: true;
      ideas: ProposedIdea[];
      dropped: DroppedIdea[];
      bannedTopics: string[];
      generatedAt: number;
      model: string;
      claudeCallCount: number;
      pipelineFailure?: PipelineFailure;
    }
  | { ok: false; status: number; error: string; retryAfterSec?: number };

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function generateIdeasForChannel(opts: {
  userChannelId: string;
  outlierVideoIds?: string[];
  windowDays?: number;
  minMultiplier?: number;
  mode?: "mixed" | "free-form"; // legacy knob; ignored.
}): Promise<GenerateIdeasResult> {
  const userChannelId = opts.userChannelId?.trim();
  if (!userChannelId) {
    return { ok: false, status: 400, error: "userChannelId required" };
  }
  const channel = listAllChannels().find((c) => c.id === userChannelId);
  if (!channel) {
    return {
      ok: false,
      status: 404,
      error: `Unknown userChannelId: ${userChannelId}`,
    };
  }
  const apiKey = getIntegration("claude")?.api_key;
  if (!apiKey) {
    return {
      ok: false,
      status: 400,
      error: "Claude API key not configured. Add it on the Integrations page.",
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const bannedTopics = readBannedTopics(userChannelId);
  const dropped: DroppedIdea[] = [];

  // Channel-context diagnostics.
  {
    const descChars = resolveChannelDescription(
      channel as unknown as Channel
    ).length;
    const rulesChars = (
      (channel as unknown as Channel).ideation_rules ?? ""
    ).trim().length;
    log.info(
      "claude",
      `[diag] ideation_context channel=${userChannelId} description_chars=${descChars} rules_chars=${rulesChars} banned_topics_count=${bannedTopics.length}`
    );
  }

  const outlierWindow = opts.windowDays ?? OUTLIER_WINDOW_DAYS;
  const outlierMult = opts.minMultiplier ?? OUTLIER_MIN_MULTIPLIER;

  // 1. Source pool — competitor outliers (pre-filter banned terms).
  const outliers = loadOutlierPool({
    userChannelId,
    outlierVideoIds: opts.outlierVideoIds,
    windowDays: outlierWindow,
    minMultiplier: outlierMult,
    bannedTopics,
  });

  // 2. Own-channel winners (top ≥3× from last 365d).
  const ownWinners = listMyWinners(userChannelId, {
    limit: OWN_WINNER_LIMIT,
    lookbackDays: OWN_WINNER_LOOKBACK_DAYS,
    minMultiplier: OWN_WINNER_MIN_MULTIPLIER,
  });

  // 3. Format pool (all trending formats, including single-channel).
  const formatCandidates = buildFormatPool(userChannelId).slice(
    0,
    FORMAT_CANDIDATE_LIMIT
  );

  // 4. Last 20 own uploads for frequency awareness.
  const recentOwn = loadRecentOwnUploads(userChannelId, OWN_RECENT_LIMIT);

  const ctx = {
    description: resolveChannelDescription(channel as unknown as Channel),
    ideationRules: ((channel as unknown as Channel).ideation_rules ?? "").trim(),
    channelTitle: (channel as unknown as Channel).title ?? "this channel",
  };

  // 5. Research pre-pass — Reddit + Exa. Cached for 6h per channel.
  // Every proposed title MUST cite at least one event from this bundle
  // when the bundle is non-empty; the model emits sourceEventIds[] per
  // title and the post-filter drops titles missing an attribution.
  const research = await loadResearchBundle({
    userChannelId,
    channelDescription: ctx.description,
  });

  log.info(
    "claude",
    `[diag] ideation_inputs channel=${userChannelId} outliers=${outliers.length} formats=${formatCandidates.length} winners=${ownWinners.length} recent_own=${recentOwn.length} events=${research.events.length}`
  );

  // Up-front fail-fast: if no outliers and no winners and no formats and
  // no research events, we genuinely have nothing to feed Opus.
  if (
    outliers.length === 0 &&
    ownWinners.length === 0 &&
    formatCandidates.length === 0 &&
    research.events.length === 0
  ) {
    return {
      ok: true,
      ideas: [],
      dropped,
      bannedTopics,
      generatedAt: now,
      model: OPUS_COMPOSE_MODEL,
      claudeCallCount: 0,
      pipelineFailure: {
        outliers_pulled: 0,
        formats_pulled: 0,
        own_winners_pulled: 0,
        research_events_pulled: 0,
        passes_run: 0,
        compose_total_returned: 0,
        post_filter_survivors: 0,
        fail_reason:
          "Nothing in the source pool: no competitor outliers, no own-channel winners, no extracted formats, and no research events (Reddit/Exa returned empty). Sync competitors, re-extract trending formats, or add an Exa API key.",
      },
    };
  }

  // Build the source-id set used by the originality (exact-copy) check.
  const sourceTitleSet = new Set<string>([
    ...outliers.map((o) => o.title.toLowerCase().trim()),
    ...formatCandidates.flatMap((f) =>
      [f.formatSourceVideo.title, ...f.formatConfirmationVideos.map((c) => c.title)].map(
        (t) => t.toLowerCase().trim()
      )
    ),
  ]);

  // Multi-pass compose loop. Each pass sends the prior rejected titles
  // back so the model can adjust. We stop as soon as we have ≥3 survivors,
  // up to MAX_TITLES_TO_SHIP. Hard cap: MAX_COMPOSE_PASSES Opus calls.
  const survivors: ProposedIdea[] = [];
  let claudeCallCount = 0;
  let composeTotalReturned = 0;
  const rejectedHistory: Array<{ title: string; reason: string }> = [];
  let lastFailureNote: string | null = null;

  // Build the event-id set for the source-citation gate. When the
  // bundle has at least one event, every shipped title MUST cite at
  // least one valid id; the post-filter drops misses as
  // "no_real_source" and the next pass re-prompts.
  const knownEventIds = new Set(research.events.map((e) => e.eventId));
  const eventById = new Map(research.events.map((e) => [e.eventId, e]));

  for (let pass = 1; pass <= MAX_COMPOSE_PASSES; pass++) {
    if (survivors.length >= MIN_TITLES_TO_SHIP) break;
    const compose = await runComposeCall({
      apiKey,
      model: OPUS_COMPOSE_MODEL,
      pass,
      ctx,
      outliers,
      ownWinners,
      formatCandidates,
      recentOwn,
      events: research.events,
      bannedTopics,
      rejected: rejectedHistory.slice(-15),
      survivorsSoFar: survivors,
      targetCount: MAX_TITLES_TO_SHIP,
    });
    claudeCallCount++;
    if (!compose.ok) {
      lastFailureNote = compose.error;
      log.warn(
        "claude",
        `[diag] ideation_compose pass=${pass} failed: ${compose.error}`
      );
      // A compose-call failure is recoverable on the next pass. Continue.
      continue;
    }
    composeTotalReturned += compose.ideas.length;
    log.info(
      "claude",
      `[diag] ideation_internals pass=${pass} returned=${compose.ideas.length} titles=${JSON.stringify(compose.ideas.map((i) => ({
        title: i.proposedTitle,
        topic: i.sourceTopicVideoId ?? null,
        format: i.sourceFormatId ?? null,
        events: i.sourceEventIds ?? null,
        rationale: i.coherenceRationale ?? null,
      })))}`
    );

    for (const idea of compose.ideas) {
      if (survivors.length >= MAX_TITLES_TO_SHIP) break;
      const drop = filterIdea(
        idea.proposedTitle,
        bannedTopics,
        sourceTitleSet,
        userChannelId,
        recentOwn,
        survivors,
        rejectedHistory
      );
      if (drop) {
        dropped.push({ proposedTitle: idea.proposedTitle, ...drop });
        rejectedHistory.push({
          title: idea.proposedTitle,
          reason: `${drop.reason}: ${drop.detail ?? ""}`.trim(),
        });
        continue;
      }
      // Source-citation gate — only when the research bundle actually
      // produced events. If the bundle is empty (Reddit + Exa both
      // unavailable) we ship without the gate so the pipeline isn't
      // bricked by an external outage.
      let resolvedEvents: EventCard[] | undefined;
      if (knownEventIds.size > 0) {
        const ids = (idea.sourceEventIds ?? [])
          .map((id) => (typeof id === "string" ? id.trim() : ""))
          .filter((id) => knownEventIds.has(id));
        if (ids.length === 0) {
          dropped.push({
            proposedTitle: idea.proposedTitle,
            reason: "no_real_source",
            detail:
              "title did not cite any event id from the research bundle",
          });
          rejectedHistory.push({
            title: idea.proposedTitle,
            reason: "no_real_source: cite at least one event id from the REAL EVENT SOURCES block",
          });
          continue;
        }
        resolvedEvents = ids
          .map((id) => eventById.get(id))
          .filter((e): e is EventCard => !!e);
      }
      survivors.push({
        ...idea,
        sourceEventIds: resolvedEvents
          ? resolvedEvents.map((e) => e.eventId)
          : idea.sourceEventIds,
        sourceEvents: resolvedEvents,
      });
    }

    log.info(
      "claude",
      `[diag] ideation_pass pass=${pass} survivors=${survivors.length}/${MAX_TITLES_TO_SHIP} dropped_this_pass=${compose.ideas.length - Math.min(MAX_TITLES_TO_SHIP - (survivors.length - compose.ideas.length), compose.ideas.length)}`
    );
  }

  const finalIdeas = survivors.slice(0, MAX_TITLES_TO_SHIP);
  const passesRun = claudeCallCount;

  let pipelineFailure: PipelineFailure | undefined;
  if (finalIdeas.length < MIN_TITLES_TO_SHIP) {
    pipelineFailure = {
      outliers_pulled: outliers.length,
      formats_pulled: formatCandidates.length,
      own_winners_pulled: ownWinners.length,
      research_events_pulled: research.events.length,
      passes_run: passesRun,
      compose_total_returned: composeTotalReturned,
      post_filter_survivors: finalIdeas.length,
      fail_reason: lastFailureNote
        ? `After ${passesRun} compose passes only ${finalIdeas.length} titles survived. Last compose error: ${lastFailureNote}.`
        : `After ${passesRun} compose passes only ${finalIdeas.length} titles survived. Most common drop reasons: ${summariseDrops(dropped)}.`,
    };
    log.warn(
      "claude",
      `[diag] ideation_done channel=${userChannelId} shipped=${finalIdeas.length} (< ${MIN_TITLES_TO_SHIP} floor) passes=${passesRun} compose_returned=${composeTotalReturned} drops=${dropped.length}`
    );
  } else {
    log.info(
      "claude",
      `[diag] ideation_done channel=${userChannelId} shipped=${finalIdeas.length} passes=${passesRun} compose_returned=${composeTotalReturned} drops=${dropped.length}`
    );
  }

  return {
    ok: true,
    ideas: finalIdeas,
    dropped,
    bannedTopics,
    generatedAt: now,
    model: OPUS_COMPOSE_MODEL,
    claudeCallCount,
    ...(pipelineFailure ? { pipelineFailure } : {}),
  };
}

// ---------------------------------------------------------------------------
// Source pool helpers
// ---------------------------------------------------------------------------

type OutlierLite = {
  videoId: string;
  title: string;
  views: number;
  channelMedian: number;
  multiplier: number;
  publishedAt: number | null;
  competitorTitle: string | null;
  competitorChannelId: string | null;
};

function loadOutlierPool(opts: {
  userChannelId: string;
  outlierVideoIds?: string[];
  windowDays: number;
  minMultiplier: number;
  bannedTopics: string[];
}): OutlierLite[] {
  const {
    userChannelId,
    outlierVideoIds,
    windowDays,
    minMultiplier,
    bannedTopics,
  } = opts;
  let rows: OutlierLite[] = [];
  if (outlierVideoIds && outlierVideoIds.length > 0) {
    const fetched = getCompetitorVideosByIds(
      outlierVideoIds.slice(0, OUTLIER_SOURCE_LIMIT)
    );
    rows = fetched.map((r) => ({
      videoId: r.videoId,
      title: r.title,
      views: r.views,
      channelMedian: 0,
      multiplier: 0,
      publishedAt: r.publishedAt,
      competitorTitle: r.competitorTitle,
      competitorChannelId: r.competitorChannelId ?? null,
    }));
  } else {
    const { outliers } = listOutliersForActiveChannel({
      userChannelId,
      windowDays,
      minMultiplier,
      limit: OUTLIER_SOURCE_LIMIT,
    });
    rows = outliers.map((o) => ({
      videoId: o.videoId,
      title: o.title,
      views: o.views,
      channelMedian: o.channelMedian,
      multiplier: o.multiplier,
      publishedAt: o.publishedAt,
      competitorTitle: o.competitorTitle,
      competitorChannelId: o.competitorChannelId ?? null,
    }));
  }

  // Strip own-channel rows (defense-in-depth) + banned-topic substrings.
  rows = rows.filter(
    (r) =>
      !(
        r.competitorChannelId !== null &&
        r.competitorChannelId === userChannelId
      )
  );
  if (bannedTopics.length > 0) {
    rows = rows.filter((r) => {
      const haystack = (r.title ?? "").toLowerCase();
      for (const term of bannedTopics) {
        if (term && haystack.includes(term)) return false;
      }
      return true;
    });
  }
  return rows;
}

type FormatCandidate = {
  formatId: number;
  template: string;
  exampleCount: number;
  distinctChannels: number;
  risingRate: number | null;
  avgMultiplier: number | null;
  isSingleChannel: boolean;
  formatSourceVideo: {
    videoId: string;
    title: string;
    multiplier: number;
    competitorTitle: string | null;
  };
  formatConfirmationVideos: Array<{
    videoId: string;
    title: string;
    multiplier: number;
    competitorTitle: string | null;
  }>;
};

function buildFormatPool(userChannelId: string): FormatCandidate[] {
  const formats = getFormatsForChannel(userChannelId, 50);
  const out: FormatCandidate[] = [];
  for (const f of formats) {
    if (f.examples.length < 2) continue;
    const sorted = [...f.examples].sort(
      (a, b) => (b.multiplierAtExtract || 0) - (a.multiplierAtExtract || 0)
    );
    const primary = sorted[0];
    const confirmations = sorted.slice(1, 3).map((e) => ({
      videoId: e.videoId,
      title: e.title,
      multiplier: Math.round((e.multiplierAtExtract ?? 0) * 10) / 10,
      competitorTitle: e.competitorTitle,
    }));
    const distinctChannels = new Set(
      f.examples.map((e) => e.competitorTitle ?? `cid:${e.competitorId}`)
    ).size;
    out.push({
      formatId: f.id,
      template: f.template,
      exampleCount: f.examples.length,
      distinctChannels,
      risingRate: f.risingRate,
      avgMultiplier: f.avgMultiplier,
      isSingleChannel: f.isSingleChannel,
      formatSourceVideo: {
        videoId: primary.videoId,
        title: primary.title,
        multiplier: Math.round((primary.multiplierAtExtract ?? 0) * 10) / 10,
        competitorTitle: primary.competitorTitle,
      },
      formatConfirmationVideos: confirmations,
    });
  }
  out.sort((a, b) => {
    if ((b.risingRate ?? 0) !== (a.risingRate ?? 0))
      return (b.risingRate ?? 0) - (a.risingRate ?? 0);
    if (b.exampleCount !== a.exampleCount)
      return b.exampleCount - a.exampleCount;
    return (b.avgMultiplier ?? 0) - (a.avgMultiplier ?? 0);
  });
  return out;
}

type RecentOwn = { videoId: string; title: string; publishedAt: number | null };

function loadRecentOwnUploads(channelId: string, limit: number): RecentOwn[] {
  return db
    .prepare(
      `SELECT id AS videoId, title, published_at AS publishedAt
       FROM videos
       WHERE channel_id = ?
       ORDER BY COALESCE(published_at, imported_at) DESC
       LIMIT ?`
    )
    .all(channelId, limit) as RecentOwn[];
}

// ---------------------------------------------------------------------------
// Research pre-pass — Reddit (no auth) + Exa (web search) → event bundle
// ---------------------------------------------------------------------------

// Default subreddits when the channel description doesn't name any. Space-
// science skew because every channel HAmo currently runs is in that orbit;
// if a non-space niche shows up later we'll either parse niche keywords
// out of the description or expose a settings knob.
const DEFAULT_SUBREDDITS = ["space", "astronomy", "cosmology", "Physics"];

// Cache TTL — 6h matches the spec. Two ideation turns in the same window
// reuse the bundle so we don't burn Exa credit re-running identical queries.
const RESEARCH_CACHE_TTL_SECONDS = 6 * 3600;

export type ResearchBundle = {
  redditPosts: RedditPost[];
  webResults: ExaResult[];
  events: EventCard[];
  cachedAt: number;
};

function topContentNouns(text: string, n: number): string[] {
  const stop = STOPWORDS;
  const counts = new Map<string, number>();
  for (const raw of (text ?? "")
    .toLowerCase()
    .replace(/[^a-zа-яёіїєґ0-9 ]+/giu, " ")
    .split(/\s+/)) {
    if (!raw || raw.length < 4) continue;
    if (stop.has(raw)) continue;
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([t]) => t);
}

function buildResearchQueries(nicheKeywords: string): string[] {
  const niche = nicheKeywords.trim();
  const queries = [
    "NASA JPL news last 7 days",
    `arxiv astro-ph recent submissions ${niche}`.trim(),
    "James Webb OR Voyager OR ESA news this week",
  ];
  return queries.map((q) => q.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function eventDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "(unknown)";
  }
}

export async function loadResearchBundle(opts: {
  userChannelId: string;
  channelDescription: string;
}): Promise<ResearchBundle> {
  const cacheKey = `ideation_research:${opts.userChannelId}`;
  const cached = getCached<ResearchBundle>(cacheKey);
  if (cached) {
    log.info(
      "claude",
      `[diag] ideation_research channel=${opts.userChannelId} cache=hit reddit=${cached.redditPosts.length} web=${cached.webResults.length} events=${cached.events.length}`
    );
    return cached;
  }

  const mentioned = extractSubredditMentions(opts.channelDescription ?? "");
  const subreddits = mentioned.length > 0 ? mentioned : DEFAULT_SUBREDDITS;
  const nicheKeywords = topContentNouns(opts.channelDescription ?? "", 5).join(" ");

  let redditPosts: RedditPost[] = [];
  try {
    redditPosts = await fetchTopAcrossSubs(subreddits, {
      perSubLimit: 10,
      totalLimit: 20,
      timeframe: "week",
    });
  } catch (err) {
    log.warn(
      "claude",
      `[diag] ideation_research reddit fetch failed: ${err instanceof Error ? err.message : "?"}`
    );
  }

  let webResults: ExaResult[] = [];
  const exaKey = getIntegration("exa")?.api_key;
  if (exaKey) {
    const queries = buildResearchQueries(nicheKeywords);
    const settled = await Promise.allSettled(
      queries.map((q) =>
        exaSearch(q, exaKey, { numResults: 10, includeText: true })
      )
    );
    const seen = new Set<string>();
    for (const r of settled) {
      if (r.status !== "fulfilled") {
        log.warn(
          "claude",
          `[diag] ideation_research exa query failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`
        );
        continue;
      }
      for (const item of r.value) {
        if (!item.url || seen.has(item.url)) continue;
        seen.add(item.url);
        webResults.push(item);
      }
    }
  } else {
    log.warn(
      "claude",
      `[diag] ideation_research exa key missing — web results will be empty (Reddit still attempted)`
    );
  }

  const events: EventCard[] = [];
  redditPosts.forEach((p, i) => {
    events.push({
      eventId: `r${i + 1}`,
      source: "reddit",
      title: p.title,
      url: p.url,
      snippet:
        p.selftextPreview && p.selftextPreview.length > 0
          ? p.selftextPreview
          : `r/${p.subreddit} · score ${p.score} · ${p.numComments} comments`,
      context: `r/${p.subreddit}`,
      publishedAt: p.createdUtc > 0 ? p.createdUtc : null,
    });
  });
  webResults.forEach((w, i) => {
    events.push({
      eventId: `w${i + 1}`,
      source: "web",
      title: w.title || "(untitled)",
      url: w.url,
      snippet: (w.text ?? "").slice(0, 280),
      context: eventDomain(w.url),
      publishedAt: w.publishedDate
        ? Math.floor(Date.parse(w.publishedDate) / 1000) || null
        : null,
    });
  });

  const bundle: ResearchBundle = {
    redditPosts,
    webResults,
    events,
    cachedAt: Math.floor(Date.now() / 1000),
  };
  if (events.length > 0) {
    setCached(cacheKey, bundle, RESEARCH_CACHE_TTL_SECONDS);
  }
  log.info(
    "claude",
    `[diag] ideation_research channel=${opts.userChannelId} cache=miss reddit=${redditPosts.length} web=${webResults.length} events=${events.length} subs=${subreddits.join(",")} niche=${JSON.stringify(nicheKeywords)}`
  );
  return bundle;
}

// ---------------------------------------------------------------------------
// Post-LLM filters
// ---------------------------------------------------------------------------

function filterIdea(
  title: string,
  bannedTopics: string[],
  sourceTitleSet: Set<string>,
  userChannelId: string,
  recentOwn: RecentOwn[],
  survivorsSoFar: ProposedIdea[],
  rejected: Array<{ title: string; reason: string }>
): Omit<DroppedIdea, "proposedTitle"> | null {
  if (!title || !title.trim()) {
    return { reason: "title_too_short", detail: "empty title" };
  }
  const len = title.length;
  if (len < TITLE_LEN_DROP_FLOOR) {
    return { reason: "title_too_short", detail: `${len} chars` };
  }
  if (len > TITLE_LEN_HARD_MAX) {
    return { reason: "title_too_long", detail: `${len} chars` };
  }
  const bw = title.match(BANNED_WORDS_RE);
  if (bw) {
    return { reason: "banned_word", detail: `contains banned term "${bw[0]}"` };
  }
  const lower = title.toLowerCase();
  for (const t of bannedTopics) {
    if (t && lower.includes(t)) {
      return { reason: "banned_topic", detail: `matched banned term "${t}"` };
    }
  }
  // Exact-copy guard: the proposed title must not match a source title
  // verbatim (case-insensitive, trimmed). Keeps Opus from regurgitating
  // a competitor's outlier when it gets lazy.
  if (sourceTitleSet.has(lower.trim())) {
    return {
      reason: "exact_copy_of_source",
      detail: "matches a source-pool title verbatim",
    };
  }
  // Topic-frequency guard against the channel's last 20 uploads. ≥2
  // overlapping content nouns flags the topic as "you already shipped
  // this recently" — keep variety on the slate.
  const nouns = tokenizeContentNouns(title);
  if (nouns.length > 0) {
    for (const v of recentOwn) {
      const vNouns = tokenizeContentNouns(v.title);
      let hits = 0;
      for (const n of nouns) {
        if (vNouns.includes(n)) hits++;
        if (hits >= 2) break;
      }
      if (hits >= 2) {
        return {
          reason: "topic_overused",
          detail: `topic overlaps recent upload "${v.title}"`,
        };
      }
    }
  }
  // Dedup against survivors + earlier rejected titles on this turn.
  const norm = title.toLowerCase().replace(/\s+/g, " ").trim();
  if (survivorsSoFar.some((s) => s.proposedTitle.toLowerCase().replace(/\s+/g, " ").trim() === norm)) {
    return { reason: "title_dup", detail: "already in survivors" };
  }
  if (rejected.some((r) => r.title.toLowerCase().replace(/\s+/g, " ").trim() === norm)) {
    return { reason: "title_dup", detail: "already rejected this turn" };
  }
  // userChannelId is threaded through so downstream callers can keep the
  // signature stable when we add per-channel guards.
  void userChannelId;
  return null;
}

function tokenizeContentNouns(s: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of s
    .toLowerCase()
    .replace(/[^a-zа-яёіїєґ0-9 ]+/giu, " ")
    .split(/\s+/)) {
    if (!raw || raw.length < 4) continue;
    if (STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function summariseDrops(dropped: DroppedIdea[]): string {
  if (dropped.length === 0) return "none";
  const counts: Record<string, number> = {};
  for (const d of dropped) counts[d.reason] = (counts[d.reason] ?? 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}×${n}`)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Compose call
// ---------------------------------------------------------------------------

type ComposeOutput = {
  proposedTitle: string;
  sourceTopicVideoId?: string | null;
  sourceFormatId?: number | null;
  coherenceRationale?: string | null;
  // Event-id citations from the research bundle ("r3", "w7", …). The
  // post-filter resolves these to URLs via the bundle and drops titles
  // that don't reference at least one valid id when the bundle is
  // non-empty.
  sourceEventIds?: string[];
};

type ComposeResult =
  | { ok: true; ideas: ComposeOutput[] }
  | { ok: false; error: string };

async function runComposeCall(opts: {
  apiKey: string;
  model: string;
  pass: number;
  ctx: { description: string; ideationRules: string; channelTitle: string };
  outliers: OutlierLite[];
  ownWinners: ReturnType<typeof listMyWinners>;
  formatCandidates: FormatCandidate[];
  recentOwn: RecentOwn[];
  events: EventCard[];
  bannedTopics: string[];
  rejected: Array<{ title: string; reason: string }>;
  survivorsSoFar: ProposedIdea[];
  targetCount: number;
}): Promise<ComposeResult> {
  const systemPrompt = buildComposeSystemPrompt(opts);
  const userBody = buildComposeUserBody(opts);
  try {
    const client = new Anthropic({ apiKey: opts.apiKey });
    const resp = await client.messages.create({
      model: opts.model,
      max_tokens: COMPOSE_MAX_TOKENS,
      temperature: 1,
      system: systemPrompt,
      messages: [{ role: "user", content: userBody }],
      // Opus 4.7 thinking shape — caught earlier as a 400 when we used
      // {type:"enabled", budget_tokens:N}. Adaptive + summarized display
      // + high effort matches a ~6000-token thinking budget on Sonnet.
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
    void IDEATION_THINKING_BUDGET; // legacy knob retained for env-override readers
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    const parsed = parseComposeOutput(text);
    if (!parsed) {
      return { ok: false, error: "compose returned malformed JSON" };
    }
    return { ok: true, ideas: parsed };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "compose call failed",
    };
  }
}

function buildComposeSystemPrompt(opts: {
  pass: number;
  ctx: { description: string; ideationRules: string; channelTitle: string };
  bannedTopics: string[];
  events: EventCard[];
  targetCount: number;
}): string {
  const lines: string[] = [];
  lines.push(
    `You are a senior YouTube title strategist for ${opts.ctx.channelTitle}. You have full creative freedom. Your job: produce ${MIN_TITLES_TO_SHIP}-${opts.targetCount} viral title candidates per turn that the channel owner will actually film. Use the Topic × Format approach when it produces sharp titles, but you can also propose fresh structures, remix the channel's own winners, or apply patterns from outside the supplied formats if you spot something better. Trust your judgment. Channel context, rules, and source material follow. Output ONLY a JSON object with a "titles" array of ${MIN_TITLES_TO_SHIP}-${opts.targetCount} entries.`
  );
  lines.push("");
  lines.push("# OUTPUT");
  lines.push("Return ONLY a JSON object. No prose, no markdown, no code fence.");
  lines.push("{");
  lines.push('  "titles": [');
  lines.push("    {");
  lines.push('      "title": string,                  // REQUIRED. 50-80 chars. Plain language. No jargon. No banned words. No exact copy of a source title.');
  lines.push('      "sourceEventIds": string[],       // REQUIRED when REAL EVENT SOURCES is non-empty. 1-3 entries. Each MUST be an exact eventId from the bundle (e.g. "r3", "w7"). The title must be a faithful reframing of those events — no fabricated facts.');
  lines.push('      "sourceTopicVideoId": string|null, // OPTIONAL — the outlier id you riffed off, for our internal logs.');
  lines.push('      "sourceFormatId": number|null,     // OPTIONAL — the format template id you used, for our internal logs.');
  lines.push('      "rationale": string|null           // OPTIONAL — one short sentence (≤180 chars) on why this title fits THIS channel.');
  lines.push("    }");
  lines.push("  ]");
  lines.push("}");
  lines.push("");
  lines.push("# TITLE CONSTRAINTS");
  lines.push(
    `- Length: 50-70 chars ideal, ${TITLE_LEN_HARD_MAX} hard ceiling, ${TITLE_LEN_DROP_FLOOR} floor.`
  );
  lines.push("- Plain words a 14-year-old reads in <2 seconds.");
  lines.push("- NEVER use: cinematic, sensory, visceral, profound, desolate expanse, humanity has ever charted, humanity has ever mapped, inexorable, vastest, the most absolute, physically impossible.");
  lines.push("- NEVER copy a source title verbatim. The model picks a topic + a different shape — fabrications are out, but reframings are in.");
  lines.push("- NEVER repeat a topic the channel covered in its last 20 uploads (you'll see those below) unless you have a clearly fresh angle.");
  if (opts.events.length > 0) {
    lines.push("");
    lines.push("# REAL-EVENT GROUNDING (NON-NEGOTIABLE)");
    lines.push(
      "Every proposed title MUST be traceable to at least one real event from the REAL EVENT SOURCES block below. Pick the event(s) you're riffing off and emit their eventIds in sourceEventIds[]. Reject your own draft if you can't point to a real event. We are NOT writing speculative dread headlines. We are remixing REAL recent news using the channel's voice + viral structural formats. Titles missing sourceEventIds — or citing ids that don't exist in the bundle — are dropped server-side."
    );
  }
  if (opts.bannedTopics.length > 0) {
    lines.push("");
    lines.push("# BANNED TOPICS (NEVER propose)");
    for (const t of opts.bannedTopics) lines.push(`- ${t}`);
  }
  if (opts.ctx.ideationRules) {
    lines.push("");
    lines.push("# PER-CHANNEL IDEATION RULES (HARD)");
    lines.push(opts.ctx.ideationRules);
  }
  if (opts.pass > 1) {
    lines.push("");
    lines.push(
      "# RETRY CONTEXT"
    );
    lines.push(
      `This is compose pass ${opts.pass}. Earlier titles were rejected (you'll see the list below). Try different topics, different formats, or fresh structures. We need at least ${MIN_TITLES_TO_SHIP} clean titles to ship.`
    );
  }
  return lines.join("\n");
}

function buildComposeUserBody(opts: {
  ctx: { description: string; ideationRules: string; channelTitle: string };
  outliers: OutlierLite[];
  ownWinners: ReturnType<typeof listMyWinners>;
  formatCandidates: FormatCandidate[];
  recentOwn: RecentOwn[];
  events: EventCard[];
  rejected: Array<{ title: string; reason: string }>;
  survivorsSoFar: ProposedIdea[];
}): string {
  const lines: string[] = [];
  lines.push("# CHANNEL DESCRIPTION");
  lines.push(
    opts.ctx.description.length > 0
      ? opts.ctx.description
      : "(not set)"
  );
  if (opts.events.length > 0) {
    lines.push("");
    lines.push(`# REAL EVENT SOURCES (${opts.events.length}) — cite at least one eventId per title`);
    for (const e of opts.events) {
      const dateStr = e.publishedAt
        ? new Date(e.publishedAt * 1000).toISOString().slice(0, 10)
        : "(undated)";
      const snippet = e.snippet
        ? ` — ${e.snippet.replace(/\s+/g, " ").slice(0, 200)}`
        : "";
      lines.push(
        `- ${e.eventId} [${e.source}|${e.context}|${dateStr}] ${e.title} (${e.url})${snippet}`
      );
    }
  } else {
    lines.push("");
    lines.push(
      "# REAL EVENT SOURCES — empty this turn (Reddit + Exa returned nothing). Ground titles in the outliers / winners / formats below; do not invent news."
    );
  }
  lines.push("");
  lines.push(`# COMPETITOR OUTLIERS (${opts.outliers.length})`);
  if (opts.outliers.length === 0) {
    lines.push("(none — competitor pool is empty for the requested window)");
  } else {
    for (const o of opts.outliers) {
      lines.push(
        `- [${o.videoId}] ${o.multiplier.toFixed(1)}× — ${o.competitorTitle ?? "(unknown)"} — ${o.title}`
      );
    }
  }
  lines.push("");
  lines.push(`# OWN-CHANNEL WINNERS (${opts.ownWinners.length}, ≥${OWN_WINNER_MIN_MULTIPLIER}× own median, last ${OWN_WINNER_LOOKBACK_DAYS}d)`);
  if (opts.ownWinners.length === 0) {
    lines.push("(none qualified)");
  } else {
    for (const w of opts.ownWinners) {
      lines.push(
        `- [${w.videoId}] ${w.multiplier.toFixed(1)}× (${w.views.toLocaleString("en-US")} views) — ${w.title}`
      );
    }
  }
  lines.push("");
  lines.push(`# TRENDING FORMATS (${opts.formatCandidates.length})`);
  if (opts.formatCandidates.length === 0) {
    lines.push("(no extracted formats — feel free to invent a structure)");
  } else {
    for (const f of opts.formatCandidates) {
      lines.push(
        `- format_id=${f.formatId} template=${JSON.stringify(f.template)}${f.isSingleChannel ? " (single-channel pattern)" : ""}`
      );
      lines.push(
        `    examples: [${f.formatSourceVideo.videoId}] "${f.formatSourceVideo.title}" (${f.formatSourceVideo.multiplier}×)${f.formatConfirmationVideos.map((c) => `, [${c.videoId}] "${c.title}" (${c.multiplier}×)`).join("")}`
      );
    }
  }
  lines.push("");
  lines.push(`# CHANNEL'S LAST ${opts.recentOwn.length} UPLOADS (avoid topic repeats unless you have a fresh angle)`);
  if (opts.recentOwn.length === 0) {
    lines.push("(no recent uploads on record)");
  } else {
    for (const r of opts.recentOwn) {
      lines.push(`- [${r.videoId}] ${r.title}`);
    }
  }
  if (opts.rejected.length > 0) {
    lines.push("");
    lines.push("# PREVIOUSLY REJECTED THIS TURN (do not repeat or near-repeat)");
    for (const r of opts.rejected) {
      lines.push(`- "${r.title}" — ${r.reason}`);
    }
  }
  if (opts.survivorsSoFar.length > 0) {
    lines.push("");
    lines.push("# ALREADY ACCEPTED THIS TURN (vary the next batch — different topics, different shapes)");
    for (const s of opts.survivorsSoFar) {
      lines.push(`- "${s.proposedTitle}"`);
    }
  }
  return lines.join("\n");
}

function parseComposeOutput(raw: string): ComposeOutput[] | null {
  const parsed = parseJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return null;
  // Accept either {titles:[{title,…},…]} (preferred) or {titles:[string,…]}.
  const arr = (parsed as { titles?: unknown }).titles;
  if (!Array.isArray(arr)) return null;
  const out: ComposeOutput[] = [];
  for (const entry of arr) {
    if (typeof entry === "string") {
      const t = entry.trim();
      if (t) out.push({ proposedTitle: t });
      continue;
    }
    if (entry && typeof entry === "object") {
      const o = entry as Record<string, unknown>;
      const title = typeof o.title === "string" ? o.title.trim() : "";
      if (!title) continue;
      const eventIds: string[] = [];
      const rawEventIds = o.sourceEventIds;
      if (Array.isArray(rawEventIds)) {
        for (const e of rawEventIds) {
          if (typeof e === "string") {
            const trimmed = e.trim();
            if (trimmed) eventIds.push(trimmed);
          }
        }
      }
      out.push({
        proposedTitle: title,
        sourceTopicVideoId:
          typeof o.sourceTopicVideoId === "string"
            ? o.sourceTopicVideoId.trim() || null
            : null,
        sourceFormatId:
          typeof o.sourceFormatId === "number" &&
          Number.isFinite(o.sourceFormatId)
            ? Math.floor(o.sourceFormatId)
            : null,
        coherenceRationale:
          typeof o.rationale === "string"
            ? o.rationale.trim() || null
            : typeof o.coherenceRationale === "string"
              ? o.coherenceRationale.trim() || null
              : null,
        sourceEventIds: eventIds.length > 0 ? eventIds : undefined,
      });
    }
  }
  return out.length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBannedTopics(channelId: string): string[] {
  const rows = listChannelMemory(channelId);
  const row = rows.find((r) => r.key === "banned_topics");
  if (!row || !row.value) return [];
  return row.value
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

function parseJsonObject(raw: string): unknown {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
