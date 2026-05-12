import "server-only";
import { db } from "./db";

/**
 * Safe read-only SQL executor for Claude.
 * - Only SELECT statements
 * - Only whitelisted tables
 * - Caps rows returned
 * - Runs on a read-only connection pragma
 */

const ALLOWED_TABLES = new Set([
  "videos",
  "channels",
  "transcripts",
  "comments",
  "chat_sessions",
  "chat_messages",
]);

// Columns Claude is allowed to read. Keeps it schema-aware.
export const SQL_SCHEMA = `
TABLES (SQLite):

videos (
  id TEXT PRIMARY KEY,
  channel_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  published_at INTEGER,           -- unix seconds
  duration_seconds INTEGER,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  thumbnail_url TEXT,
  tags TEXT,                      -- JSON array as text
  imported_at INTEGER
)

channels (
  id TEXT PRIMARY KEY,
  title TEXT,
  handle TEXT,
  description TEXT,
  subscriber_count INTEGER,
  view_count INTEGER,
  video_count INTEGER,
  imported_at INTEGER
)

transcripts (
  video_id TEXT PRIMARY KEY,       -- FK to videos.id
  language TEXT,
  text TEXT NOT NULL,
  fetched_at INTEGER
)

comments (
  id TEXT PRIMARY KEY,             -- YouTube comment ID
  video_id TEXT NOT NULL,          -- FK to videos.id
  parent_id TEXT,                  -- NULL for top-level, else parent comment id
  author TEXT,
  author_channel_id TEXT,
  text TEXT NOT NULL,
  like_count INTEGER,
  reply_count INTEGER,
  published_at INTEGER,
  updated_at INTEGER,
  fetched_at INTEGER
)

Useful idioms:
- datetime(published_at, 'unixepoch')
- strftime('%Y-%m', datetime(published_at, 'unixepoch')) for month bucketing
- AVG/MAX/MIN/COUNT for aggregates
- json_each(tags) for tag-level analysis
`.trim();

const FORBIDDEN = [
  /\bPRAGMA\b/i,
  /\bATTACH\b/i,
  /\bDETACH\b/i,
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bDROP\b/i,
  /\bALTER\b/i,
  /\bCREATE\b/i,
  /\bREPLACE\b/i,
  /\bREINDEX\b/i,
  /\bVACUUM\b/i,
  /--/,
  /\/\*/,
  /;.+/, // no multiple statements
];

export function runSelect(
  query: string,
  maxRows = 200
): { columns: string[]; rows: unknown[][] } {
  const q = query.trim();
  if (!/^\s*(WITH|SELECT)\b/i.test(q)) {
    throw new Error("Only SELECT / WITH statements allowed.");
  }
  for (const rx of FORBIDDEN) {
    if (rx.test(q)) throw new Error(`Disallowed token in SQL: ${rx}`);
  }

  // Very lightweight referenced-table check: all FROM/JOIN identifiers must be whitelisted.
  const referenced = Array.from(
    q.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)
  ).map((m) => m[1].toLowerCase());
  for (const t of referenced) {
    if (!ALLOWED_TABLES.has(t)) {
      throw new Error(`Table not allowed: ${t}`);
    }
  }

  // Enforce row cap by wrapping if no LIMIT present.
  const withLimit = /\bLIMIT\s+\d+/i.test(q)
    ? q
    : `SELECT * FROM (${q.replace(/;+\s*$/, "")}) LIMIT ${maxRows}`;

  const stmt = db.prepare(withLimit);
  stmt.raw(true);
  const rows = stmt.all() as unknown[][];
  const columns = stmt.columns().map((c) => c.name);
  return { columns, rows: rows.slice(0, maxRows) };
}
