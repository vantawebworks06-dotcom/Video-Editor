import { NextResponse, type NextRequest } from "next/server";
import { requireProject, requireUser, route } from "@/lib/api/server";
import { loadEdit } from "@/lib/data/store";
import { Transcript } from "@/lib/domain/types";

/** Scenes, placed visuals (with full source/licence data) and transcript words for the editor. */
export const GET = route(async (_req: NextRequest, ctx: RouteContext<"/api/projects/[id]/edit">) => {
  const auth = await requireUser();
  const id = (await ctx.params).id;
  // Both queries are RLS-scoped, so the edit can load while the project is checked. The editor
  // never uses each clip's fallback candidates, so they stay out of the response.
  const [p, edit] = await Promise.all([requireProject(auth, id), loadEdit(auth.supabase, id, { alternates: false })]);
  const t = Transcript.safeParse(p.transcript);
  return NextResponse.json({
    plans: edit.plans,
    clips: edit.selections.map((clip) => ({ ...clip, alternates: undefined })), // dropped from the JSON
    words: t.success ? t.data.words : [],
    duration: t.success ? t.data.duration : Number(p.narration_duration ?? 0),
  });
});
