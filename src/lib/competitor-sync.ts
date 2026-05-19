import "server-only";
import { apifyYouTubeScrape, type ApifyYouTubeVideo } from "./apify";
import {
  Competitor,
  competitorMedianViews,
  db,
  getCompetitor,
  getIntegration,
  getSetting,
  recordCompetitorAlert,
  setSetting,
  updateCompetitorAfterSync,
  upsertCompetitorVideo,
} from "./db";
import { log } from "./logger";
import {
  fetchVideos,
  listUploadIds,
  resolveChannel,
  YouTubeApiError,
} from "./youtube";

// -----------------------------------------------------------------------
// Default backend: YouTube Data API (free, ~3 quota units per full sync —
// 1 for resolveChannel + 1 for listUploadIds + 1 for fetchVideos, all
// well under the 10,000/day free-tier ceiling).
// Apify retained for users who hit the YT quota ceiling on >100 competitors.
// Override via settings.competitor_sync_backend = "apify".
// -----------------------------------------------------------------------

// Settings key + values for the backend selector.
const BACKEND_SETTING = "competitor_sync_backend";
type SyncBackend = "youtube" | "apify";
const DEFAULT_BACKEND: SyncBackend = "youtube";

function getSyncBackend(): SyncBackend {
  const raw = (getSetting(BACKEND_SETTING) ?? "").trim().toLowerCase();
  return raw === "apify" ? "apify" : DEFAULT_BACKEND;
}

// Outlier threshold — when a video's views exceed median × this we flag it.
// Generation floor is 1.5×; the methodology canon (MENTOR_METHOD §2) stays
// at 2×. Why the gap: the Alerts tab UI lets the user filter by min
// multiplier (1.5×, 2×, 3×, 5×, 10×). If generation also stopped at 2× the
// 1.5× pill would always show 0 results. 1.5× generation + 2× default
// filter = methodology preserved at the surface, with an opt-in wider bucket.
const OUTLIER_MULTIPLIER = 1.5;

// How many videos to pull per sync. Apify charges per request, so we cap
// at 50 — covers most channels' recent activity without burning credits.
// YT backend pulls the same window (last 50 from uploads playlist) for
// parity with the prior data shape.
const VIDEOS_PER_SYNC = 50;

export class CompetitorSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompetitorSyncError";
  }
}

/**
 * Resolve various user-supplied identifiers (@handle, full URLs, plain
 * UCxxxxx) to a single canonical channel URL that Apify accepts.
 */
export function normaliseChannelUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new CompetitorSyncError("Empty channel identifier");
  if (/^https?:\/\//.test(trimmed)) return trimmed.replace(/\/+$/, "");
  if (trimmed.startsWith("@")) {
    return `https://www.youtube.com/${trimmed}`;
  }
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
    return `https://www.youtube.com/channel/${trimmed}`;
  }
  // Bare handle without @ prefix.
  if (/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return `https://www.youtube.com/@${trimmed}`;
  }
  throw new CompetitorSyncError(
    `Could not parse identifier "${input}". Pass a YouTube channel URL, @handle, or UC-id.`
  );
}

