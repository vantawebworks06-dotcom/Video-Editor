/**
 * DocuCut render/pipeline worker. Runs where FFmpeg can run for minutes at a time
 * (your machine or a VPS) — not on Vercel serverless functions.
 *
 *   npm run worker
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-only).
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeClaude, makeDirector, parseSettings, resolveStyle } from "@/lib/data/project";
import { type AssetRow, assetRowToNormalized, type LoadedEdit, loadEdit, saveGeneration, SupabaseSearchCache } from "@/lib/data/store";
import { DEMO_SCRIPT } from "@/lib/demo/script";
import { ACTIVE_RENDER_STATUSES, JOB_CANCELLED, OutputFormat, type ProjectSettings, Transcript, type AssetRef } from "@/lib/domain/types";
import { applyOriginalFootage, narrationFootageAsset } from "@/lib/pipeline/originalFootage";
import { transcribeLocally } from "@/lib/transcription/local";
import { stableHash } from "@/lib/media/cache";
import { LocalLibraryMusicProvider } from "@/lib/media/music";
import { looksAiGenerated } from "@/lib/media/rights";
import { generateEdit, type SceneSelection } from "@/lib/pipeline/generate";
import { buildTimeline } from "@/lib/pipeline/timelineBuilder";
import { alignScriptToAudio } from "@/lib/pipeline/transcript";
import { analyzeReferenceVideo } from "@/lib/reference/analyze";
import { bindProcessesTo, detectSilences, probe, runFfmpeg } from "@/lib/render/ffmpeg";
import { library, libraryReady } from "@/lib/render/library";
import { renderTimeline } from "@/lib/render/render";
import { resolveCredentials } from "@/lib/settings/apiKeys";
import { BUCKET, createAdminClient } from "@/lib/supabase/admin";
import { transcribeWithWhisper } from "@/lib/transcription/whisper";

const WORKER_ID = `${os.hostname()}-${process.pid}`;
const ROOT = path.join(process.cwd(), ".cache");
const STORAGE_CACHE = path.join(ROOT, "storage");
const TEMP_RETENTION_HOURS = Number(process.env.TEMP_RETENTION_HOURS ?? 24);
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 3000);
const MAX_NARRATION_SECONDS = 60 * 60;

const db = createAdminClient();
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function downloadObject(objectPath: string): Promise<string> {
  await mkdir(STORAGE_CACHE, { recursive: true });
  const ext = (objectPath.split(".").pop() ?? "bin").replace(/[^a-z0-9]/gi, "").slice(0, 5);
  const local = path.join(STORAGE_CACHE, `${stableHash(objectPath).slice(0, 32)}.${ext}`);
  if (existsSync(local)) return local;
  const { data, error } = await db.storage.from(BUCKET).download(objectPath);
  if (error || !data) throw new Error(`Could not download ${objectPath} from storage: ${error?.message ?? "no data"}`);
  await writeFile(local, Buffer.from(await data.arrayBuffer()));
  return local;
}

async function uploadFile(local: string, objectPath: string, contentType: string) {
  const body = await readFile(local);
  const { error } = await db.storage.from(BUCKET).upload(objectPath, body, { contentType, upsert: true });
  if (error) throw new Error(error.message);
}

function throttle<T extends unknown[]>(fn: (...a: T) => Promise<void>, ms: number) {
  let last = 0;
  return async (...a: T) => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    await fn(...a).catch(() => undefined);
  };
}

// ---------------------------------------------------------------------------
// Narration + transcript
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  is_demo: boolean;
  settings: unknown;
  style_profile_id: string | null;
  narration_path: string | null;
  script: string | null;
  transcript: unknown;
  reference_video_path: string | null;
  music_path: string | null;
  timeline_version: number;
}

async function loadProject(id: string): Promise<ProjectRow> {
  const { data, error } = await db.from("projects").select("*").eq("id", id).single();
  if (error || !data) throw new Error(`Project ${id} not found`);
  return data as ProjectRow;
}

interface NarrationInfo {
  path: string; // extracted narration audio (original channels, 48 kHz PCM) — the edit's backbone
  duration: number;
  /** The uploaded file itself, when it is a video (for "mix" mode). */
  video: { storagePath: string; width: number | null; height: number | null } | null;
}

