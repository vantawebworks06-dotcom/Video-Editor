import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import type { TranscriptAnalysis } from "@/lib/analysis/types";
import { undoable } from "@/lib/data/history";
import type { Graphic } from "@/lib/domain/graphics";
import type { ScenePlan } from "@/lib/domain/types";
import { suggestGraphics } from "@/lib/pipeline/graphicsSuggest";

/**
 * Add graphics suggested by the transcript analysis (names, places, dates, figures, quotes…).
 * replace: remove earlier suggestions first (the user's own graphics are always kept). Undoable.
 */
export const POST = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/graphics/suggest">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id, "id, analysis, timeline_version");
  const { replace } = await parseBody(req, z.object({ replace: z.boolean().default(true) }));
  const analysis = project.analysis as TranscriptAnalysis | null;
  if (!analysis) throw new HttpError(400, "Analyse the script first (SCRIPT → Analyse).");
  if (!analysis.timed) throw new HttpError(400, "The analysis has no narration timing yet — generate the edit, then analyse again.");
  const db = auth.supabase;
  const { data: rows } = await db.from("scenes").select("id, scene_key, plan").eq("project_id", project.id).order("start_time");
  const scenes = (rows ?? []).map((r) => ({ id: r.id as string, plan: r.plan as ScenePlan }));
  if (!scenes.length) throw new HttpError(400, "Generate the edit first.");

  const keep = scenes.flatMap((s) => (s.plan.graphics ?? []).filter((g) => !replace || g.source !== "analysis").map((g) => ({ sceneId: s.plan.sceneId, graphic: g })));
  const found = suggestGraphics(analysis, scenes.map((s) => s.plan), { keep });
  let added = 0;
  await undoable(db, { userId: auth.userId, projectId: project.id }, `Suggest graphics (${found.length})`, async () => {
    for (const s of scenes) {
      const mine = keep.filter((k) => k.sceneId === s.plan.sceneId).map((k) => k.graphic);
      const fresh: Graphic[] = found.filter((f) => f.sceneId === s.plan.sceneId).map((f) => ({ ...f.graphic, id: `g${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}` }));
      const before = s.plan.graphics ?? [];
      if (!fresh.length && mine.length === before.length) continue;
      const plan = { ...s.plan, graphics: [...mine, ...fresh].sort((a, b) => a.at - b.at) };
      const { error } = await db.from("scenes").update({ plan }).eq("id", s.id);
      if (error) throw new Error(error.message);
      added += fresh.length;
    }
  });
  await db.from("projects").update({ timeline_version: Number(project.timeline_version ?? 0) + 1 }).eq("id", project.id);
  return NextResponse.json({ ok: true, added, suggestions: found.map((f) => ({ kind: f.graphic.kind, title: f.graphic.title, at: Math.round(f.t * 10) / 10 })) });
});
