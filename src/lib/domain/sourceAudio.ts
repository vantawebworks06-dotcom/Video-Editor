import { z } from "zod";

/**
 * How inserted source footage (an interview, a news report) plays against the narration:
 *  - pause:       the narration stops while the source plays, then resumes (time is inserted).
 *  - duck:        the narration keeps going at a reduced level under the source audio.
 *  - overlap:     the source starts while the narration is finishing its line; the narration then
 *                 pauses for the rest of the source (a J-cut into the clip).
 *  - visual_only: the source picture plays, its audio is muted; the narration is unchanged.
 */
export const SourceAudioMode = z.enum(["pause", "duck", "overlap", "visual_only"]);
export type SourceAudioMode = z.infer<typeof SourceAudioMode>;

export const SourceAudio = z.object({
  mode: SourceAudioMode,
  /** Linear gain of the source's own audio (1 = as recorded). */
  sourceVolume: z.number().min(0).max(2),
  /** Linear gain of the narration while it is ducked (duck mode, and the overlap window). */
  narrationVolume: z.number().min(0).max(1),
  fadeIn: z.number().min(0).max(5),
  fadeOut: z.number().min(0).max(5),
  /** Overlap mode: seconds the source plays before the narration pauses. */
  overlap: z.number().min(0).max(10),
  /** Ducking ramp (attack/release) in seconds. */
  duckRamp: z.number().min(0.05).max(3),
});
export type SourceAudio = z.infer<typeof SourceAudio>;

export const DEFAULT_SOURCE_AUDIO: SourceAudio = {
  mode: "pause",
  sourceVolume: 1,
  narrationVolume: 0.25,
  fadeIn: 0.15,
  fadeOut: 0.3,
  overlap: 1.5,
  duckRamp: 0.35,
};

export const SOURCE_MODE_LABEL: Record<SourceAudioMode, string> = {
  pause: "Pause narration",
  duck: "Duck narration",
  overlap: "Overlap",
  visual_only: "Visual only",
};

/** Inserted time (narration paused) in the edit — narration time `at`, `duration` seconds long. */
export interface NarrationInsert {
  /** Narration time at which the narration pauses. */
  at: number;
  duration: number;
  /** Output time the pause starts at (after earlier inserts). */
  outAt: number;
}

/** Map narration time → output time. `side` decides a time exactly on an insertion point. */
export function toOutputTime(t: number, inserts: Pick<NarrationInsert, "at" | "duration">[], side: "before" | "after" = "after"): number {
  let out = t;
  // Times within a microsecond of a pause point count as "at" it (word times are unrounded floats:
  // a word ending at 8.0000000001 still ends before a pause at 8.0).
  const EPS = 1e-6;
  for (const ins of inserts) if (ins.at < t - EPS || (side === "after" && Math.abs(ins.at - t) <= EPS)) out += ins.duration;
  return out;
}

/** Narration pauses created by pause/overlap source clips, in narration-time order. */
export function narrationInserts(sources: { start: number; duration: number; audio: SourceAudio }[], snap: (t: number) => number = (t) => t): NarrationInsert[] {
  const raw = sources
    .filter((s) => s.audio.mode === "pause" || s.audio.mode === "overlap")
    .map((s) => {
      const o = s.audio.mode === "overlap" ? Math.min(s.audio.overlap, Math.max(0, s.duration - 0.2)) : 0;
      // The narration stops at a word boundary (snap), never mid-word.
      return { at: round(snap(s.start + o)), duration: round(Math.max(0.2, s.duration - o)) };
    })
    .sort((a, b) => a.at - b.at);
  let shift = 0;
  return raw.map((r) => {
    const ins = { ...r, outAt: round(r.at + shift) };
    shift += r.duration;
    return ins;
  });
}

const round = (n: number) => Math.round(n * 1000) / 1000;
