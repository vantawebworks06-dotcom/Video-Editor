/**
 * Narration (voice) processing: the chain applied to the narration before it is mixed.
 *
 * Every preset is a set of plain values, so "custom" is just the same controls moved by hand.
 * "auto" derives the values from a measurement of the narration (noise floor, speech level,
 * loudness range, sibilance) — see audio/voiceMeasure.ts.
 */
import { z } from "zod";

export const VoicePreset = z.enum(["off", "auto", "natural", "documentary", "broadcast", "podcast", "custom"]);
export type VoicePreset = z.infer<typeof VoicePreset>;

export const VoiceProcessing = z.object({
  preset: VoicePreset,
  /** Hz; rumble/handling noise below this is removed (0 = off). */
  highpass: z.number().min(0).max(200),
  /** 0–1: FFT noise reduction strength (0 = off). */
  noiseReduction: z.number().min(0).max(1),
  /** 0–1: lowers room noise between phrases (downward expander; 0 = off). */
  gate: z.number().min(0).max(1),
  /** dB, low shelf at 150 Hz: body/warmth. */
  warmth: z.number().min(-6).max(6),
  /** dB cut around 300 Hz: boxiness/mud (0 = off). */
  mudCut: z.number().min(0).max(8),
  /** dB, peak around 3.5 kHz: clarity/intelligibility. */
  presence: z.number().min(-6).max(6),
  /** dB, high shelf at 10 kHz: air/brightness. */
  air: z.number().min(-6).max(6),
  /** 0–1: de-essing intensity (harsh s/sh sounds; 0 = off). */
  deEss: z.number().min(0).max(1),
  /** 0–1: compression amount (evens out loud and quiet words; 0 = off). */
  compression: z.number().min(0).max(1),
  /** Integrated loudness target of the narration, LUFS. */
  loudness: z.number().min(-24).max(-12),
});
export type VoiceProcessing = z.infer<typeof VoiceProcessing>;

type Values = Omit<VoiceProcessing, "preset">;

/** Loudness only: the behaviour before voice processing existed (renders stay identical). */
const OFF: Values = { highpass: 0, noiseReduction: 0, gate: 0, warmth: 0, mudCut: 0, presence: 0, air: 0, deEss: 0, compression: 0, loudness: -16 };

export const VOICE_PRESETS: Record<Exclude<VoicePreset, "auto" | "custom">, Values> = {
  off: OFF,
  /** Light touch: clean up without changing the voice's character. */
  natural: { highpass: 80, noiseReduction: 0.4, gate: 0, warmth: 0, mudCut: 1.5, presence: 1, air: 0.5, deEss: 0.25, compression: 0.3, loudness: -16 },
  /** Warm, intimate narration that sits under music. */
  documentary: { highpass: 75, noiseReduction: 0.35, gate: 0.2, warmth: 1.5, mudCut: 2.5, presence: 2, air: 1, deEss: 0.4, compression: 0.5, loudness: -16 },
  /** Dense and forward, consistent level. */
  broadcast: { highpass: 90, noiseReduction: 0.4, gate: 0.3, warmth: 1, mudCut: 3, presence: 3, air: 1.5, deEss: 0.5, compression: 0.75, loudness: -16 },
  /** Close, clear speech for spoken-word content (louder target, like podcast platforms). */
  podcast: { highpass: 80, noiseReduction: 0.45, gate: 0.35, warmth: 2, mudCut: 3, presence: 2.5, air: 1, deEss: 0.45, compression: 0.65, loudness: -14 },
};

export const VOICE_PRESET_LABEL: Record<VoicePreset, string> = {
  off: "Loudness only",
  auto: "Auto (from measurement)",
  natural: "Natural",
  documentary: "Documentary",
  broadcast: "Broadcast",
  podcast: "Podcast",
  custom: "Custom",
};

export const DEFAULT_VOICE: VoiceProcessing = { preset: "off", ...OFF };