/** Parse Apify's duration string ("PT3M42S" or "3:42" or seconds) into seconds. */
function parseDuration(raw: string | undefined): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  // ISO 8601: PT3M42S
  const iso = raw.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (iso) {
    const [, h = "0", m = "0", s = "0"] = iso;
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  }
  // Colon-separated 3:42 or 1:03:42
  const parts = raw.split(":").map((p) => Number(p));
  if (parts.every((n) => Number.isFinite(n))) {
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

function parseDate(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function extractVideoId(url: string | undefined, fallback: string | undefined): string | null {
  if (fallback) return fallback;
  if (!url) return null;
  // youtu.be/ID, watch?v=ID, /shorts/ID
  const m = url.match(/(?:youtu\.be\/|v=|\/shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

export type SyncResult = {
  videosSeen: number;
  videosInserted: number;
  newAlerts: number;
  channelTitle: string | null;
  medianViews: number;
};

/**
 * Orchestrator. Dispatches to the YouTube Data API path (default) or
 * the legacy Apify path based on the `competitor_sync_backend` setting.
 * Both paths produce the same DB shape (competitor_videos +
 * competitor_alerts rows) so callers don't see the difference.
 *
 * Backend selection:
 *   - settings.competitor_sync_backend = "youtube" (default) → YT Data API
 *   - settings.competitor_sync_backend = "apify"             → legacy
 * No UI for this; toggle via SQL or `setSetting` in code.
 */
export async function syncCompetitor(competitorId: number): Promise<SyncResult> {
  const backend = getSyncBackend();
  if (backend === "youtube") {
    return syncCompetitorViaYouTube(competitorId);
  }
  return syncCompetitorViaApify(competitorId);
}

/**
 * YouTube Data API competitor sync. Quota cost per full sync:
 *   resolveChannel  → 1 unit (channels.list)
 *   listUploadIds   → 1 unit per 50 ids (typical: 1 unit)
 *   fetchVideos     → 1 unit per 50 ids (typical: 1 unit)
 * Total: ~3 units. Free tier is 10,000/day — fine for ≤3,000 syncs/day.
 *
 * Logs a [diag] yt_sync line with the video count and a quota estimate
 * so HAmo can audit the daily YT API burn at-a-glance.
 */
export async function syncCompetitorViaYouTube(
  competitorId: number
): Promise<SyncResult> {
  const competitor = getCompetitor(competitorId);
  if (!competitor) {
    throw new CompetitorSyncError(`Competitor ${competitorId} not found`);
  }
  const apiKey = getIntegration("youtube")?.api_key;
  if (!apiKey) {
    throw new CompetitorSyncError(
      "YouTube Data API key is not configured. Add it on the Integrations page (or switch competitor_sync_backend to 'apify')."
    );
  }

  // We need a UC-id to call channels.list. resolveChannel accepts a UC-id,
  // a handle (@something), or a bare handle and returns the canonical
  // metadata including the uploads playlist id.
  const lookup =
    competitor.channel_id ??
    competitor.handle ??
    null;
  if (!lookup) {
    throw new CompetitorSyncError(
      `Competitor ${competitorId} has no channel identifier — re-add with a valid handle/UC-id.`
    );
  }

  log.info("competitors", "Syncing competitor (YouTube Data API)", {
    competitorId,
    lookup,
  });
  const startedAt = Date.now();
  let quotaUnits = 0;

  let resolved: Awaited<ReturnType<typeof resolveChannel>>;
  try {
    resolved = await resolveChannel(lookup, apiKey);
    // UC-id lookup hits channels.list directly (1 unit). Handle/URL
    // lookup adds one upstream channels.list-forHandle call (2 units
    // total). Legacy /c/Name fallback uses search.list (~101 units) —
    // very rare since added competitors land with a UC-id or handle.
    const looksLikeUcId = /^UC[A-Za-z0-9_-]{20,}$/.test(lookup);
    quotaUnits += looksLikeUcId ? 1 : 2;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "resolveChannel failed";
    throw new CompetitorSyncError(`YT resolveChannel: ${msg}`);
  }

  let videoIds: string[];
  try {
    videoIds = await listUploadIds(resolved.uploadsPlaylistId, apiKey, {
      max: VIDEOS_PER_SYNC,
    });
    // 1 quota unit per playlistItems page (50 ids/page).
    quotaUnits += Math.max(1, Math.ceil(videoIds.length / 50));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "listUploadIds failed";
    throw new CompetitorSyncError(`YT listUploadIds: ${msg}`);
  }

  let videos: Awaited<ReturnType<typeof fetchVideos>>;
  try {
    videos = await fetchVideos(videoIds, apiKey);
    // 1 quota unit per 50 ids on videos.list.
    quotaUnits += Math.max(1, Math.ceil(videoIds.length / 50));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "fetchVideos failed";
    throw new CompetitorSyncError(`YT fetchVideos: ${msg}`);
  }

  let videosInserted = 0;
  for (const v of videos) {
    if (!v.id || !v.title) continue;
    upsertCompetitorVideo({
      competitor_id: competitorId,
      video_id: v.id,
      title: v.title,
      thumbnail_url:
        v.thumbnail ?? `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
      views: v.views ?? 0,
      likes: v.likes ?? 0,
      comments: v.comments ?? 0,
      duration_seconds: v.durationSeconds,
      published_at: v.publishedAt,
    });
    videosInserted++;
  }

  // Persist canonical channel metadata while we have the resolved row.
  // Avoids needing a separate enrich pass on first sync (the worker
  // route still calls enrichCompetitorMetadataFromYouTube for redundancy,
  // but the data is already correct here).
  const channelMetaPatch: Partial<Competitor> = {
    title: resolved.title ?? competitor.title,
    channel_id: resolved.id ?? competitor.channel_id,
    video_count: videosInserted,
  };
  if (resolved.subscribers !== null && resolved.subscribers !== undefined) {
    channelMetaPatch.subscriber_count = resolved.subscribers;
  }
  if (resolved.thumbnail) {
    channelMetaPatch.avatar_url = resolved.thumbnail;
  }
  if (!competitor.handle && resolved.handle) {
    channelMetaPatch.handle = resolved.handle.startsWith("@")
      ? resolved.handle
      : `@${resolved.handle}`;
  }
  updateCompetitorAfterSync(competitorId, channelMetaPatch);

  // Outlier scan — runs AFTER inserts so the median reflects the new rows.
  const median = competitorMedianViews(competitorId);
  let newAlerts = 0;
  if (median > 0) {
    for (const v of videos) {
      if (!v.id || !v.title || !v.views) continue;
      const multiplier = v.views / median;
      if (multiplier >= OUTLIER_MULTIPLIER) {
        recordCompetitorAlert({
          competitor_id: competitorId,
          video_id: v.id,
          title: v.title,
          thumbnail_url:
            v.thumbnail ?? `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
          views: v.views,
          channel_median_views: median,
          multiplier: Math.round(multiplier * 10) / 10,
        });
        newAlerts++;
      }
    }
  }

  log.info(
    "competitors",
    `[diag] yt_sync channel=${resolved.id ?? lookup} videos_pulled=${videosInserted} quota_units_estimate=${quotaUnits}`
  );
  log.info("competitors", "Competitor sync done (YT)", {
    competitorId,
    videosSeen: videos.length,
    videosInserted,
    newAlerts,
    medianViews: median,
    quotaUnits,
    durationMs: Date.now() - startedAt,
  });

  return {
    videosSeen: videos.length,
    videosInserted,
    newAlerts,
    channelTitle: resolved.title ?? competitor.title ?? null,
    medianViews: median,
  };
}

/**
 * Legacy Apify-backed sync. Kept for users who hit the YT Data API quota
 * ceiling on >100 competitors. Short-circuits with a clear error when
 * either the Apify key is missing OR the backend setting hasn't been
 * flipped to "apify" — the default-YT switch makes this the rare path.
 */
export async function syncCompetitorViaApify(
  competitorId: number
): Promise<SyncResult> {
  if (getSyncBackend() !== "apify") {
    throw new CompetitorSyncError(
      "Apify backend disabled — using YouTube Data API. Set settings.competitor_sync_backend='apify' to re-enable."
    );
  }
  const apifyKey = getIntegration("apify")?.api_key;
  if (!apifyKey) {
    throw new CompetitorSyncError(
      "Apify API key is not configured. Add it on Integrations OR switch to the YouTube Data API backend (default)."
    );
  }

  const competitor = getCompetitor(competitorId);
  if (!competitor) {
    throw new CompetitorSyncError(`Competitor ${competitorId} not found`);
  }

  const url = competitor.channel_id
    ? `https://www.youtube.com/channel/${competitor.channel_id}`
    : competitor.handle
      ? normaliseChannelUrl(competitor.handle)
      : null;
  if (!url) {
    throw new CompetitorSyncError(
      `Competitor ${competitorId} has no channel identifier — re-add with a valid handle/URL.`
    );
  }

  log.info("competitors", "Syncing competitor (Apify legacy)", {
    competitorId,
    url,
  });
  const startedAt = Date.now();
  const items: ApifyYouTubeVideo[] = await apifyYouTubeScrape(
    { startUrls: [{ url }], maxResults: VIDEOS_PER_SYNC, includeTranscript: false },
    apifyKey
  );

  // Pull channel metadata off the first item (Apify embeds channelName
  // / channelUrl on every video row).
  const first = items[0];
  const channelTitle = first?.channelName ?? competitor.title ?? null;
  const channelIdMatch = first?.channelUrl?.match(/channel\/(UC[A-Za-z0-9_-]+)/);
  const resolvedChannelId = channelIdMatch ? channelIdMatch[1] : competitor.channel_id;

  let videosInserted = 0;
  for (const it of items) {
    const vid = extractVideoId(it.url, it.id);
    if (!vid || !it.title) continue;
    upsertCompetitorVideo({
      competitor_id: competitorId,
      video_id: vid,
      title: it.title,
      thumbnail_url: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`,
      views: it.viewCount ?? 0,
      likes: it.likes ?? 0,
      comments: it.commentsCount ?? 0,
      duration_seconds: parseDuration(it.duration),
      published_at: parseDate(it.date),
    });
    videosInserted++;
  }

  updateCompetitorAfterSync(competitorId, {
    title: channelTitle,
    channel_id: resolvedChannelId,
    video_count: videosInserted,
  });

  const median = competitorMedianViews(competitorId);
  let newAlerts = 0;
  if (median > 0) {
    for (const it of items) {
      const vid = extractVideoId(it.url, it.id);
      if (!vid || !it.title || !it.viewCount) continue;
      const multiplier = it.viewCount / median;
      if (multiplier >= OUTLIER_MULTIPLIER) {
        recordCompetitorAlert({
          competitor_id: competitorId,
          video_id: vid,
          title: it.title,
          thumbnail_url: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`,
          views: it.viewCount,
          channel_median_views: median,
          multiplier: Math.round(multiplier * 10) / 10,
        });
        newAlerts++;
      }
    }
  }

  log.info("competitors", "Competitor sync done (Apify)", {
    competitorId,
    videosSeen: items.length,
    videosInserted,
    newAlerts,
    medianViews: median,
    durationMs: Date.now() - startedAt,
  });

  return {
    videosSeen: items.length,
    videosInserted,
    newAlerts,
    channelTitle,
    medianViews: median,
  };
}

// ---------------------------------------------------------------------------
// One-shot migration: re-queue competitors that previously failed with an
// Apify-credits-exhausted error so the new YT backend can pick them up
// cleanly. Gated by a settings flag — runs once per database.
// ---------------------------------------------------------------------------

const APIFY_FAILED_REQUEUE_FLAG = "competitor_sync_backend.apify_failed_requeue_done";

export function requeueApifyFailedCompetitorsOnce(): number {
  if (getSetting(APIFY_FAILED_REQUEUE_FLAG) === "1") return 0;
  // Pattern-match common Apify credit-exhausted messages. The actor
  // surfaces variations of "out of credits" / "credits exhausted" /
  // "monthly limit" — case-insensitive substring covers all of them.
  const info = db
    .prepare(
      `UPDATE competitors
       SET sync_status = 'queued', sync_error = NULL
       WHERE sync_status = 'failed'
         AND sync_error IS NOT NULL
         AND (
           LOWER(sync_error) LIKE '%apify%'
           OR LOWER(sync_error) LIKE '%credits%'
           OR LOWER(sync_error) LIKE '%credit%exhaust%'
           OR LOWER(sync_error) LIKE '%monthly limit%'
         )`
    )
    .run();
  setSetting(APIFY_FAILED_REQUEUE_FLAG, "1");
  if (info.changes > 0) {
    log.info(
      "competitors",
      `[migration] requeued ${info.changes} Apify-failed competitor(s) for the new YT-default backend`
    );
  }
  return info.changes;
}

/**
 * Always-on YouTube Data API metadata enrichment. Layered on top of the
 * Apify sync (Apify still owns video lists + view counts; YT API owns
 * canonical channel metadata: title, subscriber count, video count, avatar).
 *
 * Safe to call repeatedly — overwrites the same DB columns each time.
 * Returns ok:false rather than throwing on any of:
 *   - competitor row missing
 *   - channel_id not yet resolved (Apify hasn't run / errored on add)
 *   - no YouTube Data API key configured
 *   - YouTube API error (4xx/5xx, network, channel not found)
 *
 * Quota cost: 1 unit per call (channels.list with a single UC-id).
 */
export type EnrichResult = {
  ok: boolean;
  fields: Partial<{
    subscriber_count: number | null;
    video_count: number | null;
    title: string | null;
    avatar_url: string | null;
    handle: string | null;
  }>;
  error?: string;
};

export async function enrichCompetitorMetadataFromYouTube(
  competitorId: number
): Promise<EnrichResult> {
  const comp = getCompetitor(competitorId);
  if (!comp) {
    return { ok: false, fields: {}, error: "competitor not found" };
  }
  if (!comp.channel_id) {
    // Handle-only entries until first Apify sync resolves the UC-id.
    return { ok: false, fields: {}, error: "no channel_id resolved yet" };
  }
  const apiKey = getIntegration("youtube")?.api_key;
  if (!apiKey) {
    return { ok: false, fields: {}, error: "no YouTube Data API key configured" };
  }

  try {
    // resolveChannel called with a UC-id skips the search/handle lookup
    // and goes straight to channels.list — exactly 1 quota unit.
    const resolved = await resolveChannel(comp.channel_id, apiKey);

    // Log the raw shape we received so the next "subs not showing up"
    // report is a `tail -f` away rather than an investigation. Includes
    // the bits we actually consume; not the full payload (description
    // strings would bloat logs).
    log.info("competitors", `YT enrich ${comp.channel_id} resolved`, {
      title: resolved.title,
      subscribers: resolved.subscribers,
      videoCount: resolved.videoCount,
      hasThumbnail: !!resolved.thumbnail,
    });

    const fields: EnrichResult["fields"] = {
      title: resolved.title,
      subscriber_count: resolved.subscribers,
      video_count: resolved.videoCount,
      avatar_url: resolved.thumbnail,
    };
    // Handle protection: only overwrite a null local handle. Never clobber
    // a value the user typed in (custom URLs returned by YouTube can lag
    // by months when a creator updates their @handle).
    if (!comp.handle && resolved.handle) {
      fields.handle = resolved.handle.startsWith("@")
        ? resolved.handle
        : `@${resolved.handle}`;
    }

    updateCompetitorAfterSync(competitorId, fields as Partial<Competitor>);
    log.info("competitors", `YT enrich ${comp.channel_id}: 1 unit quota burned`);
    return { ok: true, fields };
  } catch (err) {
    const message =
      err instanceof YouTubeApiError || err instanceof Error
        ? err.message
        : "unknown error";
    log.warn(
      "competitors",
      `YT enrich ${comp.channel_id} failed (non-fatal): ${message}`
    );
    return { ok: false, fields: {}, error: message };
  }
}
