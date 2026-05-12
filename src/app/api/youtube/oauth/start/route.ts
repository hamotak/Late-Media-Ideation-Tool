import { NextResponse } from "next/server";
import {
  buildAuthUrl,
  getOAuthConfig,
  setPendingChannelId,
} from "@/lib/google-oauth";

export const runtime = "nodejs";

/**
 * Resolve the public base URL the browser sees us at. `new URL(req.url).origin`
 * lies behind a reverse proxy (Railway internally routes via localhost:8080),
 * which would build a redirect_uri that doesn't match the one we registered
 * in Google Cloud Console — and OAuth fails with redirect_uri_mismatch.
 *
 * Resolution order, most authoritative first:
 *   1. `PUBLIC_BASE_URL` env var — set this on Railway to bulletproof things.
 *   2. `X-Forwarded-Proto` + `X-Forwarded-Host` (or `Forwarded`) — what the
 *      browser hit, propagated by every modern reverse proxy.
 *   3. Plain `Host` header.
 *   4. `req.url` origin — only useful in local dev where there's no proxy.
 */
function resolveOrigin(req: Request): string {
  // 1. Explicit override via env var, e.g.
  //    PUBLIC_BASE_URL=https://yt-channel-ai.up.railway.app
  const envBase = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (envBase) return envBase;

  // 2. Forwarded headers — Railway sets `x-forwarded-proto` + `x-forwarded-host`.
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ||
    "https";
  const fwdHost =
    req.headers.get("x-forwarded-host")?.split(",")[0].trim() ||
    req.headers.get("host");
  if (fwdHost) return `${proto}://${fwdHost}`;

  // 3 & 4 — last-ditch fallback. Local dev path.
  return new URL(req.url).origin;
}

export async function GET(req: Request) {
  const cfg = getOAuthConfig();
  if (!cfg) {
    return NextResponse.json(
      { error: "Save your OAuth client ID and secret first." },
      { status: 400 }
    );
  }
  // Per-channel handshake: the binder UI passes ?channelId=<UCxxx> when
  // the user clicked "Connect" on a specific channel row. We stash it
  // until the callback comes back so we know which slot to write tokens
  // into. No channelId → legacy single-account flow that writes to the
  // global slot.
  const reqUrl = new URL(req.url);
  const pendingChannelId = reqUrl.searchParams.get("channelId");
  setPendingChannelId(pendingChannelId);

  const origin = resolveOrigin(req);
  try {
    const authUrl = buildAuthUrl(origin);
    return NextResponse.redirect(authUrl, { status: 302 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to build auth URL" },
      { status: 500 }
    );
  }
}
