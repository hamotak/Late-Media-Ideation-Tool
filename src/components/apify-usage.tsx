"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Zap, ExternalLink } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Snapshot = {
  planName: string;
  monthlyAllowanceUsd: number | null;
  monthlyUsedUsd: number | null;
  remainingUsd: number | null;
  percentageUsed: number | null;
  estimatedScrapesRemaining: number | null;
  cycleEndAt: string | null;
};

/**
 * Live progress bar for the Apify monthly credit. Polls /usage on
 * mount + on manual refresh. Free plan ships $5/month, paid plans
 * scale; we render the same shape either way against
 * `monthlyAllowanceUsd` so the bar always means "credit consumed
 * this billing cycle".
 *
 * Three colour buckets: green <60%, amber 60-85%, red >85%. The
 * accent on the bar is the same red/amber YouTube studio uses for
 * its own quota indicators — vibrates the same "running out"
 * intuition without us having to teach the user a new code.
 */
export function ApifyUsage({ enabled }: { enabled: boolean }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErrored(false);
    try {
      const r = await fetch("/api/integrations/apify/usage", {
        cache: "no-store",
      });
      const d = (await r.json()) as {
        configured?: boolean;
        usage?: Snapshot | null;
      };
      if (!d.configured || !d.usage) {
        setErrored(true);
        setSnap(null);
        return;
      }
      setSnap(d.usage);
    } catch {
      setErrored(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) load();
  }, [enabled, load]);

  if (!enabled) return null;

  if (loading && !snap) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading Apify usage…
        </CardContent>
      </Card>
    );
  }

  if (errored || !snap) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-2 p-3 text-xs">
          <span className="text-muted-foreground">
            Connected to Apify — couldn&apos;t pull usage stats. Try again later.
          </span>
          <button
            onClick={load}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Retry"
            title="Retry"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </CardContent>
      </Card>
    );
  }

  const pct = snap.percentageUsed ?? 0;
  const barColor =
    pct >= 85
      ? "bg-destructive"
      : pct >= 60
        ? "bg-amber-500"
        : "bg-emerald-500";
  const dollar = (n: number | null) =>
    n === null ? "—" : `$${n.toFixed(2)}`;

  return (
    <Card>
      <CardContent className="space-y-3 p-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 font-medium">
            <Zap className="h-3.5 w-3.5 text-primary" />
            Apify {snap.planName} —{" "}
            <span className="text-muted-foreground">monthly credit</span>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            aria-label="Refresh"
            title="Refresh"
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
          </button>
        </div>

        {/* Bar */}
        <div className="space-y-1">
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full transition-all", barColor)}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>
              <strong className="text-foreground">{dollar(snap.monthlyUsedUsd)}</strong>{" "}
              of {dollar(snap.monthlyAllowanceUsd)} used
              {pct > 0 && (
                <span className="ml-1">
                  ({pct}%)
                </span>
              )}
            </span>
            <span>
              {snap.estimatedScrapesRemaining !== null && (
                <>
                  <strong className="text-foreground">
                    ~{snap.estimatedScrapesRemaining}
                  </strong>{" "}
                  competitor scrapes left
                </>
              )}
            </span>
          </div>
        </div>

        <div className="border-t border-border pt-2 text-[10px] text-muted-foreground">
          Used for competitor channel scraping (≈$0.05 per channel-sync).
          Transcription itself runs through Deepgram, not Apify.
          {snap.cycleEndAt && (
            <>
              {" "}Resets{" "}
              {new Date(snap.cycleEndAt).toLocaleDateString("en-US", {
                day: "2-digit",
                month: "short",
              })}
              .
            </>
          )}{" "}
          <a
            href="https://console.apify.com/billing"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-primary hover:underline"
          >
            Manage plan
            <ExternalLink className="h-2.5 w-2.5" />
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
