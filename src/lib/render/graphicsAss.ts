/**
 * Designed graphics as libass events. Each kind is a block of text lines (font role, size, colour,
 * optional box) plus decorations whose size does not depend on the text width (accent bars,
 * rules, a location diamond, a quotation mark, a dimmed frame) — so nothing needs measuring.
 * Text only ever appears escaped inside the .ass file (never on the FFmpeg command line).
 */
import { defaultAnimation, FONTS, type FontRole, GRAPHIC_LAYOUT, type GraphicClip, graphicContent, type GraphicLine, resolvePosition, THEMES } from "@/lib/domain/graphics";
import { assAlpha, assColor, assTime, escapeAss } from "./assUtil";
import { fontAvailable } from "./library";
import { wrapRows } from "./textMeasure";

export interface GraphicsAssOptions {
  /** Bottom captions are on: bottom placements move up out of the caption band. */
  captionsBottom: boolean;
}

/** Styles the graphic events use (text with outline/shadow; text on an opaque box). */
export function graphicStyles(): string[] {
  // Fonts and colours are set per event with override tags; these only fix the border style.
  return [
    "Style: GText,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
    "Style: GBox,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,0,0,7,0,0,0,1",
  ];
}

const fam = (role: FontRole) => (fontAvailable(FONTS[role].file) ? FONTS[role].family : "Arial");
const n = (v: number) => Math.round(v);


type Line = Omit<GraphicLine, "box"> & { box?: { color: string; opacity: number; pad: number } };

