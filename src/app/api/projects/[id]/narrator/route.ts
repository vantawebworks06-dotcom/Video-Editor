import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { splitScript } from "@/lib/narrator/split";
import { parseNarrator } from "@/lib/narrator/state";
import { NarratorControls, NarratorProcessing, NarratorStyle, SentenceOverride } from "@/lib/narrator/types";
import { BUCKET } from "@/lib/supabase/admin";

const ACTIVE = ["QUEUED", "RUNNING"];

/** The project's narrator: script, sentences (with preview URLs), settings, output, running job. */
export const GET = route(async (_req: NextRequest, ctx: RouteContext<"/api/projects/[id]/narrator">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id, "id, narrator, narration_path");
  const n = parseNarrator(project.narrator);
  const paths = [...n.sentences.flatMap((s) => (s.audio ? [s.audio.path] : [])), ...(n.output ? [n.output.beforePath, n.output.afterPath] : [])];
  const urls: Record<string, string> = {};
  if (paths.length) {
    const { data } = await auth.supabase.storage.from(BUCKET).createSignedUrls(paths, 3600);
    for (const s of data ?? []) if (s.path && s.signedUrl) urls[s.path] = s.signedUrl;
  }
  const { data: jobs } = await auth.supabase
    .from("pipeline_jobs")
    .select("id, kind, status, progress, current_stage, error, payload, created_at")
    .eq("project_id", project.id)
    .in("kind", ["narrate", "voice_profile"])
    .order("created_at", { ascending: false })
    .limit(6);
  const running = (jobs ?? []).find((j) => ACTIVE.includes(j.status as string)) ?? null;
  const latest = jobs?.[0];
  return NextResponse.json({
    narrator: n,
    urls,
    usedAsNarration: Boolean(n.output && project.narration_path === n.output.narrationPath),
    running: running && { id: running.id, kind: running.kind, status: running.status, progress: running.progress, stage: running.current_stage, payload: running.payload },
    error: latest?.status === "FAILED" && latest.error !== "Replaced by a newer request." ? { kind: latest.kind, message: latest.error as string } : null,
  });
});

const Put = z.object({
  profileId: z.uuid().nullable().optional(),
  voice: z.string().max(40).nullable().optional(),
  style: NarratorStyle.optional(),
  controls: NarratorControls.optional(),
  script: z.string().max(60_000).optional(),
  processing: NarratorProcessing.optional(),
  /** Sentence id → override (null clears it). */
  overrides: z.record(z.string().max(40), SentenceOverride.nullable()).optional(),
});

/** Save narrator settings. The script is split here, keeping audio for unchanged sentences. */
export const PUT = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/narrator">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id, "id, narrator");
  const body = await parseBody(req, Put);
  const n = parseNarrator(project.narrator);
  if (body.profileId !== undefined) n.profileId = body.profileId;
  if (body.voice !== undefined) n.voice = body.voice;
  if (body.style) n.style = body.style;
  if (body.controls) n.controls = body.controls;
  if (body.processing) n.processing = body.processing;
  if (body.script !== undefined) {
    n.script = body.script;
    n.sentences = splitScript(body.script, n.sentences);
  }
  if (body.overrides) n.sentences = n.sentences.map((s) => (s.id in body.overrides! ? { ...s, override: body.overrides![s.id] ?? null } : s));
  const { error } = await auth.supabase.from("projects").update({ narrator: n }).eq("id", project.id);
  if (error) throw error;
  return NextResponse.json({ narrator: n });
});
