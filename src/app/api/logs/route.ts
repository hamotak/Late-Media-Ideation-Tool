import { NextResponse } from "next/server";
import { clearLogs, listLogs, logStats, type LogLevel } from "@/lib/db";

export const runtime = "nodejs";

const LEVELS: readonly (LogLevel | "all")[] = ["all", "debug", "info", "warn", "error"];

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const levelRaw = url.searchParams.get("level") ?? "all";
    const level = (LEVELS.includes(levelRaw as LogLevel | "all")
      ? (levelRaw as LogLevel | "all")
      : "all");
    const source = url.searchParams.get("source") ?? undefined;
    const search = url.searchParams.get("q") ?? undefined;
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);

    const rows = listLogs({ level, source: source ?? undefined, search, limit, offset });
    const stats = logStats();

    return NextResponse.json({
      logs: rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        level: r.level,
        source: r.source,
        message: r.message,
        context: r.context ? safeParse(r.context) : null,
        stack: r.stack,
      })),
      stats,
    });
  } catch (err) {
    // Any DB error (missing table on an old handle, bad SQL, whatever) must
    // still resolve to JSON — otherwise the client fetch blows up with
    // "Unexpected end of JSON input" and the real error is invisible.
    const message = err instanceof Error ? err.message : "Unknown error";
    // eslint-disable-next-line no-console
    console.error("[GET /api/logs] failed:", err);
    return NextResponse.json(
      {
        error: message,
        logs: [],
        stats: { total: 0, byLevel: { debug: 0, info: 0, warn: 0, error: 0 }, sources: [], last24hErrors: 0 },
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/logs
 *   ?level=error           — wipe just that level
 *   ?olderThanDays=7       — trim everything older than N days
 *   no params              — wipe everything
 */
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const levelParam = url.searchParams.get("level") as LogLevel | null;
  const days = Number(url.searchParams.get("olderThanDays")) || 0;
  const deleted = clearLogs({
    level: levelParam && LEVELS.includes(levelParam) && levelParam !== ("all" as LogLevel) ? levelParam : undefined,
    olderThanSec: days > 0 ? days * 24 * 3600 : undefined,
  });
  return NextResponse.json({ ok: true, deleted });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
