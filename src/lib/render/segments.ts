import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import path from "node:path";
import type { Annotation, MotionType, PaperStyle, VisualClip } from "@/lib/domain/types";
import { stableHash } from "@/lib/media/cache";
import { seeded } from "@/lib/pipeline/engines";
import { runFfmpeg } from "./ffmpeg";
import { library } from "./library";
import type { PreparedAsset } from "./prepare";

/** Bump when filter graphs change so cached segments are invalidated. */
export const RENDERER_VERSION = 3;

export interface SegmentSpec {
  clip: VisualClip;
  asset: PreparedAsset | null; // null → fallback paper card (asset failed)
  width: number;
  height: number;
  fps: number;
  paper: PaperStyle;
  draft: boolean;
}

export function segmentKey(s: SegmentSpec): string {
  // Only visual properties matter: the same look at a different time/position reuses the segment.
  const visual = { duration: s.clip.duration, trimStart: s.clip.trimStart, layout: s.clip.layout, motion: s.clip.motion, treatment: s.clip.treatment, annotations: s.clip.annotations, transitionIn: s.clip.transitionIn, transitionOut: s.clip.transitionOut, role: s.clip.role, seed: s.clip.id + s.clip.asset.assetId };
  return stableHash({
    v: RENDERER_VERSION,
    visual,
    file: s.asset ? { p: s.asset.path, w: s.asset.width, h: s.asset.height } : null,
    size: [s.width, s.height, s.fps],
    paper: s.paper,
    draft: s.draft,
  });
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const f = (n: number) => Number(n.toFixed(4));

/** zoompan expressions for each motion. P = progress 0..1 across the clip. */
function motionExpr(type: MotionType, intensity: number, frames: number) {
  const I = f(Math.min(0.3, Math.max(0.02, intensity)));
  const P = `(on/${Math.max(1, frames - 1)})`;
  const cx = "iw/2-(iw/zoom/2)";
  const cy = "ih/2-(ih/zoom/2)";
  switch (type) {
    case "slow_zoom_in":
      return { z: `1+${I}*${P}`, x: cx, y: cy };
    case "slow_zoom_out":
      return { z: `1+${I}*(1-${P})`, x: cx, y: cy };
    case "pan_left":
      return { z: `${1 + I}`, x: `(iw-iw/zoom)*(1-${P})`, y: cy };
    case "pan_right":
      return { z: `${1 + I}`, x: `(iw-iw/zoom)*${P}`, y: cy };
    case "pan_up":
      return { z: `${1 + I}`, x: cx, y: `(ih-ih/zoom)*(1-${P})` };
    case "pan_down":
      return { z: `${1 + I}`, x: cx, y: `(ih-ih/zoom)*${P}` };
    case "diagonal":
      return { z: `${1 + I * 0.6}+${f(I * 0.4)}*${P}`, x: `(iw-iw/zoom)*${P}`, y: `(ih-ih/zoom)*${P}` };
    case "punch_in":
      return { z: `if(lt(${P},0.42),1+0.015*${P},${f(1 + Math.max(0.12, I * 1.6))})`, x: cx, y: cy };
    case "subtle_rotation":
      return { z: `${f(1.05 + I * 0.3)}`, x: cx, y: cy };
    default:
      return null;
  }
}

interface Graph {
  inputs: string[];
  filters: string[];
  n: number; // next input index
}

function addLoopedImage(g: Graph, file: string, fps: number, seconds: number): number {
  g.inputs.push("-loop", "1", "-framerate", String(fps), "-t", seconds.toFixed(3), "-i", file);
  return g.n++;
}

/**
 * Draw annotations onto a card-sized stream. Coordinates are relative to the visual
 * (0-1) and converted to pixels here. Returns the output label.
 */
function annotate(
  g: Graph,
  label: string,
  anns: Annotation[],
  box: { ox: number; oy: number; w: number; h: number; cw: number; ch: number },
  fps: number,
  seconds: number,
): string {
  let cur = label;
  anns.forEach((a, i) => {
    const rx = Math.round(box.ox + a.rect.x * box.w);
    const ry = Math.round(box.oy + a.rect.y * box.h);
    const rw = Math.max(8, Math.round(a.rect.w * box.w));
    const rh = Math.max(6, Math.round(a.rect.h * box.h));
    const at = f(Math.max(0, a.appearAt));
    const enable = `enable='gte(t,${at})'`;
    const next = `${label}a${i}`;
    switch (a.kind) {
      case "highlight":
        g.filters.push(`[${cur}]drawbox=x=${rx}:y=${ry}:w=${rw}:h=${rh}:color=0xFFE14D@0.42:t=fill:${enable}[${next}]`);
        break;
      case "underline": {
        const th = Math.max(4, Math.round(box.ch / 150));
        g.filters.push(`[${cur}]drawbox=x=${rx}:y=${ry + rh - th}:w=${rw}:h=${th}:color=0xE31E1E@0.95:t=fill:${enable}[${next}]`);
        break;
      }
      case "red_circle": {
        const idx = addLoopedImage(g, library.overlay("circle"), fps, seconds);
        const w = even(rw * 1.3);
        const h = even(rh * 1.6);
        g.filters.push(`[${idx}:v]scale=${w}:${h},format=rgba[ov${label}${i}]`);
        g.filters.push(`[${cur}][ov${label}${i}]overlay=x=${rx - Math.round((w - rw) / 2)}:y=${ry - Math.round((h - rh) / 2)}:${enable}[${next}]`);
        break;
      }
      case "arrow": {
        const idx = addLoopedImage(g, library.overlay("arrow"), fps, seconds);
        const aw = even(Math.max(90, Math.min(box.cw * 0.2, 360)));
        const ah = even(aw / 2.5);
        const leftSpace = rx - aw - 10 >= 0;
        const x = leftSpace ? rx - aw - 10 : Math.min(box.cw - aw, rx + rw + 10);
        const y = Math.round(ry + rh / 2 - ah / 2);
        g.filters.push(`[${idx}:v]scale=${aw}:${ah}${leftSpace ? "" : ",hflip"},format=rgba[ov${label}${i}]`);
        g.filters.push(`[${cur}][ov${label}${i}]overlay=x=${x}:y=${y}:${enable}[${next}]`);
        break;
      }
      case "magnifier": {
        const scale = Math.min(1.9, (box.cw * 0.55) / rw, (box.ch * 0.5) / rh);
        const mw = even(rw * scale);
        const mh = even(rh * scale);
        const x = Math.max(0, Math.min(box.cw - mw, Math.round(rx + rw / 2 - mw / 2)));
        const y = ry + rh + 12 + mh <= box.ch ? ry + rh + 12 : Math.max(0, ry - mh - 12);
        g.filters.push(`[${cur}]split[${cur}k1][${cur}k2]`);
        g.filters.push(
          `[${cur}k2]crop=${rw}:${rh}:${rx}:${ry},scale=${mw}:${mh},drawbox=x=0:y=0:w=iw:h=ih:color=0xE31E1E:t=${Math.max(4, Math.round(box.ch / 180))}[mag${label}${i}]`,
        );
        g.filters.push(`[${cur}k1][mag${label}${i}]overlay=x=${x}:y=${y}:${enable}[${next}]`);
        break;
      }
      case "cursor": {
        const idx = addLoopedImage(g, library.overlay("cursor"), fps, seconds);
        const cs = even(Math.max(32, box.ch / 18));
        const x1 = rx + Math.round(rw / 2);
        const y1 = ry + Math.round(rh / 2);
        const x0 = box.cw - cs;
        const y0 = box.ch - cs;
        const k = `min(1,max(0,(t-${at})/0.7))`;
        g.filters.push(`[${idx}:v]scale=${cs}:${even(cs * 1.5)},format=rgba[ov${label}${i}]`);
        g.filters.push(`[${cur}][ov${label}${i}]overlay=x='${x0}+(${x1 - x0})*${k}':y='${y0}+(${y1 - y0})*${k}':${enable}[${next}]`);
        break;
      }
    }
    cur = next;
  });
  return cur;
}

/**
 * Transition effects applied to the start of the incoming clip (and the end of the outgoing one
 * for dip-to-black). Each is short: an editor's transition is felt, not watched.
 */
export function transitionFilters(t: VisualClip["transitionIn"], seconds: number, out?: VisualClip["transitionOut"]): string {
  let f = "";
  switch (t) {
    case "flash":
      f += ",fade=t=in:st=0:d=0.16:color=white";
      break;
    case "fade":
      f += ",fade=t=in:st=0:d=0.35";
      break;
    case "dip_to_black":
      f += ",fade=t=in:st=0:d=0.4";
      break;
    case "shutter":
      f += ",fade=t=in:st=0:d=0.09";
      break;
    case "film_burn":
      f += ",fade=t=in:st=0:d=0.45:color=0xFF9A3C,noise=alls=28:allf=t:enable='lt(t,0.5)',eq=brightness=0.06:saturation=1.25:enable='lt(t,0.6)'";
      break;
    case "paper":
      f += ",fade=t=in:st=0:d=0.3:color=0xEDE6D6";
      break;
    case "glitch":
      f += ",rgbashift=rh=-16:bh=16:gv=5:enable='lt(t,0.22)',noise=alls=42:allf=t:enable='lt(t,0.22)'";
      break;
    case "whip":
      f += ",avgblur=sizeX=64:sizeY=1:enable='lt(t,0.2)',eq=brightness=0.06:enable='lt(t,0.2)'";
      break;
    default:
      break; // hard_cut; zoom is applied inside the motion expression
  }
  if (out === "dip_to_black" && seconds > 0.8) f += `,fade=t=out:st=${f4(seconds - 0.3)}:d=0.3`;
  return f;
}
const f4 = (n: number) => Number(n.toFixed(3));

/** Build and run the FFmpeg command for one timeline clip. */
export async function renderSegment(spec: SegmentSpec, outDir: string): Promise<{ path: string; cached: boolean }> {
  const out = path.join(outDir, `${segmentKey(spec)}.mp4`);
  if (existsSync(out)) return { path: out, cached: true };

  const { clip, asset, width: W, height: H, fps, draft } = spec;
  const frames = Math.max(1, Math.round(clip.duration * fps));
  const seconds = frames / fps + 0.5;
  const rand = seeded(clip.id + clip.asset.assetId);
  const g: Graph = { inputs: [], filters: [], n: 0 };
  const up = draft ? 1 : 2; // supersample for smooth zoompan motion
  let layout = clip.layout;
  const isStill = !asset || asset.kind === "image";

  // --- asset input -------------------------------------------------------
  let src: string;
  if (asset) {
    if (asset.kind === "image") {
      g.inputs.push("-loop", "1", "-framerate", String(fps), "-t", seconds.toFixed(3), "-i", asset.path);
    } else if (asset.alpha) {
      g.inputs.push("-ignore_loop", "0", "-t", seconds.toFixed(3), "-i", asset.path);
    } else {
      g.inputs.push("-stream_loop", "-1", "-t", seconds.toFixed(3), "-i", asset.path);
    }
    src = `${g.n++}:v`;
  } else {
    layout = "paper_card";
    src = "";
  }

  const assetAR = asset ? asset.width / asset.height : 16 / 9;
  const outAR = W / H;
  let comp: string;

  const bwChain = clip.treatment.blackAndWhite ? ",hue=s=0,eq=contrast=1.08" : "";
  const grain = clip.treatment.grain ? ",noise=alls=9:allf=t" : "";

  if (layout === "fullscreen" || !asset) {
    if (!asset) {
      // Fallback: paper texture only (used when every candidate for this clip failed).
      const bg = addLoopedImage(g, library.texture(spec.paper), fps, seconds);
      g.filters.push(`[${bg}:v]scale=${W * up}:${H * up}:force_original_aspect_ratio=increase,crop=${W * up}:${H * up},setsar=1[comp]`);
    } else if (Math.abs(assetAR - outAR) / outAR > 0.35 || clip.role === "meme") {
      // Strong aspect mismatch (portrait photo, square GIF): blurred fill + fitted foreground.
      g.filters.push(`[${src}]fps=${fps},setsar=1,split[fa][fb]`);
      g.filters.push(`[fa]scale=${even(W / 4)}:${even(H / 4)}:force_original_aspect_ratio=increase,crop=${even(W / 4)}:${even(H / 4)},gblur=sigma=6,scale=${W * up}:${H * up},eq=brightness=-0.08[fbg]`);
      g.filters.push(`[fb]scale=${W * up}:${H * up}:force_original_aspect_ratio=decrease${bwChain}[ffg]`);
      g.filters.push(`[fbg][ffg]overlay=x=(W-w)/2:y=(H-h)/2,setsar=1[comp]`);
    } else {
      g.filters.push(`[${src}]fps=${fps},scale=${W * up}:${H * up}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W * up}:${H * up},setsar=1${bwChain}[comp]`);
    }
    comp = "comp";
  } else {
    // --- paper / document compositions ---------------------------------------
    const bg = addLoopedImage(g, library.texture(clip.layout === "article" ? (spec.paper === "dark_paper" ? "dark_paper" : "newspaper") : spec.paper), fps, seconds);
    const frac = { paper_card: [0.72, 0.78], polaroid: [0.56, 0.66], article: [0.82, 0.88], picture_in_picture: [0.46, 0.5], fullscreen: [1, 1] }[layout];
    const boxW = W * frac[0]! * up;
    const boxH = H * frac[1]! * up;
    const scale = Math.min(boxW / asset.width, boxH / asset.height);
    const cw = even(asset.width * scale);
    const ch = even(asset.height * scale);
    const b = layout === "polaroid" ? even(14 * up) : layout === "paper_card" ? even(9 * up) : even(2 * up);
    const bBottom = layout === "polaroid" ? even(56 * up) : b;
    const border = layout === "article" ? "0xD8D8D8" : "0xFBFAF7";
    const angle = layout === "article" ? (rand() - 0.5) * 0.02 : (rand() - 0.5) * 0.07;

    g.filters.push(`[${bg}:v]scale=${W * up}:${H * up}:force_original_aspect_ratio=increase,crop=${W * up}:${H * up},setsar=1[bg]`);
    g.filters.push(`[${src}]fps=${fps},scale=${cw}:${ch}:flags=lanczos,setsar=1${bwChain},format=rgba,pad=${cw + 2 * b}:${ch + b + bBottom}:${b}:${b}:color=${border}[card0]`);
    const card = annotate(g, "card0", clip.annotations, { ox: b, oy: b, w: cw, h: ch, cw: cw + 2 * b, ch: ch + b + bBottom }, fps, seconds);
    const m = even(40 * up);
    const off = Math.round(10 * up);
    g.filters.push(`[${card}]split[cA][cB]`);
    g.filters.push(`[cB]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.5,pad=iw+${2 * m}:ih+${2 * m}:${m + off}:${m + Math.round(off * 1.4)}:color=black@0,boxblur=${Math.round(9 * up)}:2[shadow]`);
    g.filters.push(`[cA]pad=iw+${2 * m}:ih+${2 * m}:${m}:${m}:color=black@0[cP]`);
    g.filters.push(`[shadow][cP]overlay=0:0,rotate=a=${f(angle)}:c=none:ow=rotw(${f(angle)}):oh=roth(${f(angle)})[layer]`);
    const dx = Math.round((rand() - 0.5) * W * 0.03 * up);
    g.filters.push(`[bg][layer]overlay=x=(W-w)/2+${dx}:y=(H-h)/2:shortest=0,setsar=1[comp]`);
    comp = "comp";
  }

  // --- annotations on fullscreen visuals ----------------------------------------
  if ((layout === "fullscreen" && asset) && clip.annotations.length) {
    comp = annotate(g, comp, clip.annotations, { ox: 0, oy: 0, w: W * up, h: H * up, cw: W * up, ch: H * up }, fps, seconds);
  }

  // --- motion ---------------------------------------------------------------
  const motionType = !isStill && clip.motion.type !== "punch_in" ? "none" : clip.motion.type;
  let expr = motionExpr(motionType, clip.motion.intensity, frames);
  // Zoom transition: the incoming shot starts pushed in and settles over ~0.35 s.
  if (clip.transitionIn === "zoom") {
    const settle = Math.max(2, Math.round(0.35 * fps));
    const push = `(1+0.24*max(0,1-on/${settle}))`;
    expr = expr ? { ...expr, z: `(${expr.z})*${push}` } : { z: push, x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" };
  }
  let chain: string;
  if (expr) {
    chain = `[${comp}]zoompan=z='${expr.z}':x='${expr.x}':y='${expr.y}':d=1:s=${W}x${H}:fps=${fps}`;
    if (motionType === "subtle_rotation") chain += `,rotate=a='0.012*sin(2*PI*t/${f(frames / fps)})':c=black`;
  } else {
    chain = `[${comp}]scale=${W}:${H}:flags=bicubic`;
  }
  chain += grain;
  chain += transitionFilters(clip.transitionIn, frames / fps, clip.transitionOut);
  chain += `,fps=${fps},format=yuv420p,setsar=1[out]`;
  g.filters.push(chain);

  const tmp = `${out}.tmp.mp4`;
  await runFfmpeg(
    [
      ...g.inputs,
      "-filter_complex", g.filters.join(";"),
      "-map", "[out]",
      "-frames:v", String(frames),
      "-r", String(fps),
      "-c:v", "libx264",
      "-preset", draft ? "ultrafast" : "veryfast",
      "-crf", draft ? "26" : "18",
      "-g", String(fps * 2),
      "-pix_fmt", "yuv420p",
      "-video_track_timescale", String(fps * 1000),
      "-an",
      tmp,
    ],
    { timeoutMs: 10 * 60_000 },
  );
  await rename(tmp, out);
  return { path: out, cached: false };
}
