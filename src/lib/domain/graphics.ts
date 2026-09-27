/**
 * Designed graphics: lower thirds, location and date tags, time jumps, statistics, quotes,
 * headlines and chapter titles, drawn over the picture.
 *
 * A graphic is content (kind + title/sub) plus timing; its look comes from a theme (fonts,
 * colours, bar style), so a whole film restyles by changing one setting. The renderer draws
 * graphics with libass (render/graphicsAss.ts); the live preview draws the same layout in HTML
 * (components/workstation/GraphicOverlay.tsx). Both use the layout numbers in GRAPHIC_LAYOUT.
 */
import { z } from "zod";

export const GraphicKind = z.enum(["lower_third", "location", "date", "time_jump", "statistic", "quote", "headline", "chapter"]);
export type GraphicKind = z.infer<typeof GraphicKind>;

export const GraphicPosition = z.enum(["auto", "top_left", "top", "top_right", "center", "bottom_left", "bottom", "bottom_right"]);
export type GraphicPosition = z.infer<typeof GraphicPosition>;

export const GraphicAnimation = z.enum(["auto", "slide", "wipe", "fade", "pop", "typewriter", "none"]);
export type GraphicAnimation = z.infer<typeof GraphicAnimation>;

export const GraphicTheme = z.enum(["documentary", "editorial", "news", "minimal", "tabloid"]);
export type GraphicTheme = z.infer<typeof GraphicTheme>;

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** A graphic as stored on a scene plan (time relative to the scene start, like textOverlay). */
export const Graphic = z.object({
  id: z.string().min(1).max(40),
  kind: GraphicKind,
  title: z.string().max(90),
  sub: z.string().max(140).default(""),
  at: z.number().min(0),
  duration: z.number().min(0.5).max(30),
  position: GraphicPosition.default("auto"),
  animation: GraphicAnimation.default("auto"),
  /** Per-graphic theme / accent overrides (else the project's). */
  theme: GraphicTheme.optional(),
  accent: Hex.optional(),
  /** Where it came from (shown in the editor). */
  source: z.enum(["user", "analysis"]).default("user"),
});
export type Graphic = z.infer<typeof Graphic>;

/** Project-wide graphics style. */
export const GraphicsStyle = z.object({
  theme: GraphicTheme,
  accent: Hex.nullable(),
  /** Scales every graphic (0.8 = smaller, 1.2 = larger). */
  scale: z.number().min(0.6).max(1.5),
});
export type GraphicsStyle = z.infer<typeof GraphicsStyle>;
export const DEFAULT_GRAPHICS_STYLE: GraphicsStyle = { theme: "documentary", accent: null, scale: 1 };

/** A graphic on the timeline (absolute output time, style resolved). */
export const GraphicClip = z.object({
  id: z.string(),
  sceneId: z.string(),
  kind: GraphicKind,
  title: z.string(),
  sub: z.string(),
  start: z.number(),
  duration: z.number(),
  position: GraphicPosition,
  animation: GraphicAnimation,
  theme: GraphicTheme,
  accent: Hex,
  scale: z.number(),
});
export type GraphicClip = z.infer<typeof GraphicClip>;

export type FontRole = "display" | "condensed" | "sans" | "serif" | "mono";
/** Font files in the render library (assets/library/fonts) and the family names inside them. */
export const FONTS: Record<FontRole, { file: string; family: string }> = {
  display: { file: "Anton-Regular.ttf", family: "Anton" },
  condensed: { file: "Oswald.ttf", family: "Oswald" },
  sans: { file: "Inter.ttf", family: "Inter" },
  serif: { file: "PlayfairDisplay.ttf", family: "Playfair Display" },
  mono: { file: "IBMPlexMono-Regular.ttf", family: "IBM Plex Mono" },
};

/**
 * libass sizes text by the font's full line height (\fs = winAscent + winDescent); CSS sizes by the
 * em. em = \fs × this ratio (unitsPerEm / (winAscent + winDescent)), measured from the font files.
 */
export const FONT_EM: Record<FontRole, number> = { display: 0.577, condensed: 0.588, sans: 0.699, serif: 0.709, mono: 0.769 };

export interface ThemeSpec {
  label: string;
  /** Font for titles, subs, big numbers/years, quotes. */
  title: FontRole;
  sub: FontRole;
  big: FontRole;
  quote: FontRole;
  tag: FontRole;
  upper: boolean;
  text: string;
  subText: string;
  accent: string;
  /** Box behind lower thirds/tags: solid bar, none (text with shadow) or outlined. */
  bar: "solid" | "none";
  barColor: string;
  barOpacity: number;
  /** Box behind the second line (role, detail): often the accent colour. */
  subBarColor: string;
  /** Text shadow strength 0–1 when there is no bar. */
  shadow: number;
}

