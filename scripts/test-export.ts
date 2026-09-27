/**
 * Export, rendered and measured:  npm run test:export -- <projectId>
 * Renders 20 s of a generated project (with an interview clip that pauses the narration for 4 s)
 * at two delivery loudness targets, then checks: the file's measured loudness and true peak, that
 * captions/chapters are in output time (shifted past the pause), SRT/VTT/chapter formats, the
 * rights CSV (incl. formula-injection guard), and that captions can be delivered without burn-in.
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { loadEdit } from "@/lib/data/store";
import { DEFAULT_SOURCE_AUDIO } from "@/lib/domain/sourceAudio";
import { DEFAULT_SETTINGS, type NormalizedAsset } from "@/lib/domain/types";
import { buildChapters, buildManifest, chaptersText, rightsCsv, toSrt, toVtt } from "@/lib/export/deliverables";
import type { SceneSelection } from "@/lib/pipeline/generate";
import { buildTimeline } from "@/lib/pipeline/timelineBuilder";
import { alignScriptToAudio } from "@/lib/pipeline/transcript";
import { buildAss } from "@/lib/render/ass";
import { probe } from "@/lib/render/ffmpeg";
import { library } from "@/lib/render/library";
import { renderTimeline } from "@/lib/render/render";
import { DEMO_SCRIPT } from "@/lib/demo/script";
import { createAdminClient } from "@/lib/supabase/admin";

const OUT = path.resolve(".cache/export-test");
const SRC = path.resolve(".cache/ui/files/interview-test.mp4");
const LEN = 20;

async function main() {
  const projectId = process.argv[2];
  if (!projectId) throw new Error("usage: test:export <projectId>");
  await rm(OUT, { recursive: true, force: true });
  const edit = await loadEdit(createAdminClient(), projectId);
  const narr = await probe(library.demoNarration);
  const tr = alignScriptToAudio(DEMO_SCRIPT, narr.duration ?? 60);
  const t20 = { ...tr, duration: LEN, words: tr.words.filter((w) => w.end < LEN) };
  const plans = edit.plans.filter((p) => p.startTime < LEN).map((p) => ({ ...p, endTime: Math.min(p.endTime, LEN), sfx: [] }));
  const base: SceneSelection[] = edit.selections.filter((s) => s.start < LEN && s.role === "primary");
  // A title that tries formula injection, to check the rights CSV guard.
  base[1] = { ...base[1]!, asset: { ...base[1]!.asset, title: '=HYPERLINK("http://evil","x")' } };
  const withSource = existsSync(SRC);
  const srcAsset: NormalizedAsset = { ...base[0]!.asset, id: "uploaded:test-interview", provider: "uploaded", providerAssetId: "test-interview", type: "video", mediaUrl: "storage:test", duration: 6, width: 1280, height: 720, title: "test interview" };
  const source: SceneSelection = { ...base[0]!, clipId: "src_export", role: "source", start: 8, duration: 4, trimStart: 0.5, asset: srcAsset, alternates: [], sourceAudio: { ...DEFAULT_SOURCE_AUDIO, mode: "pause" }, layout: "fullscreen", motion: "none", annotations: [], transitionIn: "hard_cut" };
  const selections = withSource ? [...base, source] : base;

  let failures = 0;
  const check = (ok: boolean, label: string) => {
    console.log(`    ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failures++;
  };

  for (const target of [-14, -23]) {
    const settings = { ...DEFAULT_SETTINGS, captions: "STANDARD" as const, musicTrack: "none", export: { ...DEFAULT_SETTINGS.export, loudness: target, burnCaptions: target === -14 } };
    const timeline = buildTimeline({ plans, selections, transcript: t20, settings, format: "draft", voicePath: library.demoNarration, musicPath: null });
    const out = path.join(OUT, `export${target}.mp4`);
    const t0 = Date.now();
    const r = await renderTimeline(timeline, { workDir: path.join(OUT, `w${target}`), outPath: out, draft: true, concurrency: 2, loudnessTarget: target, burnCaptions: settings.export.burnCaptions, resolveLocal: async (ref) => (ref.assetId === "uploaded:test-interview" ? SRC : null) });
    const q = r.qc;
    console.log(`\ntarget ${target} LUFS: rendered in ${Math.round((Date.now() - t0) / 1000)} s · measured ${q.loudness} LUFS, peak ${q.truePeak} dBTP, LRA ${q.lra} · gain ${r.loudness?.gainDb} dB${r.loudness?.limited ? " (limited)" : ""} · ${q.width}×${q.height} ${q.fps} fps · ${Math.round(q.sizeBytes / 1024)} KB · black ${q.black.length} · silence ${q.silence.length}`);
    check(q.loudness !== null && Math.abs(q.loudness - target) <= 1, `loudness within 1 LU of ${target}`);
    check(q.truePeak !== null && q.truePeak <= -0.9, "true peak ≤ −1 dBTP");
    check(q.duration !== null && Math.abs(q.duration - timeline.duration) < 0.3, `duration ${q.duration?.toFixed(2)} matches the timeline (${timeline.duration})`);

    const assets = new Map(selections.map((s) => [s.clipId, { ...s.asset, userApproved: false }]));
    const m = buildManifest({ jobId: "test", projectName: "Export test", format: "draft", timeline, assets, settings: settings.export, sceneTitles: { scene_001: "Kingston, 1976" }, qc: q, loudness: r.loudness, warnings: r.warnings });
    const srt = toSrt(m.cues);
    const blocks = srt.trim().split(/\n\n/);
    const times = blocks.map((b) => b.split("\n")[1]!.split(" --> ").map((x) => { const [h, mi, s] = x.replace(",", ".").split(":").map(Number); return h! * 3600 + mi! * 60 + s!; }));
    check(blocks.length === m.cues.length && blocks.every((b, i) => b.startsWith(`${i + 1}\n`)), `SRT: ${blocks.length} numbered cues`);
    check(times.every(([a, b], i) => a! < b! && (i === 0 || a! >= times[i - 1]![0]!)) && times.every(([, b]) => b! <= timeline.duration + 0.7), "SRT times ordered and inside the video");
    check(toVtt(m.cues).startsWith("WEBVTT\n\n") && /\d\d:\d\d:\d\d\.\d{3} --> /.test(toVtt(m.cues)), "VTT format");
    if (withSource) {
      // Every word after the 8 s pause point is exactly 4 s later in the captions; words before it don't move.
      const out = timeline.captions.words;
      const shifted = t20.words.every((w, i) => Math.abs(out[i]!.start - (w.start >= 8 ? w.start + 4 : w.start)) < 0.02);
      const after = t20.words.findIndex((w) => w.start >= 8);
      check(shifted, `captions follow the narration pause (“${t20.words[after]!.word}” ${t20.words[after]!.start.toFixed(2)} s → ${out[after]!.start.toFixed(2)} s)`);
      // The interview plays 8–12 s (output time); a caption may linger ≤ 0.2 s into it, never across it.
      const over = m.cues.filter((c) => c.start < 11.95 && c.end > 8.25);
      check(!over.length, `no caption on screen during the interview's own speech${over.length ? ` (${over.map((c) => `${c.start}–${c.end} “${c.text}”`).join("; ")})` : ""}`);
    }
    check(m.chapters[0]?.t === 0 && m.chapters.every((c, i) => i === 0 || c.t - m.chapters[i - 1]!.t >= 10), `chapters start at 0:00 and are ≥ 10 s apart (${m.chapters.length}; ${m.chaptersNote ?? "valid for YouTube"})`);
    check(/^0:00 /.test(chaptersText(m.chapters)), `chapter text: “${chaptersText(m.chapters).split("\n")[0]}”`);
    const csv = rightsCsv(m.rights);
    check(csv.split("\r\n").filter(Boolean).length === m.rights.length + 1, `rights CSV: ${m.rights.length} rows + header`);
    check(csv.includes(`"'=HYPERLINK(`) && !csv.includes(`"=HYPERLINK(`), "rights CSV neutralises spreadsheet formulas");
    const ass = buildAss(settings.export.burnCaptions ? timeline : { ...timeline, captions: { ...timeline.captions, mode: "OFF" } });
    check(settings.export.burnCaptions ? ass.includes(",Caption,") : !ass.includes(",Caption,"), settings.export.burnCaptions ? "captions burned in" : "captions delivered as files only (not burned in)");
  }
  // Chapter rules on a synthetic timeline: short scenes merge, the last must be ≥ 10 s.
  const fake = { duration: 45, graphics: [], visuals: [0, 4, 12, 30, 40].map((s, i) => ({ id: `c${i}`, sceneId: `s${i}`, start: s })) } as never;
  const ch = buildChapters(fake, { s0: "Opening", s1: "Too short", s2: "Middle", s3: "Late", s4: "End" });
  console.log(`\nchapter merge: ${ch.chapters.map((c) => `${c.t}s ${c.title}`).join(" | ")}`);
  check(ch.chapters.map((c) => c.title).join(",") === "Opening,Middle,Late", "short scenes merge; a final chapter under 10 s is dropped");
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
