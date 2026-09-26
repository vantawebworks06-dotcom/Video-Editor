/**
 * Music direction (sections 14-16 of the brief): the score follows the story. Each scene's mood
 * (from the storyboard) picks a bed; neighbouring scenes are merged into sections long enough to
 * feel intentional; sections crossfade; the volume follows the intensity curve (quiet under calm
 * explanation, building underneath tension, a short drop right before a climax and a hard hit on
 * it, a lower bed for the aftermath). Voice-keyed ducking in the mixer keeps narration on top.
 */
import type { MusicCue, MusicMood, ProjectSettings, ScenePlan } from "@/lib/domain/types";
import { MUSIC_TRACKS } from "@/lib/render/libraryTracks";

/** Mood → generated bed (see scripts/generate-library.ts). */
export const MOOD_TRACK: Record<MusicMood, string> = {
  calm: "ambient_pad",
  neutral: "ambient_pad",
  reflective: "sad_keys",
  sad: "sad_keys",
  mysterious: "mystery_bells",
  tense: "tension_drone",
  suspenseful: "suspense_tick",
  dark: "dark_pulse",
  aggressive: "dark_pulse",
  triumphant: "triumph_rise",
  energetic: "energy_beat",
  comedic: "light_pulse",
};

/**
 * Per-track trim so every bed sits at roughly the same loudness (measured mean levels differ by
 * up to 14 dB; without this a "dark" section would be quieter than a calm one).
 */
export const TRACK_TRIM: Record<string, number> = Object.fromEntries(
  Object.entries({ ambient_pad: 0.97, tension_drone: 0.5, light_pulse: 2.2, dark_pulse: 1.55, suspense_tick: 1.0, sad_keys: 1.6, triumph_rise: 1.45, energy_beat: 0.8, mystery_bells: 1.2 })
    // +6 dB (with gentler ducking in audio.ts): measured ~14 dB under the narration in calm
    // passages, ~10 dB in a climax. Before, the beds sat ~25 dB under it — inaudible.
    .map(([k, v]) => [k, Math.round(v * 2 * 1000) / 1000]),
);

const MIN_SECTION = 14;

function sceneGain(p: ScenePlan): number {
  const sb = p.storyboard;
  const I = sb?.intensity ?? Math.round(p.intensity.importance * 10);
  let g = 0.6 + 0.065 * I;
  if (sb?.intents.includes("climax")) g += 0.12;
  if (sb?.intents.includes("aftermath")) g = Math.min(g, 0.72);
  return Math.round(g * 1000) / 1000;
}

export interface MusicPlanInput {
  plans: ScenePlan[];
  duration: number;
  settings: ProjectSettings;
  /** Local file for a library track key, or null if missing. */
  resolveTrack: (key: string) => string | null;
  /** The project's uploaded music file, when settings.musicTrack === "uploaded". */
  uploadedPath: string | null;
}

