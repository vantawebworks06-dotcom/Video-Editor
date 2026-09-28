/**
 * Narrator: synthetic narration in a voice matched to the user's recordings.
 *
 * Engine: Kokoro-82M (Apache-2.0, runs locally on CPU through ONNX Runtime). Kokoro does not clone
 * voices; the profile's measured pitch, pace and pauses choose the closest Kokoro voice and set
 * the pitch shift, base speed and pause lengths. A cloning engine (Chatterbox) can be added behind
 * the same `engine` field later.
 */
import { z } from "zod";
import { VoiceProcessing } from "@/lib/domain/voice";

export const NarratorStyle = z.enum(["serious", "conversational", "dramatic", "suspenseful", "emotional", "energetic"]);
export type NarratorStyle = z.infer<typeof NarratorStyle>;

export const STYLE_LABEL: Record<NarratorStyle, string> = {
  serious: "Serious",
  conversational: "Conversational",
  dramatic: "Dramatic",
  suspenseful: "Suspenseful",
  emotional: "Emotional",
  energetic: "Energetic",
};

/** Whole-narration controls (manual). Neutral values leave the style + profile untouched. */
export const NarratorControls = z.object({
  /** Speed multiplier on top of the style and profile (1 = unchanged). */
  speed: z.number().min(0.7).max(1.35),
  /** Semitones on top of the profile's pitch match. */
  pitch: z.number().min(-4).max(4),
  /** Multiplier on every pause. */
  pauseScale: z.number().min(0.4).max(2.5),
  /** 0–1: how strongly key words are stressed (beat before, stress mark). */
  emphasis: z.number().min(0).max(1),
  /** 0–1: energy (level, brightness, pace lift). 0.5 = the style's own. */
  intensity: z.number().min(0).max(1),
  /** 0–1: how much delivery differs from sentence to sentence. */
  variation: z.number().min(0).max(1),
});
export type NarratorControls = z.infer<typeof NarratorControls>;

export const DEFAULT_CONTROLS: NarratorControls = { speed: 1, pitch: 0, pauseScale: 1, emphasis: 0.5, intensity: 0.5, variation: 0.6 };

/** Per-sentence manual override (any field left out follows the automatic plan). */
export const SentenceOverride = z.object({
  speed: z.number().min(0.6).max(1.5).optional(),
  pitch: z.number().min(-5).max(5).optional(),
  pauseAfter: z.number().min(0).max(5).optional(),
  intensity: z.number().min(0).max(1).optional(),
  /** Words to stress (overrides the automatic choice; [] = none). */
  emphasis: z.array(z.string().max(60)).max(8).optional(),
});
export type SentenceOverride = z.infer<typeof SentenceOverride>;

/** The delivery chosen for one sentence (automatic plan with overrides applied). */
export interface SentencePlan {
  /** Engine speed (1 = the voice's natural pace). */
  speed: number;
  /** Semitones relative to the matched voice (profile shift + style + meaning + manual). */
  pitch: number;
  /** dB applied to the sentence. */
  gainDb: number;
  /** dB of high-shelf tilt (brighter = more energy). */
  tilt: number;
  /** Seconds of silence after the sentence. */
  pauseAfter: number;
  /** Words stressed. */
  emphasis: string[];
  /** A short beat before each stressed word (dramatic delivery). */
  beat: boolean;
  /** Why (shown in the UI). */
  reasons: string[];
}

export const NarratorSentence = z.object({
  id: z.string(),
  text: z.string(),
  paragraph: z.number().int().min(0),
  /** Increments on "regenerate" so the engine input changes and the take differs. */
  take: z.number().int().min(0).default(0),
  override: SentenceOverride.nullable().default(null),
  /** Last generated audio (storage path of a small preview, duration, input hash). */
  audio: z.object({ path: z.string(), duration: z.number(), hash: z.string(), key: z.string().default("") }).nullable().default(null),
});
export type NarratorSentence = z.infer<typeof NarratorSentence>;

