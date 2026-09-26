import type { ClaudeService } from "@/lib/ai/claude/service";
import { getPreset } from "@/lib/domain/presets";
import type { ReferenceStyle, StyleProfile } from "@/lib/domain/types";
import { clamp } from "@/lib/pipeline/engines";
import { measureReference, type ReferenceMeasurements } from "./measure";

export interface ReferenceAnalysis {
  metrics: ReferenceMeasurements;
  profile: StyleProfile;
  /** Which profile fields were measured vs. taken from defaults. */
  measured: string[];
  estimated: string[];
  method: "measured";
  notes: string;
}

/**
 * Analyse a reference video's editing language with FFmpeg measurements (reference/measure.ts)
 * and turn it into the style profile the timeline generator follows. Only statistics are kept;
 * no footage is copied into the user's project.
 */
export async function analyzeReferenceVideo(
  file: string,
  opts: { workDir: string; claude?: ClaudeService; maxSeconds?: number; source?: string },
): Promise<ReferenceAnalysis> {
  const { measurements: m } = await measureReference(file, { workDir: opts.workDir, maxSeconds: opts.maxSeconds ?? 1200 });
  const base = getPreset("documentary").profile;
  const reference: ReferenceStyle = {
    source: opts.source ?? file,
    averageShotDuration: m.averageShotDuration,
    medianShotDuration: m.medianShotDuration,
    shotDurationVariation: m.shotDurationVariation,
    cutsPerMinute: m.cutsPerMinute,
    transitionMix: m.transitions,
    shotKinds: m.shotKinds,
    photoAnimationShare: m.photoAnimationShare,
    blackAndWhiteShare: m.blackAndWhiteShare,
    silencesPerMinute: m.audio.silencesPerMinute,
    impactsPerMinute: m.audio.impactsPerMinute,
    buildsPerMinute: m.audio.buildsPerMinute,
    dropsPerMinute: m.audio.dropsPerMinute,
    loudnessRange: m.audio.loudnessRange,
    pacingCurve: m.pacingCurve,
    introCutRate: m.introCutRate,
    outroCutRate: m.outroCutRate,
  };
  // The typical shot sits between the median (most cuts) and the mean (which long holds pull up).
  const typical = 0.55 * m.medianShotDuration + 0.45 * m.averageShotDuration;
  const stills = m.shotKinds.still + m.shotKinds.animatedStill;
  const profile: StyleProfile = {
    ...base,
    averageShotDuration: clamp(typical, 1, 10),
    minShotDuration: clamp(Math.max(0.8, m.shortestShot), 0.6, 4),
    maxShotDuration: clamp(m.longestShot, 3, 20),
    photoPercentage: Math.round(clamp(stills, 0, 1) * 100),
    videoPercentage: Math.round(clamp(m.shotKinds.live, 0, 1) * 100),
    screenshotPercentage: Math.round(clamp(m.shotKinds.graphic, 0, 1) * 100),
    zoomFrequency: clamp(m.photoAnimationShare, 0, 1),
    blackAndWhiteFrequency: clamp(m.blackAndWhiteShare, 0, 1),
    // ~1 SFX-worthy impact per minute ≈ 0.25; the budget in storyboard.ts scales from this.
    sfxFrequency: clamp(m.audio.impactsPerMinute / 5, 0.05, 1),
    transitionStyle: m.transitions.hardCut >= 0.85 ? "mostly_hard_cut" : m.transitions.hardCut >= 0.55 ? "mixed" : "mostly_soft",
    visualDensity: m.cutsPerMinute >= 20 ? "high" : m.cutsPerMinute >= 12 ? "medium" : "low",
    reference,
  };
  return {
    metrics: m,
    profile,
    measured: [
      "shot durations (average, median, spread, shortest, longest)",
      "cuts per minute and pacing curve (intro/outro rates)",
      "transition mix (hard cut / dissolve / dip to black / dip to white)",
      "still vs animated still vs live vs graphic shots (≈70% accurate)",
      "black-and-white share",
      "silences, impacts on cuts, loudness builds and drops",
    ],
    estimated: ["text-card, meme and paper-layout frequencies use Documentary defaults (not measurable from pixels alone)"],
    method: "measured",
    notes: `Measured ${m.shotCount} shots over ${m.analysedSeconds}s with FFmpeg.`,
  };
}
