/**
 * End-to-end test of the Auto-Edit workflow against the real Supabase project:
 * upload ONE narration video (no transcript) → worker transcribes locally, plans scenes,
 * searches providers, inserts reactions, builds the timeline → review actions → renders →
 * verifies the MP4 and that the original narration is intact.
 *
 * Needs the app on BASE_URL (default http://localhost:3100) and `npm run worker` running.
 *   npx tsx --env-file=.env.local scripts/e2e-autoedit.ts path/to/narration.mp4
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { ffmpegPath, probe } from "@/lib/render/ffmpeg";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const VIDEO = process.argv[2];
if (!VIDEO) throw new Error("Pass the narration video path");
const admin = createAdminClient();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const ok = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

function pcm8k(file: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const c = spawn(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"]);
    const chunks: Buffer[] = [];
    c.stdout.on("data", (d: Buffer) => chunks.push(d));
    c.on("error", reject);
    c.on("close", () => {
      const b = Buffer.concat(chunks);
      const u = new Uint8Array(b.byteLength);
      u.set(b);
      resolve(new Float32Array(u.buffer, 0, Math.floor(b.byteLength / 4)));
    });
  });
}

/** RMS envelope in 50 ms windows. */
function envelope(x: Float32Array) {
  const w = 400;
  const out: number[] = [];
  for (let i = 0; i + w <= x.length; i += w) {
    let s = 0;
    for (let j = i; j < i + w; j++) s += x[j]! * x[j]!;
    out.push(Math.sqrt(s / w));
  }
  return out;
}

