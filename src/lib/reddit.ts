import "server-only";

/**
 * Minimal Reddit JSON-API client. No auth required for public listings;
 * we just need a stable User-Agent string per Reddit's API policy
 * (anything that identifies the app — a generic browser UA gets rate-
 * limited fast). Used by the ideation pre-pass to pull recent viral
 * threads from subreddits the channel cares about.
 *
 * Docs: https://www.reddit.com/dev/api/#GET_top
 */

export type RedditPost = {
  id: string;
  subreddit: string;
  title: string;
  url: string;           // canonical reddit URL (https://www.reddit.com/r/.../comments/...)
  externalUrl: string;   // the outbound link if the post is a link-post (else same as `url`)
  score: number;
  numComments: number;
  createdUtc: number;    // unix seconds
  author: string | null;
  isSelfPost: boolean;
  selftextPreview: string; // first 300 chars of selftext, "" for link posts
  thumbnail: string | null;
};

const USER_AGENT =
  process.env.REDDIT_USER_AGENT ??
  "yt-channel-ai/0.1 (+local research pre-pass)";

const REDDIT_BASE = "https://www.reddit.com";

type RedditListingResponse = {
  data?: {
    children?: Array<{
      kind: string;
      data: {
        id?: string;
        subreddit?: string;
        title?: string;
        permalink?: string;
        url?: string;
        url_overridden_by_dest?: string;
        score?: number;
        num_comments?: number;
        created_utc?: number;
        author?: string;
        is_self?: boolean;
        selftext?: string;
        thumbnail?: string;
        over_18?: boolean;
        removed_by_category?: string;
      };
    }>;
  };
};

/**
 * Pull top N posts from a single subreddit over the given timeframe.
 * Throws on network / 5xx; returns [] on 404 (sub doesn't exist or is
 * private). NSFW + removed posts are filtered out.
 */
export async function fetchSubredditTop(
  subreddit: string,
  opts: {
    limit?: number;
    timeframe?: "hour" | "day" | "week" | "month" | "year" | "all";
    signal?: AbortSignal;
  } = {}
): Promise<RedditPost[]> {
  const sub = subreddit.replace(/^r\//i, "").trim();
  if (!sub) return [];
  const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
  const timeframe = opts.timeframe ?? "week";
  const url = `${REDDIT_BASE}/r/${encodeURIComponent(sub)}/top.json?t=${timeframe}&limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    signal: opts.signal,
  });
  if (res.status === 404) return [];
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Reddit r/${sub}/top.json ${res.status}: ${body.slice(0, 200)}`
    );
  }
  const json = (await res.json()) as RedditListingResponse;
  const children = json.data?.children ?? [];
  const out: RedditPost[] = [];
  for (const c of children) {
    if (c.kind !== "t3") continue;
    const d = c.data;
    if (d.over_18 || d.removed_by_category) continue;
    if (!d.id || !d.title) continue;
    const permalink = d.permalink ? `${REDDIT_BASE}${d.permalink}` : "";
    const isSelf = d.is_self === true;
    const external = d.url_overridden_by_dest ?? d.url ?? "";
    out.push({
      id: d.id,
      subreddit: d.subreddit ?? sub,
      title: d.title,
      url: permalink || external,
      externalUrl: isSelf ? permalink : external,
      score: typeof d.score === "number" ? d.score : 0,
      numComments: typeof d.num_comments === "number" ? d.num_comments : 0,
      createdUtc:
        typeof d.created_utc === "number" ? Math.floor(d.created_utc) : 0,
      author: d.author ?? null,
      isSelfPost: isSelf,
      selftextPreview: ((d.selftext ?? "").trim()).slice(0, 300),
      thumbnail:
        d.thumbnail && /^https?:/.test(d.thumbnail) ? d.thumbnail : null,
    });
  }
  return out;
}

/**
 * Pull top posts across multiple subreddits in parallel and return a
 * single merged list sorted by score DESC. Limit applies to the FINAL
 * merged list, not the per-sub fetch.
 */
export async function fetchTopAcrossSubs(
  subreddits: string[],
  opts: {
    perSubLimit?: number;
    totalLimit?: number;
    timeframe?: "hour" | "day" | "week" | "month" | "year" | "all";
  } = {}
): Promise<RedditPost[]> {
  const perSubLimit = Math.max(1, Math.min(25, opts.perSubLimit ?? 10));
  const totalLimit = Math.max(1, Math.min(200, opts.totalLimit ?? 20));
  const timeframe = opts.timeframe ?? "week";
  const settled = await Promise.allSettled(
    subreddits.map((s) =>
      fetchSubredditTop(s, { limit: perSubLimit, timeframe })
    )
  );
  const merged: RedditPost[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") merged.push(...r.value);
  }
  // Dedup by id (some posts crosspost across subs).
  const seen = new Set<string>();
  const unique: RedditPost[] = [];
  for (const p of merged) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    unique.push(p);
  }
  unique.sort((a, b) => b.score - a.score);
  return unique.slice(0, totalLimit);
}

/**
 * Extract subreddit mentions ("r/space", "/r/astronomy") from free-form
 * channel-description prose. Returns lowercased, deduped names without
 * the "r/" prefix. Falls back to an empty array when none are found —
 * the caller picks a default list in that case.
 */
export function extractSubredditMentions(text: string): string[] {
  if (!text) return [];
  const re = /(?:^|[^A-Za-z0-9_])\/?r\/([A-Za-z0-9_]{2,21})/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].toLowerCase();
    if (!seen.has(name)) seen.add(name);
  }
  return [...seen];
}
