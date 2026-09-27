import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { VoiceProcessing } from "@/lib/domain/voice";
import { BUCKET, createAdminClient, hasServiceRole } from "@/lib/supabase/admin";

const ACTIVE = ["QUEUED", "RUNNING"];

/** Latest narration processing result (measurement, applied values, A/B preview URLs) and any running job. */
export const GET = route(async (_req: NextRequest, ctx: RouteContext<"/api/projects/[id]/audio/voice">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id, "id");
  const { data: jobs } = await auth.supabase
    .from("pipeline_jobs")
    .select("id, status, progress, current_stage, error, payload, result, created_at")
    .eq("project_id", project.id)
    .eq("kind", "process_audio")
    .order("created_at", { ascending: false })
    .limit(10);
  const running = (jobs ?? []).find((j) => ACTIVE.includes(j.status as string)) ?? null;
  const done = (jobs ?? []).find((j) => j.status === "COMPLETE" && j.result) ?? null;
  const failed = jobs?.[0]?.status === "FAILED" ? jobs[0] : null;
  let latest: Record<string, unknown> | null = null;
  if (done) {
    const r = done.result as { afterPath: string; beforePath: string } & Record<string, unknown>;
    const { data } = await auth.supabase.storage.from(BUCKET).createSignedUrls([r.afterPath, r.beforePath], 3600);
    latest = { ...r, afterUrl: data?.[0]?.signedUrl ?? null, beforeUrl: data?.[1]?.signedUrl ?? null, jobId: done.id, createdAt: done.created_at };
  }
  return NextResponse.json({
    latest,
    running: running && { id: running.id, status: running.status, progress: running.progress, stage: running.current_stage },
    error: failed ? (failed.error as string) : null,
  });
});

/** Measure + process the narration with these settings and make A/B previews (worker task). */
export const POST = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/audio/voice">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id, "id, narration_path, is_demo");
  const { voice } = await parseBody(req, z.object({ voice: VoiceProcessing }));
  if (!project.narration_path && !project.is_demo) throw new HttpError(400, "Upload a narration first.");
  // One at a time: a newer request replaces a queued one (jobs are worker-owned: service role, after the ownership check).
  const { data: queued } = await auth.supabase.from("pipeline_jobs").select("id, status").eq("project_id", project.id).eq("kind", "process_audio").in("status", ACTIVE);
  const waiting = (queued ?? []).filter((j) => j.status === "QUEUED");
  if (waiting.length && hasServiceRole()) await createAdminClient().from("pipeline_jobs").update({ status: "FAILED", error: "Replaced by a newer request.", completed_at: new Date().toISOString() }).in("id", waiting.map((j) => j.id));
  const { data, error } = await auth.supabase.from("pipeline_jobs").insert({ project_id: project.id, user_id: auth.userId, kind: "process_audio", payload: { voice } }).select("id").single();
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true, jobId: data.id });
});
