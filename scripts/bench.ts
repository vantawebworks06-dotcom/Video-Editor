/**
 * Performance benchmark. Run it before and after a change and compare the JSON it writes.
 *
 *   npm run bench -- <label> [pipeline] [prepare] [ui] [api]
 *
 * - pipeline: generateEdit on the demo narration (heuristic director, real provider searches),
 *             cold (empty search cache) and warm (same cache again).
 * - prepare:  draft-render asset preparation (download + normalise) for the first video clips.
 * - ui:       server-render the Timeline component with a realistic edit: time + element count.
 * - api:      latency of GET /status and GET /edit as a signed-in user. Needs the app on BASE_URL
 *             (default http://localhost:3100). Creates and deletes a throwaway user and project.
 *
 * Results: .cache/bench/<label>.json
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServerClient } from "@supabase/ssr";
import { createPlayhead } from "@/components/editor/playhead";
import { Timeline } from "@/components/editor/Timeline";
import type { Clip, EditData } from "@/components/editor/types";
import { saveGeneration } from "@/lib/data/store";
import { DEMO_SCRIPT } from "@/lib/demo/script";
import { getPreset } from "@/lib/domain/presets";
import { DEFAULT_SETTINGS, type ProjectSettings } from "@/lib/domain/types";
import { MemorySearchCache, type CachedSearch, type SearchCache } from "@/lib/media/cache";
import { generateEdit, type GenerateResult } from "@/lib/pipeline/generate";
import { HeuristicDirector } from "@/lib/pipeline/heuristicDirector";
import { toAssetRef } from "@/lib/pipeline/timelineBuilder";
import { alignScriptToAudio } from "@/lib/pipeline/transcript";
import { detectSilences, probe } from "@/lib/render/ffmpeg";
import { library } from "@/lib/render/library";
import { prepareAsset } from "@/lib/render/prepare";
import { resolveEnvCredentials } from "@/lib/settings/credentials";
import { createAdminClient } from "@/lib/supabase/admin";

const label = process.argv[2];
if (!label) throw new Error("Pass a label, e.g. `before` or `after`");
const sections = new Set(process.argv.slice(3));
const all = sections.size === 0;
const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const OUT = path.join(process.cwd(), ".cache", "bench");
const results: Record<string, unknown> = { label, at: new Date().toISOString() };

const ms = (t0: number) => Math.round(performance.now() - t0);
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { n: s.length, median: q(0.5), p90: q(0.9), min: s[0]!, max: s.at(-1)! };
};

/** Counts real provider calls (cache misses that were stored) and cache hits. */
class CountingCache implements SearchCache {
  gets = 0;
  hits = 0;
  sets = 0;
  constructor(private inner: SearchCache) {}
  async get(k: string) {
    this.gets++;
    const v = await this.inner.get(k);
    if (v) this.hits++;
    return v;
  }
  async set(k: string, v: CachedSearch) {
    this.sets++;
    await this.inner.set(k, v);
  }
}

async function demoTranscript() {
  const info = await probe(library.demoNarration);
  return alignScriptToAudio(DEMO_SCRIPT, info.duration ?? 60, await detectSilences(library.demoNarration));
}

const preset = getPreset("dancehall_documentary");
const settings: ProjectSettings = { ...DEFAULT_SETTINGS, stylePreset: preset.key, memeFrequency: "MEDIUM", captions: "DYNAMIC", paperStyle: preset.defaultPaper };

async function runGenerate(cache: SearchCache) {
  const transcript = await demoTranscript();
  const stageAt: Record<string, number> = {};
  const t0 = performance.now();
  const result = await generateEdit(
    { projectTitle: "Bench", transcript, settings, style: preset.profile, orientation: "landscape" },
    {
      director: new HeuristicDirector(),
      creds: resolveEnvCredentials(),
      searchCache: cache,
      onProgress: (s) => {
        const k = s.split("…")[0]!;
        stageAt[k] ??= ms(t0);
      },
    },
  );
  return { totalMs: ms(t0), stageStartMs: stageAt, result, words: transcript.words.length, duration: transcript.duration };
}

async function benchPipeline(): Promise<GenerateResult> {
  const mem = new MemorySearchCache();
  const cold = new CountingCache(mem);
  const a = await runGenerate(cold);
  const warm = new CountingCache(mem);
  const b = await runGenerate(warm);
  const summary = (r: typeof a, c: CountingCache) => ({
    totalMs: r.totalMs,
    stageStartMs: r.stageStartMs,
    scenes: r.result.plans.length,
    clips: r.result.selections.length,
    cacheLookups: c.gets,
    cacheHits: c.hits,
    providerCalls: c.sets,
    searchErrors: r.result.searchErrors.length,
  });
  results.pipeline = { narrationSeconds: a.duration, words: a.words, cold: summary(a, cold), warm: summary(b, warm) };
  console.log("pipeline", JSON.stringify(results.pipeline, null, 1));
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, `${label}.generate.json`), JSON.stringify(a.result));
  return a.result;
}

