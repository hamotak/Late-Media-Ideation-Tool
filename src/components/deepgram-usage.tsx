"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

type UsageData = {
  totalCostCents: number;
  totalSeconds: number;
  transcriptCount: number;
  lastUsageAt: number | null;
  last10: {
    id: number;
    video_id: string;
    duration_seconds: number;
    cost_cents: number;
    model: string;
    transcribed_at: number;
  }[];
  limitCents: number;
  remainingCents: number;
  percentUsed: number;
};

/**
 * Transparent cost tracker for Deepgram. Shows "$X used of $Y credit" +
 * a progress bar + the last 10 transcriptions. Only rendered when the
 * Deepgram key is configured (parent handles that gate).
 */
export function DeepgramUsage({ enabled }: { enabled: boolean }) {
  const { t } = useI18n();
  const [data, setData] = useState<UsageData | null>(null);
  const [editingLimit, setEditingLimit] = useState(false);
  const [limitInput, setLimitInput] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/deepgram/usage");
      if (!res.ok) return;
      const d = (await res.json()) as UsageData;
      setData(d);
      setLimitInput(((d.limitCents ?? 0) / 100).toString());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (enabled) load();
  }, [enabled, load]);

  const saveLimit = async () => {
    const n = Number(limitInput);
    if (!Number.isFinite(n) || n < 0) return;
    setSaving(true);
    try {
      await fetch("/api/deepgram/usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limitUsd: n }),
      });
      setEditingLimit(false);
      load();
    } finally {
      setSaving(false);
    }
  };

  if (!enabled || !data) return null;

  const usedUsd = (data.totalCostCents / 100).toFixed(2);
  const limitUsd = (data.limitCents / 100).toFixed(2);
  const remainingUsd = (data.remainingCents / 100).toFixed(2);
  const hoursLeft =
    // Nova-3 is $0.0043/min = $0.258/hour.
    // Ceil so we don't over-promise remaining capacity.
    Math.max(0, Math.floor(data.remainingCents / 100 / 0.258));

  return (
    <div className="mt-4 space-y-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{t.deepgram.usageTitle}</span>
        <span className="text-xs text-muted-foreground">
          {t.deepgram.transcriptsCount.replace("{n}", String(data.transcriptCount))}
        </span>
      </div>

      {/* Progress bar */}
      <div>
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">
            ${usedUsd} <span className="text-xs text-muted-foreground">{t.deepgram.of}</span> ${limitUsd}
          </span>
          <span className="text-xs text-muted-foreground">
            {data.percentUsed.toFixed(1)}%
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full transition-all",
              data.percentUsed > 80
                ? "bg-destructive"
                : data.percentUsed > 50
                  ? "bg-amber-500"
                  : "bg-primary"
            )}
            style={{ width: `${Math.min(100, data.percentUsed)}%` }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>{t.deepgram.remainingHint.replace("{amount}", `$${remainingUsd}`).replace("{hours}", String(hoursLeft))}</span>
        </div>
      </div>

      {/* Limit editor */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t.deepgram.creditLimitLabel}:</span>
        {editingLimit ? (
          <>
            <div className="relative w-24">
              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                $
              </span>
              <Input
                type="number"
                min="0"
                step="10"
                value={limitInput}
                onChange={(e) => setLimitInput(e.target.value)}
                className="h-7 pl-5 text-xs"
              />
            </div>
            <Button size="sm" variant="outline" onClick={saveLimit} disabled={saving} className="h-7">
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            </Button>
          </>
        ) : (
          <button
            onClick={() => setEditingLimit(true)}
            className="inline-flex items-center gap-1 font-medium hover:text-foreground text-muted-foreground"
          >
            ${limitUsd}
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Last 10 */}
      {data.last10.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            {t.deepgram.recentTitle} ({data.last10.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {data.last10.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground"
              >
                <span className="truncate">{row.video_id}</span>
                <span>{formatDuration(row.duration_seconds)}</span>
                <span>${(row.cost_cents / 100).toFixed(2)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
