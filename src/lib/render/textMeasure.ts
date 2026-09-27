/**
 * Text widths from the actual font files (glyph advances + kerning), so graphic layouts know how
 * wide a line is and how many rows libass will wrap it into — no guessing per font.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import opentype from "opentype.js";
import { FONTS, type FontRole } from "@/lib/domain/graphics";
import { library } from "./library";

const cache = new Map<FontRole, opentype.Font | null>();
/** Fallback average advance (fraction of the size) when a font file is missing. */
const FALLBACK: Record<FontRole, number> = { display: 0.45, condensed: 0.45, sans: 0.55, serif: 0.5, mono: 0.6 };

function font(role: FontRole): opentype.Font | null {
  if (!cache.has(role)) {
    try {
      const buf = readFileSync(path.join(library.fontsDir, FONTS[role].file));
      cache.set(role, opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
    } catch {
      cache.set(role, null);
    }
  }
  return cache.get(role)!;
}

/**
 * libass (like VSFilter) treats \fs as the font's full line height (OS/2 winAscent + winDescent),
 * not its em size, so the em it draws with is size × unitsPerEm / (winAscent + winDescent).
 */
function emScale(f: opentype.Font): number {
  const os2 = f.tables.os2 as { usWinAscent?: number; usWinDescent?: number } | undefined;
  const h = os2?.usWinAscent && os2.usWinDescent !== undefined ? os2.usWinAscent + os2.usWinDescent : f.ascender - f.descender;
  return h > 0 ? f.unitsPerEm / h : 1;
}

/** Width in pixels of `text` at libass \fs `size`, plus letter spacing (px per character). */
export function textWidth(text: string, role: FontRole, size: number, spacing = 0): number {
  const f = font(role);
  const base = f ? f.getAdvanceWidth(text, size * emScale(f), { kerning: true }) : [...text].length * size * FALLBACK[role];
  return base + spacing * [...text].length;
}

/** Rows after word wrapping at `maxWidth` (greedy by words, like libass for short titles). */
export function wrapRows(text: string, role: FontRole, size: number, maxWidth: number, spacing = 0): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const space = textWidth(" ", role, size, spacing);
  let rows = 1;
  let line = 0;
  for (const w of words) {
    const ww = textWidth(w, role, size, spacing);
    if (line > 0 && line + space + ww > maxWidth) {
      rows++;
      line = ww;
    } else line += (line > 0 ? space : 0) + ww;
  }
  return rows;
}
