import "server-only";

/**
 * Exa API — semantic web search.
 * Docs: https://docs.exa.ai/
 */

export type ExaResult = {
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  text?: string;
  score?: number;
};

export async function exaSearch(
  query: string,
  apiKey: string,
  opts: { numResults?: number; includeText?: boolean } = {}
): Promise<ExaResult[]> {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      query,
      numResults: opts.numResults ?? 8,
      useAutoprompt: true,
      contents: opts.includeText ? { text: { maxCharacters: 2000 } } : undefined,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Exa search failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { results?: ExaResult[] };
  return data.results ?? [];
}

export async function exaGetContents(
  urls: string[],
  apiKey: string
): Promise<{ url: string; title: string; text: string }[]> {
  if (!urls.length) return [];
  const res = await fetch("https://api.exa.ai/contents", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      urls,
      text: { maxCharacters: 3000 },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Exa contents failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as {
    results?: { url: string; title?: string; text?: string }[];
  };
  return (data.results ?? []).map((r) => ({
    url: r.url,
    title: r.title ?? "",
    text: r.text ?? "",
  }));
}
