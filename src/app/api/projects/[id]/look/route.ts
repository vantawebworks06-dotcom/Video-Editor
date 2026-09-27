import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { undoable } from "@/lib/data/history";
import { parseSettings } from "@/lib/data/project";
import { Look, LOOK_PRESET_LABEL } from "@/lib/domain/look";
import { ProjectSettings } from "@/lib/domain/types";

/** Set the project's image look; optionally make every clip follow it (clears clip overrides). Undoable. */
export const POST = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/look">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id, "id, settings, timeline_version");
  const { look, clearOverrides } = await parseBody(req, z.object({ look: Look, clearOverrides: z.boolean().default(false) }));
  const db = auth.supabase;
  let cleared = 0;
  await undoable(db, { userId: auth.userId, projectId: project.id }, `Project look: ${LOOK_PRESET_LABEL[look.preset]}`, async () => {
    const settings = ProjectSettings.parse({ ...parseSettings(project.settings), look });
    const { error } = await db.from("projects").update({ settings }).eq("id", project.id);
    if (error) throw new Error(error.message);
    if (!clearOverrides) return;
    const { data: rows } = await db.from("scene_assets").select("id, treatment").eq("project_id", project.id).not("treatment->look", "is", null);
    for (const r of rows ?? []) {
      const { look: _l, ...rest } = (r.treatment ?? {}) as Record<string, unknown>;
      void _l;
      await db.from("scene_assets").update({ treatment: rest }).eq("id", r.id);
      cleared++;
    }
  });
  await db.from("projects").update({ timeline_version: Number(project.timeline_version ?? 0) + 1 }).eq("id", project.id);
  return NextResponse.json({ ok: true, cleared });
});
