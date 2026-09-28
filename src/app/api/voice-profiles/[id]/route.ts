import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireUser, route } from "@/lib/api/server";
import { isProfileSamplePath } from "@/lib/narrator/samples";
import { BUCKET, createAdminClient, hasServiceRole } from "@/lib/supabase/admin";

async function load(auth: Awaited<ReturnType<typeof requireUser>>, id: string) {
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, "Voice profile not found");
  // RLS: only the owner's profiles are visible.
  const { data } = await auth.supabase.from("voice_profiles").select("*").eq("id", id).maybeSingle();
  if (!data) throw new HttpError(404, "Voice profile not found");
  return data as { id: string; samples: { path: string }[] };
}

/** Delete sample files: the profile's own folder with the service role (it may outlive its project), anything else as the user. */
async function removeSamples(auth: Awaited<ReturnType<typeof requireUser>>, profileId: string, paths: string[]) {
  const own = paths.filter((p) => isProfileSamplePath(p, profileId));
  const other = paths.filter((p) => !own.includes(p));
  if (own.length && hasServiceRole()) await createAdminClient().storage.from(BUCKET).remove(own);
  else if (own.length) other.push(...own);
  if (other.length) await auth.supabase.storage.from(BUCKET).remove(other);
}

const Patch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  accent: z.enum(["us", "uk"]).optional(),
  /** Word → how to say it (respelling), applied before synthesis. */
  pronunciations: z.record(z.string().trim().min(1).max(60), z.string().trim().min(1).max(120)).refine((r) => Object.keys(r).length <= 200, "Too many pronunciations").optional(),
  removeSample: z.string().max(400).optional(),
});

export const PATCH = route(async (req: NextRequest, ctx: RouteContext<"/api/voice-profiles/[id]">) => {
  const auth = await requireUser();
  const profile = await load(auth, (await ctx.params).id);
  const body = await parseBody(req, Patch);
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name) update.name = body.name;
  if (body.accent) {
    update.accent = body.accent;
    // The match was made among the old accent's voices.
    update.match = null;
  }
  if (body.pronunciations) update.pronunciations = body.pronunciations;
  if (body.removeSample) {
    if (!profile.samples.some((s) => s.path === body.removeSample)) throw new HttpError(404, "Sample not found");
    update.samples = profile.samples.filter((s) => s.path !== body.removeSample);
    // Measurements no longer describe the remaining samples.
    update.analysis = null;
    update.match = null;
    await removeSamples(auth, profile.id, [body.removeSample]);
  }
  const { data, error } = await auth.supabase.from("voice_profiles").update(update).eq("id", profile.id).select("*").single();
  if (error) throw error;
  return NextResponse.json({ profile: data });
});

export const DELETE = route(async (_req: NextRequest, ctx: RouteContext<"/api/voice-profiles/[id]">) => {
  const auth = await requireUser();
  const profile = await load(auth, (await ctx.params).id);
  await removeSamples(auth, profile.id, profile.samples.map((s) => s.path));
  const { error } = await auth.supabase.from("voice_profiles").delete().eq("id", profile.id);
  if (error) throw error;
  return NextResponse.json({ ok: true });
});
