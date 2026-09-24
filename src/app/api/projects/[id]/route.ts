import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { parseSettings } from "@/lib/data/project";
import { STYLE_PRESETS } from "@/lib/domain/presets";
import { AudioMix, ProjectSettings } from "@/lib/domain/types";
import { BUCKET } from "@/lib/supabase/admin";

const PatchBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  script: z.string().max(200_000).nullable().optional(),
  styleProfileId: z.uuid().nullable().optional(),
  settings: ProjectSettings.omit({ mix: true }).partial().extend({ mix: AudioMix.partial().optional() }).optional(),
});

export const PATCH = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id);
  const body = await parseBody(req, PatchBody);
  const update: Record<string, unknown> = {};
  if (body.name !== undefined) update.name = body.name;
  if (body.script !== undefined) {
    update.script = body.script;
    update.transcript = null; // re-align on next generation
  }
  if (body.styleProfileId !== undefined) update.style_profile_id = body.styleProfileId;
  if (body.settings) {
    const current = parseSettings(project.settings);
    if (body.settings.stylePreset && !STYLE_PRESETS.some((p) => p.key === body.settings!.stylePreset)) {
      return NextResponse.json({ error: "Unknown style preset" }, { status: 400 });
    }
    const next = { ...current, ...body.settings, mix: { ...current.mix, ...(body.settings.mix ?? {}) } };
    const clamped = { ...next, mix: Object.fromEntries(Object.entries(next.mix).map(([k, v]) => [k, Math.min(2, Math.max(0, Number(v)))])) };
    update.settings = ProjectSettings.parse(clamped);
  }
  const { error } = await auth.supabase.from("projects").update(update).eq("id", project.id);
  if (error) throw error;
  return NextResponse.json({ ok: true });
});

export const DELETE = route(async (_req: NextRequest, ctx: RouteContext<"/api/projects/[id]">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id);
  // Remove this project's storage objects (RLS allows owners to delete inside their project folder).
  for (const folder of ["audio", "assets", "thumbnails", "renders", "temp"]) {
    const { data } = await auth.supabase.storage.from(BUCKET).list(`${project.id}/${folder}`, { limit: 1000 });
    const paths = (data ?? []).map((f) => `${project.id}/${folder}/${f.name}`);
    if (paths.length) await auth.supabase.storage.from(BUCKET).remove(paths);
  }
  const { error } = await auth.supabase.from("projects").delete().eq("id", project.id);
  if (error) throw error;
  return NextResponse.json({ ok: true });
});