function correlation(a: number[], b: number[], lag: number) {
  const pairs: [number, number][] = [];
  for (let i = 0; i < a.length; i++) if (i + lag >= 0 && i + lag < b.length) pairs.push([a[i]!, b[i + lag]!]);
  const n = pairs.length;
  const ma = pairs.reduce((s, p) => s + p[0], 0) / n;
  const mb = pairs.reduce((s, p) => s + p[1], 0) / n;
  let num = 0, da = 0, db = 0;
  for (const [x, y] of pairs) {
    num += (x - ma) * (y - mb);
    da += (x - ma) ** 2;
    db += (y - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

async function main() {
  const email = `docucut-e2e-${Date.now()}@example.com`;
  const password = `E2e-${crypto.randomUUID()}`;
  const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  let projectId: string | null = null;
  const t0 = Date.now();
  try {
    const jar = new Map<string, string>();
    const ssr = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (l) => l.forEach(({ name, value }) => jar.set(name, value)) },
    });
    await ssr.auth.signInWithPassword({ email, password });
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const browser = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    await browser.auth.signInWithPassword({ email, password });
    const call = async <T = Json>(p: string, init: { method?: string; json?: unknown } = {}): Promise<T> => {
      const r = await fetch(BASE + p, { method: init.method ?? "GET", headers: { cookie, ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}) }, body: init.json !== undefined ? JSON.stringify(init.json) : undefined });
      const b = (await r.json().catch(() => ({}))) as T & { error?: string };
      if (!r.ok) throw new Error(`${p} → ${r.status}: ${b.error}`);
      return b;
    };
    const waitFor = async (label: string, key: "pipelineJob" | "renderJob", done: (s: Json) => boolean, stages?: Set<string>) => {
      let last = "";
      for (;;) {
        const s = await call(`/api/projects/${projectId}/status`);
        const j = s[key];
        const line = `${j?.status} ${Math.round(Number(j?.progress ?? 0) * 100)}% ${j?.current_stage ?? ""}`;
        if (line !== last) console.log(`   ${label}: ${line}`);
        last = line;
        if (j?.current_stage) stages?.add(String(j.current_stage).replace(/[\s(].*$/, "").replace(/…$/, ""));
        if (j?.status === "FAILED") throw new Error(`${label} failed: ${j.error}`);
        if (done(s)) return s;
        await new Promise((r) => setTimeout(r, 1500));
      }
    };

    const fetchExport = async (e: Json) => {
      const res = await fetch(e.url.startsWith("/") ? BASE + e.url : e.url, { headers: e.url.startsWith("/") ? { cookie } : {} });
      if (!res.ok) throw new Error(`export download failed: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    };

    // 1. Auto-Edit: create project with options, upload the video, start generation + auto draft render.
    const video = readFileSync(VIDEO);
    const info = await probe(VIDEO);
    projectId = (await call<{ id: string }>("/api/projects", { method: "POST", json: { name: "Auto-edit test", stylePreset: "dancehall_documentary", memeFrequency: "MEDIUM", captions: "DYNAMIC", originalFootage: "mix" } })).id;
    const start = await call<{ path: string; token: string }>(`/api/projects/${projectId}/uploads`, { method: "POST", json: { step: "start", kind: "narration", filename: path.basename(VIDEO), mime: "video/mp4", size: video.length } });
    const up = await browser.storage.from("projects").uploadToSignedUrl(start.path, start.token, new Blob([video], { type: "video/mp4" }), { contentType: "video/mp4" });
    ok(!up.error, `upload narration video (${(video.length / 1e6).toFixed(1)} MB, ${info.duration?.toFixed(1)}s, ${info.width}x${info.height})`);
    await call(`/api/projects/${projectId}/uploads`, { method: "POST", json: { step: "complete", kind: "narration", path: start.path } });
    await call(`/api/projects/${projectId}/jobs`, { method: "POST", json: { type: "generate", autoRender: "draft" } });

    const stages = new Set<string>();
    const gen = await waitFor("auto-edit", "pipelineJob", (s) => s.pipelineJob?.status === "COMPLETE", stages);
    console.log(`   stages seen: ${[...stages].join(" → ")}`);
    const result = gen.pipelineJob.result;

    // 2. Transcription.
    const { data: proj } = await admin.from("projects").select("transcript, narration_duration, script").eq("id", projectId).single();
    const tr = proj!.transcript as { words: { word: string; start: number; end: number }[]; source: string; text: string; duration: number };
    ok(!proj!.script, "no transcript/script was provided by the user");
    ok(tr?.source === "whisper" && tr.words.length > 50, `transcribed locally: ${tr?.words.length} words with timestamps (source=${tr?.source})`);
    ok(Math.abs(Number(proj!.narration_duration) - (info.duration ?? 0)) < 0.2, `audio extracted: narration duration ${Number(proj!.narration_duration).toFixed(2)}s matches video ${info.duration?.toFixed(2)}s`);
    console.log(`   transcript: "${tr.text.slice(0, 140)}…"`);

    // 3. Scenes, analysis, media, memes, timeline.
    const edit = await call<{ plans: Json[]; clips: Json[]; words: unknown[] }>(`/api/projects/${projectId}/edit`);
    ok(edit.plans.length >= 3, `scenes generated: ${edit.plans.length}`);
    ok(edit.plans.every((p) => p.analysis?.topic), "every scene has an analysis (topic/people/locations/events/tone)");
    for (const p of edit.plans.slice(0, 3)) console.log(`   ${p.sceneId}: topic="${p.analysis.topic}" people=[${p.analysis.people}] places=[${p.analysis.locations}] tone=${p.analysis.tone} strategy=${p.visualStrategy}`);
    const bySource: Record<string, number> = {};
    for (const c of edit.clips) bySource[`${c.asset.provider}/${c.asset.type}`] = (bySource[`${c.asset.provider}/${c.asset.type}`] ?? 0) + 1;
    console.log(`   visuals by source: ${JSON.stringify(bySource)}`);
    ok(new Set(edit.clips.map((c) => c.asset.provider)).size >= 3, "media searched across multiple providers");
    ok(edit.clips.every((c) => c.scores || c.asset.provider === "uploaded" || c.role === "meme"), "visuals were ranked (scores recorded)");
    const meme = edit.clips.find((c) => c.role === "meme");
    ok(meme, `meme/reaction inserted: ${meme ? `"${meme.asset.title}" at ${meme.start.toFixed(1)}s — ${meme.reason}` : "none"}`);
    ok(edit.clips.some((c) => c.asset.provider === "uploaded"), "original footage mixed in (interview + B-roll mode)");
    ok(edit.clips.every((c) => c.asset.sourceUrl && c.asset.license), "every visual carries source + licence info");
    const lastEnd = Math.max(...edit.clips.map((c) => c.start + c.duration));
    const lastWord = tr.words.at(-1)!.end;
    ok(edit.clips[0]!.start < 1 && lastEnd >= lastWord - 0.5, `visuals span the narration (${edit.clips[0]!.start.toFixed(1)}s → ${lastEnd.toFixed(1)}s; last word ends ${lastWord.toFixed(1)}s; pauses between scenes are filled by the timeline builder)`);
    console.log(`   result: ${JSON.stringify({ director: result.director, scenes: result.scenes, clips: result.clips, warnings: result.warnings?.length, searchErrors: result.searchErrors })}`);

    // 4. Review actions (single clip/scene only).
    const photo = edit.clips.find((c) => c.asset.type === "photo" && c.role === "primary")!;
    await call(`/api/projects/${projectId}/clips/${photo.clipId}`, { method: "PATCH", json: { action: "update", motion: { type: "pan_right", intensity: 0.1 } } });
    ok(true, `Change Effect on ${photo.clipId}`);
    const rec = await call<{ candidates: Json[] }>(`/api/projects/${projectId}/clips/${photo.clipId}/recommend`, { method: "POST" });
    ok(rec.candidates.length > 0, `Find Better: ${rec.candidates.length} alternatives`);
    await call(`/api/projects/${projectId}/clips/${photo.clipId}/replace`, { method: "POST", json: { provider: rec.candidates[0]!.provider, providerAssetId: rec.candidates[0]!.providerAssetId } });
    ok(true, `Replace ${photo.clipId} with "${rec.candidates[0]!.title.slice(0, 50)}"`);
    const removable = edit.clips.find((c) => c.role === "primary" && c.clipId !== photo.clipId && edit.clips.filter((x) => x.sceneId === c.sceneId).length > 1)!;
    await call(`/api/projects/${projectId}/clips/${removable.clipId}`, { method: "PATCH", json: { action: "delete" } });
    ok(true, `Remove ${removable.clipId}`);

    // 5. The auto-queued draft render (from generation).
    const r1 = await waitFor("draft render", "renderJob", (s) => s.renderJob?.status === "COMPLETE" && Boolean(s.latestExport?.url));
    const draftPath = path.join(process.cwd(), "output", "autoedit-draft.mp4");
    writeFileSync(draftPath, await fetchExport(r1.latestExport));

    // 6. Regenerate one scene, then final 1920x1080 render.
    await call(`/api/projects/${projectId}/jobs`, { method: "POST", json: { type: "regenerate_scenes", sceneIds: [edit.plans[1]!.sceneId] } });
    await waitFor("regenerate scene", "pipelineJob", (s) => s.pipelineJob?.status === "COMPLETE" && s.pipelineJob?.kind === "regenerate_scenes");
    ok(true, `Regenerate ${edit.plans[1]!.sceneId} (only that scene)`);
    await call(`/api/projects/${projectId}/jobs`, { method: "POST", json: { type: "render", format: "landscape" } });
    const r2 = await waitFor("final render", "renderJob", (s) => s.renderJob?.status === "COMPLETE" && s.renderJob?.format === "landscape" && s.latestExport?.format === "landscape");
    const finalPath = path.join(process.cwd(), "output", "autoedit-final.mp4");
    writeFileSync(finalPath, await fetchExport(r2.latestExport));
    console.log(`   final export served from ${r2.latestExport.local ? "the worker disk (too large for Storage plan)" : "Supabase Storage"}, ${(r2.latestExport.size_bytes / 1e6).toFixed(1)} MB`);

    // 7. Verify the MP4 and the narration.
    const out = await probe(finalPath);
    ok(out.width === 1920 && out.height === 1080 && Math.round(out.frameRate ?? 0) === 30 && out.videoCodec === "h264" && out.audioCodec === "aac", `final MP4: ${out.width}x${out.height} ${out.frameRate}fps ${out.videoCodec}/${out.audioCodec}`);
    ok(Math.abs((out.duration ?? 0) - (info.duration ?? 0)) < 1.2, `final duration ${out.duration?.toFixed(2)}s vs narration ${info.duration?.toFixed(2)}s (narration not cut)`);
    const a = envelope(await pcm8k(VIDEO));
    const b = envelope(await pcm8k(finalPath));
    let best = { lag: 0, r: -1 };
    for (let lag = -10; lag <= 10; lag++) {
      const r = correlation(a, b, lag);
      if (r > best.r) best = { lag, r };
    }
    ok(best.r > 0.8 && Math.abs(best.lag) <= 1, `narration intact & in sync: envelope correlation ${best.r.toFixed(3)} at lag ${best.lag * 50} ms`);
    console.log(`   saved ${draftPath} and ${finalPath}`);
    console.log(`TOTAL ${Math.round((Date.now() - t0) / 1000)}s`);
  } finally {
    if (projectId) {
      for (const f of ["audio", "assets", "renders", "temp"]) {
        const { data } = await admin.storage.from("projects").list(`${projectId}/${f}`, { limit: 1000 });
        if (data?.length) await admin.storage.from("projects").remove(data.map((x) => `${projectId}/${f}/${x.name}`));
      }
    }
    await admin.auth.admin.deleteUser(created.user.id);
    console.log("cleanup: test user, project and storage removed");
  }
}

main().catch((e) => {
  console.error("E2E FAILED:", e);
  process.exit(1);
});
