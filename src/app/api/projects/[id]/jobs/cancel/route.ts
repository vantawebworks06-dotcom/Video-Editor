import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { ACTIVE_PIPELINE_STATUSES, ACTIVE_RENDER_STATUSES, JOB_CANCELLED } from "@/lib/domain/types";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";

const Body = z.object({ target: z.enum(["pipeline", "render", "all"]).default("all") });

/**
 * Cancel the project's queued/running jobs. Job status is only writable with the service role
 * (RLS), so ownership is checked with the user's client first. The worker polls its job row and
 * stops (killing FFmpeg) as soon as it sees the cancellation.
 */
export const POST = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/jobs/cancel">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id);
  const { target } = await parseBody(req, Body);
  if (!hasServiceRole()) throw new HttpError(400, "Cancelling jobs requires SUPABASE_SERVICE_ROLE_KEY on the server.");
  const db = createAdminClient();
  const cancelled = { status: "FAILED", error: JOB_CANCELLED, completed_at: new Date().toISOString() };

  let pipeline: { id: string; kind: string }[] = [];
  let render: { id: string }[] = [];
  if (target !== "render") {
    const { data, error } = await db.from("pipeline_jobs").update(cancelled).eq("project_id", project.id).in("status", [...ACTIVE_PIPELINE_STATUSES]).select("id, kind");
    if (error) throw error;
    pipeline = data ?? [];
  }
  if (target !== "pipeline") {
    const { data, error } = await db.from("render_jobs").update(cancelled).eq("project_id", project.id).in("status", [...ACTIVE_RENDER_STATUSES]).select("id");
    if (error) throw error;
    render = data ?? [];
  }
  if (!pipeline.length && !render.length) throw new HttpError(409, "Nothing is running for this project.");

  // An interrupted generation leaves the previous edit untouched, so the project goes back to it.
  if (pipeline.some((j) => j.kind !== "analyze_reference")) {
    await db.from("projects").update({ status: Number(project.timeline_version ?? 0) > 0 ? "ready" : "draft", last_error: null }).eq("id", project.id);
  }
  return NextResponse.json({ cancelled: { pipeline: pipeline.map((j) => j.id), render: render.map((j) => j.id) } });
});
