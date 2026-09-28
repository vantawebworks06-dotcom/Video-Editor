import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseBody, requireUser, route } from "@/lib/api/server";
import { isProfileSamplePath } from "@/lib/narrator/samples";
import { BUCKET, createAdminClient, hasServiceRole } from "@/lib/supabase/admin";

/** The user's voice profiles, with playable sample URLs. */
export const GET = route(async () => {
  const auth = await requireUser();
  const { data, error } = await auth.supabase.from("voice_profiles").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  const all = (data ?? []).flatMap((p) => ((p.samples as { path: string }[]) ?? []).map((s) => ({ path: s.path, own: isProfileSamplePath(s.path, p.id as string) })));
  const urls = new Map<string, string>();
  // Samples in a profile's own folder outlive their project, so they're signed with the service
  // role; any other path only through the user's own storage access.
  const sign = async (paths: string[], admin: boolean) => {
    if (!paths.length) return;
    const storage = admin ? createAdminClient().storage : auth.supabase.storage;
    const { data: signed } = await storage.from(BUCKET).createSignedUrls(paths, 3600);
    for (const s of signed ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
  };
  const admin = hasServiceRole();
  await sign(all.filter((s) => s.own && admin).map((s) => s.path), true);
  await sign(all.filter((s) => !(s.own && admin)).map((s) => s.path), false);
  return NextResponse.json({
    profiles: (data ?? []).map((p) => ({ ...p, samples: ((p.samples as { path: string }[]) ?? []).map((s) => ({ ...s, url: urls.get(s.path) ?? null })) })),
  });
});

export const POST = route(async (req: NextRequest) => {
  const auth = await requireUser();
  const body = await parseBody(req, z.object({ name: z.string().trim().min(1).max(80), accent: z.enum(["us", "uk"]).default("us") }));
  const { data, error } = await auth.supabase.from("voice_profiles").insert({ user_id: auth.userId, name: body.name, accent: body.accent }).select("*").single();
  if (error) throw error;
  return NextResponse.json({ profile: { ...data, samples: [] } });
});