/** Post-generation processing: the narration chain plus tone and space. */
export const NarratorProcessing = VoiceProcessing.extend({
  /** dB, low shelf at 100 Hz. */
  bass: z.number().min(-10).max(10),
  /** dB, high shelf at 5 kHz. */
  treble: z.number().min(-10).max(10),
  /** Linear volume after everything else (1 = unchanged). */
  volume: z.number().min(0).max(2),
  /** 0–1 reverb amount; size 0–1 = small room → hall. */
  reverb: z.number().min(0).max(1),
  reverbSize: z.number().min(0).max(1),
  /** 0–1 echo amount; delay in ms. */
  echo: z.number().min(0).max(1),
  echoDelay: z.number().min(60).max(1000),
  /** dBFS of room tone under the whole narration (-90 = off): synthetic speech in digital silence sounds unnatural. */
  roomTone: z.number().min(-90).max(-45),
});
export type NarratorProcessing = z.infer<typeof NarratorProcessing>;

export const DEFAULT_PROCESSING: NarratorProcessing = {
  // Kokoro output is clean: light processing, no noise reduction by default.
  preset: "custom",
  highpass: 70,
  noiseReduction: 0,
  gate: 0,
  warmth: 1,
  mudCut: 1.5,
  presence: 1.5,
  air: 0.5,
  deEss: 0.3,
  compression: 0.35,
  loudness: -16,
  bass: 0,
  treble: 0,
  volume: 1,
  reverb: 0,
  reverbSize: 0.3,
  echo: 0,
  echoDelay: 250,
  roomTone: -66,
};

export const NarratorOutput = z.object({
  /** Unprocessed (engine + delivery) and processed previews (m4a) for A/B. */
  beforePath: z.string(),
  afterPath: z.string(),
  /** Processed narration at full quality, used when it becomes the project narration. */
  narrationPath: z.string(),
  duration: z.number(),
  hash: z.string(),
  /** Sentence id → start/end (s) in the narration. */
  timings: z.array(z.object({ id: z.string(), start: z.number(), end: z.number() })),
  /** outputBasis() when generated: differs from the current value when the output is out of date. */
  basis: z.string().default(""),
  voice: z.string().default(""),
  createdAt: z.string(),
});
export type NarratorOutput = z.infer<typeof NarratorOutput>;

export const Narrator = z.object({
  profileId: z.string().uuid().nullable().default(null),
  /** Engine voice when no profile is chosen (or to override the profile's match). */
  voice: z.string().nullable().default(null),
  style: NarratorStyle.default("conversational"),
  controls: NarratorControls.default(DEFAULT_CONTROLS),
  script: z.string().max(60_000).default(""),
  sentences: z.array(NarratorSentence).default([]),
  processing: NarratorProcessing.default(DEFAULT_PROCESSING),
  output: NarratorOutput.nullable().default(null),
});
export type Narrator = z.infer<typeof Narrator>;

export const EMPTY_NARRATOR: Narrator = Narrator.parse({});

// ---------------------------------------------------------------------------
// Voice profiles
// ---------------------------------------------------------------------------

export const VoiceSample = z.object({ path: z.string(), name: z.string(), duration: z.number().nullable().default(null), addedAt: z.string() });
export type VoiceSample = z.infer<typeof VoiceSample>;

/** What was measured from the user's recordings (all values measured, none guessed). */
export const VoiceAnalysis = z.object({
  /** Seconds of audio analysed, and of it detected as speech. */
  duration: z.number(),
  speechSeconds: z.number(),
  /** Fundamental frequency (YIN, voiced frames): median and 10th/90th percentile, Hz. */
  pitchMedian: z.number(),
  pitchLow: z.number(),
  pitchHigh: z.number(),
  /** Semitones between the 10th and 90th percentile (how melodic the delivery is). */
  pitchRange: z.number(),
  /** Syllables per second while speaking (energy-peak nuclei, pauses excluded). */
  articulationRate: z.number(),
  /** Syllables per second overall (pauses included). */
  speakingRate: z.number(),
  /** Estimated words per minute (speaking rate ÷ 1.5 syllables per word). */
  wordsPerMinute: z.number(),
  /** Pauses ≥ 0.25 s: median length, 90th percentile, and how many per minute. */
  pauseMedian: z.number(),
  pauseLong: z.number(),
  pausesPerMinute: z.number(),
  /** Std-dev of phrase loudness, dB (how much energy varies). */
  energyVariation: z.number(),
  /** Recording quality (noise floor etc.) for the notes. */
  noiseFloor: z.number(),
  notes: z.array(z.string()),
  analysedAt: z.string(),
});
export type VoiceAnalysis = z.infer<typeof VoiceAnalysis>;

