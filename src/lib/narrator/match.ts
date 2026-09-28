/**
 * Fit an engine voice to a voice profile. Each Kokoro voice is measured once with the same
 * analyser as the user's recordings (pitch, articulation rate, pauses) on a fixed calibration
 * passage; results are cached. The closest voice by pitch (with a penalty for lower published
 * quality) is chosen, then pitch shift, speed and pause lengths are set from the differences.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeMono16k, speechStats, summarise, type SpeechSummary } from "./analyze";
import type { NarratorEngine } from "./engine";
import { KOKORO_VOICES, type VoiceAnalysis, type VoiceMatch } from "./types";
import { trimSilence, writeWav } from "./wav";

export const CALIBRATION = [
  "On a quiet street in the old part of the city, a young engineer spent his evenings building speakers out of scrap wood and salvaged radio parts.",
  "Nobody expected much from him.",
  "But within a year, his sound system was the talk of the town, and every Saturday night the crowds grew larger.",
];

const GRADE_PENALTY: Record<string, number> = { A: 0, "A-": 0.3, "B+": 0.5, B: 0.6, "B-": 0.8, "C+": 1.1, C: 1.4, "C-": 1.7, "D+": 2.2, D: 2.5, "D-": 2.8, "F+": 3.5, F: 4 };

export interface VoiceCalibration {
  voice: string;
  pitch: number;
  pitchRange: number;
  articulationRate: number;
  pauseMedian: number;
}

const CAL_VERSION = 1;

/** Measure one engine voice on the calibration passage (cached per voice). */
export async function calibrateVoice(engine: NarratorEngine, voice: string, dir: string): Promise<VoiceCalibration> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `calibration-v${CAL_VERSION}-${voice}.json`);
  if (existsSync(file)) return JSON.parse(await readFile(file, "utf8")) as VoiceCalibration;
  const stats = [];
  for (const [i, text] of CALIBRATION.entries()) {
    const r = await engine.synthesize({ text, voice, speed: 1, emphasis: [], beat: false });
    const wav = path.join(dir, `cal-${voice}-${i}.wav`);
    await writeWav(wav, trimSilence(r.samples, r.sampleRate), r.sampleRate);
    stats.push(speechStats(await decodeMono16k(wav)));
    await rm(wav, { force: true });
  }
  const s = summarise(stats);
  const cal: VoiceCalibration = { voice, pitch: s.pitchMedian, pitchRange: s.pitchRange, articulationRate: s.articulationRate, pauseMedian: s.pauseMedian };
  await writeFile(file, JSON.stringify(cal));
  return cal;
}

/** Which voices to measure for a profile: its accent, and the gender its pitch points to (both if unclear). */
export function candidateVoices(accent: "us" | "uk", pitchMedian: number): string[] {
  const gender = pitchMedian < 150 ? ["male"] : pitchMedian > 180 ? ["female"] : ["male", "female"];
  return KOKORO_VOICES.filter((v) => v.accent === accent && gender.includes(v.gender)).map((v) => v.id);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (v: number) => Math.round(v * 100) / 100;

export function chooseMatch(a: Pick<VoiceAnalysis, "pitchMedian" | "pitchRange" | "articulationRate" | "pauseMedian" | "pauseLong" | "energyVariation">, cals: VoiceCalibration[]): VoiceMatch {
  const notes: string[] = [];
  const candidates = cals
    .map((c) => {
      const grade = KOKORO_VOICES.find((v) => v.id === c.voice)?.grade ?? "D";
      // Semitones apart, beyond the ±3 we can shift naturally, count double.
      const st = Math.abs(12 * Math.log2(a.pitchMedian / c.pitch));
      const pitchCost = st <= 3 ? st * 0.5 : 1.5 + (st - 3) * 1.5;
      return { voice: c.voice, pitch: c.pitch, rate: c.articulationRate, grade, score: r2(pitchCost + (GRADE_PENALTY[grade] ?? 2.5)) };
    })
    .sort((x, y) => x.score - y.score);
  const best = candidates[0]!;
  const cal = cals.find((c) => c.voice === best.voice)!;
  const rawShift = 12 * Math.log2(a.pitchMedian / cal.pitch);
  const pitchShift = r2(clamp(rawShift, -3, 3));
  if (Math.abs(rawShift) > 3) notes.push(`Your voice is ${Math.abs(rawShift).toFixed(1)} semitones ${rawShift > 0 ? "higher" : "lower"} than the closest voice; shifting more than 3 semitones sounds processed, so it is shifted 3.`);
  const speed = r2(clamp(a.articulationRate > 0 && cal.articulationRate > 0 ? a.articulationRate / cal.articulationRate : 1, 0.8, 1.2));
  const sentencePause = r2(clamp(a.pauseMedian > 0 ? a.pauseMedian : 0.55, 0.3, 1.1));
  const paragraphPause = r2(clamp(a.pauseLong > 0 ? a.pauseLong * 1.3 : 1.1, sentencePause + 0.3, 2.2));
  // Typical read speech spans ~6–9 semitones (10th–90th percentile) with ~2–4 dB of phrase-level variation.
  const variation = r2(clamp(((a.pitchRange - 5) / 6) * 0.6 + ((a.energyVariation - 1.5) / 4) * 0.4, 0, 1));
  const name = KOKORO_VOICES.find((v) => v.id === best.voice)?.name ?? best.voice;
  notes.unshift(`Closest voice: ${name} (${best.pitch.toFixed(0)} Hz vs your ${a.pitchMedian.toFixed(0)} Hz) → pitch ${pitchShift >= 0 ? "+" : ""}${pitchShift} semitones.`);
  notes.push(`Pace: your ${a.articulationRate.toFixed(1)} vs its ${cal.articulationRate.toFixed(1)} syllables/s → speed ×${speed}.`);
  notes.push(`Pauses: ${sentencePause} s between sentences, ${paragraphPause} s between paragraphs (from your recordings).`);
  return { engine: "kokoro", voice: best.voice, pitchShift, speed, sentencePause, paragraphPause, variation, candidates, notes };
}

/** Human-readable notes about a profile's measurements. */
export function analysisNotes(s: SpeechSummary): string[] {
  const notes: string[] = [];
  if (s.speechSeconds < 20) notes.push(`Only ${s.speechSeconds.toFixed(0)} s of speech found — add recordings until there is at least 30–60 s for reliable pace and pause measurements.`);
  if (s.noiseFloor > -45) notes.push(`Background noise is high (${s.noiseFloor.toFixed(0)} dBFS); pitch and pauses may be less accurate. Record somewhere quieter if you can.`);
  if (s.pitchRange < 4) notes.push("Your recordings are fairly monotone (small pitch range); read expressively, as you would narrate, for a better match.");
  if (s.pausesPerMinute < 4 && s.speechSeconds > 20) notes.push("Few pauses detected — read full paragraphs rather than single sentences so pauses can be measured.");
  return notes;
}