export function graphicEvents(g: GraphicClip, W: number, H: number, opts: GraphicsAssOptions): string[] {
  const th = THEMES[g.theme];
  const U = Math.min(W, H) * g.scale;
  const L = GRAPHIC_LAYOUT;
  const pos = resolvePosition(g);
  const anim = g.animation === "auto" ? defaultAnimation(g.kind) : g.animation;
  const title = escapeAss(g.title);
  const sub = escapeAss(g.sub);
  if (!title) return [];
  const T = U * L.titleSize[g.kind];
  const shadowed = th.bar === "none" || th.barOpacity === 0;

  // --- content per kind (shared with the preview), in pixels ------------------------
  const content = graphicContent({ ...g, title, sub });
  const lines: Line[] = content.lines.map((l) => ({ ...l, size: l.size * U, box: l.box ? { ...l.box, pad: l.box.pad * U } : undefined }));
  const deco = content.deco;

  // --- block geometry ----------------------------------------------------------
  // libass wraps long text; measure how many rows each line takes (real glyph widths from the font
  // files) so stacked lines never overlap and never leave gaps. Side-anchored text wraps at 60% of the width, centred at 76%.
  const halignEarly = pos.endsWith("left") || pos.endsWith("right") ? "side" : "center";
  const wrapW = halignEarly === "center" ? W * 0.76 : W * 0.6;
  const rows = (l: Line) => Math.min(4, wrapRows(l.text, l.role, l.size, wrapW - (l.box ? l.box.pad * 2 : 0), (l.spacing ?? 0) * U * 0.001));
  // libass \fs is the full line height, so a row is about the size itself.
  const lineH = (l: Line) => l.size * 1.02 * rows(l) + (l.box ? l.box.pad * 2 : 0);
  const gap = (i: number) => (i === 0 ? 0 : U * 0.012);
  const blockH = lines.reduce((a, l, i) => a + lineH(l) + gap(i), 0);
  const halign: "left" | "center" | "right" = pos.endsWith("left") ? "left" : pos.endsWith("right") ? "right" : "center";
  const safeX = W * L.safe;
  const safeY = H * L.safe;
  const lift = opts.captionsBottom && pos.startsWith("bottom") ? H * 0.11 : 0;
  const glyph = deco === "quote" ? T * 3 : 0;
  let top = pos.startsWith("top") ? safeY : pos.startsWith("bottom") ? H - safeY - lift - blockH : (H - blockH + glyph * 0.6) / 2;
  if (g.kind === "headline" && pos.startsWith("top")) top = safeY * 1.3;
  const decoW = deco === "bar" ? U * 0.008 : deco === "diamond" ? T * 0.5 : 0;
  const decoGap = decoW ? U * 0.016 : 0;
  const xAnchor = halign === "left" ? safeX : halign === "right" ? W - safeX : W / 2;
  const xText = halign === "left" ? xAnchor + decoW + decoGap : halign === "right" ? xAnchor - decoW - decoGap : xAnchor;
  const an = halign === "left" ? 7 : halign === "right" ? 9 : 8;
  // Centered text wraps inside the frame's middle 76%; side-anchored text wraps before the far third.
  const margins = halign === "center" ? [n(W * 0.12), n(W * 0.12)] : halign === "left" ? [0, n(W * 0.4)] : [n(W * 0.4), 0];

  // --- animation -----------------------------------------------------------------
  const inMs = anim === "none" ? 0 : 280;
  const fadeOut = 260;
  const wipeClip = () => {
    const y0 = n(top - U * 0.2);
    const y1 = n(top + blockH + U * 0.2);
    if (halign === "left") return `\\clip(${n(xAnchor)},${y0},${n(xAnchor)},${y1})\\t(0,420,\\clip(${n(xAnchor)},${y0},${W},${y1}))`;
    if (halign === "right") return `\\clip(${n(xAnchor)},${y0},${n(xAnchor)},${y1})\\t(0,420,\\clip(0,${y0},${n(xAnchor)},${y1}))`;
    return `\\clip(${n(W / 2)},${y0},${n(W / 2)},${y1})\\t(0,420,\\clip(0,${y0},${W},${y1}))`;
  };
  const motion = (x: number, y: number) => {
    if (anim === "slide") {
      const dx = halign === "left" ? -W * 0.03 : halign === "right" ? W * 0.03 : 0;
      const dy = halign === "center" ? H * 0.03 : 0;
      return `\\move(${n(x + dx)},${n(y + dy)},${n(x)},${n(y)},0,380)`;
    }
    return `\\pos(${n(x)},${n(y)})`;
  };
  const enter = (delayMs = 0) => {
    const d = delayMs;
    switch (anim) {
      case "pop":
        return `\\fscx40\\fscy40\\t(${d},${d + 120},\\fscx112\\fscy112)\\t(${d + 120},${d + 220},\\fscx100\\fscy100)${d ? `\\alpha&HFF&\\t(${d},${d + 1},\\alpha&H00&)` : ""}`;
      case "wipe":
        return wipeClip() + (d ? `\\alpha&HFF&\\t(${d},${d + 200},\\alpha&H00&)` : "");
      case "none":
        return "";
      default:
        return d ? `\\alpha&HFF&\\t(${d},${d + 260},\\alpha&H00&)` : "";
    }
  };
  const fad = (inFade: boolean) => `\\fad(${inFade && anim !== "wipe" && anim !== "pop" ? inMs : 0},${fadeOut})`;
  const start = assTime(g.start);
  const end = assTime(g.start + g.duration);
  const ev = (layer: number, style: "GText" | "GBox", tags: string, body: string, m = margins, s = start) => `Dialogue: ${layer},${s},${end},${style},,${m[0]},${m[1]},0,,{${tags}}${body}`;

  const out: string[] = [];
  // Unboxed text: a soft drop shadow (thin faint outline + offset shadow, edges blurred) — the same
  // shadow the preview draws with CSS text-shadow.
  const shadowTags = shadowed ? `\\bord1\\3c&H000000&\\3a${assAlpha(0.25 * th.shadow)}\\shad${(U * 0.003 * th.shadow).toFixed(1)}\\4c&H000000&\\4a${assAlpha(0.6 * th.shadow)}\\blur${(U * 0.003).toFixed(1)}` : "\\bord0\\shad0";
  const drawTags = (color: string, opacity: number) => `\\bord0\\shad0\\1c${assColor(color)}\\1a${assAlpha(opacity)}\\p1`;

  // --- decorations ------------------------------------------------------------------
  const rect = (x: number, y: number, w: number, h: number) => `m 0 0 l ${n(w)} 0 ${n(w)} ${n(h)} 0 ${n(h)}`;
  if (deco === "dim") out.push(ev(0, "GText", `\\an7\\pos(0,0)${drawTags("#000000", 0.5)}\\fad(${inMs},${fadeOut})`, `${rect(0, 0, W, H)}{\\p0}`, [0, 0]));
  if (deco === "bar") {
    const bx = halign === "right" ? xAnchor - decoW : halign === "left" ? xAnchor : xAnchor - W * 0.08;
    const by = halign === "center" ? top + blockH + U * 0.012 : top;
    const [bw, bh] = halign === "center" ? [W * 0.16, U * 0.006] : [decoW, blockH];
    out.push(ev(1, "GText", `\\an7\\pos(${n(bx)},${n(by)})${drawTags(g.accent, 1)}${anim === "wipe" ? wipeClip() : ""}${fad(true)}`, `${rect(0, 0, bw, bh)}{\\p0}`, [0, 0]));
  }
  if (deco === "diamond") {
    const d = decoW;
    const dx = halign === "right" ? xAnchor - d : halign === "left" ? xAnchor : xAnchor - W * 0.02;
    const dy = top + lineH(lines[0]!) / 2 - d / 2;
    out.push(ev(1, "GText", `\\an7\\pos(${n(dx)},${n(dy)})${drawTags(g.accent, 1)}\\fad(200,${fadeOut})`, `m ${n(d / 2)} 0 l ${n(d)} ${n(d / 2)} ${n(d / 2)} ${n(d)} 0 ${n(d / 2)}{\\p0}`, [0, 0]));
  }
  if (deco === "underline" || deco === "rules") {
    const w = U * (deco === "rules" ? 0.16 : 0.12);
    const h = Math.max(2, U * 0.005);
    const lx = halign === "left" ? xText : halign === "right" ? xText - w : W / 2 - w / 2;
    const ys = deco === "rules" ? [top - U * 0.035, top + blockH + U * 0.02] : [top + blockH + U * 0.012];
    for (const y of ys) {
      const grow = anim === "none" ? "" : `\\fscx0\\t(0,450,\\fscx100)`;
      out.push(ev(1, "GText", `\\an7\\pos(${n(lx)},${n(y)})${drawTags(g.accent, 1)}${grow}\\fad(0,${fadeOut})`, `${rect(0, 0, w, h)}{\\p0}`, [0, 0]));
    }
  }
  if (deco === "quote") {
    out.push(ev(1, "GText", `\\an8\\pos(${n(W / 2)},${n(top - glyph * 0.75)})\\fn${fam("serif")}\\fs${n(glyph)}\\1c${assColor(g.accent)}\\bord0\\shad0\\fad(${inMs},${fadeOut})`, "“", [0, 0]));
  }

  // --- text lines ---------------------------------------------------------------
  let y = top;
  lines.forEach((l, i) => {
    y += gap(i);
    const boxPad = l.box?.pad ?? 0;
    const ty = y + boxPad;
    const font = `\\fn${fam(l.role)}\\fs${n(l.size)}${l.italic ? "\\i1" : ""}${l.spacing ? `\\fsp${(l.spacing * U * 0.001).toFixed(1)}` : ""}`;
    const colors = `\\1c${assColor(l.color)}`;
    const box = l.box ? `\\bord${n(l.box.pad)}\\shad0\\3c${assColor(l.box.color)}\\3a${assAlpha(l.box.opacity)}` : shadowTags;
    const x = xText + (l.box && halign === "left" ? boxPad : l.box && halign === "right" ? -boxPad : 0);
    const rot = g.kind === "headline" ? "\\frz-1.2" : "";
    const style = l.box ? "GBox" : "GText";
    if (anim === "typewriter" && i === 0) {
      // Reveal letter by letter (≤ 24 steps), then hold the full line.
      const chars = [...l.text];
      const steps = Math.min(24, chars.length);
      const stepS = Math.min(0.045, 0.9 / steps);
      for (let k = 1; k <= steps; k++) {
        const upto = Math.ceil((chars.length * k) / steps);
        const s = g.start + (k - 1) * stepS;
        const e = k === steps ? g.start + g.duration : g.start + k * stepS;
        out.push(`Dialogue: 2,${assTime(s)},${assTime(e)},${style},,${margins[0]},${margins[1]},0,,{\\an${an}\\pos(${n(x)},${n(ty)})${font}${colors}${box}${k === steps ? `\\fad(0,${fadeOut})` : ""}}${chars.slice(0, upto).join("")}`);
      }
    } else {
      out.push(ev(2, style, `\\an${an}${motion(x, ty)}${rot}${font}${colors}${box}${enter(l.delayMs)}${fad(!l.delayMs)}`, l.text));
    }
    y += lineH(l);
  });
  return out;
}
