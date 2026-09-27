import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { parseSettings } from "@/lib/data/project";
import { undoable } from "@/lib/data/history";
import { OpError, placeItem } from "@/lib/data/timelineOps";
import { SourceAudio } from "@/lib/domain/sourceAudio";

const Body = z.object({
  itemId: z.uuid(),
  at: z.number().min(0).max(36000),
  duration: z.number().min(0.5).max(600).optional(),
  trimStart: z.number().min(0).max(36000).optional(),
  asSource: z.boolean().optional(),
  sourceAudio: SourceAudio.partial().optional(),
});

/** Place a media library item on the timeline at a narration time (undoable). */
export const POST = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/timeline/place">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id, "id, settings, narration_duration, timeline_version");
  const body = await parseBody(req, Body);
  const settings = parseSettings(project.settings);
  const narrationDuration = Number(project.narration_duration ?? 0);
  if (!narrationDuration) throw new HttpError(400, "The narration hasn't been measured yet — generate the edit first.");
  const c = { userId: auth.userId, projectId: project.id };
  const { data: item } = await auth.supabase.from("media_items").select("title").eq("id", body.itemId).eq("project_id", project.id).maybeSingle();
  if (!item) throw new HttpError(404, "Media item not found.");
  try {
    const r = await undoable(auth.supabase, c, `Place “${(item.title as string).slice(0, 60)}”`, () => placeItem(auth.supabase, c, { ...body, narrationDuration, defaultSourceAudio: settings.sourceAudioDefault }));
    await auth.supabase.from("projects").update({ timeline_version: Number(project.timeline_version ?? 0) + 1 }).eq("id", project.id);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof OpError) throw new HttpError(e.status, e.message);
    throw e;
  }
});
