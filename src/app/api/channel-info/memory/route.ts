import { NextResponse } from "next/server";
import {
  deleteChannelMemory,
  getActiveChannelId,
  listChannelMemory,
  upsertChannelMemory,
} from "@/lib/db";

export const runtime = "nodejs";

/**
 * /api/channel-info/memory — CRUD for the per-channel agent memory.
 *
 * GET    ?channelId=ID        → list rows for that channel (defaults to active).
 * POST   { channelId?, key, value, source?, confidence? }  → upsert one row.
 * DELETE { channelId?, key }                                → delete one row.
 *
 * channelId is optional on every verb; falls back to getActiveChannelId().
 * Validation: key and value are required strings; both capped at 2000 chars
 * after trim — same envelope as update_channel_context for consistency.
 */
function resolveChannel(explicit?: unknown): string | null {
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim();
  }
  return getActiveChannelId() ?? null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const channelId = resolveChannel(url.searchParams.get("channelId"));
  if (!channelId) {
    return NextResponse.json(
      { error: "No active channel; pass channelId in the query." },
      { status: 400 }
    );
  }
  return NextResponse.json({
    channelId,
    memory: listChannelMemory(channelId),
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    channelId?: unknown;
    key?: unknown;
    value?: unknown;
    source?: unknown;
    confidence?: unknown;
  };
  const channelId = resolveChannel(body.channelId);
  if (!channelId) {
    return NextResponse.json(
      { error: "No active channel; pass channelId in the body." },
      { status: 400 }
    );
  }
  const key =
    typeof body.key === "string" ? body.key.trim() : "";
  const value =
    typeof body.value === "string" ? body.value.trim() : "";
  if (!key) {
    return NextResponse.json({ error: "key required" }, { status: 400 });
  }
  if (key.length > 2000) {
    return NextResponse.json(
      { error: "key exceeds 2000 chars" },
      { status: 400 }
    );
  }
  if (!value) {
    return NextResponse.json({ error: "value required" }, { status: 400 });
  }
  if (value.length > 2000) {
    return NextResponse.json(
      { error: "value exceeds 2000 chars" },
      { status: 400 }
    );
  }
  const source =
    typeof body.source === "string" && body.source.trim().length > 0
      ? body.source.trim().slice(0, 200)
      : "ui:channel-info";
  const confidence =
    typeof body.confidence === "number" && Number.isFinite(body.confidence)
      ? body.confidence
      : undefined;
  const row = upsertChannelMemory({
    channelId,
    key,
    value,
    source,
    confidence,
  });
  return NextResponse.json({ ok: true, memory: row });
}

export async function DELETE(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    channelId?: unknown;
    key?: unknown;
  };
  const channelId = resolveChannel(body.channelId);
  if (!channelId) {
    return NextResponse.json(
      { error: "No active channel; pass channelId in the body." },
      { status: 400 }
    );
  }
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!key) {
    return NextResponse.json({ error: "key required" }, { status: 400 });
  }
  const removed = deleteChannelMemory(channelId, key);
  return NextResponse.json({ ok: true, removed });
}
