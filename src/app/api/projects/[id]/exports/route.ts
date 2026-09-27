import { NextResponse, type NextRequest } from "next/server";
import { requireProject, requireUser, route } from "@/lib/api/server";
import type { ExportManifest } from "@/lib/export/deliverables";
import { localRenderSize } from "@/lib/render/localRenders";
import { BUCKET } from "@/lib/supabase/admin";

/** Export history: completed renders with the video, thumbnail and measured quality (from each manifest). */
export const GET = route(async (_req: NextRequest, ctx: RouteContext<"/api/projects/[id]/exports">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id, "id");
  const { data: jobs } = await auth.supabase
    .from("render_jobs")
    .select("id, format, output_path, warnings, created_at, completed_at")
    .eq("project_id", project.id)
    .eq("status", "COMPLETE")
    .order("created_at", { ascending: false })
    .limit(12);
  const storage = auth.supabase.storage.from(BUCKET);
  const exports = await Promise.all(
    (jobs ?? []).map(async (j) => {
      const base = `${project.id}/renders/${j.id}`;
      const inStorage = typeof j.output_path === "string" && j.output_path.startsWith(`${project.id}/`);
      const local = inStorage ? null : localRenderSize(j.id);
      const [video, thumb, manifest] = await Promise.all([
        inStorage ? storage.createSignedUrl(j.output_path as string, 3600).then((r) => r.data?.signedUrl ?? null) : Promise.resolve(local ? `/api/renders/${j.id}/file` : null),
        storage.createSignedUrl(`${base}.jpg`, 3600).then((r) => r.data?.signedUrl ?? null),
        storage.download(`${base}.manifest.json`).then(async (r) => (r.data ? (JSON.parse(await r.data.text()) as ExportManifest) : null)).catch(() => null),
      ]);
      return {
        id: j.id,
        format: j.format,
        createdAt: j.completed_at ?? j.created_at,
        warnings: j.warnings ?? [],
        videoUrl: video,
        downloadUrl: video ? (inStorage ? `${video}&download=${encodeURIComponent(`${j.id}.mp4`)}` : `${video}?download=1`) : null,
        thumbnailUrl: thumb,
        // Renders made before deliverables existed have no manifest.
        manifest: manifest && {
          duration: manifest.duration,
          width: manifest.width,
          height: manifest.height,
          fps: manifest.fps,
          settings: manifest.settings,
          qc: manifest.qc,
          loudness: manifest.loudness,
          cues: manifest.cues.length,
          chapters: manifest.chapters,
          chaptersNote: manifest.chaptersNote,
          credits: manifest.credits.length,
          rights: { total: manifest.rights.length, unconfirmed: manifest.rights.filter((r) => (r.rightsStatus === "UNKNOWN" || r.rightsStatus === "USER_REVIEW") && !r.approvedByUser).length },
        },
      };
    }),
  );
  return NextResponse.json({ exports });
});
