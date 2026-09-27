"use client";

import type { CSSProperties } from "react";
import { defaultAnimation, FONT_EM, FONTS, type FontRole, GRAPHIC_LAYOUT, type GraphicClip, graphicContent, type GraphicLine, resolvePosition, THEMES } from "@/lib/domain/graphics";

/** The render library's fonts, served by /api/fonts, under preview-only family names. */
const FONT_FACES = (Object.keys(FONTS) as FontRole[]).map((r) => `@font-face{font-family:"dc-${r}";src:url(/api/fonts/${FONTS[r].file}) format("truetype");font-display:swap}`).join("");
const family = (r: FontRole) => `"dc-${r}", ${r === "serif" ? "Georgia, serif" : r === "mono" ? "ui-monospace, monospace" : "system-ui, sans-serif"}`;

function hexA(hex: string, a: number) {
  const h = hex.replace("#", "");
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}

/**
 * Designed graphics over the live preview: same content (graphicContent), fonts and layout numbers
 * as the render; sizes in container units (cqmin = 1% of the frame's shorter side). Animation state
 * is computed from the playhead, so scrubbing shows each moment exactly.
 */
export function GraphicOverlay({ graphics, t, captionsBottom }: { graphics: GraphicClip[]; t: number; captionsBottom: boolean }) {
  const active = graphics.filter((g) => t >= g.start && t < g.start + g.duration);
  return (
    // Inline layout styles: the overlay must look the same wherever it is mounted.
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", containerType: "size" }}>
      <style>{FONT_FACES}</style>
      {active.map((g) => (
        <GraphicView key={g.id} g={g} e={t - g.start} r={g.start + g.duration - t} captionsBottom={captionsBottom} />
      ))}
    </div>
  );
}

