"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Flame,
  Loader2,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/* ---------------- Types + constants (page-local, mirror server shapes) ---------------- */

const TIERS = ["authority", "breakthrough", "adjacent", "far"] as const;
type Tier = (typeof TIERS)[number];

const TIER_LABEL: Record<Tier, string> = {
  authority: "Authority",
  breakthrough: "Breakthrough",
  adjacent: "Adjacent",
  far: "Far",
};
const TIER_PILL: Record<Tier, string> = {
  authority:
    "bg-sky-500/15 text-sky-700 dark:text-sky-400 border border-sky-500/30",
  breakthrough:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30",
  adjacent:
    "bg-orange-500/15 text-orange-700 dark:text-orange-400 border border-orange-500/30",
  far: "bg-muted text-muted-foreground border border-border",
};

const WINDOW_PILLS = [7, 30, 90] as const;
type WindowDays = (typeof WINDOW_PILLS)[number];

const MULTIPLIER_PILLS = [2, 3, 5, 10] as const;
type Multiplier = (typeof MULTIPLIER_PILLS)[number];

type Outlier = {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  views: number;
  publishedAt: number | null;
  durationSeconds: number | null;
  competitorId: number;
  competitorTitle: string | null;
  competitorHandle: string | null;
  competitorAvatar: string | null;
  tier: Tier;
  multiplier: number;
  channelMedian: number;
};

type OutliersResponse = {
  outliers: Outlier[];
  totalScanned: number;
  competitorsCovered: number;
};

type Explanation = {
  levers: string[];
  explanation: string;
  cached?: boolean;
};

type Idea = {
  topic: string;
  suggestedTitle: string;
  angle: string;
  confidence: number;
  sourceOutlierVideoId: string;
};

const VIEW_MODE_KEY = "dashboard.viewMode";

/* ---------------- Formatters ---------------- */

