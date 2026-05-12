import { NextResponse } from "next/server";
import { getChannel, getTranscript, getVideo, commentCount } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const video = getVideo(id);
  if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });

  const transcript = getTranscript(id);
  const channel = getChannel();
  const comments = commentCount(id);

  return NextResponse.json({
    video,
    channel,
    transcript,
    commentSummary: comments,
  });
}
