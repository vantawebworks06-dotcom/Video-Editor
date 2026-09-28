/**
 * Narrator, end to end on this machine (no database):  npm run test:narrator
 * 1. Analyse a human narration as if it were the user's recordings, and check the measurements.
 * 2. Match a Kokoro voice to it (calibrating the candidate voices, cached after the first run).
 * 3. Plan delivery for the first paragraphs of the demo script in two styles and check that
 *    sentences differ (no single cadence) and that the style moves pace and pauses.
 * 4. Render: sentence synthesis + delivery, assembly with pauses, processing; check timings,
 *    loudness on target, and that each processing control measurably changes the audio.
 * 5. Regenerate one sentence (new take): only that sentence changes.
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { DEMO_SCRIPT } from "@/lib/demo/script";
import { decodeMono16k, speechStats, summarise } from "@/lib/narrator/analyze";
import { kokoroEngine } from "@/lib/narrator/engine";
import { analysisNotes, calibrateVoice, candidateVoices, chooseMatch } from "@/lib/narrator/match";
import { planDelivery } from "@/lib/narrator/prosody";
import { assemble, processNarration, renderSentence } from "@/lib/narrator/render";
import { splitScript } from "@/lib/narrator/split";
import { DEFAULT_CONTROLS, DEFAULT_PROCESSING, type NarratorProcessing } from "@/lib/narrator/types";
import { runFfmpeg } from "@/lib/render/ffmpeg";
import { library } from "@/lib/render/library";
import { measureLoudness } from "@/lib/render/qc";

const ROOT = path.resolve(".cache");
const OUT = path.join(ROOT, "narrator-test");
let failures = 0;
const check = (ok: boolean, label: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
};

/** Mean level (dB) of a frequency band. */
async function band(file: string, filter: string): Promise<number> {
  const { spawn } = await import("node:child_process");
  const { ffmpegPath } = await import("@/lib/render/ffmpeg");
  return new Promise((resolve) => {
    const c = spawn(ffmpegPath(), ["-hide_banner", "-nostats", "-i", file, "-af", `${filter},volumedetect`, "-f", "null", "-"], { windowsHide: true });
    let e = "";
    c.stderr.on("data", (d: Buffer) => (e += d.toString()));
    c.on("close", () => resolve(Number(e.match(/mean_volume: (-?[\d.]+) dB/)?.[1] ?? -120)));
  });
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const engine = kokoroEngine(ROOT);
  const t0 = Date.now();

  console.log("1. Analyse recordings (the demo narration stands in for the user's voice)");
  const summary = summarise([speechStats(await decodeMono16k(library.demoNarration))]);
  console.log(`   ${JSON.stringify(summary)}`);
  const words = (DEMO_SCRIPT.match(/[A-Za-z0-9'’-]+/g) ?? []).length;
  const trueWpm = (words / summary.duration) * 60;
  check(summary.pitchMedian > 70 && summary.pitchMedian < 300, `pitch ${summary.pitchMedian} Hz is in the speaking range`);
  check(Math.abs(summary.wordsPerMinute - trueWpm) / trueWpm < 0.25, `words/min ${summary.wordsPerMinute} within 25% of the script's ${trueWpm.toFixed(0)}`);
  check(summary.pauseMedian > 0.2 && summary.pauseMedian < 2, `pause median ${summary.pauseMedian} s`);
  const analysis = { ...summary, notes: analysisNotes(summary), analysedAt: new Date().toISOString() };

  console.log("2. Match a voice");
  const voices = candidateVoices("us", analysis.pitchMedian);
  const cals = [];
  for (const v of voices) {
    const t = Date.now();
    cals.push(await calibrateVoice(engine, v, path.join(ROOT, "narrator")));
    console.log(`   ${v}: ${JSON.stringify(cals.at(-1))} (${Math.round((Date.now() - t) / 1000)} s)`);
  }
  const match = chooseMatch(analysis, cals);
  match.notes.forEach((n) => console.log(`   ${n}`));
  const chosen = cals.find((c) => c.voice === match.voice)!;
  check(Math.abs(12 * Math.log2(analysis.pitchMedian / (chosen.pitch * Math.pow(2, match.pitchShift / 12)))) < 1.5, "pitch after shift within 1.5 semitones of the recordings");

  console.log("3. Plan delivery");
  const script = DEMO_SCRIPT.split(/\n\s*\n/).slice(0, 3).join("\n\n");
  const sentences = splitScript(script);
  check(sentences.length >= 4, `${sentences.length} sentences in ${new Set(sentences.map((s) => s.paragraph)).size} paragraphs`);
  const plan = planDelivery({ sentences, style: "conversational", controls: DEFAULT_CONTROLS, match });
  plan.forEach((p, i) => console.log(`   #${i + 1} speed ${p.speed} pitch ${p.pitch} gain ${p.gainDb} pause ${p.pauseAfter} stress [${p.emphasis}] — ${p.reasons.join("; ")}`));
  const distinct = new Set(plan.map((p) => `${p.speed}|${p.pitch}`)).size;
  check(distinct === plan.length, "every sentence has its own speed/pitch");
  check(plan.every((p, i) => i === 0 || Math.abs(p.speed - plan[i - 1]!.speed) >= 0.01 || Math.abs(p.pitch - plan[i - 1]!.pitch) >= 0.2), "no two neighbours share a cadence");
  const dramatic = planDelivery({ sentences, style: "suspenseful", controls: DEFAULT_CONTROLS, match });
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  check(avg(dramatic.map((p) => p.speed)) < avg(plan.map((p) => p.speed)) - 0.05 && avg(dramatic.map((p) => p.pauseAfter)) > avg(plan.map((p) => p.pauseAfter)) * 1.2, "suspenseful is slower with longer pauses than conversational");

  console.log("4. Render");
  const dir = path.join(OUT, "sentences");
  const rendered = [];
  for (const [i, s] of sentences.entries()) {
    const t = Date.now();
    const r = await renderSentence(engine, dir, match.voice, s, plan[i]!, { Delroy: "Del-roy" });
    rendered.push(r);
    console.log(`   #${i + 1} ${r.duration.toFixed(2)} s in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
  const raw = path.join(OUT, "raw.wav");
  const asm = await assemble(rendered.map((r, i) => ({ id: r.id, file: r.file, pauseAfter: plan[i]!.pauseAfter })), raw);
  const expected = 0.3 + rendered.reduce((a, r, i) => a + r.duration + plan[i]!.pauseAfter, 0);
  check(Math.abs(asm.duration - expected) < 0.01, `assembled ${asm.duration.toFixed(2)} s = sentences + pauses`);
  check(asm.timings.every((t, i) => i === 0 || t.start >= asm.timings[i - 1]!.end + plan[i - 1]!.pauseAfter - 0.002), "sentence timings follow the pauses");

  const proc = async (name: string, p: Partial<NarratorProcessing>) => {
    const out = path.join(OUT, `${name}.wav`);
    await processNarration(raw, { ...DEFAULT_PROCESSING, ...p }, out, asm.duration);
    return out;
  };
  const baseFile = await proc("default", {});
  const lufs = (await measureLoudness(baseFile)).loudness;
  check(lufs !== null && Math.abs(lufs - DEFAULT_PROCESSING.loudness) <= 1, `processed loudness ${lufs} LUFS (target ${DEFAULT_PROCESSING.loudness})`);
  const flat = { warmth: 0, mudCut: 0, presence: 0, air: 0, deEss: 0, compression: 0, roomTone: -90 } as const;
  const ref = await proc("flat", flat);
  const low = (f: string) => band(f, "lowpass=f=150,lowpass=f=150");
  const high = (f: string) => band(f, "highpass=f=6000,highpass=f=6000");
  const [refLow, refHigh] = [await low(ref), await high(ref)];
  const bassUp = await low(await proc("bass", { ...flat, bass: 8 }));
  check(bassUp - refLow > 2, `bass +8 dB raises < 150 Hz by ${(bassUp - refLow).toFixed(1)} dB (vs the rest after loudness)`);
  const trebleUp = await high(await proc("treble", { ...flat, treble: 8 }));
  check(trebleUp - refHigh > 2, `treble +8 dB raises > 6 kHz by ${(trebleUp - refHigh).toFixed(1)} dB`);
  // Reverb/echo fill the pauses: level in the first pause rises.
  const gapStart = asm.timings[0]!.end + 0.25;
  const gap = (f: string) => band(f, `atrim=${gapStart.toFixed(2)}:${(gapStart + 0.15).toFixed(2)}`);
  const refGap = await gap(ref);
  const rev = await gap(await proc("reverb", { ...flat, reverb: 0.8, reverbSize: 0.8 }));
  const speechLvl = await band(ref, `atrim=${asm.timings[0]!.start.toFixed(2)}:${asm.timings[0]!.end.toFixed(2)}`);
  check(rev - refGap > 20 && speechLvl - rev < 30, `reverb tail fills the pause: ${rev.toFixed(0)} dB, ${(speechLvl - rev).toFixed(0)} dB under the speech (silence was ${refGap.toFixed(0)})`);
  const echoGap = await band(await proc("echo", { ...flat, echo: 0.8, echoDelay: 200 }), `atrim=${(asm.timings[0]!.end + 0.05).toFixed(2)}:${(asm.timings[0]!.end + 0.3).toFixed(2)}`);
  const refEcho = await band(ref, `atrim=${(asm.timings[0]!.end + 0.05).toFixed(2)}:${(asm.timings[0]!.end + 0.3).toFixed(2)}`);
  check(echoGap - refEcho > 10, `echo repeats into the pause (${refEcho.toFixed(0)} → ${echoGap.toFixed(0)} dB)`);
  const roomGap = await gap(await proc("room", { ...flat, roomTone: -60 }));
  check(Math.abs(roomGap + 60) <= 3, `room tone −60 dBFS fills silence at ${roomGap.toFixed(0)} dB (was ${refGap.toFixed(0)})`);
  const quieter = (await measureLoudness(await proc("volume", { volume: 0.5 }))).loudness;
  check(lufs !== null && quieter !== null && Math.abs(lufs - quieter - 6) < 1, `volume 0.5 → ${(lufs! - quieter!).toFixed(1)} dB quieter`);
  const sib = (f: string) => band(f, "highpass=f=5000,lowpass=f=9000");
  const ess = await sib(await proc("deess", { ...flat, deEss: 1 }));
  check(ess < (await sib(ref)) - 0.3, `de-esser lowers 5–9 kHz (${(await sib(ref)).toFixed(1)} → ${ess.toFixed(1)} dB)`);
  await runFfmpeg(["-i", baseFile, "-c:a", "aac", "-b:a", "128k", path.join(OUT, "narration.m4a")]);

  console.log("5. Regenerate one sentence");
  const again = sentences.map((s, i) => (i === 1 ? { ...s, take: s.take + 1 } : s));
  const plan2 = planDelivery({ sentences: again, style: "conversational", controls: DEFAULT_CONTROLS, match });
  const changed = plan2.map((p, i) => JSON.stringify(p) !== JSON.stringify(plan[i])).map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
  check(changed.length >= 1 && changed.includes(1) && changed.every((i) => i === 1 || i === 2), `only the regenerated sentence changes (changed: ${changed.map((i) => `#${i + 1}`).join(", ")})`);
  const r2 = await renderSentence(engine, dir, match.voice, again[1]!, plan2[1]!, {});
  check(r2.hash !== rendered[1]!.hash, "new take has new audio");

  console.log(`\n${failures ? `${failures} check(s) failed` : "all checks passed"} in ${Math.round((Date.now() - t0) / 1000)} s — listen: ${path.join(OUT, "narration.m4a")}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
