"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronsUpDown,
  Layers,
  Loader2,
  Search,
  Tv,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Channel = {
  id: string;
  title: string | null;
  handle: string | null;
  subscriber_count: number | null;
  monetization_status?: "monetized" | "pending" | "not_eligible" | null;
  editor_name?: string | null;
};

type StatusFilter = "all" | "monetized" | "pending" | "not_eligible";

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: "All",
  monetized: "Monetized",
  pending: "YPP pending",
  not_eligible: "Not eligible",
};

/**
 * Channel scope picker that drives the dashboard view.
 *
 * Two modes:
 *   - "all"     — cross-channel summary (AllChannelsOverview).
 *   - "channel" — per-channel widgets scoped to the active channel.
 *
 * UI: a left-side "All channels" toggle pill + a right-side searchable
 * dropdown for picking a specific channel. With 1-3 channels a flat tab
 * bar would be fine; the user has 21+ which made the previous tab-row
 * unusable, so we switched to a dropdown.
 *
 * Selecting a per-channel option calls /api/channels/active and reloads
 * the page — every server-rendered widget reads active channel during
 * render, so a soft re-fetch isn't enough.
 *
 * Selected mode is persisted to localStorage so it survives F5.
 *
 * Self-hides when there are 0 or 1 channels — no point in a picker
 * with nothing to pick from.
 */
const STORAGE_KEY = "dashboard.viewMode";

type Mode = "all" | "channel";

export type DashboardMode = Mode;

