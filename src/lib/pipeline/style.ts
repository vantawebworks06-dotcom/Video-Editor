/**
 * Editing targets: the reference video's measured editing language (or the style preset when
 * there's no reference) combined with the user's controls (pacing, visual/music/SFX intensity).
 * The storyboard, transition allocator, sound design, music and the style-match check all read
 * these numbers — so a reference with 2.2 s median shots and 21 % dips to black produces an edit
 * that cuts around 2-3 s and dips to black about one join in five.
 */
import type { ProjectSettings, StyleProfile } from "@/lib/domain/types";
import { clamp } from "./engines";

export interface EditingTargets {
  source: "reference" | "preset";
  /** Typical shot length (s) and spread (std/mean) the edit should show overall. */
  shotSeconds: number;
  shotVariation: number;
  cutsPerMinute: number;
  /** Multiplier on beat lengths at relative position 0..1 of the video (from the reference's pacing curve). */
  pacingAt: (pos: number) => number;
  /** How much faster the opening minute cuts than the rest (hook). */
  introSpeedup: number;
  /** Share of clip joins by transition family. */
  transitionMix: { hardCut: number; dissolve: number; dipToBlack: number; dipToWhite: number; stylised: number };
  /** Share of visuals that should be stills (photos/cards) vs live footage. */
  stillShare: number;
  /** Share of stills that move (zoom/pan) rather than hold. */
  photoAnimationShare: number;
  blackAndWhiteShare: number;
  sfxPerMinute: number;
  silencesPerMinute: number;
  /** Music: minimum section length (s), envelope depth multiplier, overall gain (dB). */
  music: { minSection: number; depth: number; gainDb: number; allowDrops: boolean; singleBed: boolean };
  /** Motion intensity multiplier for zooms/pans. */
  motion: number;
  /** Text-emphasis overlays per scene (0-1). */
  textFrequency: number;
}

export function editingTargets(style: StyleProfile, settings: ProjectSettings): EditingTargets {
  const ref = style.reference;
  const pacingScale = { auto: 1, slow: 1.35, normal: 1, fast: 0.75, dynamic: 0.95 }[settings.pacing];
  const vi = settings.visualIntensity;
  const visualScale = vi === "low" ? 1.15 : vi === "high" ? 0.85 : 1;
  const shotSeconds = clamp(style.averageShotDuration * pacingScale * visualScale, 0.9, 9);
  const baseVariation = ref ? ref.shotDurationVariation : 0.5;
  const shotVariation = clamp(baseVariation * (settings.pacing === "dynamic" ? 1.4 : 1), 0.2, 1.3);

  // Reference pacing curve (cut density in tenths) → beat-length multiplier (denser = shorter).
  const curve = ref?.pacingCurve?.length === 10 ? ref.pacingCurve : null;
  const pacingAt = (pos: number) => {
    if (!curve) return 1;
    const i = Math.min(9, Math.max(0, Math.floor(pos * 10)));
    return clamp(1 / Math.pow(Math.max(0.3, curve[i]!), 0.45), 0.7, 1.4);
  };
  const introSpeedup = ref && ref.cutsPerMinute > 0 ? clamp(ref.introCutRate / ref.cutsPerMinute, 0.8, 2) : 1.25;

  const mix = ref
    ? { hardCut: ref.transitionMix.hardCut, dissolve: ref.transitionMix.dissolve, dipToBlack: ref.transitionMix.dipToBlack, dipToWhite: ref.transitionMix.dipToWhite }
    : style.transitionStyle === "mostly_hard_cut"
      ? { hardCut: 0.9, dissolve: 0.03, dipToBlack: 0.05, dipToWhite: 0.01 }
      : style.transitionStyle === "mixed"
        ? { hardCut: 0.72, dissolve: 0.12, dipToBlack: 0.1, dipToWhite: 0.02 }
        : { hardCut: 0.5, dissolve: 0.25, dipToBlack: 0.15, dipToWhite: 0.03 };
  // Stylised transitions (zoom/whip/glitch/film burn…) are an editorial accent, scaled by the user.
  const stylised = vi === "low" ? 0.02 : vi === "high" ? 0.09 : 0.05;

  const sfxBase = ref ? Math.max(0.6, ref.impactsPerMinute) : 1 + style.sfxFrequency * 3;
  const sfxScale = { auto: 1, off: 0, low: 0.5, medium: 1, high: 1.7 }[settings.sfxIntensity];

  const mi = settings.musicIntensity;
  const music = {
    minSection: mi === "dynamic" || mi === "intense" ? 10 : mi === "minimal" ? 1e9 : ref && ref.buildsPerMinute + ref.dropsPerMinute > 1 ? 11 : 14,
    depth: mi === "minimal" ? 0.4 : mi === "intense" ? 1.5 : mi === "dynamic" ? 1.25 : ref ? clamp(ref.loudnessRange / 10, 0.7, 1.4) : 1,
    gainDb: mi === "intense" ? 3 : mi === "minimal" ? -3 : 0,
    allowDrops: mi !== "minimal",
    singleBed: mi === "minimal",
  };

  return {
    source: ref ? "reference" : "preset",
    shotSeconds,
    shotVariation,
    cutsPerMinute: 60 / shotSeconds,
    pacingAt,
    introSpeedup,
    transitionMix: { ...mix, stylised },
    stillShare: ref ? clamp(ref.shotKinds.still + ref.shotKinds.animatedStill + ref.shotKinds.graphic, 0.1, 0.9) : clamp(style.photoPercentage / 100, 0.1, 0.9),
    photoAnimationShare: ref ? clamp(ref.photoAnimationShare, 0.3, 1) : clamp(style.zoomFrequency, 0.3, 1),
    blackAndWhiteShare: ref ? ref.blackAndWhiteShare : style.blackAndWhiteFrequency,
    sfxPerMinute: sfxBase * sfxScale,
    silencesPerMinute: mi === "minimal" ? 0 : ref ? clamp(ref.silencesPerMinute, 0.15, 1.5) : 0.3,
    music,
    motion: vi === "low" ? 0.75 : vi === "high" ? 1.3 : 1,
    textFrequency: clamp(style.textEmphasisFrequency * (vi === "high" ? 1.6 : vi === "low" ? 0.6 : 1), 0, 0.6),
  };
}
