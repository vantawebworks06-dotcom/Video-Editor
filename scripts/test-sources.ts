/**
 * Source-footage modes, rendered and measured (not just built):
 *   npm run test:sources -- <projectId>
 * Takes the first 20 s of a generated project, inserts a test "interview" (a 440 Hz tone video,
 * .cache/ui/files/interview-test.mp4) at 6 s for 5 s in each mode, renders a draft, then measures
 * the output: duration (pause/overlap insert time), speech energy (high-passed > 1 kHz: the
 * narration) and tone energy (band-passed at 440 Hz: the source audio) inside the source window.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadEdit } from "@/lib/data/store";
import { DEFAULT_SOURCE_AUDIO, type SourceAudio } from "@/lib/domain/sourceAudio";
import { DEFAULT_SETTINGS, type NormalizedAsset } from "@/lib/domain/types";
import type { SceneSelection } from "@/lib/pipeline/generate";
import { buildTimeline } from "@/lib/pipeline/timelineBuilder";
import { alignScriptToAudio } from "@/lib/pipeline/transcript";
import { ffmpegPath, probe } from "@/lib/render/ffmpeg";
import { library } from "@/lib/render/library";
import { renderTimeline } from "@/lib/render/render";
import { DEMO_SCRIPT } from "@/lib/demo/script";
import { createAdminClient } from "@/lib/supabase/admin";

const SRC = path.resolve(".cache/ui/files/interview-test.mp4");
const OUT = path.resolve(".cache/sources-test");
const LEN = 20;
const AT = 6;
const DUR = 5;

function rms(file: string, from: number, to: number, filter: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-nostats", "-ss", from.toFixed(2), "-t", (to - from).toFixed(2), "-i", file, "-vn", "-af", `${filter},volumedetect`, "-f", "null", "-"];
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("close", () => {
      const m = err.match(/mean_volume: (-?[\d.]+) dB/);
      if (m) resolve(Number(m[1]));
      else reject(new Error(err.slice(-300)));
    });
  });
}

async function main() {
  const projectId = process.argv[2];
  if (!projectId) throw new Error("usage: test:sources <projectId>");
  if (!existsSync(SRC)) throw new Error(`missing ${SRC}`);
  const edit = await loadEdit(createAdminClient(), projectId);
  const narr = await probe(library.demoNarration);
  const transcript = alignScriptToAudio(DEMO_SCRIPT, narr.duration ?? 60);
  const t20 = { ...transcript, duration: LEN, words: transcript.words.filter((w) => w.end < LEN) };
  const plans = edit.plans.filter((p) => p.startTime < LEN).map((p) => ({ ...p, endTime: Math.min(p.endTime, LEN), sfx: [], textOverlay: { ...p.textOverlay, enabled: false } }));
  const base: SceneSelection[] = edit.selections.filter((s) => s.start < LEN && s.role === "primary");
  const srcAsset: NormalizedAsset = { ...base[0]!.asset, id: "uploaded:test-interview", provider: "uploaded", providerAssetId: "test-interview", type: "video", mediaUrl: "storage:test", duration: 6, width: 1280, height: 720, title: "test interview" };
  let failures = 0;
  const check = (ok: boolean, label: string) => {
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failures++;
  };

  const only = process.argv[3] as SourceAudio["mode"] | undefined;
  for (const mode of (only ? [only] : ["pause", "duck", "overlap", "visual_only"]) as SourceAudio["mode"][]) {
    const audio: SourceAudio = { ...DEFAULT_SOURCE_AUDIO, mode, fadeIn: 0.05, fadeOut: 0.05, overlap: 1.5, narrationVolume: 0.25 };
    const source: SceneSelection = { ...base[0]!, clipId: `src_${mode}`, role: "source", start: AT, duration: DUR, trimStart: 0.5, asset: srcAsset, alternates: [], sourceAudio: audio, layout: "fullscreen", motion: "none", annotations: [], transitionIn: "hard_cut" };
    const timeline = buildTimeline({ plans, selections: [...base, source], transcript: t20, settings: { ...DEFAULT_SETTINGS, musicTrack: "none", captions: "OFF", mix: { ...DEFAULT_SETTINGS.mix, sfxVolume: 0 } }, format: "draft", voicePath: library.demoNarration, musicPath: null });
    const inserted = (timeline.audio.inserts ?? []).reduce((a, x) => a + x.duration, 0);
    const out = path.join(OUT, `${mode}.mp4`);
    const t0 = Date.now();
    await renderTimeline(timeline, { workDir: path.join(OUT, `work-${mode}`), outPath: out, draft: true, resolveLocal: async (ref) => (ref.assetId === "uploaded:test-interview" ? SRC : null), concurrency: 2 });
    const info = await probe(out);
    const srcClip = timeline.visuals.find((v) => v.role === "source")!;
    const [a, b] = [srcClip.start + 0.4, srcClip.start + srcClip.duration - 0.4];
    const speechIn = await rms(out, a, b, "highpass=f=1200,highpass=f=1200");
    const toneIn = await rms(out, a, b, "bandpass=f=440:width_type=q:w=8");
    const speechBefore = await rms(out, 2, 5, "highpass=f=1200,highpass=f=1200");
    // The narration has energy near 440 Hz too: compare the band against the same band before the window.
    const toneBefore = await rms(out, 2, 5, "bandpass=f=440:width_type=q:w=8");
    console.log(`\n${mode}: rendered in ${Math.round((Date.now() - t0) / 1000)} s · duration ${info.duration?.toFixed(2)} (expected ${(LEN + 0.6 + inserted).toFixed(2)}) · source at ${srcClip.start}–${(srcClip.start + srcClip.duration).toFixed(2)}`);
    console.log(`  speech dB before=${speechBefore.toFixed(1)} in-window=${speechIn.toFixed(1)} · 440 Hz tone in-window=${toneIn.toFixed(1)}`);
    check(Math.abs((info.duration ?? 0) - (LEN + 0.6 + inserted)) < 0.3, "output duration includes the inserted time");
    if (mode === "pause") {
      check(inserted === DUR, "pause inserts the whole source length");
      check(speechIn < speechBefore - 20, "narration silent while the source plays");
      check(toneIn > -45, "source audio audible");
    }
    if (mode === "duck") {
      check(inserted === 0, "duck inserts no time");
      check(speechIn < speechBefore - 6 && speechIn > speechBefore - 25, "narration ducked, not silent");
      check(toneIn > -45, "source audio audible");
    }
    if (mode === "overlap") {
      check(Math.abs(inserted - (DUR - 1.5)) < 0.01, "overlap inserts source length minus overlap");
      const lateSpeech = await rms(out, srcClip.start + 2, b, "highpass=f=1200,highpass=f=1200");
      check(lateSpeech < speechBefore - 20, "narration paused after the overlap window");
    }
    if (mode === "visual_only") {
      check(inserted === 0, "visual only inserts no time");
      check(toneIn - toneBefore < 3, `source audio muted (440 Hz band ${toneIn.toFixed(1)} dB vs ${toneBefore.toFixed(1)} dB of narration alone)`);
      check(Math.abs(speechIn - speechBefore) < 12, "narration unchanged");
    }
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
