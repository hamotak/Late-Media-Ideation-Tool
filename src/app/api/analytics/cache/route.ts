import { NextResponse } from "next/server";
import { invalidateCache } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Wipes every `analytics.*` row from the api_cache table so the next
 * fetch of any analytics endpoint goes straight to YouTube. Triggered
 * by the dashboard "Refresh" button when the user wants to force-fresh
 * data (e.g. after switching channels and noticing stale numbers).
 *
 * No payload — just the count of busted rows in the response so the UI
 * can show a tiny "refreshed N entries" hint if it wants.
 */
export async function POST() {
  const removed = invalidateCache("analytics.");
  return NextResponse.json({ ok: true, removed });
}
