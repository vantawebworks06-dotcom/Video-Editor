import { NextResponse, type NextRequest } from "next/server";
import { HttpError, requireProject, requireUser, route } from "@/lib/api/server";
import { chaptersText, creditsText, type ExportManifest, rightsCsv, toSrt, toVtt } from "@/lib/export/deliverables";
import { BUCKET } from "@/lib/supabase/admin";

const FILES: Record<string, { type: string; make: (m: ExportManifest) => string }> = {
  "captions.srt": { type: "application/x-subrip; charset=utf-8", make: (m) => toSrt(m.cues) },
  "captions.vtt": { type: "text/vtt; charset=utf-8", make: (m) => toVtt(m.cues) },
  "chapters.txt": { type: "text/plain; charset=utf-8", make: (m) => `${chaptersText(m.chapters)}\n${m.chaptersNote ? `\n(${m.chaptersNote})\n` : ""}` },
  "credits.txt": { type: "text/plain; charset=utf-8", make: creditsText },
  "rights.csv": { type: "text/csv; charset=utf-8", make: (m) => rightsCsv(m.rights) },
  "report.json": { type: "application/json; charset=utf-8", make: (m) => JSON.stringify({ projectName: m.projectName, format: m.format, createdAt: m.createdAt, settings: m.settings, qc: m.qc, loudness: m.loudness, chapters: m.chapters, warnings: m.warnings }, null, 2) },
};

/** One export deliverable, generated from the render's manifest (captions, chapters, credits, rights, QC report). */
export const GET = route(async (_req: NextRequest, ctx: RouteContext<"/api/projects/[id]/exports/[jobId]/[file]">) => {
  const auth = await requireUser();
  const { id, jobId, file } = await ctx.params;
  const project = await requireProject(auth, id, "id, name");
  const kind = FILES[file];
  if (!kind) throw new HttpError(404, "Unknown export file");
  // The job must belong to this project (RLS also scopes it to the owner).
  const { data: job } = await auth.supabase.from("render_jobs").select("id").eq("id", jobId).eq("project_id", project.id).maybeSingle();
  if (!job) throw new HttpError(404, "Export not found");
  const { data, error } = await auth.supabase.storage.from(BUCKET).download(`${project.id}/renders/${job.id}.manifest.json`);
  if (error || !data) throw new HttpError(404, "This render has no export files (it was made before exports produced them). Render again to get them.");
  const manifest = JSON.parse(await data.text()) as ExportManifest;
  const safeName = String(project.name).replace(/[^\p{L}\p{N} _-]+/gu, "").trim().replace(/\s+/g, "-").slice(0, 60) || "docucut";
  return new NextResponse(kind.make(manifest), {
    headers: { "content-type": kind.type, "content-disposition": `attachment; filename="${safeName}-${file}"`, "cache-control": "private, no-store" },
  });
});
