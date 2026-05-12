import { NextResponse } from "next/server";
import { listVideosAdvanced, type VideoSort, type DurationFilter } from "@/lib/db";

export const runtime = "nodejs";

const SORTS: VideoSort[] = ["recent", "oldest", "views", "likes", "comments", "engagement"];
const DURATIONS: DurationFilter[] = ["all", "short", "long"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const search = url.searchParams.get("search") ?? undefined;
  const sortRaw = url.searchParams.get("sort");
  const durationRaw = url.searchParams.get("duration");
  const limitRaw = url.searchParams.get("limit");

  const sort = (SORTS as string[]).includes(sortRaw ?? "")
    ? (sortRaw as VideoSort)
    : "recent";
  const duration = (DURATIONS as string[]).includes(durationRaw ?? "")
    ? (durationRaw as DurationFilter)
    : "all";
  const limit = limitRaw ? Math.min(500, Math.max(1, parseInt(limitRaw, 10) || 100)) : 100;

  return NextResponse.json({
    videos: listVideosAdvanced({ search, sort, duration, limit }),
  });
}
