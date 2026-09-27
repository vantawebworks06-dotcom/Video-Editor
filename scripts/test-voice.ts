/**
 * Narration processing, measured on real files:  npm run test:voice
 * Builds a noisy copy of the demo narration (broadband pink noise), processes the clean and noisy
 * narration with every preset, and checks: loudness on target, true peak under the ceiling, noise
 * reduced where there is noise, and a clean recording left without noise reduction by Auto.
 */
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { measureVoice, processVoice } from "@/lib/audio/voiceMeasure";
import { DEFAULT_VOICE, VOICE_PRESETS, type VoicePreset } from "@/lib/domain/voice";
import { runFfmpeg } from "@/lib/render/ffmpeg";
import { library } from "@/lib/render/library";

const DIR = path.resolve(".cache/voice-test");

async function main() {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  if (!existsSync(library.demoNarration)) throw new Error("Demo narration missing: npm run assets:generate");
  const noisy = path.join(DIR, "noisy.wav");
  await runFfmpeg([
    "-i", library.demoNarration,
    "-f", "lavfi", "-i", "anoisesrc=c=pink:a=0.03:r=48000",
    "-filter_complex", "[0:a]aresample=48000,aformat=channel_layouts=mono[v];[1:a]aformat=channel_layouts=mono[n];[v][n]amix=inputs=2:normalize=0:duration=first",
    "-c:a", "pcm_s16le", noisy,
  ]);
  let failures = 0;
  const check = (ok: boolean, label: string) => {
    console.log(`    ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failures++;
  };

  for (const [name, file] of [["clean", library.demoNarration], ["noisy", noisy]] as const) {
    const before = await measureVoice(file, { cacheDir: DIR });
    console.log(`\n${name}: floor ${before.noiseFloor} dBFS · speech ${before.speechLevel} · ${before.loudness} LUFS · LRA ${before.lra}`);
    for (const preset of ["auto", "natural", "documentary", "broadcast", "podcast"] as VoicePreset[]) {
      const t0 = Date.now();
      const r = await processVoice(file, { ...DEFAULT_VOICE, preset }, { cacheDir: DIR });
      const after = await measureVoice(r.path, { cacheDir: DIR });
      const target = preset === "auto" ? r.values.loudness : VOICE_PRESETS[preset as keyof typeof VOICE_PRESETS].loudness;
      console.log(`  ${preset.padEnd(11)} ${((Date.now() - t0) / 1000).toFixed(1)} s · floor ${after.noiseFloor} · ${after.loudness} LUFS (target ${target}) · TP ${after.truePeak} · NR ${Math.round(r.values.noiseReduction * 100)}%`);
      check(Math.abs(after.loudness - target) <= 0.7, `loudness within 0.7 LU of ${target}`);
      check(after.truePeak <= -1.0, "true peak ≤ −1 dBTP");
      // Natural is the light-touch preset: it may clean less, but must still clean.
      const minGain = preset === "natural" ? 3 : 6;
      if (name === "noisy" && r.values.noiseReduction >= 0.3) check(after.snr - before.snr >= minGain, `noise reduced ≥ ${minGain} dB (SNR ${before.snr} → ${after.snr} dB)`);
      if (name === "clean" && preset === "auto") check(r.values.noiseReduction === 0 && r.values.gate === 0, "Auto applies no noise reduction to a clean recording");
      if (name === "noisy" && preset === "auto") check(after.noiseFloor <= before.noiseFloor - 10, `Auto lowers the noise floor ≥ 10 dB (${before.noiseFloor} → ${after.noiseFloor})`);
    }
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
