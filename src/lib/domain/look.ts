/**
 * Image looks: colour grade + finishing (vignette, grain, fade, sharpening) for visuals.
 *
 * A look is plain values, so a preset is just a named set of them. The project has a default look;
 * a clip can override it. The renderer turns a look into FFmpeg filters (lookFilters); the live
 * preview approximates it with CSS (lookCss) — the render is the reference.
 */
import { z } from "zod";

export const LookPreset = z.enum(["none", "natural", "warm_documentary", "cold_thriller", "teal_orange", "vintage", "faded_film", "noir", "bleach_bypass", "custom"]);
export type LookPreset = z.infer<typeof LookPreset>;

export const Look = z.object({
  preset: LookPreset,
  /** Stops, −1 … +1. */
  exposure: z.number().min(-1).max(1),
  /** 1 = unchanged. */
  contrast: z.number().min(0.5).max(1.6),
  /** 1 = unchanged, 0 = black & white. */
  saturation: z.number().min(0).max(2),
  /** −1 cool … +1 warm. */
  temperature: z.number().min(-1).max(1),
  /** −1 green … +1 magenta. */
  tint: z.number().min(-1).max(1),
  /** −1 … +1: teal shadows / orange highlights split (positive) or the reverse. */
  split: z.number().min(-1).max(1),
  /** 0–1: lifted blacks, a matte film finish. */
  fade: z.number().min(0).max(1),
  /** 0–1: darkened corners. */
  vignette: z.number().min(0).max(1),
  /** 0–1: film grain. */
  grain: z.number().min(0).max(1),
  /** 0–1: sharpening. */
  sharpen: z.number().min(0).max(1),
});
export type Look = z.infer<typeof Look>;
export type LookValues = Omit<Look, "preset">;

const NEUTRAL: LookValues = { exposure: 0, contrast: 1, saturation: 1, temperature: 0, tint: 0, split: 0, fade: 0, vignette: 0, grain: 0, sharpen: 0 };

export const LOOK_PRESETS: Record<Exclude<LookPreset, "custom">, LookValues> = {
  none: NEUTRAL,
  natural: { ...NEUTRAL, contrast: 1.05, saturation: 1.05, sharpen: 0.2 },
  warm_documentary: { ...NEUTRAL, contrast: 1.08, saturation: 0.92, temperature: 0.35, fade: 0.12, vignette: 0.3, grain: 0.15, sharpen: 0.15 },
  cold_thriller: { ...NEUTRAL, exposure: -0.1, contrast: 1.15, saturation: 0.75, temperature: -0.45, tint: -0.1, vignette: 0.45, grain: 0.2 },
  teal_orange: { ...NEUTRAL, contrast: 1.12, saturation: 1.1, split: 0.6, vignette: 0.25, sharpen: 0.2 },
  vintage: { ...NEUTRAL, contrast: 0.92, saturation: 0.7, temperature: 0.5, tint: 0.1, fade: 0.35, vignette: 0.45, grain: 0.45 },
  faded_film: { ...NEUTRAL, contrast: 0.9, saturation: 0.8, fade: 0.5, grain: 0.3, vignette: 0.2 },
  noir: { ...NEUTRAL, contrast: 1.3, saturation: 0, vignette: 0.55, grain: 0.35 },
  bleach_bypass: { ...NEUTRAL, contrast: 1.3, saturation: 0.45, exposure: 0.05, vignette: 0.3, grain: 0.2, sharpen: 0.3 },
};

export const LOOK_PRESET_LABEL: Record<LookPreset, string> = {
  none: "None",
  natural: "Natural",
  warm_documentary: "Warm documentary",
  cold_thriller: "Cold thriller",
  teal_orange: "Teal & orange",
  vintage: "Vintage",
  faded_film: "Faded film",
  noir: "Noir",
  bleach_bypass: "Bleach bypass",
  custom: "Custom",
};

export const DEFAULT_LOOK: Look = { preset: "none", ...NEUTRAL };

export function lookValues(l: Look): LookValues {
  return l.preset === "custom" ? l : LOOK_PRESETS[l.preset];
}

export function isNeutral(v: LookValues): boolean {
  return (Object.keys(NEUTRAL) as (keyof LookValues)[]).every((k) => Math.abs(v[k] - NEUTRAL[k]) < 1e-6);
}

const r = (n: number, d = 3) => Number(n.toFixed(d));

/**
 * FFmpeg filters for a look. `media` grades the picture itself (applied to the photo/footage only, so
 * paper textures and cards keep their colours); `frame` finishes the whole frame (vignette, grain).
 * Both start with a comma (or are empty) so they append to an existing chain.
 */
export function lookFilters(v: LookValues, opts: { seed?: number } = {}): { media: string; frame: string } {
  const m: string[] = [];
  // exposure works in float RGB: convert straight back to 8-bit for the filters after it.
  if (v.exposure) m.push(`exposure=exposure=${r(v.exposure)},format=gbrp`);
  if (v.temperature) m.push(`colortemperature=temperature=${Math.round(6500 - v.temperature * 3000)}:mix=1:pl=0.3`);
  if (v.tint || v.split) {
    // Tint on the midtones; split toning: shadows toward teal, highlights toward orange (or reverse).
    const t = v.tint * 0.12;
    const s = v.split * 0.14;
    m.push(`colorbalance=rs=${r(-s)}:gs=${r(s * 0.2)}:bs=${r(s)}:rm=${r(t)}:gm=${r(-t)}:bm=${r(t)}:rh=${r(s)}:gh=${r(s * 0.25)}:bh=${r(-s)}`);
  }
  if (v.contrast !== 1 || v.saturation !== 1) m.push(`eq=contrast=${r(v.contrast)}:saturation=${r(v.saturation)}`);
  if (v.fade) m.push(`curves=all='0/${r(v.fade * 0.16)} 0.5/${r(0.5 + v.fade * 0.02)} 1/${r(1 - v.fade * 0.04)}'`);
  if (v.sharpen) m.push(`unsharp=5:5:${r(v.sharpen * 1.2, 2)}:5:5:0`);
  const f: string[] = [];
  if (v.vignette) f.push(`vignette=angle=${r(0.25 + v.vignette * 0.5)}:mode=forward`);
  if (v.grain) f.push(`noise=c0s=${Math.round(4 + v.grain * 16)}:c0f=t+u${opts.seed !== undefined ? `:all_seed=${opts.seed}` : ""}`);
  return { media: m.length ? `,${m.join(",")}` : "", frame: f.length ? `,${f.join(",")}` : "" };
}

/** CSS approximation for the live preview (brightness/contrast/saturation/warmth; overlays separately). */
export function lookCss(v: LookValues): { filter: string; vignette: number; fade: number } {
  const parts = [`brightness(${r(Math.pow(2, v.exposure * 0.7))})`, `contrast(${r(v.contrast)})`, `saturate(${r(v.saturation * (1 - Math.abs(v.temperature) * 0.1))})`];
  if (v.temperature > 0) parts.push(`sepia(${r(v.temperature * 0.35)})`);
  if (v.temperature < 0) parts.push(`hue-rotate(${Math.round(v.temperature * -12)}deg)`);
  return { filter: parts.join(" "), vignette: v.vignette, fade: v.fade };
}
