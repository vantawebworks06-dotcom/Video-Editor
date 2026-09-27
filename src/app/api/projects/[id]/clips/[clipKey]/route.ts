import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { undoable } from "@/lib/data/history";
import { parseSettings } from "@/lib/data/project";
import { cutBase, loadRows, newClipKey, type Row } from "@/lib/data/timelineOps";
import { SourceAudio } from "@/lib/domain/sourceAudio";
import { Annotation, Layout, MotionType, Transition } from "@/lib/domain/types";

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update"),
    trimStart: z.number().min(0).max(36000).optional(),
    layout: Layout.optional(),
    motion: z.object({ type: MotionType, intensity: z.number().min(0).max(0.3) }).optional(),
    blackAndWhite: z.boolean().optional(),
    annotations: z.array(Annotation).max(8).optional(),
  }),
  z.object({
    action: z.literal("resize"),
    duration: z.number().min(0.5).max(600),
  }),
  z.object({
    action: z.literal("move"),
    direction: z.union([z.literal(-1), z.literal(1)]),
  }),
  z.object({ action: z.literal("delete") }),
  /** Move/trim/extend in narration time (start and/or end edge). */
  z.object({
    action: z.literal("retime"),
    start: z.number().min(0).max(36000).optional(),
    duration: z.number().min(0.3).max(600).optional(),
    trimStart: z.number().min(0).max(36000).optional(),
  }),
  z.object({ action: z.literal("split"), at: z.number().min(0).max(36000) }),
  z.object({ action: z.literal("audio"), sourceAudio: SourceAudio.partial() }),
  z.object({ action: z.literal("role"), role: z.enum(["primary", "source"]) }),
  z.object({ action: z.literal("transition"), transitionIn: Transition }),
]);

const CONTENT_FIELDS = [
  "asset_id",
  "trim_start",
  "need_type",
  "need_description",
  "queries",
  "layout",
  "motion",
  "treatment",
  "annotations",
  "alternates",
  "scores",
  "overall_score",
  "reason",
  "role",
  "audio",
  "media_item_id",
] as const;
const LABEL: Record<string, string> = {
  update: "Edit clip",
  resize: "Resize clip",
  move: "Move clip",
  delete: "Delete clip",
  retime: "Trim/move clip",
  split: "Split clip",
  audio: "Change source audio",
  role: "Change clip audio role",
  transition: "Change transition",
};
const round = (n: number) => Math.round(n * 1000) / 1000;

