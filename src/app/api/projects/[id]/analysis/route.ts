import { NextResponse, type NextRequest } from "next/server";
import { analysisSourceHash, analyzeTranscript } from "@/lib/analysis/analyze";
import type { TranscriptAnalysis } from "@/lib/analysis/types";
import { requireProject, requireUser, route } from "@/lib/api/server";
import { parseSettings } from "@/lib/data/project";
import { SupabaseSearchCache } from "@/lib/data/store";
import { DEMO_SCRIPT } from "@/lib/demo/script";
import { Transcript } from "@/lib/domain/types";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";

export const maxDuration = 60;

async function inputs(auth: Awaited<ReturnType<typeof requireUser>>, id: string) {
  const p = await requireProject(auth, id, "id, name, is_demo, script, transcript, settings, analysis");
  const t = Transcript.safeParse(p.transcript);
  const settings = parseSettings(p.settings);
  const script = (p.script as string | null) ?? (p.is_demo ? DEMO_SCRIPT : null);
  const input = { words: t.success ? t.data.words : null, script, topic: settings.topic, projectTitle: p.name };
  return { p, input, stored: (p.analysis as TranscriptAnalysis | null) ?? null };
}

/** The stored analysis, and whether it still matches the current transcript/script/topic. */
export const GET = route(async (_req: NextRequest, ctx: RouteContext<"/api/projects/[id]/analysis">) => {
  const auth = await requireUser();
  const { input, stored } = await inputs(auth, (await ctx.params).id);
  const hasText = Boolean(input.words?.length || input.script?.trim());
  return NextResponse.json({
    analysis: stored?.version === 1 ? stored : null,
    stale: Boolean(stored && stored.sourceHash !== analysisSourceHash(input)),
    canAnalyze: hasText,
  });
});

/** (Re)analyse the transcript — sentences, entities, claims, visual intents, scenes. */
export const POST = route(async (_req: NextRequest, ctx: RouteContext<"/api/projects/[id]/analysis">) => {
  const auth = await requireUser();
  const { p, input } = await inputs(auth, (await ctx.params).id);
  if (!input.words?.length && !input.script?.trim()) {
    return NextResponse.json({ error: "Nothing to analyse yet: upload a narration and generate (for a timed transcript), or paste the script in the Project tab." }, { status: 400 });
  }
  // Scenes follow the generated edit when there is one, so research links to timeline scenes.
  const { data: scenes } = await auth.supabase.from("scenes").select("scene_key, start_time, end_time").eq("project_id", p.id).order("idx");
  const plans = (scenes ?? []).map((s) => ({ sceneId: s.scene_key as string, startTime: Number(s.start_time), endTime: Number(s.end_time) }));
  const analysis = await analyzeTranscript({ ...input, plans }, { cache: hasServiceRole() ? new SupabaseSearchCache(createAdminClient()) : undefined });
  const { error } = await auth.supabase.from("projects").update({ analysis }).eq("id", p.id);
  if (error) throw error;
  return NextResponse.json({ analysis, stale: false, canAnalyze: true });
});
