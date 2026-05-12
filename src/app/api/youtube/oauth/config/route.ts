import { NextResponse } from "next/server";
import {
  clearOAuthConfig,
  getOAuthConfig,
  setOAuthConfig,
} from "@/lib/google-oauth";

export const runtime = "nodejs";

export async function GET() {
  const cfg = getOAuthConfig();
  return NextResponse.json({
    configured: !!cfg,
    // Only surface a masked preview of the client_id so the UI can hint at
    // "already configured" without leaking the full credentials.
    clientIdPreview: cfg?.clientId
      ? `${cfg.clientId.slice(0, 12)}…${cfg.clientId.slice(-6)}`
      : null,
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    clientId?: string;
    clientSecret?: string;
  };
  const clientId = body.clientId?.trim();
  const clientSecret = body.clientSecret?.trim();
  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: "clientId and clientSecret are required" },
      { status: 400 }
    );
  }
  // Light sanity check — Google OAuth client IDs end with ".apps.googleusercontent.com".
  if (!clientId.endsWith(".apps.googleusercontent.com")) {
    return NextResponse.json(
      {
        error:
          "clientId does not look like a Google OAuth client ID (should end with .apps.googleusercontent.com)",
      },
      { status: 400 }
    );
  }
  setOAuthConfig({ clientId, clientSecret });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  clearOAuthConfig();
  return NextResponse.json({ ok: true });
}