/** What was measured about the narration (all values measured from the file). */
export const VoiceMeasurement = z.object({
  /** dBFS RMS of the quietest 10% of 50 ms windows (room/background noise). */
  noiseFloor: z.number(),
  /** dBFS RMS of the loudest 10% of windows (speech). */
  speechLevel: z.number(),
  /** speechLevel − noiseFloor, dB. */
  snr: z.number(),
  /** Integrated loudness, LUFS. */
  loudness: z.number(),
  /** True peak, dBTP. */
  truePeak: z.number(),
  /** Loudness range, LU. */
  lra: z.number(),
  /** dB of 5–9 kHz energy relative to 300 Hz–4 kHz during speech (higher = harsher s sounds). */
  sibilance: z.number(),
  /** dB of < 80 Hz energy relative to 300 Hz–4 kHz (rumble, handling, HVAC; includes low voice harmonics). */
  rumble: z.number(),
  duration: z.number(),
  /** The longest stretch with no speech (noise only), used to teach the denoiser the noise; null if none. */
  noiseSample: z.object({ start: z.number(), end: z.number() }).nullable().default(null),
});
export type VoiceMeasurement = z.infer<typeof VoiceMeasurement>;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Settings recommended for a measured narration, with the reason for each. */
export function recommendVoice(m: VoiceMeasurement): { values: Values; notes: string[] } {
  const notes: string[] = [];
  // Noise: a floor around −70 dBFS is clean; −40 is clearly audible hiss/room.
  const noiseReduction = r2(clamp((m.noiseFloor + 68) / 30, 0, 0.8));
  if (noiseReduction > 0.05) notes.push(`Background noise at ${m.noiseFloor.toFixed(0)} dBFS → noise reduction ${Math.round(noiseReduction * 100)}%.`);
  else notes.push(`Background is clean (${m.noiseFloor.toFixed(0)} dBFS) → no noise reduction.`);
  // Gate: only where noise is audible between phrases, and never so much it chops words.
  const rawGate = m.snr < 45 && m.noiseFloor > -60 ? clamp((45 - m.snr) / 25, 0, 0.5) : 0;
  const gate = rawGate >= 0.1 ? r2(rawGate) : 0;
  if (gate > 0) notes.push(`Speech is only ${m.snr.toFixed(0)} dB above the noise → gentle gap noise reduction.`);
  // Low voice harmonics leak into the < 80 Hz band, so only strong readings mean real rumble.
  const highpass = m.rumble > -10 ? 100 : 80;
  if (m.rumble > -10) notes.push(`Low-frequency rumble (${m.rumble.toFixed(0)} dB) → high-pass at ${highpass} Hz.`);
  // Sibilance: about −14 dB is typical speech; above −9 is harsh.
  const deEss = r2(clamp((m.sibilance + 16) / 10, 0, 0.8));
  if (deEss > 0.3) notes.push(`Strong s sounds (${m.sibilance.toFixed(0)} dB) → de-esser ${Math.round(deEss * 100)}%.`);
  // Dynamics: a wide loudness range makes quiet words disappear under music.
  const compression = r2(clamp((m.lra - 4) / 12, 0.2, 0.8));
  notes.push(`Loudness range ${m.lra.toFixed(1)} LU → compression ${Math.round(compression * 100)}%.`);
  if (m.truePeak > -0.5) notes.push(`Peaks reach ${m.truePeak.toFixed(1)} dBTP — the source may be clipped; processing can't restore clipped audio.`);
  return { values: { highpass, noiseReduction, gate, warmth: 1, mudCut: 2, presence: 2, air: 1, deEss, compression, loudness: -16 }, notes };
}

/** The values a setting resolves to (presets filled in; auto needs a measurement). */
export function resolveVoice(v: VoiceProcessing, m: VoiceMeasurement | null): Values {
  if (v.preset === "custom") return v;
  if (v.preset === "auto") return m ? recommendVoice(m).values : VOICE_PRESETS.natural;
  return VOICE_PRESETS[v.preset];
}

