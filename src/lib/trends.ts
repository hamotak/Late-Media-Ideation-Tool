import "server-only";

/**
 * Lightweight Google Trends client — uses the public trends.google.com endpoints
 * (same ones the unofficial npm packages wrap). No auth required.
 *
 * Two useful endpoints:
 *  - explore:   get widget tokens
 *  - interest over time (multiline): for each widget
 *  - related queries: "rising" and "top" related
 */

const BASE = "https://trends.google.com/trends/api";

async function gfetch(path: string, params: Record<string, string>): Promise<string> {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120",
      Accept: "application/json,text/plain,*/*",
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Trends ${path} ${res.status}`);
  // Google prepends `)]}',` to JSON responses — strip it.
  const text = await res.text();
  return text.replace(/^\)\]\}',?\s*/, "");
}

type WidgetToken = { id: string; token: string; request: unknown };

async function getWidgets(
  keywords: string[],
  geo: string,
  timeframe: string
): Promise<WidgetToken[]> {
  const req = {
    comparisonItem: keywords.map((k) => ({ keyword: k, geo, time: timeframe })),
    category: 0,
    property: "",
  };
  const raw = await gfetch("explore", {
    hl: "en-US",
    tz: "-120",
    req: JSON.stringify(req),
  });
  const parsed = JSON.parse(raw) as { widgets: WidgetToken[] };
  return parsed.widgets;
}

export type InterestPoint = { date: string; values: number[] };

export async function interestOverTime(
  keywords: string[],
  opts: { geo?: string; timeframe?: string } = {}
): Promise<{ keywords: string[]; points: InterestPoint[] }> {
  const geo = opts.geo ?? "";
  const timeframe = opts.timeframe ?? "today 12-m";
  const widgets = await getWidgets(keywords, geo, timeframe);
  const tl = widgets.find((w) => w.id === "TIMESERIES");
  if (!tl) throw new Error("No TIMESERIES widget returned");
  const raw = await gfetch("widgetdata/multiline", {
    hl: "en-US",
    tz: "-120",
    req: JSON.stringify(tl.request),
    token: tl.token,
  });
  const parsed = JSON.parse(raw) as {
    default: { timelineData: { formattedTime: string; value: number[] }[] };
  };
  return {
    keywords,
    points: parsed.default.timelineData.map((d) => ({
      date: d.formattedTime,
      values: d.value,
    })),
  };
}

export type RelatedQuery = { query: string; value: number | string };

export async function relatedQueries(
  keyword: string,
  opts: { geo?: string; timeframe?: string } = {}
): Promise<{ top: RelatedQuery[]; rising: RelatedQuery[] }> {
  const geo = opts.geo ?? "";
  const timeframe = opts.timeframe ?? "today 12-m";
  const widgets = await getWidgets([keyword], geo, timeframe);
  const rq = widgets.find((w) => w.id === "RELATED_QUERIES");
  if (!rq) return { top: [], rising: [] };
  const raw = await gfetch("widgetdata/relatedsearches", {
    hl: "en-US",
    tz: "-120",
    req: JSON.stringify(rq.request),
    token: rq.token,
  });
  const parsed = JSON.parse(raw) as {
    default: {
      rankedList: { rankedKeyword: { query: string; value: number }[] }[];
    };
  };
  const [top, rising] = parsed.default.rankedList ?? [];
  return {
    top: (top?.rankedKeyword ?? []).map((k) => ({ query: k.query, value: k.value })),
    rising: (rising?.rankedKeyword ?? []).map((k) => ({ query: k.query, value: k.value })),
  };
}