/** Validate the upload and extract its narration audio untouched (no trimming, no re-timing). */
async function narrationAudio(p: ProjectRow): Promise<NarrationInfo> {
  if (p.is_demo && !p.narration_path) {
    if (!existsSync(library.demoNarration)) throw new Error("Demo narration missing: run `npm run assets:generate` on the worker machine.");
    const info = await probe(library.demoNarration);
    return { path: library.demoNarration, duration: info.duration ?? 0, video: null };
  }
  if (!p.narration_path) throw new Error("Upload a narration (audio or video) first.");
  const src = await downloadObject(p.narration_path);
  const info = await probe(src).catch(() => null);
  if (!info) throw new Error("The uploaded file could not be read — it may be corrupt or an unsupported codec.");
  if (!info.hasAudio) throw new Error("The uploaded file has no audio track, so there is no narration to edit around.");
  if (!info.duration || info.duration < 2) throw new Error("The narration is too short.");
  if (info.duration > MAX_NARRATION_SECONDS) throw new Error("The narration is longer than 60 minutes.");
  const wav = `${src}.voice.wav`;
  if (!existsSync(wav)) await runFfmpeg(["-i", src, "-vn", "-map", "0:a:0", "-ar", "48000", "-c:a", "pcm_s16le", wav]);
  return {
    path: wav,
    duration: info.duration,
    video: info.hasVideo ? { storagePath: p.narration_path, width: info.width, height: info.height } : null,
  };
}

/**
 * Transcript with word timestamps, cached on the project. Order: saved transcript →
 * user-supplied script (advanced option) → OpenAI Whisper API if a key exists → local Whisper (free).
 */
async function ensureTranscript(
  p: ProjectRow,
  audio: { path: string; duration: number },
  creds: { openai?: string },
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<Transcript> {
  const existing = Transcript.safeParse(p.transcript);
  if (existing.success && Math.abs(existing.data.duration - audio.duration) < 0.5) return existing.data;

  const script = p.is_demo && !p.script ? DEMO_SCRIPT : p.script;
  let transcript: Transcript;
  if (script?.trim()) {
    transcript = alignScriptToAudio(script, audio.duration, await detectSilences(audio.path));
  } else if (creds.openai && process.env.TRANSCRIPTION_PROVIDER !== "local") {
    const mp3 = `${audio.path}.stt.mp3`;
    if (!existsSync(mp3)) await runFfmpeg(["-i", audio.path, "-ac", "1", "-ar", "16000", "-b:a", "48k", mp3]);
    transcript = await transcribeWithWhisper(mp3, creds.openai, audio.duration);
  } else {
    transcript = await transcribeLocally(audio.path, audio.duration, onProgress, signal);
  }
  await db.from("projects").update({ transcript, narration_duration: audio.duration }).eq("id", p.id);
  return transcript;
}

// ---------------------------------------------------------------------------
// Pipeline jobs
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  project_id: string;
  user_id: string;
  kind?: "generate" | "regenerate_scenes" | "analyze_reference";
  payload?: Record<string, unknown>;
  format?: OutputFormat;
}