const db2lin = (db: number) => Math.pow(10, db / 20);

/**
 * FFmpeg filters for the narration (after resampling, before mixing). The chain order follows
 * common voice practice: clean (high-pass, denoise, expander) → tone (EQ) → de-ess → dynamics →
 * loudness. Every stage at 0 is left out, so "Loudness only" is exactly loudnorm.
 */
export interface LoudnormMeasured {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export function voiceChain(values: Values, m: VoiceMeasurement | null, opts: { loudnorm?: "dynamic" | "none" | LoudnormMeasured; volume?: number } = {}): string {
  const f: string[] = [];
  if (values.highpass > 0) f.push(`highpass=f=${Math.round(values.highpass)}:poles=2`);
  if (values.noiseReduction > 0) {
    // nr: dB of reduction; nf: the measured noise floor (default −50) so it removes only noise.
    const nf = clamp(Math.round(m?.noiseFloor ?? -50), -80, -20);
    const nr = (6 + values.noiseReduction * 24).toFixed(1);
    // With a noise-only stretch the denoiser learns the actual noise there (about 3× more
    // reduction than blind tracking in tests); otherwise it tracks the noise as it goes.
    const ns = m?.noiseSample;
    if (ns) f.unshift(`asendcmd=c='${ns.start.toFixed(2)} afftdn sn start;${ns.end.toFixed(2)} afftdn sn stop'`);
    f.push(ns ? `afftdn=nr=${nr}:nf=${nf}:tn=0` : `afftdn=nr=${nr}:nf=${nf}:tn=1`);
  }
  if (values.gate > 0) {
    // Downward expander a little above the noise floor: gaps get quieter, speech is untouched.
    const threshold = db2lin(clamp((m?.noiseFloor ?? -55) + 10, -70, -30));
    f.push(`agate=threshold=${threshold.toFixed(5)}:ratio=${(1.5 + values.gate * 3).toFixed(2)}:range=${db2lin(-6 - values.gate * 18).toFixed(4)}:attack=8:release=250:knee=4`);
  }
  if (values.warmth) f.push(`lowshelf=f=150:g=${values.warmth.toFixed(1)}:t=q:w=0.7`);
  if (values.mudCut > 0) f.push(`equalizer=f=320:t=q:w=1.1:g=${(-values.mudCut).toFixed(1)}`);
  if (values.presence) f.push(`equalizer=f=3500:t=q:w=1.2:g=${values.presence.toFixed(1)}`);
  if (values.air) f.push(`highshelf=f=10000:g=${values.air.toFixed(1)}:t=q:w=0.7`);
  if (values.deEss > 0) f.push(`deesser=i=${values.deEss.toFixed(2)}:m=0.5:f=0.5:s=o`);
  if (values.compression > 0) {
    const c = values.compression;
    f.push(`acompressor=threshold=${db2lin(-14 - c * 12).toFixed(4)}:ratio=${(1.5 + c * 3.5).toFixed(2)}:attack=${Math.round(15 - c * 7)}:release=${Math.round(120 + c * 80)}:knee=3`);
  }
  const ln = opts.loudnorm ?? "dynamic";
  if (ln === "dynamic") f.push(`loudnorm=I=${values.loudness}:TP=-1.5:LRA=11`);
  else if (ln !== "none") {
    // Second pass: the measured input makes loudnorm apply one exact linear gain (hits the target).
    f.push(`loudnorm=I=${values.loudness}:TP=-1.5:LRA=11:measured_I=${ln.input_i}:measured_TP=${ln.input_tp}:measured_LRA=${ln.input_lra}:measured_thresh=${ln.input_thresh}:offset=${ln.target_offset}:linear=true`);
  }
  if (opts.volume !== undefined && opts.volume !== 1) f.push(`volume=${opts.volume.toFixed(3)}`);
  return f.join(",") || "anull";
}