/** How the engine voice was fitted to the profile. */
export const VoiceMatch = z.object({
  engine: z.literal("kokoro"),
  voice: z.string(),
  /** Semitones to shift the engine voice to the profile's pitch (limited to ±3 to stay natural). */
  pitchShift: z.number(),
  /** Engine speed that matches the profile's articulation rate. */
  speed: z.number(),
  /** Pause after a sentence (s) and between paragraphs, from the profile's pauses. */
  sentencePause: z.number(),
  paragraphPause: z.number(),
  /** 0–1 from the profile's pitch range and energy variation. */
  variation: z.number(),
  candidates: z.array(z.object({ voice: z.string(), pitch: z.number(), rate: z.number(), grade: z.string(), score: z.number() })),
  notes: z.array(z.string()),
});
export type VoiceMatch = z.infer<typeof VoiceMatch>;

export interface VoiceProfile {
  id: string;
  name: string;
  accent: "us" | "uk";
  samples: VoiceSample[];
  analysis: VoiceAnalysis | null;
  match: VoiceMatch | null;
  pronunciations: Record<string, string>;
  created_at: string;
  updated_at: string;
}

/** Kokoro-82M v1.0 English voices with the published quality grades (Kokoro VOICES.md). */
export const KOKORO_VOICES: { id: string; name: string; accent: "us" | "uk"; gender: "female" | "male"; grade: string }[] = [
  { id: "af_heart", name: "Heart", accent: "us", gender: "female", grade: "A" },
  { id: "af_bella", name: "Bella", accent: "us", gender: "female", grade: "A-" },
  { id: "af_nicole", name: "Nicole", accent: "us", gender: "female", grade: "B-" },
  { id: "af_aoede", name: "Aoede", accent: "us", gender: "female", grade: "C+" },
  { id: "af_kore", name: "Kore", accent: "us", gender: "female", grade: "C+" },
  { id: "af_sarah", name: "Sarah", accent: "us", gender: "female", grade: "C+" },
  { id: "af_nova", name: "Nova", accent: "us", gender: "female", grade: "C" },
  { id: "af_alloy", name: "Alloy", accent: "us", gender: "female", grade: "C" },
  { id: "af_sky", name: "Sky", accent: "us", gender: "female", grade: "C-" },
  { id: "af_jessica", name: "Jessica", accent: "us", gender: "female", grade: "D" },
  { id: "af_river", name: "River", accent: "us", gender: "female", grade: "D" },
  { id: "am_fenrir", name: "Fenrir", accent: "us", gender: "male", grade: "C+" },
  { id: "am_michael", name: "Michael", accent: "us", gender: "male", grade: "C+" },
  { id: "am_puck", name: "Puck", accent: "us", gender: "male", grade: "C+" },
  { id: "am_echo", name: "Echo", accent: "us", gender: "male", grade: "D" },
  { id: "am_eric", name: "Eric", accent: "us", gender: "male", grade: "D" },
  { id: "am_liam", name: "Liam", accent: "us", gender: "male", grade: "D" },
  { id: "am_onyx", name: "Onyx", accent: "us", gender: "male", grade: "D" },
  { id: "am_adam", name: "Adam", accent: "us", gender: "male", grade: "F+" },
  { id: "bf_emma", name: "Emma", accent: "uk", gender: "female", grade: "B-" },
  { id: "bf_isabella", name: "Isabella", accent: "uk", gender: "female", grade: "C" },
  { id: "bf_alice", name: "Alice", accent: "uk", gender: "female", grade: "D" },
  { id: "bf_lily", name: "Lily", accent: "uk", gender: "female", grade: "D" },
  { id: "bm_george", name: "George", accent: "uk", gender: "male", grade: "C" },
  { id: "bm_fable", name: "Fable", accent: "uk", gender: "male", grade: "C" },
  { id: "bm_lewis", name: "Lewis", accent: "uk", gender: "male", grade: "D+" },
  { id: "bm_daniel", name: "Daniel", accent: "uk", gender: "male", grade: "D" },
];

export const DEFAULT_VOICE_ID = "am_michael";
