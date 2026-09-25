import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeJob, HttpError, parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { OutputFormat } from "@/lib/domain/types";

const Body = z.discriminatedUnion("type", [
  z.object({ type: z.literal("generate"), autoRender: OutputFormat.optional() }),
  z.object({ type: z.literal("regenerate_scenes"), sceneIds: z.array(z.string().regex(/^scene_\d{3,}$/)).min(1).max(200) }),
  z.object({ type: z.literal("analyze_reference"), apply: z.boolean().default(true) }),
  z.object({ type: z.literal("render"), format: OutputFormat.default("landscape") }),
]);

/** Enqueue work for the worker. Only QUEUED rows can be inserted (enforced by RLS too). */
export const POST = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/jobs">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id);
  const body = await parseBody(req, Body);

  if (body.type === "render") {
    const { data: running } = await auth.supabase
      .from("render_jobs")
      .select("id")
      .eq("project_id", project.id)
      .in("status", ["QUEUED", "DOWNLOADING", "PREPARING", "RENDERING", "FINALIZING"])
      .limit(1);
    if (running?.length) throw new HttpError(409, "A render is already in progress for this project.");
    const { data, error } = await auth.supabase
      .from("render_jobs")
      .insert({ project_id: project.id, user_id: auth.userId, format: body.format, timeline_version: Number(project.timeline_version ?? 0) })
      .select("id")
      .single();
    if (error) throw error;
    return NextResponse.json({ jobId: data.id }, { status: 201 });
  }

  if (await activeJob(auth.supabase, project.id)) throw new HttpError(409, "Another generation job is already running for this project.");
  if (body.type === "generate" && !project.narration_path && !project.is_demo) throw new HttpError(400, "Upload a narration first.");
  if (body.type === "analyze_reference" && !project.reference_video_path) throw new HttpError(400, "Upload a reference video first.");
  const payload =
    body.type === "regenerate_scenes"
      ? { sceneIds: body.sceneIds }
      : body.type === "analyze_reference"
        ? { apply: body.apply }
        : body.autoRender
          ? { autoRender: body.autoRender }
          : {};
  const { data, error } = await auth.supabase
    .from("pipeline_jobs")
    .insert({ project_id: project.id, user_id: auth.userId, kind: body.type, payload })
    .select("id")
    .single();
  if (error) throw error;
  return NextResponse.json({ jobId: data.id }, { status: 201 });
});
