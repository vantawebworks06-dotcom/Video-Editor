import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, requireUser, route } from "@/lib/api/server";
import { STYLE_PRESETS } from "@/lib/domain/presets";
import { StyleProfile } from "@/lib/domain/types";

export const GET = route(async () => {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from("style_profiles").select("id, name, description, source, profile, metrics, created_at").order("created_at", { ascending: false });
  if (error) throw error;
  return NextResponse.json({ presets: STYLE_PRESETS, profiles: data });
});

const Body = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(500).optional(), profile: StyleProfile });

/** Custom style: a user-tuned profile (usually started from a preset). */
export const POST = route(async (req: Request) => {
  const { supabase, userId } = await requireUser();
  const body = await parseBody(req, Body);
  const { data, error } = await supabase
    .from("style_profiles")
    .insert({ user_id: userId, name: body.name, description: body.description ?? null, source: "custom", profile: body.profile })
    .select("id")
    .single();
  if (error) throw error;
  return NextResponse.json({ id: data.id }, { status: 201 });
});