function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function fmtRelative(ts: number | null): string {
  if (!ts) return "—";
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / (86400 * 7))}w ago`;
  return `${Math.floor(diff / (86400 * 30))}mo ago`;
}

function fmtDuration(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ---------------- Page ---------------- */

export default function OutliersPage() {
  const [scope, setScope] = useState<string | "all" | null>(null);
  const [windowDays, setWindowDays] = useState<WindowDays>(30);
  const [minMultiplier, setMinMultiplier] = useState<Multiplier>(3);
  const [tierFilters, setTierFilters] = useState<Set<Tier>>(new Set(TIERS));
  const [data, setData] = useState<OutliersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [openOutlier, setOpenOutlier] = useState<Outlier | null>(null);
  const [ideasOpen, setIdeasOpen] = useState(false);

  // Resolve scope from localStorage viewMode + the active-channel
  // pointer. viewMode === "all" → null (scan everywhere); otherwise
  // use the active channel id.
  useEffect(() => {
    let cancelled = false;
    const viewMode = (typeof window !== "undefined"
      ? window.localStorage.getItem(VIEW_MODE_KEY)
      : null) as "all" | "channel" | null;
    if (viewMode === "all") {
      setScope("all");
      return;
    }
    fetch("/api/channels/active", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { activeId: string | null }) => {
        if (cancelled) return;
        setScope(d.activeId ?? "all");
      })
      .catch(() => {
        if (cancelled) return;
        setScope("all");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    if (scope === null) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        userChannelId: scope,
        window: String(windowDays),
        minMultiplier: String(minMultiplier),
        tiers: [...tierFilters].join(","),
      });
      const r = await fetch(`/api/outliers?${params.toString()}`, {
        cache: "no-store",
      });
      const d = (await r.json().catch(() => ({}))) as
        | OutliersResponse
        | { error?: string };
      if (!r.ok || !("outliers" in d)) {
        setError(("error" in d && d.error) || `HTTP ${r.status}`);
        setData({ outliers: [], totalScanned: 0, competitorsCovered: 0 });
        return;
      }
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load outliers.");
    } finally {
      setLoading(false);
    }
  }, [scope, windowDays, minMultiplier, tierFilters]);

  useEffect(() => {
    load();
  }, [load]);

  const visibleVideoIds = useMemo(
    () => (data?.outliers ?? []).slice(0, 20).map((o) => o.videoId),
    [data]
  );

  const toggleTier = (t: Tier) => {
    setTierFilters((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const scopeLabel =
    scope === "all"
      ? "all channels"
      : scope
        ? "active channel"
        : "loading…";

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Flame className="h-6 w-6 text-amber-500" />
            Outliers
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Competitor videos that beat their own channel&apos;s median by{" "}
            {minMultiplier}× or more. Methodology in{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              MENTOR_METHOD.md §2
            </code>
            . Scoped to <span className="font-medium">{scopeLabel}</span>.
          </p>
        </div>
        <Button
          onClick={() => setIdeasOpen(true)}
          disabled={visibleVideoIds.length === 0 || scope === null}
          className="shrink-0 gap-1.5"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Generate ideas
        </Button>
      </header>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-4 rounded-md border border-border/60 bg-muted/20 p-3">
        <PillGroup label="Window">
          {WINDOW_PILLS.map((d) => (
            <Pill
              key={d}
              active={windowDays === d}
              onClick={() => setWindowDays(d)}
            >
              {d}d
            </Pill>
          ))}
        </PillGroup>
        <PillGroup label="Min multiplier">
          {MULTIPLIER_PILLS.map((m) => (
            <Pill
              key={m}
              active={minMultiplier === m}
              onClick={() => setMinMultiplier(m)}
            >
              {m}×
            </Pill>
          ))}
        </PillGroup>
        <PillGroup label="Tier">
          {TIERS.map((t) => {
            const on = tierFilters.has(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleTier(t)}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
                  on
                    ? TIER_PILL[t]
                    : "border border-border text-muted-foreground hover:text-foreground"
                )}
              >
                {TIER_LABEL[t]}
              </button>
            );
          })}
        </PillGroup>
      </div>

      {/* Stats line */}
      {data && (
        <p className="mb-4 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">
            {data.outliers.length}
          </span>{" "}
          outlier{data.outliers.length === 1 ? "" : "s"} across{" "}
          {data.competitorsCovered} competitor
          {data.competitorsCovered === 1 ? "" : "s"} · scanned{" "}
          {data.totalScanned.toLocaleString("en-US")} videos in the last{" "}
          {windowDays} days.
        </p>
      )}

      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading outliers…
        </div>
      ) : data && data.outliers.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No outliers in this window. Try widening to 90 days or lowering the
            multiplier.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {(data?.outliers ?? []).map((o) => (
            <OutlierCard
              key={o.videoId}
              outlier={o}
              onOpen={() => setOpenOutlier(o)}
            />
          ))}
        </div>
      )}

      {openOutlier && (
        <ExplainModal
          outlier={openOutlier}
          onClose={() => setOpenOutlier(null)}
        />
      )}

      {ideasOpen && scope && (
        <GenerateIdeasModal
          userChannelId={scope}
          outlierVideoIds={visibleVideoIds}
          onClose={() => setIdeasOpen(false)}
          outliersById={Object.fromEntries(
            (data?.outliers ?? []).map((o) => [o.videoId, o])
          )}
        />
      )}
    </div>
  );
}

/* ---------------- Filter primitives ---------------- */

function PillGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="flex gap-1.5">{children}</div>
    </div>
  );
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "border border-border text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

/* ---------------- Outlier card ---------------- */

function OutlierCard({
  outlier,
  onOpen,
}: {
  outlier: Outlier;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative block w-full rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card className="overflow-hidden transition-colors group-hover:bg-accent/30">
        <div className="relative aspect-video w-full bg-muted">
          {outlier.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={outlier.thumbnailUrl}
              alt=""
              className="h-full w-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : null}
          {outlier.durationSeconds ? (
            <span className="absolute bottom-2 right-2 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-mono text-white">
              {fmtDuration(outlier.durationSeconds)}
            </span>
          ) : null}
          {/* Hover overlay — appears at the bottom on hover, so the
              thumbnail stays clean by default. */}
          <div className="absolute inset-x-0 bottom-0 flex translate-y-full items-center justify-center bg-gradient-to-t from-black/85 via-black/55 to-transparent p-3 opacity-0 transition-all group-hover:translate-y-0 group-hover:opacity-100">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-white/15 px-3 py-1 text-xs font-medium text-white backdrop-blur">
              <Sparkles className="h-3.5 w-3.5" />
              Explain why this worked
            </span>
          </div>
        </div>
        <CardContent className="space-y-2 p-3">
          <div className="line-clamp-2 text-sm font-medium leading-snug">
            {outlier.title}
          </div>
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate text-muted-foreground">
              {outlier.competitorTitle ?? outlier.competitorHandle ?? "—"}
            </span>
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                TIER_PILL[outlier.tier]
              )}
            >
              {TIER_LABEL[outlier.tier]}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {fmtCount(outlier.views)} views ·{" "}
              <span className="font-bold text-amber-600 dark:text-amber-400 tabular-nums">
                {outlier.multiplier.toFixed(1)}× median
              </span>
            </span>
            <span>{fmtRelative(outlier.publishedAt)}</span>
          </div>
        </CardContent>
      </Card>
    </button>
  );
}

/* ---------------- Explain modal ---------------- */

function ExplainModal({
  outlier,
  onClose,
}: {
  outlier: Outlier;
  onClose: () => void;
}) {
  const [data, setData] = useState<Explanation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/outliers/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: outlier.videoId,
        competitorId: outlier.competitorId,
      }),
    })
      .then((r) => r.json())
      .then((d: Explanation | { error?: string; retryAfterSec?: number }) => {
        if (cancelled) return;
        if ("error" in d) {
          const detail = d.retryAfterSec
            ? `${d.error} (try again in ${d.retryAfterSec}s)`
            : d.error;
          setError(detail ?? "Could not generate explanation.");
          return;
        }
        setData(d);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Network error.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [outlier]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Flame className="h-4 w-4 text-amber-500" />
                Why this outlier worked
              </CardTitle>
              <CardDescription>
                {outlier.competitorTitle ?? outlier.competitorHandle ?? "—"} ·{" "}
                <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", TIER_PILL[outlier.tier])}>
                  {TIER_LABEL[outlier.tier]}
                </span>{" "}
                · {fmtCount(outlier.views)} views ·{" "}
                <span className="font-bold text-amber-600 dark:text-amber-400">
                  {outlier.multiplier.toFixed(1)}× median
                </span>
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {outlier.thumbnailUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={outlier.thumbnailUrl}
              alt=""
              className="aspect-video w-full rounded-md object-cover"
              referrerPolicy="no-referrer"
            />
          )}
          <div>
            <div className="text-base font-semibold leading-snug">
              {outlier.title}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {fmtRelative(outlier.publishedAt)}
              {outlier.durationSeconds
                ? ` · ${fmtDuration(outlier.durationSeconds)}`
                : ""}
            </div>
            <a
              href={`https://www.youtube.com/watch?v=${outlier.videoId}`}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-xs text-primary hover:underline"
            >
              Open on YouTube ↗
            </a>
          </div>

          <div className="border-t border-border/60 pt-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              What made it work
            </div>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Analyzing…
              </div>
            ) : error ? (
              <div className="text-sm text-destructive">{error}</div>
            ) : data ? (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {data.levers.map((l) => (
                    <span
                      key={l}
                      className="inline-flex items-center rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary"
                    >
                      {l}
                    </span>
                  ))}
                </div>
                <p className="text-sm leading-relaxed">{data.explanation}</p>
                {data.cached && (
                  <p className="text-[10px] text-muted-foreground">
                    (cached — free to re-open)
                  </p>
                )}
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ---------------- Generate Ideas modal ---------------- */

function GenerateIdeasModal({
  userChannelId,
  outlierVideoIds,
  outliersById,
  onClose,
}: {
  userChannelId: string;
  outlierVideoIds: string[];
  outliersById: Record<string, Outlier>;
  onClose: () => void;
}) {
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDismissed(new Set());
    try {
      const r = await fetch("/api/outliers/generate-ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userChannelId, outlierVideoIds }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        ideas?: Idea[];
        error?: string;
        retryAfterSec?: number;
      };
      if (!r.ok || !d.ideas) {
        const detail = d.retryAfterSec
          ? `${d.error} (try again in ${d.retryAfterSec}s)`
          : (d.error ?? `HTTP ${r.status}`);
        setError(detail);
        return;
      }
      setIdeas(d.ideas);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setLoading(false);
    }
  }, [userChannelId, outlierVideoIds]);

  const copy = async (text: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    } catch {
      /* ignore — fallback would be selectable text but the button still works visually */
    }
  };

  const dismiss = (idx: number) =>
    setDismissed((prev) => new Set(prev).add(idx));

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-primary" />
                Generate video ideas
              </CardTitle>
              <CardDescription>
                Claude reads your channel context + the top outliers currently
                visible and proposes video ideas grounded in real data.
              </CardDescription>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {ideas === null && !loading && !error && (
            <Button onClick={generate} disabled={outlierVideoIds.length === 0}>
              <Sparkles className="mr-1 h-3.5 w-3.5" />
              Generate
            </Button>
          )}
          {loading && (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading channel context + {outlierVideoIds.length} outliers…
            </div>
          )}
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {ideas !== null && ideas.length > 0 && (
            <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
              {ideas.map((idea, i) => {
                const source = outliersById[idea.sourceOutlierVideoId];
                const isDismissed = dismissed.has(i);
                return (
                  <div
                    key={i}
                    className={cn(
                      "rounded-md border border-border/60 p-3 transition-opacity",
                      isDismissed && "opacity-40"
                    )}
                  >
                    <div className="text-base font-semibold leading-snug">
                      {idea.topic}
                    </div>
                    <div className="mt-1 font-mono text-xs text-foreground/90">
                      {idea.suggestedTitle}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <span className="inline-flex items-center rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                        {idea.angle}
                      </span>
                      <div className="flex-1">
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-emerald-500"
                            style={{ width: `${Math.round(idea.confidence * 100)}%` }}
                          />
                        </div>
                      </div>
                      <span className="w-10 text-right text-[10px] text-muted-foreground tabular-nums">
                        {Math.round(idea.confidence * 100)}%
                      </span>
                    </div>
                    {source && (
                      <div className="mt-2 text-[11px] text-muted-foreground">
                        from:{" "}
                        <Link
                          href={`/competitors/${source.competitorId}`}
                          className="text-primary hover:underline"
                        >
                          {source.competitorTitle ?? source.competitorHandle ?? "—"}
                        </Link>{" "}
                        — &ldquo;{source.title}&rdquo;
                      </div>
                    )}
                    <div className="mt-2 flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copy(idea.suggestedTitle, i)}
                        disabled={isDismissed}
                        className="h-7 gap-1 px-2 text-[11px]"
                      >
                        {copiedIdx === i ? (
                          <>
                            <Check className="h-3 w-3" />
                            Copied
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" />
                            Copy title
                          </>
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => dismiss(i)}
                        disabled={isDismissed}
                        className="h-7 px-2 text-[11px] text-muted-foreground"
                      >
                        <X className="mr-1 h-3 w-3" />
                        Dismiss
                      </Button>
                    </div>
                  </div>
                );
              })}
              <div className="flex items-center justify-between border-t border-border/60 pt-3">
                <span className="text-[11px] text-muted-foreground">
                  <TrendingUp className="mr-1 inline h-3 w-3" />
                  {ideas.length} ideas from {outlierVideoIds.length} outliers
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={generate}
                  disabled={loading}
                  className="gap-1.5"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Generate another batch
                </Button>
              </div>
            </div>
          )}
          {ideas !== null && ideas.length === 0 && !loading && (
            <div className="text-sm text-muted-foreground">
              Claude returned no usable ideas. Try widening the outlier filter
              (more results) or refining your channel context.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
