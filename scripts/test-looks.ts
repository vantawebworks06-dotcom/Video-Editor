/**
 * Image looks, measured on real pixels:  npm run test:looks [image]
 * Applies every preset's FFmpeg filters to a photo and checks each look does what its name says
 * (signalstats: luma, saturation, U/V colour balance, darkest decile, frame-to-frame change, and
 * corner-vs-centre brightness for the vignette). Then renders one real timeline segment with a look.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { LOOK_PRESETS, lookFilters, type LookPreset, type LookValues } from "@/lib/domain/look";
import { ffmpegPath, probe, runFfmpeg } from "@/lib/render/ffmpeg";
import type { PreparedAsset } from "@/lib/render/prepare";
import { renderSegment } from "@/lib/render/segments";
import type { VisualClip } from "@/lib/domain/types";

const IMG = path.resolve(process.argv[2] ?? ".cache/ui/files/photo-test.jpg");
const OUT = path.resolve(".cache/looks-test");

interface Stats {
  y: number;
  sat: number;
  u: number;
  v: number;
  ylow: number;
  ydif: number;
  corner: number;
  center: number;
}

function stats(chain: string, img = IMG): Promise<Stats> {
  // Three branches: whole frame, a corner crop and a centre crop, each through signalstats.
  const fc = `[0:v]scale=640:360,format=yuv420p${chain},split=3[a][b][c];[a]signalstats,metadata=print:key=lavfi.signalstats.YAVG[ao];[b]crop=128:72:0:0,signalstats,metadata=print[bo];[c]crop=128:72:256:144,signalstats,metadata=print[co]`;
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-nostats", ...(img.endsWith(".mp4") ? [] : ["-loop", "1", "-framerate", "10"]), "-t", "1", "-i", img, "-filter_complex", fc.replace("metadata=print:key=lavfi.signalstats.YAVG", "metadata=print"), "-map", "[ao]", "-f", "null", "-", "-map", "[bo]", "-f", "null", "-", "-map", "[co]", "-f", "null", "-"];
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.slice(-600)));
      // metadata lines come per branch filter instance: Parsed_metadata_N
      const byInst = new Map<string, Record<string, number[]>>();
      for (const m of err.matchAll(/\[(Parsed_metadata_\d+) @ [^\]]+\] lavfi\.signalstats\.(\w+)=(-?[\d.]+)/g)) {
        const inst = byInst.get(m[1]!) ?? {};
        (inst[m[2]!] ??= []).push(Number(m[3]));
        byInst.set(m[1]!, inst);
      }
      const insts = [...byInst.keys()].sort((a, b) => Number(a.split("_").pop()) - Number(b.split("_").pop()));
      const avg = (i: number, k: string) => {
        const xs = byInst.get(insts[i]!)?.[k] ?? [];
        return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
      };
      // YDIF of the first frame is 0 (nothing before it): average the rest.
      const ydifs = byInst.get(insts[0]!)?.YDIF?.slice(1) ?? [];
      resolve({ y: avg(0, "YAVG"), sat: avg(0, "SATAVG"), u: avg(0, "UAVG"), v: avg(0, "VAVG"), ylow: avg(0, "YLOW"), ydif: ydifs.reduce((a, b) => a + b, 0) / Math.max(1, ydifs.length), corner: avg(1, "YAVG"), center: avg(2, "YAVG") });
    });
  });
}

async function main() {
  if (!existsSync(IMG)) throw new Error(`missing test image ${IMG}`);
  await mkdir(OUT, { recursive: true });
  const all = (v: LookValues) => {
    const f = lookFilters(v, { seed: 7 });
    return `${f.media}${f.frame}`;
  };
  const base = await stats("");
  const fmt = (s: Stats) => `Y ${s.y.toFixed(1)} sat ${s.sat.toFixed(1)} U ${s.u.toFixed(1)} V ${s.v.toFixed(1)} low ${s.ylow.toFixed(1)} dif ${s.ydif.toFixed(2)} corner/centre ${(s.corner / s.center).toFixed(3)}`;
  console.log(`source      ${fmt(base)}`);
  let failures = 0;
  const check = (ok: boolean, label: string) => {
    console.log(`    ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failures++;
  };
  const vig = (s: Stats) => s.corner / s.center;
  for (const [name, v] of Object.entries(LOOK_PRESETS) as [Exclude<LookPreset, "custom">, LookValues][]) {
    const s = await stats(all(v));
    console.log(`${name.padEnd(17)} ${fmt(s)}`);
    if (name === "none") {
      check(Math.abs(s.y - base.y) < 0.5 && Math.abs(s.sat - base.sat) < 0.5, "unchanged");
      continue;
    }
    if (v.temperature > 0.2) check(s.v - s.u > base.v - base.u + 1, "warmer (more red, less blue)");
    if (v.temperature < -0.2) check(s.u - s.v > base.u - base.v + 1, "cooler (more blue, less red)");
    if (v.saturation === 0) check(s.sat < 2, "black & white");
    else if (v.saturation < 0.9) check(s.sat < base.sat * 0.95, "less saturated");
    if (v.fade >= 0.3) check(s.ylow > base.ylow + 4, "lifted blacks");
    if (v.vignette >= 0.3) {
      // Against the same look without its vignette (fade/exposure also move the corners).
      const flat = await stats(all({ ...v, vignette: 0 }));
      check(vig(s) < vig(flat) * 0.93, `darker corners (${vig(flat).toFixed(3)} → ${vig(s).toFixed(3)})`);
    }
    if (v.grain >= 0.15) check(s.ydif > base.ydif + 0.5, "moving grain");
    if (v.split > 0.3) check(Math.abs(s.u - base.u) + Math.abs(s.v - base.v) > 1, "split toning changes colour");
  }
  // Exposure direction, on a mid-tone gradient (a bright photo clips when brightened).
  const grad = path.join(OUT, "midtones.png");
  if (!existsSync(grad)) await runFfmpeg(["-f", "lavfi", "-i", "gradients=s=640x360:c0=0x303030:c1=0x909090:x0=0:y0=0:x1=640:y1=360", "-frames:v", "1", grad]);
  const mid = await stats("", grad);
  const up = await stats(all({ ...LOOK_PRESETS.none, exposure: 0.5 }), grad);
  const down = await stats(all({ ...LOOK_PRESETS.none, exposure: -0.5 }), grad);
  console.log(`exposure ±0.5   Y ${down.y.toFixed(1)} / ${mid.y.toFixed(1)} / ${up.y.toFixed(1)} (mid-tone gradient)`);
  check(up.y > mid.y * 1.2 && down.y < mid.y * 0.85, "exposure brightens and darkens");
  // A real segment through the renderer (grade + finish + motion), in a fullscreen and a paper layout.
  const info = await probe(IMG);
  const asset: PreparedAsset = { path: IMG, kind: "image", width: info.width ?? 1280, height: info.height ?? 720, duration: null, alpha: false };
  for (const layout of ["fullscreen", "polaroid"] as const) {
    const clip = {
      id: `look_${layout}`,
      sceneId: "s",
      start: 0,
      duration: 1.5,
      trimStart: 0,
      alternates: [],
      layout,
      annotations: [],
      transitionIn: "hard_cut",
      role: "primary",
      asset: { assetId: "test", type: "photo", url: "", localPath: IMG, width: asset.width, height: asset.height, duration: null, rightsStatus: "CLEAR" },
      motion: { type: "slow_zoom_in", intensity: 0.08 },
      treatment: { blackAndWhite: false, grain: false, look: { preset: "vintage", ...LOOK_PRESETS.vintage } },
    } as unknown as VisualClip;
    const t0 = Date.now();
    const seg = await renderSegment({ clip, asset, width: 960, height: 540, fps: 24, paper: "white_paper", draft: true }, OUT);
    const st = await stats("", seg.path).catch(() => null);
    console.log(`segment ${layout.padEnd(10)} ${((Date.now() - t0) / 1000).toFixed(1)} s · ${st ? `sat ${st.sat.toFixed(1)} low ${st.ylow.toFixed(1)}` : "unreadable"}`);
    check(Boolean(st) && st!.sat < base.sat && (layout !== "fullscreen" || st!.ylow > base.ylow + 4), `${layout} segment rendered with the look (desaturated${layout === "fullscreen" ? ", lifted blacks" : ""})`);
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
