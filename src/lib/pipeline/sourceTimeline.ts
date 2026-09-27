/**
 * Source footage (interviews, news reports) on a narration-backed timeline.
 *
 * The edit is planned in narration time. Source clips then change it:
 *  - pause / overlap insert time: the narration stops, the source plays, the narration resumes —
 *    everything after the insertion point moves later in the output;
 *  - duck / visual_only lay the source over the picture without moving anything;
 *  - duck (and the overlapping part of overlap) lowers the narration under the source audio.
 * The result is still a contiguous, non-overlapping visual track (what the renderer needs).
 */
import { narrationInserts, type NarrationInsert, type SourceAudio, toOutputTime } from "@/lib/domain/sourceAudio";
import type { VisualClip } from "@/lib/domain/types";

export interface SourcePlacement {
  clip: VisualClip; // narration-time start/duration, role "source"
  audio: SourceAudio;
}

export interface SourceResult {
  visuals: VisualClip[];
  inserts: NarrationInsert[];
  voiceDucks: { from: number; to: number; level: number; ramp: number }[];
  duration: number;
  /** Narration time → output time. */
  map: (t: number, side?: "before" | "after") => number;
}

const MIN_PART = 0.15;
const round = (n: number) => Math.round(n * 1000) / 1000;

/** Cut [x, y) out of a contiguous track and put `clip` there. Parts of cut clips keep playing in sync. */
export function overlayClip(list: VisualClip[], x: number, y: number, clip: VisualClip): VisualClip[] {
  const out: VisualClip[] = [];
  for (const v of list) {
    const a = v.start;
    const b = v.start + v.duration;
    if (b <= x + 1e-6 || a >= y - 1e-6) {
      out.push(v);
      continue;
    }
    if (a < x) out.push({ ...v, duration: round(x - a), transitionOut: undefined });
    if (b > y) {
      const cut = y - a;
      out.push({ ...v, id: `${v.id}~${Math.round(y * 1000)}`, start: round(y), duration: round(b - y), trimStart: v.asset.type === "video" || v.asset.type === "gif" ? round(v.trimStart + cut) : v.trimStart, transitionIn: "hard_cut" });
    }
  }
  out.push({ ...clip, start: round(x), duration: round(y - x) });
  return normalize(out.sort((p, q) => p.start - q.start));
}

/** Merge slivers into the previous clip and make starts contiguous again. */
export function normalize(list: VisualClip[]): VisualClip[] {
  const out: VisualClip[] = [];
  for (const v of list) {
    const prev = out.at(-1);
    if (v.duration < MIN_PART && prev && v.role !== "source") {
      prev.duration = round(prev.duration + v.duration);
      continue;
    }
    if (prev && prev.duration < MIN_PART && prev.role !== "source") {
      // A sliver at the front: give its time to this clip.
      out.pop();
      const shift = prev.duration;
      out.push({ ...v, start: prev.start, duration: round(v.duration + shift), trimStart: v.asset.type === "video" ? Math.max(0, round(v.trimStart - shift)) : v.trimStart });
      continue;
    }
    out.push({ ...v });
  }
  for (let i = 1; i < out.length; i++) {
    const p = out[i - 1]!;
    out[i]!.start = round(p.start + p.duration);
  }
  return out;
}

/** Split base clips at narration pauses and move everything to output time (gaps where pauses are). */
function mapToOutput(base: VisualClip[], inserts: NarrationInsert[]): VisualClip[] {
  const out: VisualClip[] = [];
  for (const v of base) {
    const a = v.start;
    const b = v.start + v.duration;
    const cuts = inserts.map((i) => i.at).filter((t) => t > a + 1e-6 && t < b - 1e-6);
    let from = a;
    for (const [k, t] of [...cuts, b].entries()) {
      const s = toOutputTime(from, inserts, "after");
      const e = toOutputTime(t, inserts, "before");
      if (e - s > 1e-3) {
        out.push({ ...v, id: k === 0 ? v.id : `${v.id}~p${k}`, start: round(s), duration: round(e - s), trimStart: k === 0 || v.asset.type !== "video" ? v.trimStart : round(v.trimStart + (from - a)), transitionIn: k === 0 ? v.transitionIn : "hard_cut", transitionOut: t === b ? v.transitionOut : undefined });
      }
      from = t;
    }
  }
  return out;
}

/**
 * snap: moves a narration pause point to the nearest word boundary (so the narration never stops
 * mid-word and captions never straddle a pause). A pause-mode clip starts where the pause does.
 */
export function applySources(base: VisualClip[], sources: SourcePlacement[], narrationDuration: number, opts: { snap?: (t: number) => number } = {}): SourceResult {
  const snap = opts.snap ?? ((t: number) => t);
  const sorted = [...sources].map((s) => (s.audio.mode === "pause" ? { ...s, clip: { ...s.clip, start: round(snap(s.clip.start)) } } : s)).sort((p, q) => p.clip.start - q.clip.start);
  const inserts = narrationInserts(sorted.map((s) => ({ start: s.clip.start, duration: s.clip.duration, audio: s.audio })), snap);
  const map = (t: number, side: "before" | "after" = "after") => toOutputTime(t, inserts, side);
  let visuals = mapToOutput(base, inserts);
  const voiceDucks: SourceResult["voiceDucks"] = [];
  for (const s of sorted) {
    const x = map(s.clip.start, s.audio.mode === "pause" ? "before" : "after");
    const y = x + s.clip.duration;
    visuals = overlayClip(visuals, round(x), round(y), { ...s.clip, sourceAudio: s.audio, role: "source", motion: { type: "none", intensity: 0 } });
    if (s.audio.mode === "duck") voiceDucks.push({ from: round(x), to: round(y), level: s.audio.narrationVolume, ramp: s.audio.duckRamp });
    if (s.audio.mode === "overlap") {
      const o = Math.min(s.audio.overlap, Math.max(0, s.clip.duration - 0.2));
      if (o > 0.05) voiceDucks.push({ from: round(x), to: round(x + o), level: s.audio.narrationVolume, ramp: Math.min(s.audio.duckRamp, o / 2) });
    }
  }
  const inserted = inserts.reduce((sum, i) => sum + i.duration, 0);
  const duration = round(narrationDuration + inserted);
  // The last clip always runs to the end of the edit.
  const last = visuals.at(-1);
  if (last && last.start + last.duration < duration) last.duration = round(duration - last.start);
  return { visuals, inserts, voiceDucks, duration, map };
}
