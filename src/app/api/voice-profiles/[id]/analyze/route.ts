import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireProject, requireUser, route } from "@/lib/api/server";

/**
 * Analyse a profile's samples and match an engine voice (worker task). Jobs belong to a project,
 * so the project the user is working in carries it.
 */
export const POST = route(async (req: NextRequest, ctx: RouteContext<"/api/voice-profiles/[id]/analyze">) => {
  const auth = await requireUser();
  const id = (await ctx.params).id;
  const { projectId } = await parseBody(req, z.object({ projectId: z.uuid() }));
  const project = await requireProject(auth, projectId, "id");
  const { data: profile } = await auth.supabase.from("voice_profiles").select("id, samples").eq("id", id).maybeSingle();
  if (!profile) throw new HttpError(404, "Voice profile not found");
  if (!((profile.samples as unknown[]) ?? []).length) throw new HttpError(400, "Add at least one recording first.");
  const { data: running } = await auth.supabase.from("pipeline_jobs").select("id").eq("kind", "voice_profile").in("status", ["QUEUED", "RUNNING"]).contains("payload", { profileId: id });
  if (running?.length) return NextResponse.json({ ok: true, jobId: running[0]!.id });
  const { data, error } = await auth.supabase.from("pipeline_jobs").insert({ project_id: project.id, user_id: auth.userId, kind: "voice_profile", payload: { profileId: id } }).select("id").single();
  if (error) throw error;
  return NextResponse.json({ ok: true, jobId: data.id });
});
