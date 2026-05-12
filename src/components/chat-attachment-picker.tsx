"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Search,
  X,
  PlaySquare,
  Loader2,
  Eye,
  MessageCircle,
  ThumbsUp,
  ImageIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/provider";

export type AttachmentRef =
  | { type: "video"; id: string; title: string; thumbnail: string | null }
  | { type: "comment"; id: string; title: string; thumbnail: null }
  | {
      type: "image";
      id: string;
      title: string;
      // Object URL we use for the chip preview while the page is open.
      // Server gets `data` (base64) and `mediaType` separately on send.
      thumbnail: string | null;
      data: string;
      mediaType: string;
    };

type Tab = "videos" | "comments";

type VideoLite = {
  id: string;
  title: string;
  views: number;
  likes: number;
  published_at: number | null;
  thumbnail_url: string | null;
  duration_seconds: number | null;
};

type CommentHit = {
  id: string;
  videoId: string;
  videoTitle: string | null;
  parentId: string | null;
  author: string | null;
  text: string;
  likeCount: number;
  replyCount: number;
  publishedAt: number | null;
};

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toLocaleString();
}

export function ChatAttachmentPicker({
  open,
  onClose,
  onPick,
  alreadyAttachedIds,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (ref: AttachmentRef) => void;
  alreadyAttachedIds: Set<string>;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("videos");
  const [q, setQ] = useState("");
  const [videos, setVideos] = useState<VideoLite[] | null>(null);
  const [comments, setComments] = useState<CommentHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // Reset per-tab state when the tab changes so stale results don't flash.
  useEffect(() => {
    setQ("");
  }, [tab]);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setLoading(true);
    const id = setTimeout(() => {
      if (tab === "videos") {
        const url = new URL("/api/videos/search", window.location.origin);
        if (q.trim()) url.searchParams.set("q", q.trim());
        url.searchParams.set("limit", "30");
        fetch(url, { signal: ctrl.signal })
          .then((r) => r.json())
          .then((d) => setVideos(d.videos ?? []))
          .catch(() => {})
          .finally(() => setLoading(false));
      } else {
        // Comments tab — FTS needs a query; show empty-state hint while blank.
        if (!q.trim()) {
          setComments(null);
          setLoading(false);
          return;
        }
        const url = new URL("/api/comments/search", window.location.origin);
        url.searchParams.set("q", q.trim());
        url.searchParams.set("limit", "30");
        fetch(url, { signal: ctrl.signal })
          .then((r) => r.json())
          .then((d) => setComments(d.comments ?? []))
          .catch(() => {})
          .finally(() => setLoading(false));
      }
    }, 180);
    return () => {
      ctrl.abort();
      clearTimeout(id);
    };
  }, [q, open, tab]);

  const onEsc = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );
  useEffect(() => {
    if (!open) return;
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open, onEsc]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-background/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="mt-24 w-full max-w-xl overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Tabs */}
        <div className="flex gap-1 border-b border-border px-2 pt-2">
          <PickerTab active={tab === "videos"} onClick={() => setTab("videos")}>
            <PlaySquare className="h-3.5 w-3.5" />
            {t.attachPicker.tabVideos}
          </PickerTab>
          <PickerTab active={tab === "comments"} onClick={() => setTab("comments")}>
            <MessageCircle className="h-3.5 w-3.5" />
            {t.attachPicker.tabComments}
          </PickerTab>
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 border-b border-border p-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              tab === "videos"
                ? t.attachPicker.searchPlaceholder
                : t.attachPicker.searchCommentsPlaceholder
            }
            className="border-0 bg-transparent shadow-none focus-visible:ring-0"
          />
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto p-1">
          {tab === "videos" ? (
            <VideosList
              videos={videos}
              loading={loading}
              alreadyAttachedIds={alreadyAttachedIds}
              onPick={onPick}
            />
          ) : (
            <CommentsList
              comments={comments}
              loading={loading}
              query={q.trim()}
              alreadyAttachedIds={alreadyAttachedIds}
              onPick={onPick}
            />
          )}
        </div>

        <div className="border-t border-border bg-muted/30 p-2 text-center">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t.attachPicker.done}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PickerTab({
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
        "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function VideosList({
  videos,
  loading,
  alreadyAttachedIds,
  onPick,
}: {
  videos: VideoLite[] | null;
  loading: boolean;
  alreadyAttachedIds: Set<string>;
  onPick: (ref: AttachmentRef) => void;
}) {
  const { t } = useI18n();
  if (loading && videos === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t.comments.loading}
      </div>
    );
  }
  if (videos && videos.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        {t.attachPicker.empty}
      </div>
    );
  }
  return (
    <ul className="space-y-0.5">
      {videos?.map((v) => {
        const attached = alreadyAttachedIds.has(v.id);
        return (
          <li key={v.id}>
            <button
              type="button"
              disabled={attached}
              onClick={() => {
                onPick({
                  type: "video",
                  id: v.id,
                  title: v.title,
                  thumbnail: v.thumbnail_url,
                });
              }}
              className={cn(
                "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm transition-colors",
                attached ? "cursor-not-allowed opacity-50" : "hover:bg-accent"
              )}
            >
              {v.thumbnail_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={v.thumbnail_url}
                  alt=""
                  className="h-10 w-16 shrink-0 rounded object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-10 w-16 shrink-0 items-center justify-center rounded bg-muted">
                  <PlaySquare className="h-4 w-4 text-muted-foreground" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{v.title}</div>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Eye className="h-2.5 w-2.5" />
                    {fmt(v.views)}
                  </span>
                  {v.published_at && (
                    <span>
                      {new Date(v.published_at * 1000).toLocaleDateString("en-US", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                  )}
                </div>
              </div>
              {attached && (
                <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                  {t.attachPicker.added}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function CommentsList({
  comments,
  loading,
  query,
  alreadyAttachedIds,
  onPick,
}: {
  comments: CommentHit[] | null;
  loading: boolean;
  query: string;
  alreadyAttachedIds: Set<string>;
  onPick: (ref: AttachmentRef) => void;
}) {
  const { t } = useI18n();

  if (!query) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        {t.attachPicker.commentsHint}
      </div>
    );
  }
  if (loading && comments === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t.comments.loading}
      </div>
    );
  }
  if (comments && comments.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        {t.attachPicker.commentsEmpty}
      </div>
    );
  }

  return (
    <ul className="space-y-0.5">
      {comments?.map((c) => {
        const attached = alreadyAttachedIds.has(c.id);
        const preview = c.text.replace(/\s+/g, " ").trim().slice(0, 80);
        const chipTitle = `${c.author ?? "?"}: ${preview}${c.text.length > 80 ? "…" : ""}`;
        return (
          <li key={c.id}>
            <button
              type="button"
              disabled={attached}
              onClick={() =>
                onPick({ type: "comment", id: c.id, title: chipTitle, thumbnail: null })
              }
              className={cn(
                "flex w-full items-start gap-3 rounded-md px-2 py-2 text-left text-sm transition-colors",
                attached ? "cursor-not-allowed opacity-50" : "hover:bg-accent"
              )}
            >
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                <MessageCircle className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 text-[11px]">
                  <span className="font-medium text-foreground">{c.author ?? "?"}</span>
                  <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                    <ThumbsUp className="h-2.5 w-2.5" />
                    {fmt(c.likeCount)}
                  </span>
                  {c.parentId && (
                    <span className="rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                      {t.attachPicker.replyBadge}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-foreground">
                  {c.text}
                </p>
                {c.videoTitle && (
                  <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                    {t.attachPicker.onVideo}: {c.videoTitle}
                  </div>
                )}
              </div>
              {attached && (
                <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                  {t.attachPicker.added}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The chip shown above the chat input once an item is attached. */
export function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: AttachmentRef;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex max-w-[240px] items-center gap-1.5 rounded-full border border-border bg-background py-0.5 pl-1 pr-1.5 text-xs">
      {attachment.type === "image" && attachment.thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={attachment.thumbnail}
          alt=""
          className="h-5 w-5 shrink-0 rounded-sm object-cover"
        />
      ) : attachment.type === "image" ? (
        <ImageIcon className="h-3 w-3 text-muted-foreground" />
      ) : attachment.type === "video" && attachment.thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={attachment.thumbnail}
          alt=""
          className="h-5 w-8 shrink-0 rounded-sm object-cover"
          referrerPolicy="no-referrer"
        />
      ) : attachment.type === "video" ? (
        <PlaySquare className="h-3 w-3 text-muted-foreground" />
      ) : (
        <MessageCircle className="h-3 w-3 text-muted-foreground" />
      )}
      <span className="truncate">{attachment.title}</span>
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Remove"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
