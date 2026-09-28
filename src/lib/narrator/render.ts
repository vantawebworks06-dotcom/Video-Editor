/**
 * Narration rendering: sentence synthesis (cached per engine input), per-sentence delivery
 * (pitch via Rubber Band with formants preserved, level, brightness), assembly with the planned
 * pauses, then the processing chain and loudness normalisation.
 */
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { stableHash } from "@/lib/media/cache";
import { voiceChain } from "@/lib/domain/voice";
import { runFfmpeg } from "@/lib/render/ffmpeg";
import { measureLoudness } from "@/lib/render/qc";
import type { NarratorEngine } from "./engine";
import { applyPronunciations } from "./state";
import type { NarratorProcessing, NarratorSentence, SentencePlan } from "./types";
import { readWav, trimSilence, writeWav } from "./wav";

const SR = 48000;

export interface RenderedSentence {
  id: string;
  /** 48 kHz mono WAV with the sentence's delivery applied. */
  file: string;
  duration: number;
  /** Identifies engine input + delivery (same hash = same audio). */
  hash: string;
  phonemes: string | null;
}

/** One sentence: synthesise (cached) → trim → pitch/level/tilt → 48 kHz WAV (cached). */
export async function renderSentence(
  engine: NarratorEngine,
  dir: string,
  voice: string,
  s: NarratorSentence,
  plan: SentencePlan,
  pronunciations: Record<string, string>,
): Promise<RenderedSentence> {
  await mkdir(dir, { recursive: true });
  const text = applyPronunciations(s.text, pronunciations);
  const emphasis = plan.emphasis.map((w) => applyPronunciations(w, pronunciations));
  // "Regenerate" bumps the take, which re-seeds the sentence's variation (speed, pitch, level, pause),
  // so the key and the delivery change. Kokoro itself is deterministic for identical input.
  const synthKey = stableHash({ e: engine.id, v: 1, voice, text, speed: plan.speed, emphasis, beat: plan.beat });
  const raw = path.join(dir, `raw-${synthKey}.wav`);
  let phonemes: string | null = null;
  if (!existsSync(raw)) {
    const r = await engine.synthesize({ text, voice, speed: plan.speed, emphasis, beat: plan.beat });
    phonemes = r.phonemes;
    const trimmed = trimSilence(r.samples, r.sampleRate);
    if (!trimmed.length) throw new Error(`The engine produced no audio for: “${s.text.slice(0, 60)}”`);
    await writeWav(`${raw}.tmp`, trimmed, r.sampleRate);
    await rename(`${raw}.tmp`, raw);
  }
  const hash = stableHash({ synthKey, pitch: plan.pitch, gain: plan.gainDb, tilt: plan.tilt, v: 1 }).slice(0, 16);
  const out = path.join(dir, `s-${hash}.wav`);
  if (!existsSync(out)) {
    const f: string[] = [`aresample=${SR}`];
    // Rubber Band keeps formants, so a few semitones sound like a different pitch, not a different person.
    if (Math.abs(plan.pitch) >= 0.05) f.push(`rubberband=pitch=${Math.pow(2, plan.pitch / 12).toFixed(5)}:formant=preserved:pitchq=quality`);
    if (plan.tilt) f.push(`highshelf=f=3000:g=${plan.tilt.toFixed(1)}:t=q:w=0.7`);
    if (plan.gainDb) f.push(`volume=${plan.gainDb.toFixed(1)}dB`);
    await runFfmpeg(["-i", raw, "-af", f.join(","), "-ac", "1", "-c:a", "pcm_s16le", `${out}.tmp.wav`], { timeoutMs: 5 * 60_000 });
    await rename(`${out}.tmp.wav`, out);
  }
  const { samples } = await readWav(out);
  return { id: s.id, file: out, duration: samples.length / SR, hash, phonemes };
}

/** Join sentence files with their pauses; returns sentence timings. */
export async function assemble(parts: { id: string; file: string; pauseAfter: number }[], out: string, leadIn = 0.3): Promise<{ duration: number; timings: { id: string; start: number; end: number }[] }> {
  const chunks: Float32Array[] = [new Float32Array(Math.round(leadIn * SR))];
  const timings: { id: string; start: number; end: number }[] = [];
  let t = leadIn;
  for (const p of parts) {
    const { samples, sampleRate } = await readWav(p.file);
    if (sampleRate !== SR) throw new Error(`Sentence audio at ${sampleRate} Hz, expected ${SR}`);
    chunks.push(samples);
    const d = samples.length / SR;
    timings.push({ id: p.id, start: Math.round(t * 1000) / 1000, end: Math.round((t + d) * 1000) / 1000 });
    t += d;
    const gap = new Float32Array(Math.round(p.pauseAfter * SR));
    chunks.push(gap);
    t += gap.length / SR;
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  await writeWav(out, all, SR);
  return { duration: total / SR, timings };
}

const db2lin = (db: number) => Math.pow(10, db / 20);

/**
 * A room impulse response: seeded noise decaying 60 dB over T60 (0.3–2.2 s by size), a pre-delay,
 * and a tail that darkens with size (one-pole low-pass). Normalised to unit energy, so the wet
 * signal has the same power as the dry one and the mix amount means what it says.
 */
export async function writeImpulse(file: string, size: number): Promise<number> {
  const t60 = 0.3 + size * 1.9;
  const n = Math.round(t60 * SR);
  const pre = Math.round((0.008 + size * 0.022) * SR);
  const ir = new Float32Array(pre + n);
  let seed = 12345;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0xffffffff) * 2 - 1;
  const a = Math.exp((-2 * Math.PI * (7500 - size * 4000)) / SR);
  let lp = 0;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    lp = (1 - a) * rand() + a * lp;
    const v = lp * Math.pow(10, (-3 * i) / n); // −60 dB at T60
    ir[pre + i] = v;
    energy += v * v;
  }
  const g = 1 / Math.sqrt(energy);
  for (let i = 0; i < ir.length; i++) ir[i]! *= g;
  // Written as float so the unit-energy scaling survives.
  const data = Buffer.alloc(ir.length * 4);
  for (let i = 0; i < ir.length; i++) data.writeFloatLE(ir[i]!, i * 4);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(3, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(32, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, Buffer.concat([h, data]));
  return t60;
}

