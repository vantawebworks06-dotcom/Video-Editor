import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireUser, route } from "@/lib/api/server";
import { Look } from "@/lib/domain/look";
import { VoiceProcessing } from "@/lib/domain/voice";

/** The user's own saved presets: image looks and voice (audio) chains. Owner-scoped by RLS. */
const Kind = z.enum(["image", "audio"]);
const DATA = { image: Look, audio: VoiceProcessing } as const;

export const GET = route(async (req: NextRequest) => {
  const auth = await requireUser();
  const k = Kind.safeParse(req.nextUrl.searchParams.get("kind"));
  if (!k.success) throw new HttpError(400, "kind must be image or audio");
  const kind = k.data;
  const { data, error } = await auth.supabase.from("user_presets").select("id, name, data, created_at").eq("kind", kind).order("name");
  if (error) throw new Error(error.message);
  // Only presets that still validate (older shapes are skipped rather than breaking the list).
  return NextResponse.json({ presets: (data ?? []).filter((p) => DATA[kind].safeParse(p.data).success) });
});

export const POST = route(async (req: NextRequest) => {
  const auth = await requireUser();
  const body = await parseBody(req, z.object({ kind: Kind, name: z.string().trim().min(1).max(80), data: z.unknown() }));
  const parsed = DATA[body.kind].safeParse(body.data);
  if (!parsed.success) throw new HttpError(400, "Invalid preset settings.");
  // Same name replaces the earlier preset.
  const { data, error } = await auth.supabase
    .from("user_presets")
    .upsert({ user_id: auth.userId, kind: body.kind, name: body.name, data: { ...parsed.data, preset: "custom" } }, { onConflict: "user_id,kind,name" })
    .select("id, name, data")
    .single();
  if (error) throw new Error(error.message);
  return NextResponse.json({ preset: data });
});

export const DELETE = route(async (req: NextRequest) => {
  const auth = await requireUser();
  const p = z.uuid().safeParse(req.nextUrl.searchParams.get("id"));
  if (!p.success) throw new HttpError(400, "id must be a preset id");
  const id = p.data;
  const { error } = await auth.supabase.from("user_presets").delete().eq("id", id);
  if (error) throw new Error(error.message);
  return NextResponse.json({ ok: true });
});
