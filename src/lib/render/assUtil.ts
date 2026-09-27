/** Shared ASS (libass) helpers: escaping, timestamps, colours. */

/** Strip ASS control characters from user/AI text (it can never become override tags). */
export function escapeAss(text: string): string {
  return text.replace(/[{}\\]/g, "").replace(/\r?\n/g, " ").trim();
}

/** Seconds → H:MM:SS.cc */
export function assTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
}

/** "#rrggbb" → ASS colour value &HBBGGRR& (use with \1c, \3c, \4c). */
export function assColor(hex: string): string {
  const h = hex.replace("#", "");
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
}

/** Opacity 0–1 → ASS alpha &HAA& (00 = opaque, FF = transparent). */
export function assAlpha(opacity: number): string {
  const a = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255);
  return `&H${a.toString(16).padStart(2, "0").toUpperCase()}&`;
}