/**
 * The processing chain as FFmpeg -filter_complex (input [0:a] → [out]): clean-up, EQ, de-ess and
 * compression from the narration chain, then bass/treble, echo and reverb (the room impulse
 * response from writeImpulse, input [1:a], convolved with afir). Loudness is applied in a second pass.
 */
export function processingGraph(p: NarratorProcessing, duration: number, t60 = 0): string {
  const base = voiceChain(p, null, { loudnorm: "none" });
  const f = [`aresample=${SR}`, "aformat=sample_fmts=fltp:channel_layouts=mono", base];
  if (p.bass) f.push(`bass=g=${p.bass.toFixed(1)}:f=100:w=0.7`);
  if (p.treble) f.push(`treble=g=${p.treble.toFixed(1)}:f=5000:w=0.7`);
  if (p.echo > 0) {
    const d = Math.round(p.echoDelay);
    f.push(`aecho=in_gain=1:out_gain=${(1 / (1 + p.echo * 0.6)).toFixed(3)}:delays=${d}|${d * 2}:decays=${(p.echo * 0.45).toFixed(3)}|${(p.echo * 0.2).toFixed(3)}`);
  }
  const graph = [`[0:a]${f.filter((x) => x && x !== "anull").join(",")}[pre]`];
  if (p.reverb > 0 && t60 > 0) {
    graph[0] = `[0:a]${f.filter((x) => x && x !== "anull").join(",")},apad=pad_dur=${t60.toFixed(2)}[pre]`;
    graph.push(
      `[pre]asplit=2[dry][wetin]`,
      // Low end kept out of the tail (muddy otherwise).
      `[1:a]aformat=sample_fmts=fltp:channel_layouts=mono,highpass=f=200[ir]`,
      `[wetin][ir]afir=gtype=none:dry=1:wet=1[wet]`,
      // Amount 1 ≈ wet at −6 dB relative to the dry voice.
      `[dry][wet]amix=inputs=2:weights='1 ${(p.reverb * 0.5).toFixed(3)}':normalize=0,atrim=0:${(duration + t60).toFixed(3)}[out]`,
    );
  } else graph.push(`[pre]anull[out]`);
  return graph.join(";");
}

/**
 * Process an assembled narration: chain → measure → one exact gain to the loudness target (peaks
 * held at −1.5 dBTP) → room tone → volume. Returns the processed 48 kHz WAV.
 */
export async function processNarration(input: string, p: NarratorProcessing, out: string, duration: number): Promise<{ loudness: number | null }> {
  await mkdir(path.dirname(out), { recursive: true });
  const pre = `${out}.pre.wav`;
  const irFile = `${out}.ir.wav`;
  const t60 = p.reverb > 0 ? await writeImpulse(irFile, p.reverbSize) : 0;
  await runFfmpeg(["-i", input, ...(t60 ? ["-i", irFile] : []), "-filter_complex", processingGraph(p, duration, t60), "-map", "[out]", "-ac", "1", "-c:a", "pcm_f32le", pre], { timeoutMs: 20 * 60_000, durationSeconds: duration });
  await rm(irFile, { force: true });
  const m = await measureLoudness(pre);
  const gain = m.loudness === null || m.loudness < -70 ? 0 : p.loudness - m.loudness;
  const len = duration + t60 + 0.5;
  const parts = [`[0:a]volume=${gain.toFixed(2)}dB,alimiter=limit=${db2lin(-1.5).toFixed(4)}:attack=3:release=60:level=disabled[v]`];
  let last = "v";
  if (p.roomTone > -90) {
    // Brown noise shaped to a quiet room (80 Hz – 4 kHz) at the requested level.
    parts.push(`anoisesrc=d=${len.toFixed(2)}:c=brown:r=${SR}:a=${(db2lin(p.roomTone) * 6).toFixed(6)}:seed=11,highpass=f=80,lowpass=f=4000[n]`, `[v][n]amix=inputs=2:normalize=0:duration=first[m]`);
    last = "m";
  }
  parts.push(`[${last}]volume=${p.volume.toFixed(3)}[out]`);
  await runFfmpeg(["-i", pre, "-filter_complex", parts.join(";"), "-map", "[out]", "-ac", "1", "-c:a", "pcm_s16le", `${out}.tmp.wav`], { timeoutMs: 20 * 60_000, durationSeconds: duration });
  await rename(`${out}.tmp.wav`, out);
  await rm(pre, { force: true });
  return { loudness: m.loudness };
}

/** Encode a WAV for preview / project narration (AAC in M4A). */
export async function encodeM4a(input: string, out: string, opts: { bitrate?: string; gainDb?: number } = {}): Promise<string> {
  if (existsSync(out)) return out;
  const af = opts.gainDb ? ["-af", `volume=${opts.gainDb.toFixed(2)}dB,alimiter=limit=${db2lin(-1.5).toFixed(4)}:level=disabled`] : [];
  await runFfmpeg(["-i", input, ...af, "-ac", "1", "-c:a", "aac", "-b:a", opts.bitrate ?? "96k", "-movflags", "+faststart", `${out}.tmp.m4a`], { timeoutMs: 20 * 60_000 });
  await rename(`${out}.tmp.m4a`, out);
  return out;
}
