import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, requireUser, route } from "@/lib/api/server";
import { localRenderPath } from "@/lib/render/localRenders";

export const runtime = "nodejs";

/**
 * Serves a finished render straight from the worker's disk when it was too large for the
 * Storage plan's upload limit. Only works when the web app runs on the worker machine.
 * Ownership is checked through RLS; the path is built from the job id, never from the DB.
 */
export const GET = route(async (req: NextRequest, ctx: RouteContext<"/api/renders/[jobId]/file">) => {
  const { supabase } = await requireUser();
  const { jobId } = await ctx.params;
  if (!z.uuid().safeParse(jobId).success) throw new HttpError(404, "Not found");
  const { data: job } = await supabase.from("render_jobs").select("id, status, project_id").eq("id", jobId).maybeSingle();
  if (!job || job.status !== "COMPLETE") throw new HttpError(404, "Render not found");

  const file = localRenderPath(job.id);
  if (!existsSync(file)) throw new HttpError(404, "This render is stored on the worker computer and isn't reachable from this server.");
  const size = statSync(file).size;
  const download = req.nextUrl.searchParams.get("download") === "1";
  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    ...(download ? { "Content-Disposition": `attachment; filename="docucut-${job.id.slice(0, 8)}.mp4"` } : {}),
  };

  // Byte ranges let the preview player seek.
  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || end < start) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
  }
  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(stream, { headers: { ...headers, "Content-Length": String(size) } });
});
