import { NextResponse } from "next/server";
import { getOAuthTokens, revokeLocal } from "@/lib/google-oauth";
import { getSetting } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Disconnect locally. Per-channel: pass `?channelId=...` to revoke just
 * that channel's tokens. Without a channelId we default to the *active*
 * channel — disconnecting in the legacy single-account UI thus only
 * affects the channel the user is looking at, not every channel.
 *
 * Best-effort also tells Google to revoke the refresh token so it
 * doesn't keep counting against the user's authorisations list. If the
 * revoke call fails we still clear local tokens — worst case a stale
 * entry in myaccount.google.com/permissions.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const channelIdParam = url.searchParams.get("channelId");
  // Default to active channel if caller didn't specify one explicitly.
  const channelId =
    channelIdParam ??
    getSetting("youtube.activeChannelId") ??
    getSetting("youtube.channelId") ??
    null;

  const tokens = getOAuthTokens(channelId);
  if (tokens?.refresh_token) {
    try {
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.refresh_token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }
      );
    } catch {
      // ignore — local revoke below is what matters
    }
  }
  revokeLocal(channelId);
  return NextResponse.json({ ok: true, channelId });
}