/** Edit one placed visual. Every change is undoable (a snapshot is saved first). */
export const PATCH = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/clips/[clipKey]">) => {
  const auth = await requireUser();
  const { id, clipKey } = await ctx.params;
  const project = await requireProject(auth, id, "id, settings, narration_duration, timeline_version");
  const body = await parseBody(req, Body);
  const db = auth.supabase;

  const rows = await loadRows(db, project.id);
  const clip = rows.find((r) => r.clip_key === clipKey);
  if (!clip) throw new HttpError(404, "Clip not found");
  const isSource = clip.role === "source";
  const track = rows.filter((r) => r.role !== "source");
  const siblings = rows.filter((r) => r.scene_id === clip.scene_id && r.role !== "source");
  const i = siblings.findIndex((s) => s.id === clip.id);
  const prev = siblings[i - 1];
  const next = siblings[i + 1];
  const narrationEnd = Number(project.narration_duration ?? 0) || Infinity;

  const save = async (rowId: string, fields: Record<string, unknown>) => {
    const { error } = await db.from("scene_assets").update(fields).eq("id", rowId);
    if (error) throw error;
  };
  const isVideo = (r: Row) => r.need_type === "video" || r.need_type === "archival" || r.need_type === "reaction";
  await undoable(db, { userId: auth.userId, projectId: project.id }, `${LABEL[body.action]} ${clipKey}`, async () => {
    switch (body.action) {
      case "update": {
        const fields: Record<string, unknown> = { selected_by: "user" };
        if (body.trimStart !== undefined) fields.trim_start = body.trimStart;
        if (body.layout) fields.layout = body.layout;
        if (body.motion) fields.motion = body.motion;
        // Merge: the treatment also carries the clip's transition (and effects), which a B&W toggle must keep.
        if (body.blackAndWhite !== undefined)
          fields.treatment = {
            ...(clip.treatment ?? {}),
            blackAndWhite: body.blackAndWhite,
            grain: body.blackAndWhite,
          };
        if (body.annotations) fields.annotations = body.annotations;
        await save(clip.id, fields);
        break;
      }
      case "transition":
        await save(clip.id, {
          treatment: {
            ...(clip.treatment ?? {}),
            transitionIn: body.transitionIn,
          },
          selected_by: "user",
        });
        break;
      case "resize": {
        if (isSource) {
          await save(clip.id, {
            duration: body.duration,
            selected_by: "user",
          });
          break;
        }
        // Narration timing is fixed, so a neighbour in the same scene absorbs the change.
        const delta = body.duration - clip.duration;
        if (next) {
          const nd = next.duration - delta;
          if (nd < 0.5) throw new HttpError(400, "The next clip would become shorter than 0.5s.");
          await save(clip.id, { duration: body.duration });
          await save(next.id, {
            start_time: next.start_time + delta,
            duration: nd,
            trim_start: isVideo(next) ? Math.max(0, next.trim_start + delta) : next.trim_start,
          });
        } else if (prev) {
          const pd = prev.duration - delta;
          if (pd < 0.5) throw new HttpError(400, "The previous clip would become shorter than 0.5s.");
          await save(prev.id, { duration: pd });
          await save(clip.id, {
            start_time: clip.start_time - delta,
            duration: body.duration,
          });
        } else {
          throw new HttpError(400, "This is the only clip in the scene; its length follows the narration.");
        }
        break;
      }
      case "retime": {
        const start = round(body.start ?? clip.start_time);
        const duration = round(body.duration ?? clip.duration);
        const end = start + duration;
        if (isSource) {
          const clash = rows.find((r) => r.role === "source" && r.id !== clip.id && r.start_time < end - 1e-6 && r.start_time + r.duration > start + 1e-6);
          if (clash) throw new HttpError(409, `That overlaps another source clip (${clash.clip_key}).`);
          if (start >= narrationEnd) throw new HttpError(400, "A source clip must start within the narration.");
          await save(clip.id, {
            start_time: start,
            duration,
            ...(body.trimStart !== undefined ? { trim_start: body.trimStart } : {}),
            selected_by: "user",
          });
          break;
        }
        // Picture track: the neighbours on either side give or take the time.
        const t = track.findIndex((r) => r.id === clip.id);
        const before = track[t - 1];
        const after = track[t + 1];
        if (before && start - before.start_time < 0.3) throw new HttpError(400, "That would leave the previous clip shorter than 0.3 s.");
        if (after && after.start_time + after.duration - end < 0.3) throw new HttpError(400, "That would leave the next clip shorter than 0.3 s.");
        if (!before && start > 0.001) throw new HttpError(400, "The first clip starts with the narration.");
        if (!after && Math.abs(end - (clip.start_time + clip.duration)) > 0.001) throw new HttpError(400, "The last clip ends with the narration.");
        if (before)
          await save(before.id, {
            duration: round(start - before.start_time),
          });
        if (after) {
          const shift = end - after.start_time;
          await save(after.id, {
            start_time: round(end),
            duration: round(after.duration - shift),
            trim_start: isVideo(after) ? Math.max(0, round(after.trim_start + shift)) : after.trim_start,
          });
        }
        const trimShift = start - clip.start_time;
        await save(clip.id, {
          start_time: start,
          duration,
          trim_start: body.trimStart ?? (isVideo(clip) ? Math.max(0, round(clip.trim_start + trimShift)) : clip.trim_start),
          selected_by: "user",
        });
        break;
      }
      case "split": {
        const cut = body.at - clip.start_time;
        if (cut < 0.3 || clip.duration - cut < 0.3) throw new HttpError(400, "Split point must be at least 0.3 s from either end of the clip.");
        await save(clip.id, { duration: round(cut) });
        const { id: _id, created_at: _c, updated_at: _u, ...copy } = clip;
        void _id;
        void _c;
        void _u;
        const { error } = await db.from("scene_assets").insert({
          ...copy,
          clip_key: newClipKey(clip.clip_key.split("_")[0]),
          start_time: round(body.at),
          duration: round(clip.duration - cut),
          trim_start: isVideo(clip) || isSource ? round(clip.trim_start + cut) : clip.trim_start,
          treatment: {
            ...(clip.treatment ?? {}),
            transitionIn: "hard_cut",
          },
        });
        if (error) throw error;
        break;
      }
      case "audio": {
        if (!isSource) throw new HttpError(400, "Only source clips play their own audio. Set this clip to “Source (play its audio)” first.");
        const merged = SourceAudio.parse({
          ...parseSettings(project.settings).sourceAudioDefault,
          ...((clip.audio as object) ?? {}),
          ...body.sourceAudio,
        });
        await save(clip.id, { audio: merged, selected_by: "user" });
        break;
      }
      case "role": {
        if (body.role === "source" && !isSource) {
          if (!isVideo(clip)) throw new HttpError(400, "Only video clips have audio to play.");
          const end = clip.start_time + clip.duration;
          const clash = rows.find((r) => r.role === "source" && r.start_time < end && r.start_time + r.duration > clip.start_time);
          if (clash) throw new HttpError(409, "Another source clip already plays here.");
          // The picture track closes the gap: the previous clip (or the next) takes over the time.
          const t = track.findIndex((r) => r.id === clip.id);
          const before = track[t - 1];
          const after = track[t + 1];
          if (before)
            await save(before.id, {
              duration: round(before.duration + clip.duration),
            });
          else if (after)
            await save(after.id, {
              start_time: clip.start_time,
              duration: round(after.duration + clip.duration),
              trim_start: isVideo(after) ? Math.max(0, round(after.trim_start - clip.duration)) : after.trim_start,
            });
          else throw new HttpError(400, "The picture track needs at least one other clip.");
          await save(clip.id, {
            role: "source",
            audio: parseSettings(project.settings).sourceAudioDefault,
            motion: { type: "none", intensity: 0 },
            selected_by: "user",
          });
        } else if (body.role === "primary" && isSource) {
          await cutBase(db, rows, clip.start_time, Math.min(clip.start_time + clip.duration, narrationEnd));
          await save(clip.id, {
            role: "primary",
            audio: null,
            duration: round(Math.min(clip.duration, narrationEnd - clip.start_time)),
            selected_by: "user",
          });
        }
        break;
      }
      case "move": {
        if (isSource) throw new HttpError(400, "Move source clips by changing their start time.");
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
        if (!isSource) {
          if (!prev && !next) throw new HttpError(400, "A scene needs at least one visual. Use Replace instead.");
          if (prev)
            await save(prev.id, {
              duration: prev.duration + clip.duration,
            });
          else
            await save(next!.id, {
              start_time: clip.start_time,
              duration: next!.duration + clip.duration,
            });
        }
        const { error } = await db.from("scene_assets").delete().eq("id", clip.id);
        if (error) throw error;
        break;
      }
    }
  });
  await db
    .from("projects")
    .update({ timeline_version: Number(project.timeline_version ?? 0) + 1 })
    .eq("id", project.id);
  return NextResponse.json({ ok: true });
});
