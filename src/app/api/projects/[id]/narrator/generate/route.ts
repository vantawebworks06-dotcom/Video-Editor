import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";
import { parseNarrator } from "@/lib/narrator/state";

const Body = z.object({
  /** full: every sentence + assembly + processing; sentences: only these sentences' audio. */
  mode: z.enum(["full", "sentences"]).default("full"),
  ids: z.array(z.string().max(40)).max(500).optional(),
  /** New take for `ids` (different delivery). */
  regenerate: z.boolean().optional(),
});

/** Queue narration generation (worker). A newer request replaces a queued one. */
export const POST = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/narrator/generate">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id, "id, narrator");
  const body = await parseBody(req, Body);
  const n = parseNarrator(project.narrator);
  if (!n.sentences.length) throw new HttpError(400, "Paste a script first.");
  if (body.mode === "sentences" && !body.ids?.length) throw new HttpError(400, "Choose the sentences to generate.");
  if (body.regenerate && body.ids?.length) {
    const ids = new Set(body.ids);
    n.sentences = n.sentences.map((s) => (ids.has(s.id) ? { ...s, take: s.take + 1 } : s));
    const { error } = await auth.supabase.from("projects").update({ narrator: n }).eq("id", project.id);
    if (error) throw error;
  }
  // Requests waiting for the worker are combined, never dropped: a full generation covers every
  // sentence; sentence requests merge their ids. (Jobs are worker-owned: service role.)
  const { data: queued } = await auth.supabase.from("pipeline_jobs").select("id, payload").eq("project_id", project.id).eq("kind", "narrate").eq("status", "QUEUED");
  const waiting = (queued ?? []) as { id: string; payload: { mode?: string; ids?: string[] | null } | null }[];
  const queuedFull = waiting.find((j) => j.payload?.mode === "full");
  if (queuedFull && body.mode === "sentences") return NextResponse.json({ ok: true, jobId: queuedFull.id, narrator: n });
  const ids = body.mode === "sentences" ? [...new Set([...waiting.flatMap((j) => j.payload?.ids ?? []), ...(body.ids ?? [])])] : null;
  if (waiting.length && hasServiceRole()) {
    await createAdminClient().from("pipeline_jobs").update({ status: "FAILED", error: "Replaced by a newer request.", completed_at: new Date().toISOString() }).in("id", waiting.map((j) => j.id));
  }
  const { data, error } = await auth.supabase
    .from("pipeline_jobs")
    .insert({ project_id: project.id, user_id: auth.userId, kind: "narrate", payload: { mode: body.mode, ids } })
    .select("id")
    .single();
  if (error) throw error;
  return NextResponse.json({ ok: true, jobId: data.id, narrator: n });
});
