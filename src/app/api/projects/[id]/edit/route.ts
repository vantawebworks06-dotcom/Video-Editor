import { NextResponse, type NextRequest } from "next/server";
import { requireProject, requireUser, route } from "@/lib/api/server";
import { loadEdit } from "@/lib/data/store";
import { Transcript } from "@/lib/domain/types";

/** Scenes, placed visuals (with full source/licence data) and transcript words for the editor. */
export const GET = route(async (_req: NextRequest, ctx: RouteContext<"/api/projects/[id]/edit">) => {
  const auth = await requireUser();
  const p = await requireProject(auth, (await ctx.params).id);
  const edit = await loadEdit(auth.supabase, p.id);
  const t = Transcript.safeParse(p.transcript);
  return NextResponse.json({
    plans: edit.plans,
    clips: edit.selections,
    words: t.success ? t.data.words : [],
    duration: t.success ? t.data.duration : Number(p.narration_duration ?? 0),
  });
});