async function runPipelineJob(job: JobRow, signal: AbortSignal) {
  const update = (fields: Record<string, unknown>) =>
    db.from("pipeline_jobs").update({ ...fields, heartbeat_at: new Date().toISOString() }).eq("id", job.id);
  // p < 0 → update the stage label only (keep the current percentage). A new stage
  // ("Searching for footage" → "Adding reactions") is always reported; repeats are throttled.
  const send = async (stage: string, p: number) => {
    await update(p < 0 ? { current_stage: stage } : { current_stage: stage, progress: Math.min(1, Math.max(0, p)) }).then(undefined, () => undefined);
  };
  const throttled = throttle(send, 700);
  let lastStage = "";
  // Every progress report doubles as a cancellation checkpoint.
  const progress = async (stage: string, p: number) => {
    signal.throwIfAborted();
    const kind = stage.split("…")[0]!;
    if (kind !== lastStage) {
      lastStage = kind;
      await send(stage, p);
    } else await throttled(stage, p);
  };

  const project = await loadProject(job.project_id);
  const settings = parseSettings(project.settings);
  const creds = await resolveCredentials(project.user_id);
  const { claude, usage } = makeClaude(creds, settings, db, { userId: project.user_id, projectId: project.id });

  if (job.kind === "analyze_reference") {
    if (!project.reference_video_path) throw new Error("Upload a reference video first.");
    await progress("Analysing reference video", 0.1);
    const file = await downloadObject(project.reference_video_path);
    const analysis = await analyzeReferenceVideo(file, { workDir: path.join(ROOT, "reference", job.id), claude: claude ?? undefined });
    signal.throwIfAborted();
    const { data: profile, error } = await db
      .from("style_profiles")
      .insert({ user_id: project.user_id, name: `Reference: ${project.name}`.slice(0, 120), source: "reference", profile: analysis.profile, metrics: { ...analysis.metrics, measured: analysis.measured, estimated: analysis.estimated, method: analysis.method, notes: analysis.notes } })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    if (job.payload?.apply !== false) await db.from("projects").update({ style_profile_id: profile.id }).eq("id", project.id);
    await rm(path.join(ROOT, "reference", job.id), { recursive: true, force: true });
    return { styleProfileId: profile.id, ...analysis };
  }

  await db.from("projects").update({ status: "processing", last_error: null }).eq("id", project.id);
  await progress("Analyzing narration…", 0.02);
  const audio = await narrationAudio(project);
  await progress("Transcribing…", 0.04);
  const transcript = await ensureTranscript(project, audio, creds, (f) => void progress(`Transcribing… ${Math.round(f * 100)}%`, 0.04 + f * 0.21).catch(() => undefined), signal);
  const style = await resolveStyle(db, project.style_profile_id, settings);
  const director = makeDirector(claude, settings);
  const orientation = "landscape" as const;

  let onlySceneIds: Set<string> | undefined;
  let existing: LoadedEdit | undefined;
  if (job.kind === "regenerate_scenes") {
    const ids = Array.isArray(job.payload?.sceneIds) ? (job.payload!.sceneIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
    if (!ids.length) throw new Error("No scenes selected to regenerate.");
    existing = await loadEdit(db, project.id);
    onlySceneIds = new Set(ids);
  }

  // The user's own library (favourites in the Media Library) is preferred when relevant.
  const { data: favs } = await db.from("assets").select("*").eq("user_id", project.user_id).eq("is_favorite", true).limit(300);
  const userLibrary = ((favs ?? []) as AssetRow[]).map(assetRowToNormalized).filter((a) => a.provider !== "graphic" && !looksAiGenerated(a));

  const result = await generateEdit(
    { projectTitle: project.name, transcript, settings, style, orientation, onlySceneIds, existing },
    { director, creds, library: userLibrary, searchCache: new SupabaseSearchCache(db), onProgress: (s, p) => progress(s, p < 0 ? p : 0.25 + p * 0.72), log: (m) => log(`[${job.id.slice(0, 8)}] ${m}`), signal },
  );
  if (settings.originalFootage === "mix" && audio.video) {
    applyOriginalFootage(result.selections, result.plans, narrationFootageAsset(audio.video.storagePath, { ...audio.video, duration: audio.duration }), onlySceneIds);
  }
  await progress("Building timeline…", 0.98); // last checkpoint: a cancelled job never replaces the edit
  await saveGeneration(db, { userId: project.user_id, projectId: project.id }, result, onlySceneIds);
  await db.from("projects").update({ status: "ready", timeline_version: project.timeline_version + 1 }).eq("id", project.id);

  // Auto-Edit: optionally queue a preview render as soon as the timeline is ready.
  const autoRender = OutputFormat.safeParse(job.payload?.autoRender);
  if (autoRender.success && !signal.aborted) {
    await db.from("render_jobs").insert({ project_id: project.id, user_id: project.user_id, format: autoRender.data, timeline_version: project.timeline_version + 1 });
  }

  const errorSummary: Record<string, number> = {};
  for (const e of result.searchErrors) errorSummary[`${e.provider}:${e.code}`] = (errorSummary[`${e.provider}:${e.code}`] ?? 0) + 1;
  const reviewSummary: Record<string, number> = {};
  for (const r of result.review ?? []) reviewSummary[`${r.problem}:${r.action}`] = (reviewSummary[`${r.problem}:${r.action}`] ?? 0) + 1;
  return {
    director: director.label,
    scenes: result.plans.length,
    clips: result.selections.length,
    review: reviewSummary,
    warnings: result.warnings.slice(0, 50),
    searchErrors: errorSummary,
    ai: usage.totals,
  };
}

// ---------------------------------------------------------------------------
// Render jobs
// ---------------------------------------------------------------------------

/** Rights gate: nothing UNKNOWN/RESTRICTED reaches the renderer without explicit approval. */
function renderableSelections(selections: LoadedEdit["selections"], settings: ProjectSettings, warn: (m: string) => void): SceneSelection[] {
  return selections.filter((s) => {
    if (looksAiGenerated(s.asset)) {
      warn(`${s.clipId}: AI-generated asset removed from render (${s.asset.title}).`);
      return false;
    }
    const st = s.asset.rightsStatus;
    if (st === "RESTRICTED") {
      warn(`${s.clipId}: restricted asset removed from render (${s.asset.title}).`);
      return false;
    }
    if (st === "UNKNOWN" && !(s.userApproved && settings.allowApprovedUnknown)) {
      warn(`${s.clipId}: unknown-rights asset skipped (approve it and enable "Allow approved unknown-rights assets").`);
      return false;
    }
    if (st === "USER_REVIEW" && !(settings.allowReviewAssets || s.userApproved)) {
      warn(`${s.clipId}: review-required asset skipped.`);
      return false;
    }
    return true;
  });
}

async function runRenderJob(job: JobRow, signal: AbortSignal) {
  const warnings: string[] = [];
  // Only while still active: a progress write must never revive a cancelled render.
  const update = (fields: Record<string, unknown>) =>
    db.from("render_jobs").update({ ...fields, heartbeat_at: new Date().toISOString() }).eq("id", job.id).in("status", [...ACTIVE_RENDER_STATUSES]);
  const stageUpdate = throttle(async (status: string, p: number, message: string) => {
    await update({ status, progress: Math.min(1, p), current_stage: message });
  }, 800);

  const project = await loadProject(job.project_id);
  const settings = parseSettings(project.settings);
  const edit = await loadEdit(db, project.id);
  if (!edit.selections.length) throw new Error("Nothing to render — generate the edit first.");
  const audio = await narrationAudio(project);
  const transcript = await ensureTranscript(project, audio, await resolveCredentials(project.user_id), (f) => void stageUpdate("DOWNLOADING", 0, `Transcribing… ${Math.round(f * 100)}%`), signal);
  const selections = renderableSelections(edit.selections, settings, (m) => warnings.push(m));
  if (!selections.length) throw new Error("Every visual was removed by the rights gate. Review assets in the Rights panel.");

  let music: string | null = null;
  if (settings.musicTrack === "uploaded" && project.music_path) music = await downloadObject(project.music_path);
  else if (settings.musicTrack !== "none") music = await new LocalLibraryMusicProvider().resolve(settings.musicTrack);

  const format = job.format ?? "landscape";
  const resolveTrack = (key: string) => (existsSync(library.music(key)) ? library.music(key) : null);
  const timeline = buildTimeline({ plans: edit.plans, selections, transcript, settings, format, voicePath: audio.path, musicPath: music, resolveTrack });
  const outPath = path.join(ROOT, "renders", `${job.id}.mp4`);
  const result = await renderTimeline(timeline, {
    workDir: path.join(ROOT, "render", job.id),
    outPath,
    draft: format === "draft",
    resolveLocal: async (ref: AssetRef) => {
      if (!ref.assetId.startsWith("uploaded:")) return null;
      // "uploaded:narration:<path>" = the narration video itself; "uploaded:<path>" = other uploads.
      return downloadObject(ref.assetId.slice("uploaded:".length).replace(/^narration:/, ""));
    },
    onStage: (s, p, m) => {
      signal.throwIfAborted();
      return stageUpdate(s, p, m);
    },
    log: (m) => log(`[render ${job.id.slice(0, 8)}] ${m}`),
  });
  warnings.push(...result.warnings);
  signal.throwIfAborted();

  const size = (await stat(outPath)).size;
  const objectPath = `${project.id}/renders/${job.id}.mp4`;
  let storagePath: string | null = objectPath;
  try {
    await uploadFile(outPath, objectPath, "video/mp4");
  } catch (err) {
    storagePath = null;
    warnings.push(`Upload to Supabase Storage failed (${(err as Error).message}); ${Math.round(size / 1e6)} MB file kept on the worker at ${outPath}. Your Storage plan's upload limit may be too small for this render.`);
  }
  if (storagePath) {
    await db.from("exports").insert({
      project_id: project.id,
      user_id: project.user_id,
      render_job_id: job.id,
      format,
      storage_path: storagePath,
      size_bytes: size,
      duration: result.duration,
      attributions: timeline.attributions,
    });
  }
  await rm(path.join(ROOT, "render", job.id), { recursive: true, force: true });
  return { output_path: storagePath ?? outPath, warnings };
}

// ---------------------------------------------------------------------------
// Loop, recovery, cleanup
// ---------------------------------------------------------------------------

async function claim<T>(fn: "claim_pipeline_job" | "claim_render_job"): Promise<T | null> {
  const { data, error } = await db.rpc(fn, { p_worker: WORKER_ID });
  if (error) throw new Error(`${fn}: ${error.message}`);
  return (Array.isArray(data) ? data[0] : data) ?? null;
}

/**
 * Watch a claimed job for cancellation (the cancel API marks it FAILED). On cancel the signal
 * aborts, FFmpeg processes are killed, and `run` settles at once instead of waiting for the job
 * to reach its next checkpoint.
 */
function watchJob(table: "pipeline_jobs" | "render_jobs", id: string) {
  const ctl = new AbortController();
  bindProcessesTo(ctl.signal);
  const timer = setInterval(async () => {
    const { data } = await db.from(table).select("status").eq("id", id).maybeSingle();
    if (data?.status === "FAILED" && !ctl.signal.aborted) ctl.abort(new Error(JOB_CANCELLED));
  }, 2000);
  const aborted = new Promise<never>((_, reject) => ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason), { once: true }));
  aborted.catch(() => undefined);
  return {
    signal: ctl.signal,
    run: <T>(work: Promise<T>) => Promise.race([work, aborted]),
    stop: () => clearInterval(timer),
  };
}