async function benchPrepare(result: GenerateResult) {
  const videos = result.selections.filter((s) => s.asset.type === "video" && !s.asset.id.startsWith("uploaded")).slice(0, 3);
  const cacheDir = path.join(OUT, `prepare-${label}`);
  await rm(cacheDir, { recursive: true, force: true });
  const clips: { asset: string; ms: number; width: number | null; height: number | null; error?: string }[] = [];
  for (const s of videos) {
    const t0 = performance.now();
    try {
      const p = await prepareAsset(
        toAssetRef(s.asset), // exactly what the renderer passes
        { trimStart: s.trimStart, duration: s.duration },
        { cacheDir, draft: true },
      );
      clips.push({ asset: s.asset.id, ms: ms(t0), width: p.width, height: p.height });
    } catch (err) {
      clips.push({ asset: s.asset.id, ms: ms(t0), width: null, height: null, error: (err as Error).message.slice(0, 120) });
    }
  }
  results.prepare = { draft: true, clips, totalMs: clips.reduce((n, c) => n + c.ms, 0) };
  console.log("prepare", JSON.stringify(results.prepare, null, 1));
  await rm(cacheDir, { recursive: true, force: true });
}

async function benchUi(result: GenerateResult | null) {
  const src = result ?? (JSON.parse(await readFile(path.join(OUT, "before.generate.json"), "utf8")) as GenerateResult);
  const transcript = await demoTranscript();
  // A 10-minute edit: repeat the generated clips over 600 s so sizes match a real project.
  const reps = Math.ceil(600 / transcript.duration);
  const clips: Clip[] = [];
  const plans: EditData["plans"] = [];
  const words: EditData["words"] = [];
  for (let r = 0; r < reps; r++) {
    const off = r * transcript.duration;
    for (const p of src.plans) plans.push({ ...p, sceneId: `${p.sceneId}_${r}`, startTime: p.startTime + off, endTime: p.endTime + off });
    for (const s of src.selections) clips.push({ ...s, rowId: `${s.clipId}_${r}`, assetRowId: "x", userApproved: false, sceneId: `${s.sceneId}_${r}`, start: s.start + off, scores: null } as Clip);
    for (const w of transcript.words) words.push({ ...w, start: w.start + off, end: w.end + off });
  }
  const data: EditData = { plans, clips, words, duration: reps * transcript.duration };
  const peaks = Array.from({ length: 1200 }, (_, i) => Math.abs(Math.sin(i / 7)));
  const noop = () => undefined;
  const store = createPlayhead();
  const render = (withPeaks: boolean, t: number) => {
    store.set(t);
    return renderToString(createElement(Timeline, { data, peaks: withPeaks ? peaks : null, playhead: store, musicLabel: "Ambient", selectedClip: null, selectedScene: null, onSelectClip: noop, onSelectScene: noop, onSeek: noop }));
  };
  const measure = (withPeaks: boolean) => {
    const html = render(withPeaks, 0);
    for (let i = 0; i < 5; i++) render(withPeaks, i); // warm up
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      render(withPeaks, i * 0.25);
      times.push(performance.now() - t0);
    }
    return { elements: (html.match(/<[a-z]/g) ?? []).length, htmlKB: Math.round(html.length / 1024), renderMs: stats(times.map((t) => Math.round(t * 10) / 10)) };
  };
  results.ui = { clips: clips.length, scenes: plans.length, words: words.length, withWaveform: measure(true), withoutWaveform: measure(false) };
  console.log("ui", JSON.stringify(results.ui, null, 1));
}

