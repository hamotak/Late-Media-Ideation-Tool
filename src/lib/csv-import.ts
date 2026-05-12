import { parse } from "csv-parse/sync";
import { upsertChannel, upsertVideo } from "./db";
import { randomUUID } from "node:crypto";

type Row = Record<string, string>;

const COLUMN_ALIASES: Record<string, string[]> = {
  videoId: ["video id", "content", "video", "url"],
  title: ["video title", "title", "content title"],
  publishedAt: [
    "video publish time",
    "publish time",
    "publish date",
    "upload date",
    "published",
  ],
  views: ["views", "view count"],
  likes: ["likes", "like count"],
  comments: ["comments", "comments added", "comment count"],
  duration: ["duration", "length", "video length"],
  impressions: ["impressions"],
  ctr: ["impressions click-through rate (%)", "impressions ctr (%)", "ctr (%)"],
  watchTimeHours: ["watch time (hours)"],
  avgViewDuration: ["average view duration"],
  subscribers: ["subscribers"],
};

function normalize(s: string) {
  return s.trim().toLowerCase();
}

function pick(row: Row, key: keyof typeof COLUMN_ALIASES): string | undefined {
  const aliases = COLUMN_ALIASES[key];
  for (const [k, v] of Object.entries(row)) {
    if (aliases.includes(normalize(k))) return v;
  }
  return undefined;
}

function parseInt0(v: string | undefined): number {
  if (!v) return 0;
  const cleaned = v.replace(/[^\d.-]/g, "");
  if (!cleaned) return 0;
  const n = Math.round(Number(cleaned));
  return Number.isFinite(n) ? n : 0;
}

function parseDate(v: string | undefined): number | null {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000);
}

function extractVideoId(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const ytMatch = s.match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) return ytMatch[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  return null;
}

function parseDurationToSeconds(v: string | undefined): number | null {
  if (!v) return null;
  const s = v.trim();
  if (!s) return null;
  const parts = s.split(":").map((p) => parseInt(p, 10));
  if (parts.some((n) => isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

export type ImportResult = {
  videosImported: number;
  channelUpdated: boolean;
  skipped: number;
  warnings: string[];
};

export function importYTStudioCSV(buf: Buffer, filenameHint?: string): ImportResult {
  const warnings: string[] = [];
  let csvText = buf.toString("utf8");
  // strip BOM
  if (csvText.charCodeAt(0) === 0xfeff) csvText = csvText.slice(1);

  const records = parse(csvText, {
    columns: (header: string[]) => header.map((h) => h.trim()),
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Row[];

  if (!records.length) {
    warnings.push("Empty CSV.");
    return { videosImported: 0, channelUpdated: false, skipped: 0, warnings };
  }

  // Drop the "Total" summary row that YT Studio usually places as row #1.
  const cleaned = records.filter((r) => {
    const firstVal = Object.values(r)[0]?.toString().trim().toLowerCase();
    return firstVal !== "total";
  });

  let videosImported = 0;
  let skipped = 0;

  for (const row of cleaned) {
    const rawId = pick(row, "videoId");
    const title = pick(row, "title") ?? "";
    const videoId = extractVideoId(rawId) ?? (title ? `local-${randomUUID().slice(0, 8)}` : null);

    if (!videoId || !title) {
      skipped++;
      continue;
    }

    upsertVideo({
      id: videoId,
      title,
      published_at: parseDate(pick(row, "publishedAt")),
      duration_seconds: parseDurationToSeconds(pick(row, "duration")),
      views: parseInt0(pick(row, "views")),
      likes: parseInt0(pick(row, "likes")),
      comments: parseInt0(pick(row, "comments")),
    });
    videosImported++;
  }

  // Try to update channel aggregate from summary row if present
  const summary = records.find((r) => {
    const firstVal = Object.values(r)[0]?.toString().trim().toLowerCase();
    return firstVal === "total";
  });

  let channelUpdated = false;
  if (summary) {
    const channelId = "default";
    upsertChannel({
      id: channelId,
      view_count: parseInt0(pick(summary, "views")) || undefined,
      video_count: videosImported,
      subscriber_count: parseInt0(pick(summary, "subscribers")) || undefined,
      title: filenameHint ? filenameHint.replace(/\.csv$/i, "") : null,
    });
    channelUpdated = true;
  } else if (videosImported > 0) {
    // create minimal channel row so stats aggregation works
    upsertChannel({
      id: "default",
      video_count: videosImported,
      title: filenameHint ? filenameHint.replace(/\.csv$/i, "") : null,
    });
    channelUpdated = true;
  }

  return { videosImported, channelUpdated, skipped, warnings };
}
