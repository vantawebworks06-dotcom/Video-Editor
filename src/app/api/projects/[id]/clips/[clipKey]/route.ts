import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { Annotation, Layout, MotionType } from "@/lib/domain/types";

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update"),
    trimStart: z.number().min(0).max(36000).optional(),
    layout: Layout.optional(),
    motion: z.object({ type: MotionType, intensity: z.number().min(0).max(0.3) }).optional(),
    blackAndWhite: z.boolean().optional(),
    annotations: z.array(Annotation).max(5).optional(),
  }),
  z.object({ action: z.literal("resize"), duration: z.number().min(0.5).max(60) }),
  z.object({ action: z.literal("move"), direction: z.union([z.literal(-1), z.literal(1)]) }),
  z.object({ action: z.literal("delete") }),
]);

interface Row {
  id: string;
  scene_id: string;
  clip_key: string;
  start_time: number;
  duration: number;
  [k: string]: unknown;
}

const CONTENT_FIELDS = ["asset_id", "trim_start", "need_type", "need_description", "queries", "layout", "motion", "treatment", "annotations", "alternates", "scores", "overall_score", "reason", "role"] as const;

/** Edit a single placed visual. Only this clip (and at most one neighbour) changes — no full re-render needed. */
export const PATCH = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/clips/[clipKey]">) => {
  const auth = await requireUser();
  const { id, clipKey } = await ctx.params;
  const project = await requireProject(auth, id);
  const body = await parseBody(req, Body);
  const db = auth.supabase;

  const { data: clip } = await db.from("scene_assets").select("*").eq("project_id", project.id).eq("clip_key", clipKey).maybeSingle<Row>();
  if (!clip) throw new HttpError(404, "Clip not found");
  const { data: siblingsRaw } = await db.from("scene_assets").select("*").eq("scene_id", clip.scene_id).order("start_time");
  const siblings = (siblingsRaw ?? []) as Row[];
  const i = siblings.findIndex((s) => s.id === clip.id);
  const prev = siblings[i - 1];
  const next = siblings[i + 1];

  const save = async (rowId: string, fields: Record<string, unknown>) => {
    const { error } = await db.from("scene_assets").update(fields).eq("id", rowId);
    if (error) throw error;
  };

  switch (body.action) {
    case "update": {
      const fields: Record<string, unknown> = { selected_by: "user" };
      if (body.trimStart !== undefined) fields.trim_start = body.trimStart;
      if (body.layout) fields.layout = body.layout;
      if (body.motion) fields.motion = body.motion;
      if (body.blackAndWhite !== undefined) fields.treatment = { blackAndWhite: body.blackAndWhite, grain: body.blackAndWhite };
      if (body.annotations) fields.annotations = body.annotations;
      await save(clip.id, fields);
      break;
    }
    case "resize": {
      // Narration timing is fixed, so a neighbour in the same scene absorbs the change.
      const delta = body.duration - Number(clip.duration);
      if (next) {
        const nd = Number(next.duration) - delta;
        if (nd < 0.5) throw new HttpError(400, "The next clip would become shorter than 0.5s.");
        await save(clip.id, { duration: body.duration });
        await save(next.id, { start_time: Number(next.start_time) + delta, duration: nd });
      } else if (prev) {
        const pd = Number(prev.duration) - delta;
        if (pd < 0.5) throw new HttpError(400, "The previous clip would become shorter than 0.5s.");
        await save(prev.id, { duration: pd });
        await save(clip.id, { start_time: Number(clip.start_time) - delta, duration: body.duration });
      } else {
        throw new HttpError(400, "This is the only clip in the scene; its length follows the narration.");
      }
      break;
    }
    case "move": {
      const other = body.direction === -1 ? prev : next;
      if (!other) throw new HttpError(400, "Nothing to swap with in that direction (clips move within their scene).");
      // Swap content, keep the narration-locked time slots.
      const a = Object.fromEntries(CONTENT_FIELDS.map((f) => [f, clip[f]]));
      const b = Object.fromEntries(CONTENT_FIELDS.map((f) => [f, other[f]]));
      await save(clip.id, { ...b, selected_by: "user" });
      await save(other.id, { ...a, selected_by: "user" });
      break;
    }
    case "delete": {
      if (!prev && !next) throw new HttpError(400, "A scene needs at least one visual. Use Replace instead.");
      if (prev) await save(prev.id, { duration: Number(prev.duration) + Number(clip.duration) });
      else await save(next!.id, { start_time: Number(clip.start_time), duration: Number(next!.duration) + Number(clip.duration) });
      const { error } = await db.from("scene_assets").delete().eq("id", clip.id);
      if (error) throw error;
      break;
    }
  }
  await db.from("projects").update({ timeline_version: Number(project.timeline_version ?? 0) + 1 }).eq("id", project.id);
  return NextResponse.json({ ok: true });
});
