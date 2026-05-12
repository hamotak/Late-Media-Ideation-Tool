"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Cookie,
  ExternalLink,
  Loader2,
  Save,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Status = {
  hasCookies: boolean;
  lineCount: number;
  estimatedExpiry: number | null;
};

/**
 * Optional YouTube cookies.txt slot. Hidden behind a <details> by default
 * since most users won't need it — it's the escape hatch for when yt-dlp
 * trips the "Sign in to confirm you're not a bot" challenge that
 * data-center IPs (Railway etc.) routinely get.
 *
 * UX: deliberately verbose, step-by-step, because most users have no
 * intuition about what cookies.txt is. We never display the saved
 * cookies back to the user (would echo session tokens to the page) —
 * only metadata.
 */
export function YouTubeCookies() {
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [justSaved, setJustSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/youtube/cookies", { cache: "no-store" });
      const data = (await res.json()) as Status;
      setStatus(data);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/youtube/cookies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cookies: draft }),
      });
      const data = (await res.json()) as { error?: string } & Status;
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
      } else {
        setDraft("");
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 1800);
        load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (!confirm("Remove saved cookies?")) return;
    setSaving(true);
    try {
      await fetch("/api/youtube/cookies", { method: "DELETE" });
      setDraft("");
      load();
    } finally {
      setSaving(false);
    }
  };

  const expiryDate =
    status?.estimatedExpiry && status.estimatedExpiry > 0
      ? new Date(status.estimatedExpiry * 1000)
      : null;
  // Three-bucket classification so the UI can distinguish "ok / warn / red".
  // Previously the same amber "expiring soon" rendered for cookies that
  // had already lapsed by days — users would re-paste the same stale file
  // because the wording read like a future-tense advisory.
  const SEVEN_DAYS_MS = 7 * 86_400_000;
  const expiryBucket: "expired" | "soon" | "ok" = !expiryDate
    ? "ok"
    : expiryDate.getTime() < Date.now()
      ? "expired"
      : expiryDate.getTime() < Date.now() + SEVEN_DAYS_MS
        ? "soon"
        : "ok";

  return (
    <details className="rounded-lg border border-dashed border-border">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm">
        <span className="inline-flex items-center gap-2">
          <Cookie className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">Login cookies for transcription</span>
          {status?.hasCookies ? (
            <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
              configured
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground">not set</span>
          )}
        </span>
      </summary>

      <div className="space-y-3 border-t border-border px-4 py-4 text-xs leading-relaxed">
        {/* Why */}
        <div className="rounded-md border border-amber-500/40 bg-amber-50/40 p-3 dark:bg-amber-900/10">
          <p className="flex items-start gap-2 font-medium">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>Why do I need this?</span>
          </p>
          <p className="mt-1.5 text-muted-foreground">
            YouTube can tell the server is running on a data-center
            (Railway / Vercel / etc.) and blocks transcription with{" "}
            <code className="rounded bg-muted px-1">
              Sign in to confirm you&apos;re not a bot
            </code>
            . If you paste your browser cookies here, the server can hit
            YouTube as if <em>you</em> were signed in — which clears the
            block.
          </p>
          <p className="mt-1.5 text-muted-foreground">
            <strong>Is it safe?</strong> Cookies are stored in your DB
            (SQLite on the Railway volume) and only used to call{" "}
            <code className="rounded bg-muted px-1">yt-dlp</code> during
            transcription. They&apos;re never echoed back to the page.
            That said, these cookies grant access to YouTube/Gmail of the
            account they came from until you sign out — if you&apos;re
            paranoid, create a separate Google account just for this.
          </p>
        </div>

        {/* How */}
        <div className="rounded-md border border-border bg-muted/20 p-3">
          <p className="font-medium text-foreground">
            How to get the cookies (5 minutes):
          </p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-muted-foreground">
            <li>
              Install the browser extension{" "}
              <a
                href="https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
              >
                Get cookies.txt LOCALLY
                <ExternalLink className="h-3 w-3" />
              </a>{" "}
              for Chrome (or{" "}
              <a
                href="https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
              >
                Cookies.txt
                <ExternalLink className="h-3 w-3" />
              </a>{" "}
              for Firefox).
            </li>
            <li>
              Open a new tab → go to{" "}
              <a
                href="https://www.youtube.com"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-primary hover:underline"
              >
                youtube.com
              </a>{" "}
              → make sure you&apos;re signed in (you can see your avatar
              top-right).
            </li>
            <li>
              Click the extension icon in the toolbar → it should show
              the <code className="rounded bg-muted px-1">.youtube.com</code>{" "}
              domain → click <strong>Export</strong> (or{" "}
              <strong>Copy</strong>).
            </li>
            <li>
              If you got <em>Export</em> — open the downloaded{" "}
              <code className="rounded bg-muted px-1">cookies.txt</code> file,
              select all (Ctrl/Cmd+A) and copy (Ctrl/Cmd+C). If you got{" "}
              <em>Copy</em> — it&apos;s already in your clipboard.
            </li>
            <li>
              Paste into the textarea below ↓ and click <strong>Save</strong>.
            </li>
            <li>
              Test transcription on a video. If it still fails with{" "}
              <code className="rounded bg-muted px-1">
                Sign in to confirm
              </code>{" "}
              — your cookies have probably expired or were exported from
              the wrong account; repeat steps 2-5.
            </li>
          </ol>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Cookies typically last ~6 months until YouTube rotates them.
            If transcription starts failing again, re-export and paste the
            fresh ones here.
          </p>
        </div>

        {/* Status of saved cookies */}
        {status?.hasCookies && (
          <div
            className={
              expiryBucket === "expired"
                ? "rounded-md border border-destructive/50 bg-destructive/10 p-2 text-[11px]"
                : expiryBucket === "soon"
                  ? "rounded-md border border-amber-500/50 bg-amber-50/40 p-2 text-[11px] dark:bg-amber-900/10"
                  : "rounded-md border border-border bg-green-50/30 p-2 text-[11px] dark:bg-green-900/10"
            }
          >
            <span className="text-muted-foreground">
              Currently saved: <strong>{status.lineCount}</strong> cookie lines.
            </span>
            {expiryDate && (
              <>
                {" "}
                <span className="text-muted-foreground">Earliest expiry:</span>{" "}
                <span
                  className={
                    expiryBucket === "expired"
                      ? "font-semibold text-destructive"
                      : expiryBucket === "soon"
                        ? "font-semibold text-amber-600 dark:text-amber-400"
                        : "font-medium"
                  }
                >
                  {expiryDate.toLocaleDateString()}
                </span>
                {expiryBucket === "expired" && (
                  <span className="ml-1 font-medium text-destructive">
                    — EXPIRED. Cookies are stale; re-export from your browser
                    and paste below. Until then, transcription will fail with
                    &quot;Sign in to confirm you&apos;re not a bot&quot;.
                  </span>
                )}
                {expiryBucket === "soon" && (
                  <span className="ml-1 text-amber-600 dark:text-amber-400">
                    (expiring soon — re-export)
                  </span>
                )}
              </>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <label className="block text-[11px] font-medium text-foreground">
            cookies.txt content
          </label>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1234567890\tSID\t..."
            }
            className="h-32 font-mono text-[11px]"
          />
        </div>

        {error && (
          <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={save}
            disabled={saving || !draft.trim()}
            className="gap-1.5"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {justSaved ? "Saved" : "Save cookies"}
          </Button>
          {status?.hasCookies && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={clear}
              disabled={saving}
              className="gap-1.5 text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </Button>
          )}
        </div>
      </div>
    </details>
  );
}
