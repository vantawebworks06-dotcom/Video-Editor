/**
 * Render a time window of an edit produced by `report:editorial` with the real renderer — to
 * check transitions, designed cards, story-driven music, SFX and ducking without rendering the
 * whole video. Read-only on the project (the narration is downloaded to .cache/editorial/).
 *
 *   npm run render:editorial -- <projectId> <label> <fromSec> <toSec> [--full]
 *
 * Output: .cache/editorial/<label>-<from>-<to>.mp4 (draft 960×540 unless --full)
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseSettings } from "@/lib/data/project";
import type { ScenePlan, Transcript } from "@/lib/domain/types";
import type { SceneSelection } from "@/lib/pipeline/generate";
import { buildTimeline } from "@/lib/pipeline/timelineBuilder";
import { runFfmpeg } from "@/lib/render/ffmpeg";
import { library } from "@/lib/render/library";
import { renderTimeline } from "@/lib/render/render";
import { BUCKET, createAdminClient } from "@/lib/supabase/admin";

const OUT = path.join(process.cwd(), ".cache", "editorial");

async function main() {
  const [id, label, fromS, toS, ...rest] = process.argv.slice(2);
  if (!id || !label || !fromS || !toS) throw new Error("usage: render:editorial <projectId> <label> <from> <to> [--full]");
  const from = Number(fromS);
  const to = Number(toS);
  const project = JSON.parse(await readFile(path.join(OUT, `project-${id}.json`), "utf8"));
  const run = JSON.parse(await readFile(path.join(OUT, `${label}.json`), "utf8")) as { plans: ScenePlan[]; selections: SceneSelection[] };
  const settings = parseSettings(project.settings);
  if (rest.includes("--auto-music")) settings.musicTrack = "auto";

  // Narration audio (downloaded once).
  const narration = path.join(OUT, `narration-${id}.m4a`);
  if (!existsSync(narration)) {
    const db = createAdminClient();
    const { data: p } = await db.from("projects").select("narration_path").eq("id", id).single();
    const { data: signed } = await db.storage.from(BUCKET).createSignedUrl(p!.narration_path, 600);
    const buf = Buffer.from(await (await fetch(signed!.signedUrl)).arrayBuffer());
    const src = `${narration}.src`;
    await writeFile(src, buf);
    await runFfmpeg(["-i", src, "-vn", "-c:a", "aac", "-b:a", "160k", narration]);
  }
  const clip = path.join(OUT, `narration-${id}-${from}-${to}.m4a`);
  await runFfmpeg(["-ss", String(from), "-t", String(to - from), "-i", narration, "-c:a", "aac", "-b:a", "160k", clip]);

  // The window, shifted to start at 0.
  const shift = <T extends { startTime: number; endTime: number }>(p: T): T => ({ ...p, startTime: Math.max(0, p.startTime - from), endTime: Math.min(to, p.endTime) - from });
  const plans = run.plans.filter((p) => p.endTime > from && p.startTime < to).map(shift);
  const selections = run.selections
    .filter((s) => s.start + s.duration > from && s.start < to)
    .map((s) => {
      const start = Math.max(s.start, from);
      const end = Math.min(s.start + s.duration, to);
      return { ...s, start: start - from, duration: end - start, trimStart: s.trimStart + (start - s.start) };
    });
  const words = project.transcript.words.filter((w: { start: number; end: number }) => w.start >= from && w.end <= to).map((w: { word: string; start: number; end: number }) => ({ ...w, start: w.start - from, end: w.end - from }));
  const transcript: Transcript = { text: words.map((w: { word: string }) => w.word).join(" "), words, duration: to - from, source: "script_alignment" };

  const timeline = buildTimeline({
    plans,
    selections,
    transcript,
    settings,
    format: rest.includes("--full") ? "landscape" : "draft",
    voicePath: clip,
    musicPath: null,
    resolveTrack: (key) => (existsSync(library.music(key)) ? library.music(key) : null),
  });
  await writeFile(path.join(OUT, `${label}-${from}-${to}.timeline.json`), JSON.stringify(timeline, null, 1));
  console.log(`visuals ${timeline.visuals.length} · texts ${timeline.texts.length} · sfx ${timeline.audio.sfx.map((c) => `${c.kind}@${c.start}`).join(" ")}`);
  console.log(`music ${(timeline.audio.musicCues ?? []).map((c) => `${c.label}[${c.mood}] ${c.start}-${c.end}`).join(" | ") || timeline.audio.music}`);
  console.log(`transitions ${timeline.visuals.filter((v) => v.transitionIn !== "hard_cut").map((v) => `${v.transitionIn}@${v.start}`).join(" ")}`);

  await mkdir(OUT, { recursive: true });
  const outPath = path.join(OUT, `${label}-${from}-${to}.mp4`);
  const t0 = Date.now();
  const r = await renderTimeline(timeline, { workDir: path.join(OUT, "work"), outPath, draft: !rest.includes("--full"), log: () => undefined });
  console.log(`rendered ${outPath} in ${((Date.now() - t0) / 1000).toFixed(0)}s · ${r.segmentsRendered} segments (${r.segmentsCached} cached)`);
  for (const w of r.warnings) console.log(`warning: ${w}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
