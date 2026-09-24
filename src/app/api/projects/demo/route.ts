import { NextResponse } from "next/server";
import { requireUser, route } from "@/lib/api/server";
import { DEMO_SCRIPT, DEMO_TITLE } from "@/lib/demo/script";
import { getPreset } from "@/lib/domain/presets";
import { DEFAULT_SETTINGS } from "@/lib/domain/types";

/** Demo Mode: a fictional documentary using the worker's generated TTS narration — no uploads needed. */
export const POST = route(async () => {
  const { supabase, userId } = await requireUser();
  const preset = getPreset("dancehall_documentary");
  const { data: project, error } = await supabase
    .from("projects")
    .insert({
      user_id: userId,
      name: DEMO_TITLE,
      is_demo: true,
      script: DEMO_SCRIPT,
      settings: { ...DEFAULT_SETTINGS, stylePreset: preset.key, memeFrequency: "MEDIUM", captions: "DYNAMIC", paperStyle: preset.defaultPaper },
    })
    .select("id")
    .single();
  if (error) throw error;
  const { error: jobErr } = await supabase
    .from("pipeline_jobs")
    .insert({ project_id: project.id, user_id: userId, kind: "generate", status: "QUEUED" });
  if (jobErr) throw jobErr;
  return NextResponse.json({ id: project.id }, { status: 201 });
});
