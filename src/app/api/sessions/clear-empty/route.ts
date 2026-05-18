import { NextResponse } from "next/server";
import { clearEmptyChatSessions, getActiveChannelId } from "@/lib/db";

export const runtime = "nodejs";

/**
 * POST /api/sessions/clear-empty
 *
 * Deletes every chat session with zero user-role messages. Optional
 * `channelId` body param scopes the sweep; default is the active channel
 * so the user only nukes the chats they actually see in the sidebar. Pass
 * `"all"` to sweep across every channel.
 *
 * Returns { removed: number } — the count of sessions deleted.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    channelId?: unknown;
  };
  let scope: string | null;
  if (body.channelId === "all") {
    scope = null;
  } else if (typeof body.channelId === "string" && body.channelId.length > 0) {
    scope = body.channelId;
  } else {
    scope = getActiveChannelId() ?? null;
  }
  const removed = clearEmptyChatSessions(scope);
  return NextResponse.json({ removed, scope });
}
