import { NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Save / clear / inspect a Netscape-format YouTube cookies file
 * (`cookies.txt` exported from a logged-in browser session). Used by
 * yt-dlp to bypass the "Sign in to confirm you're not a bot" challenge
 * that data-center IPs (Railway etc.) routinely trip.
 *
 * Storage: a single row in `settings` under key `youtube.cookies`. We
 * never log the value — these cookies effectively grant access to a
 * Google account.
 */

function summarize(raw: string | null): {
  hasCookies: boolean;
  lineCount: number;
  estimatedExpiry: number | null;
} {
  if (!raw || !raw.trim()) {
    return { hasCookies: false, lineCount: 0, estimatedExpiry: null };
  }
  const lines = raw.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  // Netscape cookies format: domain \t flag \t path \t secure \t expiry
  // \t name \t value. Pull the soonest expiry across all rows so the UI
  // can hint when the user will need to re-export.
  let earliest: number | null = null;
  for (const l of lines) {
    const cols = l.split("\t");
    if (cols.length < 7) continue;
    const expiry = Number(cols[4]);
    if (!Number.isFinite(expiry) || expiry <= 0) continue;
    if (earliest === null || expiry < earliest) earliest = expiry;
  }
  return {
    hasCookies: true,
    lineCount: lines.length,
    estimatedExpiry: earliest,
  };
}

export async function GET() {
  const raw = getSetting("youtube.cookies");
  return NextResponse.json(summarize(raw));
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { cookies?: string };
  const txt = (body.cookies ?? "").trim();
  if (!txt) {
    setSetting("youtube.cookies", "");
    return NextResponse.json({ ok: true, cleared: true });
  }
  // Light sanity check — the file should start with the Netscape header
  // or at least contain tab-separated cookie rows. We don't strictly
  // require the magic comment in case browsers' export format ever
  // drifts; just ensure there's at least one parseable row.
  const looksValid = txt
    .split(/\r?\n/)
    .some((l) => !l.startsWith("#") && l.split("\t").length >= 7);
  if (!looksValid) {
    return NextResponse.json(
      {
        error:
          "Doesn't look like a Netscape cookies.txt — expected tab-separated rows of (domain, flag, path, secure, expiry, name, value).",
      },
      { status: 400 }
    );
  }
  setSetting("youtube.cookies", txt);
  return NextResponse.json({ ok: true, ...summarize(txt) });
}

export async function DELETE() {
  setSetting("youtube.cookies", "");
  return NextResponse.json({ ok: true });
}