async function benchApi(result: GenerateResult | null) {
  const admin = createAdminClient();
  const email = `docucut-bench-${Date.now()}@example.com`;
  const password = `Bench-${crypto.randomUUID()}`;
  const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const userId = created.user.id;
  let projectId: string | null = null;
  try {
    const jar = new Map<string, string>();
    const ssr = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (l) => l.forEach(({ name, value }) => jar.set(name, value)) },
    });
    await ssr.auth.signInWithPassword({ email, password });
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const call = async (p: string, init: { method?: string; json?: unknown } = {}) => {
      const t0 = performance.now();
      const r = await fetch(BASE + p, { method: init.method ?? "GET", headers: { cookie, ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}) }, body: init.json !== undefined ? JSON.stringify(init.json) : undefined });
      const text = await r.text();
      if (!r.ok) throw new Error(`${p} → ${r.status}: ${text.slice(0, 200)}`);
      return { ms: ms(t0), bytes: text.length, body: JSON.parse(text) as Record<string, unknown> };
    };

    projectId = (await call("/api/projects", { method: "POST", json: { name: "Bench project", stylePreset: "dancehall_documentary" } })).body.id as string;
    // A narration and an export in Storage so /status signs URLs like it does for a real project.
    const media = await readFile(path.join(process.cwd(), "output", "autoedit-draft.mp4")).catch(() => Buffer.alloc(4096));
    const narrationPath = `${projectId}/uploads/narration-bench.mp4`;
    const exportPath = `${projectId}/renders/bench.mp4`;
    for (const p of [narrationPath, exportPath]) {
      const { error: upErr } = await admin.storage.from("projects").upload(p, media.subarray(0, 256 * 1024), { contentType: "video/mp4", upsert: true });
      if (upErr) throw upErr;
    }
    // A realistic 10-minute transcript on the project row (the old status route read it every poll).
    const t = await demoTranscript();
    const reps = Math.ceil(600 / t.duration);
    const words = Array.from({ length: reps }, (_, r) => t.words.map((w) => ({ ...w, start: w.start + r * t.duration, end: w.end + r * t.duration }))).flat();
    await admin.from("projects").update({ narration_path: narrationPath, narration_duration: reps * t.duration, transcript: { ...t, words, duration: reps * t.duration } }).eq("id", projectId);
    await admin.from("exports").insert({ project_id: projectId, user_id: userId, format: "draft", storage_path: exportPath, size_bytes: media.length, duration: 60 });
    if (result) await saveGeneration(admin, { userId, projectId }, result);

    const first = await call(`/api/projects/${projectId}/status`); // compile + warm up
    await call(`/api/projects/${projectId}/edit`);
    const status: number[] = [];
    let statusBytes = 0;
    for (let i = 0; i < 15; i++) {
      const r = await call(`/api/projects/${projectId}/status`);
      status.push(r.ms);
      statusBytes = r.bytes;
    }
    // Steady-state poll: the editor reports the signed URLs it already holds (ignored by old code).
    const exportId = (first.body.latestExport as { id?: string } | null)?.id ?? "";
    const poll: number[] = [];
    for (let i = 0; i < 15; i++) poll.push((await call(`/api/projects/${projectId}/status?exportId=${exportId}&narration=${encodeURIComponent(narrationPath)}`)).ms);

    // The browser's XHR upload, reproduced with fetch: same URL, headers and multipart body.
    const start = (await call(`/api/projects/${projectId}/uploads`, { method: "POST", json: { step: "start", kind: "narration", filename: "bench.mp4", mime: "video/mp4", size: 256 * 1024 } })).body as { path: string; token: string };
    const form = new FormData();
    form.append("cacheControl", "3600");
    form.append("", new Blob([media.subarray(0, 256 * 1024)], { type: "video/mp4" }), "bench.mp4");
    const up = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/upload/sign/projects/${start.path.split("/").map(encodeURIComponent).join("/")}?token=${encodeURIComponent(start.token)}`, {
      method: "PUT",
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, "x-upsert": "false" },
      body: form,
    });
    const complete = up.ok ? await call(`/api/projects/${projectId}/uploads`, { method: "POST", json: { step: "complete", kind: "narration", path: start.path } }).then(() => "ok", (e: Error) => e.message) : `HTTP ${up.status} ${await up.text()}`;
    const edit: number[] = [];
    let editBytes = 0;
    for (let i = 0; i < 8; i++) {
      const r = await call(`/api/projects/${projectId}/edit`);
      edit.push(r.ms);
      editBytes = r.bytes;
    }
    results.api = { status: { ...stats(status), bytes: statusBytes }, statusPoll: stats(poll), edit: { ...stats(edit), bytes: editBytes }, signedUpload: complete };
    console.log("api", JSON.stringify(results.api, null, 1));
  } finally {
    if (projectId) {
      const paths: string[] = [];
      for (const dir of ["uploads", "renders", "audio"]) {
        const { data: files } = await admin.storage.from("projects").list(`${projectId}/${dir}`);
        paths.push(...(files ?? []).map((f) => `${projectId}/${dir}/${f.name}`));
      }
      if (paths.length) await admin.storage.from("projects").remove(paths);
      await admin.from("projects").delete().eq("id", projectId);
    }
    await admin.auth.admin.deleteUser(userId);
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  let result: GenerateResult | null = null;
  if (all || sections.has("pipeline") || sections.has("prepare")) result = await benchPipeline();
  if (result && (all || sections.has("prepare"))) await benchPrepare(result);
  if (all || sections.has("ui")) await benchUi(null); // baseline edit, for comparable sizes
  // Same edit in every run so /edit payloads are comparable (search results vary between runs).
  if (all || sections.has("api")) await benchApi(JSON.parse(await readFile(path.join(OUT, "before.generate.json"), "utf8")) as GenerateResult);
  await writeFile(path.join(OUT, `${label}.json`), JSON.stringify(results, null, 2));
  console.log(`\nwrote .cache/bench/${label}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