/** A cancelled generation leaves the previous edit in place. */
async function restoreProjectStatus(projectId: string) {
  const { data } = await db.from("projects").select("timeline_version").eq("id", projectId).maybeSingle();
  await db.from("projects").update({ status: Number(data?.timeline_version ?? 0) > 0 ? "ready" : "draft", last_error: null }).eq("id", projectId);
}

async function recoverStaleJobs() {
  const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  await db.from("pipeline_jobs").update({ status: "FAILED", error: "Worker stopped responding; please retry.", completed_at: new Date().toISOString() }).eq("status", "RUNNING").lt("heartbeat_at", cutoff);
  await db.from("render_jobs").update({ status: "FAILED", error: "Worker stopped responding; please retry.", completed_at: new Date().toISOString() }).in("status", ["DOWNLOADING", "PREPARING", "RENDERING", "FINALIZING"]).lt("heartbeat_at", cutoff);
}

async function cleanup() {
  const cutoff = Date.now() - TEMP_RETENTION_HOURS * 3600_000;
  // Local caches.
  for (const dir of ["render", "renders", "storage", "reference"]) {
    const full = path.join(ROOT, dir);
    for (const name of await readdir(full).catch(() => [] as string[])) {
      const p = path.join(full, name);
      const s = await stat(p).catch(() => null);
      if (s && s.mtimeMs < cutoff) await rm(p, { recursive: true, force: true });
    }
  }
  // Storage temp/ folders.
  const { data: projects } = await db.from("projects").select("id").limit(1000);
  for (const p of projects ?? []) {
    const { data: files } = await db.storage.from(BUCKET).list(`${p.id}/temp`, { limit: 1000 });
    const stale = (files ?? []).filter((f) => f.created_at && new Date(f.created_at).getTime() < cutoff).map((f) => `${p.id}/temp/${f.name}`);
    if (stale.length) await db.storage.from(BUCKET).remove(stale);
  }
  // Old search cache rows.
  await db.from("search_cache").delete().lt("created_at", new Date(Date.now() - 7 * 86400_000).toISOString());
}