function fmtCount(n: number | null): string {
  if (n === null) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function DashboardTabs({
  onModeChange,
}: {
  onModeChange?: (mode: Mode) => void;
}) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("channel");
  const [pending, setPending] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Monetization status filter inside the dropdown — lets the user see
  // only monetized channels at a glance, or zoom in on the YPP-pending
  // pipeline. Persisted to localStorage so it survives F5.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Read persisted mode + status filter on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "all" || saved === "channel") {
      setMode(saved);
      onModeChange?.(saved);
    }
    const savedStatus = window.localStorage.getItem("dashboard.statusFilter");
    if (
      savedStatus === "all" ||
      savedStatus === "monetized" ||
      savedStatus === "pending" ||
      savedStatus === "not_eligible"
    ) {
      setStatusFilter(savedStatus);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setStatusAndPersist = useCallback((next: StatusFilter) => {
    setStatusFilter(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("dashboard.statusFilter", next);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/channels", { cache: "no-store" });
      const data = (await res.json()) as { channels: Channel[]; activeId: string | null };
      setChannels(data.channels);
      setActiveId(data.activeId);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Close dropdown on outside click + ESC.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!popRef.current) return;
      if (!popRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    // Auto-focus search input on open.
    setTimeout(() => searchRef.current?.focus(), 0);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const setModeAndPersist = useCallback(
    (next: Mode) => {
      setMode(next);
      onModeChange?.(next);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(STORAGE_KEY, next);
      }
    },
    [onModeChange]
  );

  const switchToChannel = async (id: string) => {
    if (id === activeId && mode === "channel") {
      setOpen(false);
      return;
    }
    if (id === activeId) {
      setModeAndPersist("channel");
      setOpen(false);
      return;
    }
    setPending(id);
    try {
      const res = await fetch("/api/channels/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(STORAGE_KEY, "channel");
        }
        window.location.reload();
      } else {
        setPending(null);
      }
    } catch {
      setPending(null);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return channels.filter((c) => {
      // Status filter first — cheaper and more aggressive.
      if (statusFilter !== "all") {
        if ((c.monetization_status ?? null) !== statusFilter) return false;
      }
      if (!q) return true;
      const title = (c.title ?? "").toLowerCase();
      const handle = (c.handle ?? "").toLowerCase();
      const editor = (c.editor_name ?? "").toLowerCase();
      return (
        title.includes(q) ||
        handle.includes(q) ||
        c.id.toLowerCase().includes(q) ||
        editor.includes(q)
      );
    });
  }, [channels, query, statusFilter]);

  // Channel counts per status — used in the filter pill labels so the
  // user knows how many channels they have in each bucket without
  // having to actually click each pill.
  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = {
      all: channels.length,
      monetized: 0,
      pending: 0,
      not_eligible: 0,
    };
    for (const c of channels) {
      const s = c.monetization_status ?? null;
      if (s === "monetized") counts.monetized += 1;
      else if (s === "pending") counts.pending += 1;
      else if (s === "not_eligible") counts.not_eligible += 1;
    }
    return counts;
  }, [channels]);

  if (channels.length <= 1) return null;

  const active = channels.find((c) => c.id === activeId) ?? channels[0];

  return (
    <div className="mb-4 flex items-center gap-2">
      {/* "All channels" toggle */}
      <button
        onClick={() => setModeAndPersist("all")}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
          mode === "all"
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background text-foreground hover:bg-accent"
        )}
      >
        <Layers className="h-3.5 w-3.5" />
        All channels
      </button>

      {/* Channel picker dropdown */}
      <div className="relative min-w-0 flex-1" ref={popRef}>
        <button
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "inline-flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left text-xs font-medium transition-colors",
            mode === "channel"
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-background text-foreground hover:bg-accent"
          )}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <Tv className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {mode === "channel"
              ? (active?.title ?? active?.handle ?? "Channel")
              : `Pick channel (${channels.length})`}
          </span>
          {mode === "channel" && active?.subscriber_count !== null && (
            <span
              className={cn(
                "shrink-0 text-[10px] tabular-nums opacity-75",
                mode === "channel" ? "text-primary-foreground" : "text-muted-foreground"
              )}
            >
              {fmtCount(active.subscriber_count)}
            </span>
          )}
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>

        {open && (
          <div className="absolute left-0 top-[calc(100%+4px)] z-30 w-full max-w-md overflow-hidden rounded-md border border-border bg-popover shadow-lg">
            {/* Status filter pills — lets the user narrow the list to
                just monetized channels, just YPP-pending ones, etc.
                Counts come from the same channels payload. */}
            <div className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/30 px-2 py-1.5">
              {(["all", "monetized", "pending", "not_eligible"] as StatusFilter[]).map(
                (s) => (
                  <button
                    key={s}
                    onClick={() => setStatusAndPersist(s)}
                    className={cn(
                      "rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
                      statusFilter === s
                        ? "bg-primary text-primary-foreground"
                        : "bg-background text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                  >
                    {STATUS_LABELS[s]}{" "}
                    <span className="opacity-70">({statusCounts[s]})</span>
                  </button>
                )
              )}
            </div>
            {/* Search input */}
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                type="text"
                placeholder="Search by title, handle, editor…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                  clear
                </button>
              )}
            </div>

            {/* Channel list */}
            <div className="max-h-[60vh] overflow-y-auto p-1">
              {filtered.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No channels match{" "}
                  {query
                    ? `"${query}"`
                    : `the ${STATUS_LABELS[statusFilter]} filter`}
                </div>
              ) : (
                filtered.map((c) => {
                  const isActive = c.id === activeId && mode === "channel";
                  const isPending = pending === c.id;
                  return (
                    <button
                      key={c.id}
                      onClick={() => switchToChannel(c.id)}
                      disabled={isPending}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-xs transition-colors",
                        isActive ? "bg-accent" : "hover:bg-accent"
                      )}
                    >
                      <span className="shrink-0">
                        {isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check
                            className={cn(
                              "h-3.5 w-3.5",
                              isActive ? "opacity-100" : "opacity-0"
                            )}
                          />
                        )}
                      </span>
                      <Tv className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium">
                            {c.title ?? c.id}
                          </span>
                          {c.monetization_status === "monetized" && (
                            <span className="shrink-0 rounded bg-emerald-500/15 px-1 py-0.5 text-[9px] font-medium text-emerald-700 dark:text-emerald-400">
                              $
                            </span>
                          )}
                          {c.monetization_status === "pending" && (
                            <span className="shrink-0 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-medium text-amber-700 dark:text-amber-400">
                              YPP
                            </span>
                          )}
                        </div>
                        {(c.handle || c.editor_name) && (
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            {c.handle && (
                              <span className="truncate">{c.handle}</span>
                            )}
                            {c.editor_name && (
                              <span className="shrink-0 italic">
                                ed: {c.editor_name}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      {c.subscriber_count !== null && (
                        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                          {fmtCount(c.subscriber_count)}
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {/* Footer hint */}
            <div className="border-t border-border bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground">
              {filtered.length} of {channels.length} channels shown · click any to switch
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
