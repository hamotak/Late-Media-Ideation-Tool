import { NextResponse } from "next/server";
import {
  addCompetitor,
  getCompetitorByChannelId,
  listCompetitors,
  unreadCompetitorAlertCount,
} from "@/lib/db";
import { CompetitorSyncError, normaliseChannelUrl, syncCompetitor } from "@/lib/competitor-sync";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/competitors — list all tracked competitors plus their video
 * counts and unread alert count (lets the sidebar show a badge).
 */
export async function GET() {
  const competitors = listCompetitors();
  return NextResponse.json({
    competitors,
    unreadAlerts: unreadCompetitorAlertCount(),
  });
}

/**
 * POST /api/competitors — add a new competitor by handle/URL/UC-id and
 * immediately run the first sync so the dashboard isn't empty for the
 * user to look at.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { identifier?: string };
  const identifier = (body.identifier ?? "").trim();
  if (!identifier) {
    return NextResponse.json({ error: "identifier required" }, { status: 400 });
  }

  let normalised: string;
  try {
    normalised = normaliseChannelUrl(identifier);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "invalid identifier" },
      { status: 400 }
    );
  }

  // Detect duplicates eagerly when the input is already a UC id; for
  // @handles we can't dedupe until the first sync resolves the real
  // channel id. Cheap insurance against accidental double-adds.
  const ucMatch = normalised.match(/channel\/(UC[A-Za-z0-9_-]+)/);
  if (ucMatch) {
    const existing = getCompetitorByChannelId(ucMatch[1]);
    if (existing) {
      return NextResponse.json(
        { error: "This competitor is already tracked.", id: existing.id },
        { status: 409 }
      );
    }
  }

  const handleMatch = normalised.match(/@([A-Za-z0-9_.-]+)/);
  const id = addCompetitor({
    handle: handleMatch ? `@${handleMatch[1]}` : normalised,
    channel_id: ucMatch ? ucMatch[1] : null,
  });

  // Kick off the first sync inline so the UI sees populated data on the
  // refresh that follows the POST. If sync blows up we keep the row but
  // surface the error — user can retry from the UI.
  try {
    const result = await syncCompetitor(id);
    return NextResponse.json({ ok: true, id, ...result });
  } catch (err) {
    const message =
      err instanceof CompetitorSyncError || err instanceof Error
        ? err.message
        : "sync failed";
    log.error("competitors", `Initial sync failed for ${id}: ${message}`, err);
    return NextResponse.json(
      { ok: true, id, syncError: message },
      { status: 201 }
    );
  }
}
