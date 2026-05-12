import { NextResponse } from "next/server";
import { runAlertPoll } from "@/lib/alerts";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
// Polling can take ~10-30s for ~10 videos; give it room.
export const maxDuration = 60;
// Force runtime evaluation only — never tries to be statically analysed
// during `next build`. Without this, Next 16's "collect page data"
// phase imports this route module and triggers SQLite init in parallel
// across build workers, which can race on the file's write lock.
export const dynamic = "force-dynamic";

/**
 * Triggered by an external cron service (cron-job.org, EasyCron, Railway
 * cron, etc.) every ~15 minutes. Walks monitored videos, takes a fresh
 * view-count snapshot, fires Telegram alerts on velocity spikes.
 *
 * This endpoint is *exempt* from Basic Auth (see `src/proxy.ts`) so
 * external cron services can hit it without juggling Authorization
 * headers. Auth is enforced here via the `ALERTS_CRON_SECRET` env var
 * — the cron URL must include `?secret=<that-value>`. If the env var
 * isn't set, we refuse the request entirely rather than running a
 * publicly-callable poll.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const expected = process.env.ALERTS_CRON_SECRET;
  if (!expected) {
    // Fail closed — alerts polling is the only Basic-Auth-exempt route
    // besides /api/health, and that exemption is only safe with a
    // configured secret. Without it the endpoint would be open to the
    // public internet, which would let anyone trigger our YouTube /
    // Telegram fan-out at will.
    return NextResponse.json(
      {
        error:
          "ALERTS_CRON_SECRET env var is not configured on the server. Set it (and pass ?secret=... in the cron URL) to enable polling.",
      },
      { status: 503 }
    );
  }
  const got = url.searchParams.get("secret");
  if (got !== expected) {
    return NextResponse.json({ error: "Invalid cron secret" }, { status: 403 });
  }

  const result = await runAlertPoll();
  log.info("alerts", "Alert poll completed", {
    monitoredCount: result.monitoredCount,
    snapshotsRecorded: result.snapshotsRecorded,
    alertsFired: result.alertsFired,
    errors: result.errors,
  });
  return NextResponse.json(result);
}

// Allow POST too — some cron services prefer POST.
export const POST = GET;
