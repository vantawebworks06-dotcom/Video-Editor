import { NextResponse, type NextRequest } from "next/server";
import { requireProject, requireUser, route } from "@/lib/api/server";
import { parseSettings } from "@/lib/data/project";
import { BUCKET } from "@/lib/supabase/admin";

/** Polled by the editor: project state, latest jobs, latest export and AI usage. */
export const GET = route(async (_req: NextRequest, ctx: RouteContext<"/api/projects/[id]/status">) => {
  const auth = await requireUser();
  const p = await requireProject(auth, (await ctx.params).id);
  const [pipeline, render, exp, usage] = await Promise.all([
    auth.supabase.from("pipeline_jobs").select("id, kind, status, progress, current_stage, error, result, created_at, completed_at").eq("project_id", p.id).order("created_at", { ascending: false }).limit(1),
    auth.supabase.from("render_jobs").select("id, status, progress, current_stage, format, error, warnings, created_at, completed_at, output_path").eq("project_id", p.id).order("created_at", { ascending: false }).limit(1),
    auth.supabase.from("exports").select("id, format, storage_path, size_bytes, duration, attributions, created_at").eq("project_id", p.id).order("created_at", { ascending: false }).limit(1),
    auth.supabase.from("project_ai_usage").select("calls, cached_calls, input_tokens, output_tokens, cost_usd").eq("project_id", p.id).maybeSingle(),
  ]);

  const latestExport = exp.data?.[0] ?? null;
  let exportUrl: string | null = null;
  if (latestExport) {
    const { data } = await auth.supabase.storage.from(BUCKET).createSignedUrl(latestExport.storage_path, 3600);
    exportUrl = data?.signedUrl ?? null;
  }
  let narrationUrl: string | null = null;
  if (typeof p.narration_path === "string") {
    const { data } = await auth.supabase.storage.from(BUCKET).createSignedUrl(p.narration_path, 3600);
    narrationUrl = data?.signedUrl ?? null;
  }

  return NextResponse.json({
    project: {
      id: p.id,
      name: p.name,
      status: p.status,
      isDemo: p.is_demo,
      lastError: p.last_error,
      timelineVersion: p.timeline_version,
      hasNarration: Boolean(p.narration_path) || p.is_demo,
      hasScript: Boolean(p.script),
      script: p.script,
      hasReference: Boolean(p.reference_video_path),
      hasMusic: Boolean(p.music_path),
      narrationDuration: p.narration_duration,
      styleProfileId: p.style_profile_id,
      settings: parseSettings(p.settings),
    },
    pipelineJob: pipeline.data?.[0] ?? null,
    renderJob: render.data?.[0] ?? null,
    latestExport: latestExport ? { ...latestExport, url: exportUrl } : null,
    narrationUrl,
    usage: usage.data ?? { calls: 0, cached_calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
  });
});
