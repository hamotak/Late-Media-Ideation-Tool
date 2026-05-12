import { NextResponse } from "next/server";
import { importYTStudioCSV } from "@/lib/csv-import";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "empty file" }, { status: 400 });
  }
  if (file.size > 25 * 1024 * 1024) {
    return NextResponse.json({ error: "file too large (25MB max)" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  try {
    const result = importYTStudioCSV(buf, file.name);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Parse error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
