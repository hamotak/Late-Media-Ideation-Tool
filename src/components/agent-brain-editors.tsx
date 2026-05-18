"use client";

/**
 * Shared editors for the agent's "brain" — the per-channel description,
 * ideation rules, and durable memory facts. Same components render on:
 *   - /channel-info (the primary editing surface)
 *   - /chat → Brain panel (inline editing without leaving the chat)
 *
 * All three editors hit the same APIs:
 *   - PATCH /api/channel-info  { channelId, field, value }
 *     (field ∈ "channelDescription" | "ideationRules")
 *   - GET / POST / DELETE /api/channel-info/memory
 *
 * Saves trigger an `onSaved` callback so the parent can show a toast.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DESCRIPTION_CAP = 1500;
const IDEATION_RULES_CAP = 1200;

// ---------------------------------------------------------------------
// Channel description — one big textarea + live counter
// ---------------------------------------------------------------------

export function DescriptionEditor({
  channelId,
  initialValue,
  onSaved,
  variant = "full",
}: {
  channelId: string;
  initialValue: string;
  onSaved?: (value: string) => void;
  /** "full" = always-editable textarea. "preview" = read-only with Edit button (used by Brain panel). */
  variant?: "full" | "preview";
}) {
  const [value, setValue] = useState(initialValue);
  const [editing, setEditing] = useState(variant === "full");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset when the parent switches the active channel.
  useEffect(() => {
    setValue(initialValue);
    setEditing(variant === "full");
    setError(null);
  }, [channelId, initialValue, variant]);

  const dirty = value !== initialValue;
  const overCap = value.length > DESCRIPTION_CAP;

  const save = async () => {
    if (overCap) {
      setError(`Description exceeds ${DESCRIPTION_CAP} chars`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/channel-info", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId,
          field: "channelDescription",
          value,
        }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? `HTTP ${r.status}`);
        return;
      }
      onSaved?.(value);
      if (variant === "preview") setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (variant === "preview" && !editing) {
    return (
      <div className="space-y-2">
        {value.trim().length > 0 ? (
          <div className="whitespace-pre-wrap text-sm leading-snug text-foreground/90 line-clamp-6">
            {value}
          </div>
        ) : (
          <div className="text-sm italic text-muted-foreground/70">
            No description yet. Click Edit to write one.
          </div>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditing(true)}
          className="gap-1.5"
        >
          <Pencil className="h-3 w-3" />
          Edit
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={variant === "full" ? 8 : 6}
        placeholder="One paragraph the agent reads before every job. Cover what the channel is, who watches (age + region), what makes you different, voice + pacing. Plain words. Shorter is better."
        className={cn(
          "w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
          "focus:outline-none focus:ring-2 focus:ring-ring",
          overCap && "border-destructive/60 focus:ring-destructive"
        )}
        disabled={saving}
      />
      <div className="flex items-center gap-2 text-[11px]">
        <span
          className={cn(
            "text-muted-foreground",
            overCap && "font-medium text-destructive"
          )}
        >
          {value.length} / {DESCRIPTION_CAP}
        </span>
        {dirty && !overCap && (
          <span className="text-amber-600 dark:text-amber-400">unsaved</span>
        )}
        {error && <span className="text-destructive">· {error}</span>}
        <div className="ml-auto flex items-center gap-2">
          {variant === "preview" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setValue(initialValue);
                setEditing(false);
                setError(null);
              }}
              disabled={saving}
            >
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            onClick={save}
            disabled={!dirty || overCap || saving}
            className="gap-1.5"
          >
            <Check className="h-3.5 w-3.5" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Ideation rules — line-list with add/delete
// ---------------------------------------------------------------------

export function IdeationRulesEditor({
  channelId,
  initialValue,
  onSaved,
}: {
  channelId: string;
  initialValue: string;
  onSaved?: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(initialValue);
    setError(null);
  }, [channelId, initialValue]);

  const dirty = value !== initialValue;
  const overCap = value.length > IDEATION_RULES_CAP;

  const save = async () => {
    if (overCap) {
      setError(`Rules exceed ${IDEATION_RULES_CAP} chars`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/channel-info", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId,
          field: "ideationRules",
          value,
        }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? `HTTP ${r.status}`);
        return;
      }
      onSaved?.(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={6}
        placeholder="One rule per line. HARD-enforcement constraints the ideation agent must follow when composing titles. Voice constraints, banned shapes, format overrides — anything you never want bent."
        className={cn(
          "w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono",
          "focus:outline-none focus:ring-2 focus:ring-ring",
          overCap && "border-destructive/60 focus:ring-destructive"
        )}
        disabled={saving}
      />
      <div className="flex items-center gap-2 text-[11px]">
        <span
          className={cn(
            "text-muted-foreground",
            overCap && "font-medium text-destructive"
          )}
        >
          {value.length} / {IDEATION_RULES_CAP}
        </span>
        {dirty && !overCap && (
          <span className="text-amber-600 dark:text-amber-400">unsaved</span>
        )}
        {error && <span className="text-destructive">· {error}</span>}
        <div className="ml-auto">
          <Button
            size="sm"
            onClick={save}
            disabled={!dirty || overCap || saving}
            className="gap-1.5"
          >
            <Check className="h-3.5 w-3.5" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Agent memory panel — durable per-channel facts
// ---------------------------------------------------------------------

type MemoryRow = {
  id: number;
  channel_id: string;
  key: string;
  value: string;
  source: string | null;
  confidence: number;
  updated_at: number;
};

export function AgentMemoryPanel({
  channelId,
  onSaved,
  /** Brain-panel variant has tighter padding + no descriptive helper text. */
  compact = false,
}: {
  channelId: string;
  onSaved?: () => void;
  compact?: boolean;
}) {
  const [rows, setRows] = useState<MemoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [draftValue, setDraftValue] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/channel-info/memory?channelId=${encodeURIComponent(channelId)}`,
        { cache: "no-store" }
      );
      const d = (await r.json()) as { memory?: MemoryRow[]; error?: string };
      if (d.error) {
        setError(d.error);
        setRows([]);
        return;
      }
      setRows(d.memory ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load memory");
    }
  }, [channelId]);

  useEffect(() => {
    void load();
  }, [load]);

  const upsert = useCallback(
    async (key: string, value: string) => {
      setBusyKey(key);
      setError(null);
      try {
        const r = await fetch("/api/channel-info/memory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelId, key, value }),
        });
        if (!r.ok) {
          const d = (await r.json().catch(() => ({}))) as { error?: string };
          setError(d.error ?? `HTTP ${r.status}`);
          return;
        }
        await load();
        onSaved?.();
      } finally {
        setBusyKey(null);
      }
    },
    [channelId, load, onSaved]
  );

  const remove = async (key: string) => {
    if (!window.confirm(`Delete memory "${key}"?`)) return;
    setBusyKey(key);
    setError(null);
    try {
      const r = await fetch("/api/channel-info/memory", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId, key }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? `HTTP ${r.status}`);
        return;
      }
      await load();
      onSaved?.();
    } finally {
      setBusyKey(null);
    }
  };

  const startEdit = (row: MemoryRow) => {
    setEditKey(row.key);
    setEditValue(row.value);
  };

  const saveEdit = async () => {
    if (!editKey) return;
    await upsert(editKey, editValue.trim());
    setEditKey(null);
    setEditValue("");
  };

  const onAdd = async () => {
    const k = draftKey.trim();
    const v = draftValue.trim();
    if (!k || !v) {
      setError("Both key and value are required.");
      return;
    }
    await upsert(k, v);
    setDraftKey("");
    setDraftValue("");
    setAdding(false);
  };

  return (
    <div data-testid="agent-memory-panel">
      <div className="mb-2 flex items-center justify-between gap-2">
        {compact ? (
          <span className="text-xs font-medium text-muted-foreground">
            Memory ({rows?.length ?? 0})
          </span>
        ) : (
          <p className="text-xs text-muted-foreground">
            Durable facts the chat agent remembers across sessions for this
            channel. The agent can propose saves via chat tools (with
            confirmation); add or edit them here directly.
          </p>
        )}
        {!adding && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAdding(true)}
            className="shrink-0 gap-1.5"
          >
            <Pencil className="h-3.5 w-3.5" />
            Add fact
          </Button>
        )}
      </div>
      {error && (
        <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
          {error}
        </div>
      )}
      {adding && (
        <div className="mb-3 space-y-2 rounded-md border border-border/60 p-3">
          <input
            type="text"
            placeholder="key (snake_case, e.g. sponsor_policy)"
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <textarea
            placeholder="value (prose — what the agent should remember)"
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onAdd} disabled={busyKey === draftKey.trim()}>
              <Check className="mr-1 h-3.5 w-3.5" />
              Save fact
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setAdding(false);
                setDraftKey("");
                setDraftValue("");
                setError(null);
              }}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              Cancel
            </Button>
          </div>
        </div>
      )}
      {rows === null ? (
        <div className="py-4 text-center text-xs text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
          No facts yet. The agent will propose saves as durable channel traits surface in chat.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="rounded-md border border-border/60 p-2">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                <span className="font-mono font-medium text-foreground">{row.key}</span>
                <span>conf {row.confidence.toFixed(2)}</span>
                {row.source && <span>· {row.source}</span>}
              </div>
              {editKey === row.key ? (
                <div className="space-y-2">
                  <textarea
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={saveEdit} disabled={busyKey === row.key}>
                      <Check className="mr-1 h-3.5 w-3.5" />
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditKey(null);
                        setEditValue("");
                      }}
                    >
                      <X className="mr-1 h-3.5 w-3.5" />
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <div className="whitespace-pre-wrap text-sm">{row.value}</div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => startEdit(row)}
                      aria-label={`Edit ${row.key}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => remove(row.key)}
                      aria-label={`Delete ${row.key}`}
                      disabled={busyKey === row.key}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
