/**
 * Editorial score and style match (sections 24-27 of the brief).
 *
 * The planned edit is measured the same way the reference is (shot lengths, spread, cut rate,
 * transition mix, stills vs live, SFX/silences per minute, music changes) and scored per
 * dimension. Relevance scores come from the per-clip relevance breakdown — i.e. whether the picture
 * is about the topic and shows what the line says — never from keyword counts. Weak dimensions
 * trigger targeted refinement passes (generate.ts); the score is recomputed after each pass.
 */
import type { ScenePlan } from "@/lib/domain/types";
import { isGraphic } from "./cards";
import { clamp } from "./engines";
import type { SceneSelection } from "./generate";
import type { EditingTargets } from "./style";

export interface EditMeasurements {
  averageShot: number;
  medianShot: number;
  shotVariation: number;
  cutsPerMinute: number;
  transitionMix: { hardCut: number; dissolve: number; dipToBlack: number; dipToWhite: number; stylised: number };
  stillShare: number;
  sfxPerMinute: number;
  silencesPerMinute: number;
  musicChangesPerMinute: number;
}

export interface EditorialScore {
  total: number;
  topicRelevance: number;
  narrationMatch: number;
  visualVariety: number;
  pacing: number;
  referenceStyle: number;
  soundDesign: number;
  musicDynamics: number;
  transitionVariety: number;
  measurements: EditMeasurements;
  /** Human-readable reasons for any weak dimension. */
  notes: string[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const closeness = (value: number, target: number, tolerance: number) => clamp(1 - Math.abs(value - target) / Math.max(1e-6, tolerance), 0, 1);

export function measureEdit(selections: SceneSelection[], plans: ScenePlan[]): EditMeasurements {
  const prim = selections.filter((s) => s.role === "primary").sort((a, b) => a.start - b.start);
  const durs = prim.map((s) => s.duration);
  const sorted = [...durs].sort((a, b) => a - b);
  const avg = mean(durs);
  const minutes = Math.max(0.1, ((plans.at(-1)?.endTime ?? 60) - (plans[0]?.startTime ?? 0)) / 60);
  const joins = prim.slice(1);
  const share = (pred: (t: string) => boolean) => joins.filter((s) => pred(s.transitionIn ?? "hard_cut")).length / Math.max(1, joins.length);
  const moods = plans.map((p) => p.storyboard?.musicMood ?? "neutral");
  const changes = moods.filter((m, i) => i > 0 && m !== moods[i - 1]).length;
  return {
    averageShot: avg,
    medianShot: sorted[Math.floor(sorted.length / 2)] ?? avg,
    shotVariation: Math.sqrt(mean(durs.map((d) => (d - avg) ** 2))) / Math.max(0.01, avg),
    cutsPerMinute: joins.length / minutes,
    transitionMix: {
      hardCut: share((t) => t === "hard_cut" || t === "match_cut" || t === "shutter"),
      dissolve: share((t) => t === "dissolve" || t === "luma_fade"),
      dipToBlack: share((t) => t === "dip_to_black" || t === "fade"),
      dipToWhite: share((t) => t === "flash" || t === "dip_to_white"),
      stylised: share((t) => ["zoom", "whip", "glitch", "film_burn", "paper", "rgb_split", "shake", "motion_blur", "wipe"].includes(t)),
    },
    stillShare: prim.filter((s) => s.asset.type !== "video").length / Math.max(1, prim.length),
    sfxPerMinute: plans.reduce((a, p) => a + p.sfx.length, 0) / minutes,
    silencesPerMinute: plans.reduce((a, p) => a + (p.storyboard?.silences?.length ?? 0), 0) / minutes,
    musicChangesPerMinute: changes / minutes,
  };
}

/** How closely the measured edit follows the targets (0-1 per dimension). */
export function styleMatch(m: EditMeasurements, t: EditingTargets) {
  const mix = t.transitionMix;
  const mixDistance =
    Math.abs(m.transitionMix.hardCut - mix.hardCut) +
    Math.abs(m.transitionMix.dissolve - mix.dissolve) +
    Math.abs(m.transitionMix.dipToBlack - mix.dipToBlack) +
    Math.abs(m.transitionMix.dipToWhite - mix.dipToWhite);
  return {
    shotLength: closeness(m.medianShot, t.shotSeconds * 0.9, t.shotSeconds * 0.6),
    variation: closeness(m.shotVariation, Math.min(0.85, t.shotVariation), 0.6),
    transitions: clamp(1 - mixDistance / 0.8, 0, 1),
    stills: closeness(m.stillShare, t.stillShare, 0.5),
    sfx: t.sfxPerMinute === 0 ? (m.sfxPerMinute === 0 ? 1 : 0.4) : closeness(m.sfxPerMinute, t.sfxPerMinute, Math.max(1, t.sfxPerMinute)),
    silences: closeness(m.silencesPerMinute, t.silencesPerMinute, Math.max(0.3, t.silencesPerMinute)),
  };
}

export function scoreEdit(selections: SceneSelection[], plans: ScenePlan[], targets: EditingTargets): EditorialScore {
  const prim = selections.filter((s) => s.role === "primary");
  const media = prim.filter((s) => !isGraphic(s.asset) && s.scores && "topicMatch" in s.scores);
  const cards = prim.filter((s) => isGraphic(s.asset));
  const cardCredit = (s: SceneSelection) => (/^Designed/.test(s.reason) ? 0.8 : 0.65); // planned cards are intentional

  // Relevance: from each picture's breakdown; designed cards are on-topic by construction but
  // not evidence, so they earn partial credit.
  const topic = (media.reduce((a, s) => a + Number(s.scores!.topicMatch) / 40, 0) + cards.reduce((a, s) => a + cardCredit(s), 0)) / Math.max(1, media.length + cards.length);
  const narration = (media.reduce((a, s) => a + (Number(s.scores!.entityMatch) + Number(s.scores!.narrationMatch)) / 45, 0) + cards.reduce((a, s) => a + cardCredit(s) * 0.85, 0)) / Math.max(1, media.length + cards.length);

  // Variety: mix of kinds + no long runs of the same kind/provider.
  const kindOf = (s: SceneSelection) => (isGraphic(s.asset) ? "card" : s.asset.type === "video" ? "video" : s.asset.archival ? "archival" : "photo");
  const counts = new Map<string, number>();
  for (const s of prim) counts.set(kindOf(s), (counts.get(kindOf(s)) ?? 0) + 1);
  const entropy = -[...counts.values()].reduce((a, c) => a + (c / prim.length) * Math.log2(c / prim.length), 0) / 2; // 4 kinds → max 2 bits
  const sorted = [...prim].sort((a, b) => a.start - b.start);
  let run = 1;
  let worst = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = kindOf(sorted[i]!) === kindOf(sorted[i - 1]!) ? run + 1 : 1;
    worst = Math.max(worst, run);
  }
  const variety = clamp(entropy, 0, 1) * 0.7 + clamp(1 - (worst - 3) / 6, 0, 1) * 0.3;

  const m = measureEdit(selections, plans);
  const sm = styleMatch(m, targets);
  const pacing = sm.shotLength * 0.6 + sm.variation * 0.4;
  const referenceStyle = sm.shotLength * 0.25 + sm.variation * 0.15 + sm.transitions * 0.25 + sm.stills * 0.15 + sm.sfx * 0.1 + sm.silences * 0.1;
  const soundDesign = sm.sfx * 0.7 + sm.silences * 0.3;
  const expectedChanges = targets.music.singleBed ? 0 : 60 / Math.max(10, targets.music.minSection * 2.5);
  const musicDynamics = targets.music.singleBed ? 1 : closeness(m.musicChangesPerMinute, expectedChanges, Math.max(0.6, expectedChanges)) * 0.6 + (plans.some((p) => p.storyboard?.intents.includes("climax")) ? 0.4 : 0.2);
  const types = new Set(sorted.slice(1).map((s) => s.transitionIn ?? "hard_cut"));
  const transitionVariety = sm.transitions * 0.7 + clamp((types.size - 1) / 4, 0, 1) * 0.3;

  const pct = (x: number) => Math.round(clamp(x, 0, 1) * 100);
  const dims = {
    topicRelevance: pct(topic),
    narrationMatch: pct(narration),
    visualVariety: pct(variety),
    pacing: pct(pacing),
    referenceStyle: pct(referenceStyle),
    soundDesign: pct(soundDesign),
    musicDynamics: pct(musicDynamics),
    transitionVariety: pct(transitionVariety),
  };
  const total = Math.round(
    dims.topicRelevance * 0.22 + dims.narrationMatch * 0.2 + dims.visualVariety * 0.1 + dims.pacing * 0.1 + dims.referenceStyle * 0.14 + dims.soundDesign * 0.08 + dims.musicDynamics * 0.07 + dims.transitionVariety * 0.09,
  );
  const notes: string[] = [];
  if (dims.topicRelevance < 60) notes.push("Too many visuals only loosely related to the video topic.");
  if (dims.narrationMatch < 55) notes.push("Visuals often don't show what the narration says.");
  if (sm.shotLength < 0.6) notes.push(`Median shot ${m.medianShot.toFixed(1)}s vs target ~${(targets.shotSeconds * 0.9).toFixed(1)}s.`);
  if (sm.transitions < 0.6) notes.push("Transition mix differs from the reference.");
  if (sm.sfx < 0.6) notes.push(`SFX ${m.sfxPerMinute.toFixed(1)}/min vs target ${targets.sfxPerMinute.toFixed(1)}/min.`);
  return { total, ...dims, measurements: m, notes };
}
