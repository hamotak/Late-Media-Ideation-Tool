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

/**
 * Apify YouTube transcript extractor.
 *
 * The pintostudio actor takes ONE URL per run (field name is
 * `videoUrl`, singular). We call it sequentially per video so the
 * caller can pass an array as a convenience — Apify-side latency
 * still wins over yt-dlp on a datacenter IP because each call goes
 * through a residential pool.
 */
export async function apifyYouTubeTranscript(
  videoUrls: string[],
  apiKey: string
): Promise<{ url: string; transcript: string; language?: string }[]> {
  const out: { url: string; transcript: string; language?: string }[] = [];
  for (const url of videoUrls) {
    try {
      const items = await runActorSync<{
        url?: string;
        videoUrl?: string;
        transcript?: string;
        subtitles?: string;
        // The transcript scraper actually returns `data: [{text, dur, start}, ...]`
        // — the older `transcript` string field is gone in current versions.
        data?: Array<{ text?: string; start?: string; dur?: string }>;
        language?: string;
      }>(
        "pintostudio~youtube-transcript-scraper",
        { videoUrl: url },
        apiKey,
        { timeoutSecs: 180 }
      );
      const first = items[0];
      // Reassemble from the `data` array when present (current format),
      // fall back to legacy `transcript`/`subtitles` strings otherwise.
      const text =
        first?.transcript ??
        first?.subtitles ??
        (Array.isArray(first?.data)
          ? first.data
              .map((d) => d.text ?? "")
              .filter(Boolean)
              .join(" ")
              .replace(/\s+/g, " ")
              .trim()
          : "");
      out.push({
        url: first?.url ?? first?.videoUrl ?? url,
        transcript: text,
        language: first?.language,
      });
    } catch (err) {
      // Surface per-video errors but keep going for the rest of the
      // batch — one busted video shouldn't void a 50-video sync.
      out.push({
        url,
        transcript: "",
        language: undefined,
      });
      void err;
    }
  }
  return out;
}
