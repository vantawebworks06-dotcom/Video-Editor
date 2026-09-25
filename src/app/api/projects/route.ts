import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, requireUser, route } from "@/lib/api/server";
import { getPreset, STYLE_PRESETS } from "@/lib/domain/presets";
import { CaptionMode, DEFAULT_SETTINGS, MemeFrequency } from "@/lib/domain/types";

export const GET = route(async () => {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, status, is_demo, updated_at, narration_duration, settings")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return NextResponse.json({ projects: data });
});

const CreateBody = z.object({
  name: z.string().trim().min(1).max(200),
  stylePreset: z.enum(STYLE_PRESETS.map((p) => p.key) as [string, ...string[]]).optional(),
  // Auto-Edit options chosen at upload time.
  memeFrequency: MemeFrequency.optional(),
  captions: CaptionMode.optional(),
  originalFootage: z.enum(["replace", "mix"]).optional(),
});

export const POST = route(async (req: Request) => {
  const { supabase, userId } = await requireUser();
  const body = await parseBody(req, CreateBody);
  const preset = getPreset(body.stylePreset ?? "documentary");
  const { data, error } = await supabase
    .from("projects")
    .insert({
      user_id: userId,
      name: body.name,
      settings: {
        ...DEFAULT_SETTINGS,
        stylePreset: preset.key,
        memeFrequency: body.memeFrequency ?? preset.defaultMemeFrequency,
        paperStyle: preset.defaultPaper,
        captions: body.captions ?? DEFAULT_SETTINGS.captions,
        originalFootage: body.originalFootage ?? DEFAULT_SETTINGS.originalFootage,
      },
    })
    .select("id")
    .single();
  if (error) throw error;
  return NextResponse.json({ id: data.id }, { status: 201 });
});
