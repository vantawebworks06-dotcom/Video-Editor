import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { getSearchCache, maybeAdmin } from "@/lib/api/media";
import { makeClaude, parseSettings } from "@/lib/data/project";
import { loadEdit, selectionToRow, upsertAssets } from "@/lib/data/store";
import { SfxKind, TextAnimation, TextPosition, TextStyle, type ScenePlan } from "@/lib/domain/types";
import { insertMeme } from "@/lib/pipeline/generate";
import { memeFor } from "@/lib/pipeline/heuristicDirector";
import { resolveCredentials } from "@/lib/settings/apiKeys";

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("text"),
    enabled: z.boolean(),
    text: z.string().max(60).default(""),
    style: TextStyle.default("key_phrase"),
    position: TextPosition.default("center"),
    animation: TextAnimation.default("pop"),
    at: z.number().min(0).max(600).default(0.3),
    duration: z.number().min(0.8).max(10).default(2),
  }),
  z.object({ action: z.literal("addSfx"), kind: SfxKind, at: z.number().min(0).max(600) }),
  z.object({ action: z.literal("removeSfx"), index: z.number().int().min(0).max(100) }),
  z.object({ action: z.literal("addMeme") }),
]);

export const POST = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/scenes/[sceneKey]">) => {
  const auth = await requireUser();
  const { id, sceneKey } = await ctx.params;
  const project = await requireProject(auth, id);
  const body = await parseBody(req, Body);
  const { data: scene } = await auth.supabase.from("scenes").select("id, plan").eq("project_id", project.id).eq("scene_key", sceneKey).maybeSingle();
  if (!scene) throw new HttpError(404, "Scene not found");
  const plan = scene.plan as ScenePlan;
  const sceneDur = plan.endTime - plan.startTime;
  let result: Record<string, unknown> = {};

  if (body.action === "text") {
    plan.textOverlay = {
      enabled: body.enabled && body.text.trim().length > 0,
      text: body.text.trim().toUpperCase(),
      style: body.style,
      position: body.position,
      animation: body.animation,
      at: Math.min(body.at, Math.max(0, sceneDur - 0.5)),
      duration: body.duration,
    };
  } else if (body.action === "addSfx") {
    plan.sfx.push({ kind: body.kind, at: Math.min(body.at, sceneDur), reason: "Added by user" });
  } else if (body.action === "removeSfx") {
    plan.sfx.splice(body.index, 1);
  } else {
    // Add Meme: explicit user request, so the frequency threshold is bypassed — but the
    // moment and reaction queries still come from Claude (or keyword rules without a key).
    const settings = parseSettings(project.settings);
    if (!settings.enabledProviders.includes("giphy")) throw new HttpError(400, "Enable GIPHY in the project settings first.");
    const creds = await resolveCredentials(auth.userId);
    if (!creds.giphy) throw new HttpError(400, "GIPHY API key is not configured (Settings → API Connections).");
    const { claude } = makeClaude(creds, settings, maybeAdmin(), { userId: auth.userId, projectId: project.id });
    const meme = claude ? await claude.suggestMeme(plan.narration, null, "HIGH") : memeFor(plan.narration, sceneDur);
    plan.meme = { ...meme, insert: true, at: Math.min(meme.at, Math.max(0, sceneDur - meme.duration)) };

    const edit = await loadEdit(auth.supabase, project.id);
    const sceneSelections = edit.selections.filter((s) => s.sceneId === sceneKey && s.role === "primary");
    if (edit.selections.some((s) => s.sceneId === sceneKey && s.role === "meme")) throw new HttpError(400, "This scene already has a meme.");
    const errors: { message: string }[] = [];
    const added = await insertMeme(plan, sceneSelections, { director: null as never, creds, searchCache: getSearchCache() }, { ...settings, allowReviewAssets: true }, errors as never, new Set(edit.selections.map((s) => s.asset.id)));
    if (!added) throw new HttpError(404, `No suitable reaction GIF found${errors.length ? `: ${errors[0]!.message}` : ""}.`);

    // Persist the scene's placements (host clip split around the meme).
    const assetIds = await upsertAssets(auth.supabase, auth.userId, sceneSelections.map((s) => s.asset));
    await auth.supabase.from("scene_assets").delete().eq("scene_id", scene.id);
    const rows = sceneSelections
      .sort((a, b) => a.start - b.start)
      .map((s, i) => selectionToRow({ userId: auth.userId, projectId: project.id }, { ...s, selectedBy: s.role === "meme" ? "user" : s.selectedBy }, scene.id, assetIds.get(s.asset.id)!, i));
    const { error } = await auth.supabase.from("scene_assets").insert(rows);
    if (error) throw error;
    result = { meme: added.asset.title, reason: meme.reason, rightsStatus: added.asset.rightsStatus };
  }

  const { error } = await auth.supabase.from("scenes").update({ plan }).eq("id", scene.id);
  if (error) throw error;
  await auth.supabase.from("projects").update({ timeline_version: Number(project.timeline_version ?? 0) + 1 }).eq("id", project.id);
  return NextResponse.json({ ok: true, ...result });
});