async function main() {
  if (!libraryReady()) throw new Error("Asset library missing — run `npm run assets:generate` first.");
  log(`worker ${WORKER_ID} started (poll ${POLL_MS}ms, temp retention ${TEMP_RETENTION_HOURS}h)`);
  let lastMaintenance = 0;
  for (;;) {
    try {
      if (Date.now() - lastMaintenance > 10 * 60_000) {
        lastMaintenance = Date.now();
        await recoverStaleJobs();
        await cleanup().catch((e) => log("cleanup failed:", (e as Error).message));
      }
      const pj = await claim<JobRow>("claim_pipeline_job");
      if (pj) {
        log(`pipeline job ${pj.id} (${pj.kind}) for project ${pj.project_id}`);
        const watch = watchJob("pipeline_jobs", pj.id);
        try {
          const result = await watch.run(runPipelineJob(pj, watch.signal));
          await db.from("pipeline_jobs").update({ status: "COMPLETE", progress: 1, current_stage: "Done", result, completed_at: new Date().toISOString() }).eq("id", pj.id).eq("status", "RUNNING");
          log(`pipeline job ${pj.id} complete`);
        } catch (err) {
          if (watch.signal.aborted) {
            log(`pipeline job ${pj.id} cancelled`);
            if (pj.kind !== "analyze_reference") await restoreProjectStatus(pj.project_id);
          } else {
            const msg = (err as Error).message;
            log(`pipeline job ${pj.id} failed: ${msg}`);
            await db.from("pipeline_jobs").update({ status: "FAILED", error: msg.slice(0, 2000), completed_at: new Date().toISOString() }).eq("id", pj.id).eq("status", "RUNNING");
            if (pj.kind !== "analyze_reference") await db.from("projects").update({ status: "error", last_error: msg.slice(0, 2000) }).eq("id", pj.project_id);
          }
        } finally {
          watch.stop();
        }
        continue;
      }
      const rj = await claim<JobRow>("claim_render_job");
      if (rj) {
        log(`render job ${rj.id} (${rj.format}) for project ${rj.project_id}`);
        const watch = watchJob("render_jobs", rj.id);
        try {
          const r = await watch.run(runRenderJob(rj, watch.signal));
          await db.from("render_jobs").update({ status: "COMPLETE", progress: 1, current_stage: "Complete", output_path: r.output_path, warnings: r.warnings.slice(0, 100), completed_at: new Date().toISOString() }).eq("id", rj.id).in("status", [...ACTIVE_RENDER_STATUSES]);
          log(`render job ${rj.id} complete`);
        } catch (err) {
          if (watch.signal.aborted) {
            log(`render job ${rj.id} cancelled`);
            await rm(path.join(ROOT, "render", rj.id), { recursive: true, force: true }).catch(() => undefined);
          } else {
            const msg = (err as Error).message;
            log(`render job ${rj.id} failed: ${msg}`);
            await db.from("render_jobs").update({ status: "FAILED", error: msg.slice(0, 2000), completed_at: new Date().toISOString() }).eq("id", rj.id).in("status", [...ACTIVE_RENDER_STATUSES]);
          }
        } finally {
          watch.stop();
        }
        continue;
      }
    } catch (err) {
      log("worker loop error:", (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