function GraphicView({ g, e, r, captionsBottom }: { g: GraphicClip; e: number; r: number; captionsBottom: boolean }) {
  const th = THEMES[g.theme];
  const { lines, deco } = graphicContent(g);
  const u = (frac: number) => `${(frac * 100 * g.scale).toFixed(3)}cqmin`;
  const pos = resolvePosition(g);
  const anim = g.animation === "auto" ? defaultAnimation(g.kind) : g.animation;
  const halign = pos.endsWith("left") ? "left" : pos.endsWith("right") ? "right" : "center";
  const safe = GRAPHIC_LAYOUT.safe * 100;
  const lift = captionsBottom && pos.startsWith("bottom") ? 11 : 0;

  // Animation (same timings as the render).
  const outO = Math.min(1, r / 0.26);
  const inP = anim === "none" ? 1 : Math.min(1, e / (anim === "wipe" ? 0.42 : anim === "slide" ? 0.38 : 0.28));
  const ease = 1 - Math.pow(1 - inP, 3);
  let blockStyle: CSSProperties = { opacity: outO * (anim === "fade" || anim === "slide" ? ease : 1) };
  if (anim === "slide") blockStyle.transform = `translate(${halign === "left" ? -(1 - ease) * 3 : halign === "right" ? (1 - ease) * 3 : 0}cqw, ${halign === "center" ? (1 - ease) * 3 : 0}cqh)`;
  if (anim === "wipe") blockStyle.clipPath = halign === "left" ? `inset(-20% ${(1 - inP) * 100}% -20% -5%)` : halign === "right" ? `inset(-20% -5% -20% ${(1 - inP) * 100}%)` : `inset(-20% ${(1 - inP) * 50}% -20% ${(1 - inP) * 50}%)`;
  if (anim === "pop") {
    const s = e < 0.12 ? 0.4 + (0.72 * e) / 0.12 : e < 0.22 ? 1.12 - (0.12 * (e - 0.12)) / 0.1 : 1;
    blockStyle = { ...blockStyle, transform: `scale(${s})`, transformOrigin: "center" };
  }

  const place: CSSProperties = { position: "absolute", display: "flex", flexDirection: "column", alignItems: halign === "left" ? "flex-start" : halign === "right" ? "flex-end" : "center", textAlign: halign, gap: u(0.012) };
  if (halign === "left") Object.assign(place, { left: `${safe}%`, maxWidth: "60%" });
  else if (halign === "right") Object.assign(place, { right: `${safe}%`, maxWidth: "60%" });
  else Object.assign(place, { left: "12%", right: "12%" });
  if (pos.startsWith("top")) place.top = `${g.kind === "headline" ? safe * 1.3 : safe}%`;
  else if (pos.startsWith("bottom")) place.bottom = `${safe + lift}%`;
  else Object.assign(place, { top: "50%", translate: "0 -50%" });

  const lineView = (l: GraphicLine, i: number) => {
    const delay = (l.delayMs ?? 0) / 1000;
    const o = delay ? Math.max(0, Math.min(1, (e - delay) / 0.26)) : 1;
    let text = l.text;
    if (anim === "typewriter" && i === 0) {
      const chars = [...text];
      const steps = Math.min(24, chars.length);
      const stepS = Math.min(0.045, 0.9 / steps);
      const k = Math.min(steps, Math.floor(e / stepS) + 1);
      text = chars.slice(0, Math.ceil((chars.length * k) / steps)).join("");
    }
    // Same soft shadow as the render (thin faint outline + blurred offset shadow).
    const shadow = !l.box && th.shadow > 0 ? `0 ${u(0.003 * th.shadow)} ${u(0.0035)} rgba(0,0,0,${0.6 * th.shadow}), 0 0 ${u(0.0012)} rgba(0,0,0,${0.25 * th.shadow})` : undefined;
    return (
      <span
        key={i}
        style={{
          fontFamily: family(l.role),
          // libass draws variable fonts at their default instance; the browser would pick optical sizes.
          fontOpticalSizing: "none",
          fontSize: u(l.size * FONT_EM[l.role]),
          lineHeight: 1 / FONT_EM[l.role],
          color: l.color,
          fontStyle: l.italic ? "italic" : undefined,
          letterSpacing: l.spacing ? u(l.spacing * 0.001) : undefined,
          background: l.box ? hexA(l.box.color, l.box.opacity) : undefined,
          padding: l.box ? `0 ${u(l.box.pad)}` : undefined,
          boxShadow: l.box ? `0 0 0 ${u(l.box.pad)} ${hexA(l.box.color, l.box.opacity)}` : undefined,
          margin: l.box ? `${u(l.box.pad)} 0` : undefined,
          textShadow: shadow,
          opacity: o,
          rotate: g.kind === "headline" && i === 0 ? "-1.2deg" : undefined,
          whiteSpace: "pre-wrap",
        }}
      >
        {text}
      </span>
    );
  };

  const T = GRAPHIC_LAYOUT.titleSize[g.kind];
  // Decorations hang outside the text block, where the render draws them (render/graphicsAss.ts).
  const side = halign === "right" ? { right: 0 } : halign === "left" ? { left: 0 } : { left: "50%", translate: "-50% 0" };
  const lineAt = (y: string, w: number, h: number): CSSProperties => ({ position: "absolute", top: y, width: u(w), height: u(h), background: g.accent, ...side });
  if (deco === "quote" && !pos.startsWith("top") && !pos.startsWith("bottom")) place.translate = `0 calc(-50% + ${u(T * 3 * 0.3)})`;
  const block = (
    <div style={{ ...place, ...blockStyle }}>
      <div style={{ position: "relative", display: "flex", alignItems: "stretch", gap: u(0.016), flexDirection: halign === "right" ? "row-reverse" : "row" }}>
        {deco === "bar" && halign !== "center" && <div style={{ width: u(0.008), background: g.accent, flexShrink: 0 }} />}
        {deco === "diamond" && <div style={{ width: u(T * 0.5), height: u(T * 0.5), background: g.accent, rotate: "45deg", scale: "0.7", alignSelf: "flex-start", marginTop: u(T * 0.25), flexShrink: 0 }} />}
        <div style={{ display: "flex", flexDirection: "column", alignItems: place.alignItems, gap: u(0.012) }}>{lines.map(lineView)}</div>
        {deco === "quote" && <span style={{ position: "absolute", bottom: "100%", left: "50%", translate: "-50% 25%", fontFamily: family("serif"), fontSize: u(T * 3 * FONT_EM.serif), lineHeight: 1, color: g.accent }}>“</span>}
        {deco === "rules" && <div style={lineAt(`calc(${u(-0.035)})`, 0.16, 0.005)} />}
        {(deco === "rules" || deco === "underline" || (deco === "bar" && halign === "center")) && (
          <div style={lineAt(`calc(100% + ${u(deco === "rules" ? 0.02 : 0.012)})`, deco === "underline" ? 0.12 : 0.16, deco === "bar" ? 0.006 : 0.005)} />
        )}
      </div>
    </div>
  );
  return (
    <>
      {deco === "dim" && <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)", opacity: outO * (anim === "none" ? 1 : Math.min(1, e / 0.28)) }} />}
      {block}
    </>
  );
}
