/**
 * Deterministic editorial engines: pacing, visual diversity, meme gating and motion choice.
 * These run the same way whether plans came from Claude or the heuristic director, so AI
 * suggestions are always bounded by predictable rules.
 */
import type {
  AssetType,
  MemeFrequency,
  MemePlan,
  MotionType,
  NormalizedAsset,
  SceneIntensity,
  StyleProfile,
  VisualNeedType,
} from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// Visual pacing engine
// ---------------------------------------------------------------------------

/**
 * Target average visual duration for a scene.
 * High information → 2-3s, normal → 3-5s, slow/emotional → 5-8s; scaled by the style profile.
 */
export function targetShotDuration(i: SceneIntensity, style: StyleProfile): number {
  const info = i.informationDensity;
  const emotional = i.emotionalIntensity;
  const pace = 0.5 * info + 0.3 * i.narrationIntensity + 0.2 * i.importance; // 0..1, higher = faster
  let base: number;
  if (emotional > 0.7 && info < 0.4) base = 5 + (1 - pace) * 3; // slow/emotional: 5-8s
  else if (pace > 0.65) base = 2 + (1 - pace) * 3; // high information: 2-3s
  else base = 3 + (1 - pace) * 2; // normal: 3-5s
  const styleScale = style.averageShotDuration / 3.8;
  return clamp(base * styleScale, style.minShotDuration, style.maxShotDuration);
}

/**
 * Split a scene into shot durations that vary around the target (never a metronome).
 * Deterministic for a given seed so re-planning an unchanged scene gives the same cut points.
 */
export function splitSceneDurations(sceneDuration: number, target: number, seed: string, min = 1.2): number[] {
  const count = Math.max(1, Math.round(sceneDuration / target));
  const rand = seeded(seed);
  const weights = Array.from({ length: count }, () => 0.7 + rand() * 0.6);
  const sum = weights.reduce((a, b) => a + b, 0);
  let durations = weights.map((w) => (w / sum) * sceneDuration);
  // Merge shots that would be too short.
  while (durations.length > 1 && durations.some((d) => d < min)) {
    const i = durations.findIndex((d) => d < min);
    const j = i === durations.length - 1 ? i - 1 : i + 1;
    durations[j]! += durations[i]!;
    durations = durations.filter((_, k) => k !== i);
  }
  return durations;
}

// ---------------------------------------------------------------------------
// Visual diversity engine
// ---------------------------------------------------------------------------

export type VisualKind = "video" | "photo" | "archival" | "screenshot" | "gif" | "text";

export function kindOf(asset: Pick<NormalizedAsset, "type" | "archival">, need?: VisualNeedType): VisualKind {
  if (asset.type === "gif" || asset.type === "sticker") return "gif";
  if (need === "screenshot" || need === "article") return "screenshot";
  if (asset.archival) return "archival";
  return asset.type === "video" ? "video" : "photo";
}

/** Penalty (0-30) for repeating the recent visual types: photo→photo→photo is discouraged. */
export function diversityPenalty(kind: VisualKind, recent: VisualKind[]): number {
  const last3 = recent.slice(-3);
  let run = 0;
  for (let i = recent.length - 1; i >= 0 && recent[i] === kind; i--) run++;
  const share = last3.filter((k) => k === kind).length / Math.max(1, last3.length);
  return Math.min(30, run * 10 + share * 8);
}

/** Pick the asset type to request next, given the style mix and what was just shown. */
export function preferredNeedType(style: StyleProfile, recent: VisualKind[], seed: string): "video" | "photo" {
  const rand = seeded(seed)();
  const photoShare = style.photoPercentage / Math.max(1, style.photoPercentage + style.videoPercentage);
  const last = recent.at(-1);
  const prev = recent.at(-2);
  if (last === "photo" && prev === "photo") return "video";
  if (last === "video" && prev === "video") return "photo";
  return rand < photoShare ? "photo" : "video";
}

// ---------------------------------------------------------------------------
// Meme / reaction system
// ---------------------------------------------------------------------------

export const MEME_THRESHOLD: Record<MemeFrequency, number> = { OFF: Infinity, LOW: 0.72, MEDIUM: 0.6, HIGH: 0.48 };
/** Minimum number of scenes between memes. */
export const MEME_COOLDOWN_SCENES: Record<MemeFrequency, number> = { OFF: Infinity, LOW: 4, MEDIUM: 2, HIGH: 1 };

export function memeScore(s: MemePlan["score"]): number {
  // Scores arrive 0-100; weight the moments memes are for (punchlines, irony, absurdity).
  const v =
    0.25 * s.humorOpportunity +
    0.15 * s.surprise +
    0.2 * s.irony +
    0.2 * s.absurdity +
    0.1 * s.emotionalBreak +
    0.1 * s.narrativePacing;
  return clamp(v / 100, 0, 1);
}

/** Final gate: only insert when score > threshold, and not within the cooldown. */
export function shouldInsertMeme(
  plan: MemePlan,
  frequency: MemeFrequency,
  scenesSinceLastMeme: number,
): { insert: boolean; score: number; reason: string } {
  const score = memeScore(plan.score);
  if (frequency === "OFF") return { insert: false, score, reason: "memes disabled" };
  if (!plan.insert) return { insert: false, score, reason: "director found no meme moment" };
  if (scenesSinceLastMeme < MEME_COOLDOWN_SCENES[frequency]) return { insert: false, score, reason: "cooldown" };
  if (score <= MEME_THRESHOLD[frequency]) return { insert: false, score, reason: `score ${score.toFixed(2)} below threshold` };
  return { insert: true, score, reason: plan.reason };
}

// ---------------------------------------------------------------------------
// Photo animation
// ---------------------------------------------------------------------------

const PHOTO_MOTIONS: MotionType[] = [
  "slow_zoom_in",
  "slow_zoom_out",
  "pan_left",
  "pan_right",
  "pan_up",
  "pan_down",
  "diagonal",
  "subtle_rotation",
  "punch_in",
];

/**
 * Choose a photo motion suited to the image shape, never repeating the previous one.
 * Wide images pan horizontally, tall images pan vertically.
 */
export function chooseMotion(
  width: number | null,
  height: number | null,
  previous: MotionType | undefined,
  suggested: MotionType | undefined,
  seed: string,
): MotionType {
  const ratio = width && height ? width / height : 16 / 9;
  let pool: MotionType[];
  if (ratio > 2) pool = ["pan_left", "pan_right"];
  else if (ratio < 0.8) pool = ["pan_up", "pan_down", "slow_zoom_in"];
  else pool = PHOTO_MOTIONS;
  if (suggested && suggested !== "none" && suggested !== previous && pool.includes(suggested)) return suggested;
  const options = pool.filter((m) => m !== previous);
  const rand = seeded(seed)();
  return options[Math.floor(rand * options.length)] ?? "slow_zoom_in";
}

// ---------------------------------------------------------------------------

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/** Small deterministic PRNG (mulberry32) seeded from a string. */
export function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function assetTypesForNeed(need: VisualNeedType): AssetType[] {
  switch (need) {
    case "video":
      return ["video"];
    case "reaction":
      return ["gif"];
    default:
      return ["photo"];
  }
}