export const THEMES: Record<GraphicTheme, ThemeSpec> = {
  documentary: { label: "Documentary", title: "condensed", sub: "sans", big: "display", quote: "serif", tag: "mono", upper: true, text: "#ffffff", subText: "#d9d9d9", accent: "#f2b441", bar: "solid", barColor: "#0e0f12", barOpacity: 0.78, subBarColor: "#0e0f12", shadow: 0.5 },
  editorial: { label: "Editorial", title: "serif", sub: "sans", big: "serif", quote: "serif", tag: "sans", upper: false, text: "#ffffff", subText: "#e6e0d4", accent: "#c8a46a", bar: "none", barColor: "#000000", barOpacity: 0, subBarColor: "#000000", shadow: 0.8 },
  news: { label: "News", title: "sans", sub: "sans", big: "condensed", quote: "sans", tag: "condensed", upper: true, text: "#ffffff", subText: "#ffffff", accent: "#d7263d", bar: "solid", barColor: "#10233f", barOpacity: 0.95, subBarColor: "#d7263d", shadow: 0 },
  minimal: { label: "Minimal", title: "sans", sub: "sans", big: "sans", quote: "sans", tag: "mono", upper: false, text: "#ffffff", subText: "#cfcfcf", accent: "#ffffff", bar: "none", barColor: "#000000", barOpacity: 0, subBarColor: "#000000", shadow: 0.6 },
  tabloid: { label: "Tabloid", title: "display", sub: "condensed", big: "display", quote: "display", tag: "display", upper: true, text: "#ffffff", subText: "#111111", accent: "#ffd400", bar: "solid", barColor: "#e10600", barOpacity: 1, subBarColor: "#ffd400", shadow: 0.3 },
};

export const GRAPHIC_KIND_LABEL: Record<GraphicKind, string> = {
  lower_third: "Lower third (name)",
  location: "Location tag",
  date: "Date stamp",
  time_jump: "Time jump",
  statistic: "Statistic",
  quote: "Quote",
  headline: "Headline",
  chapter: "Chapter title",
};

/** Field labels per kind (what title/sub mean), for the editor. */
export const GRAPHIC_FIELDS: Record<GraphicKind, { title: string; sub: string | null; example: [string, string] }> = {
  lower_third: { title: "Name", sub: "Role / description", example: ["Delroy Marsh", "Sound system engineer"] },
  location: { title: "Place", sub: "Detail (date, district…)", example: ["Kingston, Jamaica", "Harbour Street · 1976"] },
  date: { title: "Date", sub: "Event (optional)", example: ["14 August 1979", "The night of the clash"] },
  time_jump: { title: "Text", sub: null, example: ["Three years later", ""] },
  statistic: { title: "Number", sub: "What it counts", example: ["3,000", "people every Saturday night"] },
  quote: { title: "Quote", sub: "Who said it", example: ["The loudest thing on the island", "The Daily Gleaner"] },
  headline: { title: "Headline", sub: "Publication · date", example: ["Sound war erupts on Harbour Street", "The Gleaner · 1979"] },
  chapter: { title: "Chapter title", sub: "Subtitle (optional)", example: ["Part two: The clash", ""] },
};

export const DEFAULT_DURATION: Record<GraphicKind, number> = { lower_third: 4.5, location: 3.5, date: 3, time_jump: 2.8, statistic: 3.5, quote: 5, headline: 4.5, chapter: 3.2 };

/**
 * Layout, as fractions of the frame (shared by the renderer and the preview). Sizes are
 * fractions of the frame's shorter side, so a vertical 1080×1920 frame keeps the same proportions.
 */
export const GRAPHIC_LAYOUT = {
  safe: 0.06, // title-safe margin, fraction of width/height
  titleSize: { lower_third: 0.062, location: 0.042, date: 0.05, time_jump: 0.1, statistic: 0.2, quote: 0.068, headline: 0.068, chapter: 0.12 } as Record<GraphicKind, number>,
  subSize: 0.034,
};

export function defaultPosition(kind: GraphicKind): Exclude<GraphicPosition, "auto"> {
  switch (kind) {
    case "lower_third":
      return "bottom_left";
    case "location":
      return "top_left";
    case "date":
      return "bottom_right";
    case "headline":
      return "top";
    default:
      return "center";
  }
}

export function defaultAnimation(kind: GraphicKind): Exclude<GraphicAnimation, "auto"> {
  switch (kind) {
    case "lower_third":
    case "headline":
      return "wipe";
    case "location":
    case "date":
      return "typewriter";
    case "statistic":
      return "pop";
    case "time_jump":
    case "chapter":
    case "quote":
      return "fade";
  }
}

/** Whether a graphic must avoid the caption band (bottom captions): lower placements move up. */
export function resolvePosition(g: Pick<GraphicClip, "kind" | "position">): Exclude<GraphicPosition, "auto"> {
  return g.position === "auto" ? defaultPosition(g.kind) : g.position;
}