/** Build the music cues for a timeline. Empty when music is off or no file is available. */
export function buildMusicPlan(input: MusicPlanInput): MusicCue[] {
  const { plans, duration, settings } = input;
  if (settings.musicTrack === "none" || !plans.length) return [];
  const round = (n: number) => Math.round(n * 1000) / 1000;

  // A single chosen track (the user's upload or a named bed) still follows the intensity curve.
  const fixed = settings.musicTrack === "uploaded" ? input.uploadedPath : settings.musicTrack !== "auto" ? input.resolveTrack(settings.musicTrack) : null;
  if (settings.musicTrack !== "auto") {
    if (!fixed) return [];
    return [{ file: fixed, label: MUSIC_TRACKS.find((t) => t.key === settings.musicTrack)?.name ?? "Uploaded music", mood: null, start: 0, end: round(duration), offset: 0, fadeIn: 1.5, fadeOut: 2.5, trim: TRACK_TRIM[settings.musicTrack] ?? 1, gains: envelope(plans, 0, duration) }];
  }

  // Story-driven: sections of scenes sharing a bed.
  type Section = { track: string; mood: MusicMood; start: number; end: number; climax: boolean; plans: ScenePlan[] };
  const sections: Section[] = [];
  for (const p of plans) {
    const mood = p.storyboard?.musicMood ?? "neutral";
    const track = MOOD_TRACK[mood];
    const climax = Boolean(p.storyboard?.intents.includes("climax"));
    const last = sections.at(-1);
    if (last && last.track === track && !climax && !last.climax) {
      last.end = p.endTime;
      last.plans.push(p);
    } else {
      sections.push({ track, mood, start: p.startTime, end: p.endTime, climax, plans: [p] });
    }
  }
  // Short sections are folded into the previous one (music that changes every few seconds feels
  // random); a climax always keeps its own section.
  for (let i = 1; i < sections.length; i++) {
    const s = sections[i]!;
    if (s.climax || s.end - s.start >= MIN_SECTION) continue;
    const prev = sections[i - 1]!;
    if (prev.climax) continue;
    prev.end = s.end;
    prev.plans.push(...s.plans);
    sections.splice(i--, 1);
  }
  if (sections.length > 1 && !sections[0]!.climax && sections[0]!.end - sections[0]!.start < MIN_SECTION) {
    const [a, b] = sections;
    b!.start = a!.start;
    b!.plans.unshift(...a!.plans);
    sections.shift();
  }
  // Folding can leave neighbours on the same bed: join them (no pointless crossfade/restart).
  for (let i = 1; i < sections.length; i++) {
    const [a, b] = [sections[i - 1]!, sections[i]!];
    if (a.track !== b.track || a.climax || b.climax) continue;
    a.end = b.end;
    a.plans.push(...b.plans);
    sections.splice(i--, 1);
  }
  sections[0]!.start = 0;
  sections.at(-1)!.end = duration;

  const cues: MusicCue[] = [];
  sections.forEach((s, i) => {
    const file = input.resolveTrack(s.track);
    if (!file) return;
    const next = sections[i + 1];
    // Crossfade 1.5 s around boundaries; into a climax the previous bed drops out just before
    // the hit, and the climax bed enters hard.
    const start = i === 0 ? 0 : s.climax ? s.start : Math.max(0, s.start - 0.75);
    const end = next ? (next.climax ? next.start - 0.55 : Math.min(duration, s.end + 0.75)) : duration;
    if (end - start < 1) return;
    cues.push({
      file,
      label: MUSIC_TRACKS.find((t) => t.key === s.track)?.name ?? s.track,
      mood: s.mood,
      start: round(start),
      end: round(end),
      offset: round((start * 0.37) % 45),
      fadeIn: i === 0 ? 1.5 : s.climax ? 0.05 : 1.5,
      fadeOut: next?.climax ? 0.35 : 1.5,
      trim: TRACK_TRIM[s.track] ?? 1,
      gains: envelope(s.plans, start, end),
    });
  });
  return cues;
}

/** Gain points (relative to the cue's start) following each scene's intensity. */
function envelope(plans: ScenePlan[], cueStart: number, cueEnd: number): { t: number; g: number }[] {
  const pts: { t: number; g: number }[] = [];
  const rel = (t: number) => Math.max(0, Math.round((t - cueStart) * 1000) / 1000);
  for (const [i, p] of plans.entries()) {
    const g = sceneGain(p);
    const next = plans[i + 1];
    if (p.storyboard?.intents.includes("buildup") && next) {
      // Build underneath: rise across the scene towards the next one.
      pts.push({ t: rel(p.startTime), g }, { t: rel(p.endTime), g: Math.max(g, sceneGain(next)) });
    } else {
      pts.push({ t: rel(p.startTime), g }, { t: rel(Math.max(p.startTime, p.endTime - 0.4)), g });
    }
  }
  if (!pts.length) pts.push({ t: 0, g: 0.8 });
  pts.push({ t: rel(cueEnd), g: pts.at(-1)!.g });
  // Strictly increasing times.
  return pts.filter((p, i) => i === 0 || p.t > pts[i - 1]!.t);
}

/** FFmpeg `volume` expression interpolating the gain points over t (seconds). */
export function gainExpression(points: { t: number; g: number }[]): string {
  if (points.length === 1) return points[0]!.g.toFixed(3);
  let expr = points.at(-1)!.g.toFixed(3);
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const seg = `${a.g.toFixed(3)}+(${(b.g - a.g).toFixed(3)})*(t-${a.t.toFixed(3)})/${Math.max(0.001, b.t - a.t).toFixed(3)}`;
    expr = `if(lt(t,${b.t.toFixed(3)}),${seg},${expr})`;
  }
  return expr;
}
