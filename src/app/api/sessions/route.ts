import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  createSession,
  getActiveChannelId,
  listSessions,
} from "@/lib/db";

/**
 * GET /api/sessions
 *   ?channelId=ID        → only sessions for that channel
 *   ?channelId=untagged  → only sessions with NULL channel_id (legacy rows)
 *   no param             → all sessions (default for back-compat)
 *
 * POST /api/sessions
 *   Body: { title?: string, channelId?: string }
 *   channelId defaults to the server-side active channel — new chats bind
 *   to whichever channel the user is on at create time. Explicit null is
 *   honored if the client really wants an untagged chat.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const channelParam = url.searchParams.get("channelId");
  let scope: string | "untagged" | undefined;
  if (channelParam === "untagged") scope = "untagged";
  else if (typeof channelParam === "string" && channelParam.length > 0)
    scope = channelParam;
  return NextResponse.json({ sessions: listSessions(scope) });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    channelId?: string | null;
  };
  const id = randomUUID();
  const explicitChannel =
    typeof body.channelId === "string" && body.channelId.length > 0
      ? body.channelId
      : body.channelId === null
        ? null
        : undefined;
  const channelId =
    explicitChannel === undefined
      ? (getActiveChannelId() ?? null)
      : explicitChannel;
  createSession(id, body.title?.trim() || null, channelId);
  return NextResponse.json({ id, channelId });
}