/** One text line of a graphic. Sizes are fractions of the frame's shorter side (× scale). */
export interface GraphicLine {
  text: string;
  role: FontRole;
  /** libass \fs (full line height) as a fraction; CSS em = size × FONT_EM[role]. */
  size: number;
  color: string;
  italic?: boolean;
  box?: { color: string; opacity: number; pad: number };
  delayMs?: number;
  /** Letter spacing in thousandths of the unit. */
  spacing?: number;
}

export type GraphicDeco = "bar" | "diamond" | "underline" | "rules" | "dim" | "quote" | "none";

/** What a graphic shows (lines + decoration) — shared by the libass renderer and the HTML preview. */
export function graphicContent(g: Pick<GraphicClip, "kind" | "title" | "sub" | "theme" | "accent">): { lines: GraphicLine[]; deco: GraphicDeco } {
  const th = THEMES[g.theme];
  const T = GRAPHIC_LAYOUT.titleSize[g.kind];
  const S = GRAPHIC_LAYOUT.subSize;
  const up = (s: string) => (th.upper ? s.toUpperCase() : s);
  const { title, sub } = g;
  const shadowed = th.bar === "none" || th.barOpacity === 0;
  const bar = (pad: number) => (shadowed ? undefined : { color: th.barColor, opacity: th.barOpacity, pad });
  let lines: GraphicLine[] = [];
  let deco: GraphicDeco = "none";
  switch (g.kind) {
    case "lower_third":
      lines = [{ text: up(title), role: th.title, size: T, color: th.text, box: bar(T * 0.16), spacing: 1 }];
      if (sub) lines.push({ text: sub, role: th.sub, size: S, color: th.subText, box: shadowed ? undefined : { color: th.subBarColor, opacity: th.barOpacity, pad: S * 0.3 }, delayMs: 180 });
      deco = "bar";
      break;
    case "location":
      lines = [{ text: title.toUpperCase(), role: th.tag, size: T, color: th.text, box: bar(T * 0.22), spacing: 2 }];
      if (sub) lines.push({ text: sub, role: th.sub, size: S * 0.9, color: th.subText, delayMs: 350 });
      deco = "diamond";
      break;
    case "date":
      lines = [{ text: title, role: "mono", size: T, color: th.text, spacing: 1 }];
      if (sub) lines.push({ text: sub, role: th.sub, size: S, color: th.subText, delayMs: 300 });
      deco = "underline";
      break;
    case "time_jump":
      lines = [{ text: title.toUpperCase(), role: th.big, size: T, color: th.text, spacing: 4 }];
      deco = "rules";
      break;
    case "statistic":
      lines = [{ text: title, role: th.big, size: T, color: g.accent }];
      if (sub) lines.push({ text: up(sub), role: th.sub, size: S * 1.3, color: th.text, delayMs: 250, spacing: 1 });
      break;
    case "quote":
      lines = [{ text: title, role: th.quote, size: T, color: th.text, italic: th.quote === "serif" }];
      if (sub) lines.push({ text: `— ${sub}`, role: th.sub, size: S * 1.1, color: th.subText, delayMs: 400 });
      deco = "quote";
      break;
    case "headline":
      // A clipping: dark serif on paper, regardless of theme colours.
      lines = [{ text: title, role: "serif", size: T, color: "#111111", box: { color: "#f3efe6", opacity: 1, pad: T * 0.35 } }];
      if (sub) lines.push({ text: sub.toUpperCase(), role: "sans", size: S * 0.85, color: "#3a3a3a", box: { color: "#f3efe6", opacity: 1, pad: S * 0.35 }, delayMs: 150, spacing: 2 });
      break;
    case "chapter":
      lines = [{ text: up(title), role: th.big, size: T, color: th.text, spacing: 2 }];
      if (sub) lines.push({ text: sub, role: th.sub, size: S * 1.2, color: th.subText, delayMs: 300 });
      deco = "dim";
      break;
  }
  return { lines, deco };
}

/**
 * Scene graphics → timeline graphics (absolute time via `toTime`, theme/accent resolved).
 * The render maps narration time to output time; the live preview uses narration time.
 */
export function graphicClipsFor(
  plans: { sceneId: string; startTime: number; graphics?: Graphic[] }[],
  style: GraphicsStyle,
  opts: { vertical?: boolean; toTime?: (t: number) => number } = {},
): GraphicClip[] {
  const toTime = opts.toTime ?? ((t: number) => t);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return plans
    .flatMap((p) =>
      (p.graphics ?? []).map((g) => {
        const theme = g.theme ?? style.theme;
        return {
          id: `${p.sceneId}_${g.id}`,
          sceneId: p.sceneId,
          kind: g.kind,
          title: g.title,
          sub: g.sub,
          start: r(toTime(p.startTime + g.at)),
          duration: r(g.duration),
          position: g.position,
          animation: g.animation,
          theme,
          accent: g.accent ?? style.accent ?? THEMES[theme].accent,
          scale: style.scale * (opts.vertical ? 1.15 : 1),
        };
      }),
    )
    .filter((g) => g.title.trim())
    .sort((a, b) => a.start - b.start);
}
