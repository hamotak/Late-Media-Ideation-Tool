import "server-only";

/**
 * Apify Actor runner — sync call (waits for finish).
 * Docs: https://docs.apify.com/api/v2
 *
 * Uses the run-sync-get-dataset-items endpoint to get results in a single request.
 * Timeouts on large inputs — keep maxResults modest.
 */

const BASE = "https://api.apify.com/v2";

async function runActorSync<T>(
  actorSlug: string,
  input: unknown,
  apiKey: string,
  opts: { timeoutSecs?: number } = {}
): Promise<T[]> {
  const url = new URL(`${BASE}/acts/${encodeURIComponent(actorSlug)}/run-sync-get-dataset-items`);
  url.searchParams.set("token", apiKey);
  if (opts.timeoutSecs) url.searchParams.set("timeout", String(opts.timeoutSecs));

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Apify ${actorSlug} failed: ${res.status} ${text.slice(0, 500)}`);
  }
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as T[]) : [];
}

/** Apify YouTube scraper — returns a list of videos for a channel/URL. */
export type ApifyYouTubeVideo = {
  id?: string;
  url?: string;
  title?: string;
  viewCount?: number;
  likes?: number;
  commentsCount?: number;
  duration?: string;
  date?: string;
  channelName?: string;
  channelUrl?: string;
  text?: string; // transcript if requested
};

export async function apifyYouTubeScrape(
  input: {
    startUrls?: { url: string }[];
    keywords?: string[];
    maxResults?: number;
    includeTranscript?: boolean;
  },
  apiKey: string
): Promise<ApifyYouTubeVideo[]> {
  return runActorSync<ApifyYouTubeVideo>(
    "streamers~youtube-scraper",
    {
      startUrls: input.startUrls,
      keywords: input.keywords,
      maxResults: input.maxResults ?? 20,
      subtitlesLanguage: input.includeTranscript ? "any" : undefined,
      downloadSubtitles: !!input.includeTranscript,
    },
    apiKey,
    { timeoutSecs: 180 }
  );
}

// `apifyYouTubeTranscript` was removed in this fork — transcription
// runs exclusively through Deepgram (yt-dlp pulls audio locally, streams
// to Deepgram, transcript lands in SQLite). The Apify integration is
// kept around solely for competitor channel scraping via
// `apifyYouTubeScrape` above.
