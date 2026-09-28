/**
 * Measure how someone speaks, from audio:
 * - pitch: YIN (de Cheveigné & Kawahara 2002) on 40 ms windows every 10 ms, voiced frames only;
 * - speech/pause: 20 ms RMS frames against the recording's own noise floor and speech level;
 * - syllables: intensity peaks in voiced speech (after de Jong & Wempe 2009), for speaking rate;
 * - energy variation: spread of phrase loudness; brightness: FFmpeg band levels.
 * Used both on the user's samples and on each engine voice, so the match compares like with like.
 */
import { spawn } from "node:child_process";
import { ffmpegPath, spawnTracked } from "@/lib/render/ffmpeg";

const SR = 16000;

/** Decode any audio/video file to 16 kHz mono float samples. */
export function decodeMono16k(file: string, timeoutMs = 10 * 60_000): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawnTracked(() => spawn(ffmpegPath(), ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-vn", "-map", "0:a:0", "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { windowsHide: true }));
    const chunks: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Could not decode ${file}: ${err.slice(-300)}`));
      const buf = Buffer.concat(chunks);
      const out = new Float32Array(Math.floor(buf.length / 4));
      for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
      resolve(out);
    });
  });
}

/** YIN f0 (Hz) of one window, or 0 if unvoiced. */
function yin(x: Float32Array, start: number, w: number, minLag: number, maxLag: number, threshold = 0.15): number {
  const d = new Float32Array(maxLag + 1);
  for (let tau = 1; tau <= maxLag; tau++) {
    let s = 0;
    for (let i = 0; i < w; i++) {
      const diff = x[start + i]! - x[start + i + tau]!;
      s += diff * diff;
    }
    d[tau] = s;
  }
  // Cumulative mean normalised difference.
  d[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    run += d[tau]!;
    d[tau] = run > 0 ? (d[tau]! * tau) / run : 1;
  }
  // First dip under the threshold, then down to its local minimum.
  let best = -1;
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (d[tau]! < threshold) {
      while (tau + 1 <= maxLag && d[tau + 1]! < d[tau]!) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) return 0;
  // Parabolic interpolation around the minimum.
  const a = d[best - 1] ?? d[best]!;
  const b = d[best]!;
  const c = d[best + 1] ?? d[best]!;
  const den = a - 2 * b + c;
  const shift = den ? (0.5 * (a - c)) / den : 0;
  return SR / (best + shift);
}

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]! : 0);
const median = (v: number[]) => pct([...v].sort((a, b) => a - b), 0.5);

export interface SpeechStats {
  duration: number;
  speechSeconds: number;
  /** Seconds from the first to the last speech. */
  activeSeconds: number;
  f0: number[];
  syllables: number;
  pauses: number[];
  phraseLevels: number[];
  noiseFloor: number;
}

/** Measure one recording (16 kHz mono samples). */
export function speechStats(x: Float32Array): SpeechStats {
  const hop = SR * 0.01; // 10 ms
  const frames = Math.max(0, Math.floor((x.length - SR * 0.04) / hop));
  const rmsDb = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    const a = f * hop;
    for (let i = 0; i < 320; i++) s += x[a + i]! * x[a + i]!; // 20 ms
    rmsDb[f] = 10 * Math.log10(s / 320 + 1e-12);
  }
  const sorted = Array.from(rmsDb).sort((a, b) => a - b);
  const floor = Math.max(-100, pct(sorted, 0.1));
  const loud = pct(sorted, 0.95);
  // Speech: above the floor by a third of the dynamic range (at least 8 dB).
  const thr = floor + Math.max(8, (loud - floor) * 0.33);
  const speech = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) speech[f] = rmsDb[f]! > thr ? 1 : 0;
  // Close gaps shorter than 150 ms (stops and plosives are not pauses), drop blips under 60 ms.
  const fill = (val: 0 | 1, maxLen: number) => {
    let f = 0;
    while (f < frames) {
      if (speech[f] !== val) {
        f++;
        continue;
      }
      let e = f;
      while (e < frames && speech[e] === val) e++;
      if (e - f < maxLen && f > 0 && e < frames) for (let i = f; i < e; i++) speech[i] = val ? 0 : 1;
      f = e;
    }
  };
  fill(0, 15);
  fill(1, 6);

  // Segments of speech.
  const segs: { a: number; b: number }[] = [];
  for (let f = 0; f < frames; ) {
    if (!speech[f]) {
      f++;
      continue;
    }
    let e = f;
    while (e < frames && speech[e]) e++;
    segs.push({ a: f, b: e });
    f = e;
  }
  const pauses: number[] = [];
  for (let i = 1; i < segs.length; i++) {
    const gap = (segs[i]!.a - segs[i - 1]!.b) * 0.01;
    if (gap >= 0.25) pauses.push(gap);
  }
  const phraseLevels = segs.filter((s) => s.b - s.a >= 30).map((s) => {
    let sum = 0;
    for (let f = s.a; f < s.b; f++) sum += Math.pow(10, rmsDb[f]! / 10);
    return 10 * Math.log10(sum / (s.b - s.a));
  });

  // Pitch every 10 ms in speech (60–400 Hz).
  const w = 640;
  const minLag = Math.floor(SR / 400);
  const maxLag = Math.ceil(SR / 60);
  const f0 = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    if (!speech[f] || f * hop + w + maxLag >= x.length) continue;
    const hz = yin(x, f * hop, w, minLag, maxLag);
    if (hz >= 60 && hz <= 400) f0[f] = hz;
  }
  // Octave-error cleanup: drop values more than 7 semitones from the running median.
  const voiced = Array.from(f0).filter((v) => v > 0);
  const mid = median(voiced);
  const clean = voiced.filter((v) => Math.abs(12 * Math.log2(v / mid)) <= 7);

  // Syllable nuclei: peaks of the smoothed (70 ms) intensity above the speech threshold and within
  // 25 dB of the loudest speech, ≥ 1.5 dB above the dip since the previous peak, ≥ 80 ms apart.
  // Checked against known counts: 246 vs 237 syllables (66 s human narration), 9 vs 10 (a TTS line).
  const sm = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    let n = 0;
    for (let k = -3; k <= 3; k++) {
      const g = f + k;
      if (g >= 0 && g < frames) {
        s += rmsDb[g]!;
        n++;
      }
    }
    sm[f] = s / n;
  }
  let syllables = 0;
  let dip = Infinity;
  let lastPeak = -100;
  for (let f = 1; f < frames - 1; f++) {
    dip = Math.min(dip, sm[f]!);
    const isPeak = sm[f]! >= sm[f - 1]! && sm[f]! > sm[f + 1]!;
    if (isPeak && sm[f]! > thr && sm[f]! > loud - 25 && sm[f]! - dip >= 1.5 && f - lastPeak >= 8) {
      syllables++;
      lastPeak = f;
      dip = sm[f]!;
    }
  }
  const speechSeconds = segs.reduce((a, s) => a + (s.b - s.a), 0) * 0.01;
  const activeSeconds = segs.length ? (segs.at(-1)!.b - segs[0]!.a) * 0.01 : 0;
  return { duration: x.length / SR, speechSeconds, activeSeconds, f0: clean, syllables, pauses, phraseLevels, noiseFloor: floor };
}

export interface SpeechSummary {
  duration: number;
  speechSeconds: number;
  pitchMedian: number;
  pitchLow: number;
  pitchHigh: number;
  pitchRange: number;
  articulationRate: number;
  speakingRate: number;
  wordsPerMinute: number;
  pauseMedian: number;
  pauseLong: number;
  pausesPerMinute: number;
  energyVariation: number;
  noiseFloor: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Combine several recordings' stats into one summary. */
export function summarise(all: SpeechStats[]): SpeechSummary {
  const f0 = all.flatMap((s) => s.f0).sort((a, b) => a - b);
  const pauses = all.flatMap((s) => s.pauses).sort((a, b) => a - b);
  const levels = all.flatMap((s) => s.phraseLevels);
  const speech = all.reduce((a, s) => a + s.speechSeconds, 0);
  const active = all.reduce((a, s) => a + s.activeSeconds, 0);
  const syl = all.reduce((a, s) => a + s.syllables, 0);
  const mean = levels.reduce((a, v) => a + v, 0) / Math.max(1, levels.length);
  const sd = Math.sqrt(levels.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, levels.length));
  const low = pct(f0, 0.1);
  const high = pct(f0, 0.9);
  const speakingRate = active ? syl / active : 0;
  return {
    duration: r2(all.reduce((a, s) => a + s.duration, 0)),
    speechSeconds: r2(speech),
    pitchMedian: r2(pct(f0, 0.5)),
    pitchLow: r2(low),
    pitchHigh: r2(high),
    pitchRange: low > 0 ? r2(12 * Math.log2(high / low)) : 0,
    articulationRate: speech ? r2(syl / speech) : 0,
    speakingRate: r2(speakingRate),
    wordsPerMinute: Math.round((speakingRate / 1.5) * 60),
    pauseMedian: r2(pct(pauses, 0.5)),
    pauseLong: r2(pct(pauses, 0.9)),
    pausesPerMinute: active ? r2((pauses.length / active) * 60) : 0,
    energyVariation: r2(sd),
    noiseFloor: r2(Math.min(...all.map((s) => s.noiseFloor))),
  };
}
