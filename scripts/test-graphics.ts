/**
 * Designed graphics, drawn by libass exactly as the render burns them in:  npm run test:graphics
 * For every kind (and every theme on one kind), renders a frame mid-graphic and a frame after it
 * ends over a plain background, then checks: the graphic draws inside its expected region, it is
 * gone after its end time, and ASS control characters in the text cannot inject tags. Writes
 * contact sheets to .cache/graphics-test/ for visual review.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildAss } from "@/lib/render/ass";
import { ffmpegPath, runFfmpeg } from "@/lib/render/ffmpeg";
import { library } from "@/lib/render/library";
import { GRAPHIC_FIELDS, type GraphicClip, type GraphicKind, type GraphicTheme, THEMES, resolvePosition } from "@/lib/domain/graphics";
import type { Timeline } from "@/lib/domain/types";

const OUT = path.resolve(".cache/graphics-test");

function timeline(W: number, H: number, graphics: GraphicClip[]): Timeline {
  return {
    version: 1, width: W, height: H, fps: 25, duration: 6, paperStyle: "white_paper", visuals: [], texts: [], graphics,
    captions: { mode: "OFF", words: [], emphasized: [], font: "Inter", fontSize: 48, position: "bottom" },
    audio: { voice: null, music: null, ambience: null, sfx: [], mix: { voiceVolume: 1, musicVolume: 0, sfxVolume: 0, ambienceVolume: 0, duckingStrength: 0 } },
    attributions: [],
  } as Timeline;
}

/** Mean absolute difference (0–255 luma) between two images inside a crop (fractions of the frame). */
function diff(a: string, b: string, crop: [number, number, number, number]): Promise<number> {
  const [x, y, w, h] = crop;
  return new Promise((resolve, reject) => {
    const fc = `[0:v][1:v]blend=all_mode=difference,crop=iw*${w}:ih*${h}:iw*${x}:ih*${y},signalstats,metadata=print`;
    const p = spawn(ffmpegPath(), ["-hide_banner", "-nostats", "-i", a, "-i", b, "-filter_complex", fc, "-f", "null", "-"], { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("close", () => {
      const m = err.match(/YAVG=([\d.]+)/);
      if (m) resolve(Number(m[1]));
      else reject(new Error(err.slice(-400)));
    });
  });
}

const REGION: Record<string, [number, number, number, number]> = {
  top_left: [0, 0, 0.55, 0.4],
  top: [0.1, 0, 0.8, 0.4],
  top_right: [0.45, 0, 0.55, 0.4],
  center: [0.1, 0.2, 0.8, 0.6],
  bottom_left: [0, 0.55, 0.55, 0.45],
  bottom: [0.1, 0.55, 0.8, 0.45],
  bottom_right: [0.45, 0.55, 0.55, 0.45],
};

async function frames(name: string, W: number, H: number, g: GraphicClip, bg: string): Promise<{ mid: string; after: string }> {
  const dir = path.join(OUT, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "g.ass"), buildAss(timeline(W, H, [g])), "utf8");
  const fontsRel = path.relative(dir, library.fontsDir).replace(/\\/g, "/");
  const bgRel = path.relative(dir, bg).replace(/\\/g, "/");
  const grab = async (t: number, out: string) =>
    runFfmpeg(["-loop", "1", "-framerate", "25", "-t", "6", "-i", bgRel, "-vf", `ass=g.ass:fontsdir='${fontsRel}'`, "-ss", t.toFixed(2), "-frames:v", "1", out], { cwd: dir, timeoutMs: 120_000 });
  await grab(g.start + 1.6, "mid.png");
  await grab(g.start + g.duration + 0.6, "after.png");
  return { mid: path.join(dir, "mid.png"), after: path.join(dir, "after.png") };
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  let failures = 0;
  const check = (ok: boolean, label: string) => {
    console.log(`    ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failures++;
  };
  const sheet: string[] = [];
  for (const [W, H] of [[1920, 1080], [1080, 1920]] as const) {
    const bg = path.join(OUT, `bg-${W}x${H}.png`);
    await runFfmpeg(["-f", "lavfi", "-i", `gradients=s=${W}x${H}:c0=0x4a5a6a:c1=0x2a2f36:x0=0:y0=0:x1=${W}:y1=${H}`, "-frames:v", "1", bg]);
    const kinds = Object.keys(GRAPHIC_FIELDS) as GraphicKind[];
    const themes: GraphicTheme[] = W > H ? (Object.keys(THEMES) as GraphicTheme[]) : ["documentary"];
    const cases: { name: string; g: GraphicClip }[] = [];
    for (const kind of kinds) {
      const [title, sub] = GRAPHIC_FIELDS[kind].example;
      cases.push({ name: `${W}x${H}-${kind}`, g: { id: kind, sceneId: "s", kind, title, sub, start: 0.5, duration: 3, position: "auto", animation: "auto", theme: "documentary", accent: THEMES.documentary.accent, scale: 1 } });
    }
    for (const theme of themes.filter((t) => t !== "documentary")) {
      cases.push({ name: `${W}x${H}-lower_third-${theme}`, g: { id: theme, sceneId: "s", kind: "lower_third", title: "Delroy Marsh", sub: "Sound system engineer", start: 0.5, duration: 3, position: "auto", animation: "auto", theme, accent: THEMES[theme].accent, scale: 1 } });
    }
    for (const c of cases) {
      const f = await frames(c.name, W, H, c.g, bg);
      const region = REGION[resolvePosition(c.g)]!;
      const inside = await diff(bg, f.mid, region);
      const gone = await diff(bg, f.after, [0, 0, 1, 1]);
      console.log(`${c.name.padEnd(36)} drawn ${inside.toFixed(2)} · after end ${gone.toFixed(3)}`);
      // Drawn, and concentrated in the expected region (region change > whole-frame change).
      const whole = await diff(bg, f.mid, [0, 0, 1, 1]);
      // (A chapter title dims the whole frame by design, so only "drawn" applies to it.)
      check(inside > 0.5 && (c.g.kind === "chapter" || inside > whole * 1.15),`draws in its ${resolvePosition(c.g)} region (region ${inside.toFixed(2)} vs frame ${whole.toFixed(2)})`);
      check(gone < 0.05, "gone after its end time");
      sheet.push(f.mid);
    }
  }
  // Injection: a title with override tags must render exactly like its escaped text written plainly
  // (the tags become harmless letters: no size change, no repositioning).
  const bg = path.join(OUT, "bg-1920x1080.png");
  const base: GraphicClip = { id: "x", sceneId: "s", kind: "lower_third", title: "Plain name", sub: "", start: 0.5, duration: 3, position: "auto", animation: "none", theme: "documentary", accent: "#f2b441", scale: 1 };
  const plain = await frames("inject-plain", 1920, 1080, { ...base, title: "Plainfs400pos(960,540) name" }, bg);
  const evil = await frames("inject-evil", 1920, 1080, { ...base, title: "Plain{\\fs400\\pos(960,540)} name" }, bg);
  const d = await diff(plain.mid, evil.mid, [0, 0, 1, 1]);
  console.log(`injection: difference to the escaped text ${d.toFixed(3)}`);
  check(d < 0.05, "override tags in text are neutralised");

  // Contact sheets for a visual check (landscape kinds + themes, vertical kinds).
  const land = sheet.filter((p) => p.includes("1920x1080"));
  const vert = sheet.filter((p) => p.includes("1080x1920"));
  const tile = async (files: string[], cols: number, w: number, out: string) =>
    runFfmpeg([...files.flatMap((f) => ["-i", f]), "-filter_complex", `${files.map((_, i) => `[${i}:v]scale=${w}:-2[s${i}]`).join(";")};${files.map((_, i) => `[s${i}]`).join("")}xstack=inputs=${files.length}:layout=${files.map((_, i) => `${(i % cols) === 0 ? "0" : Array.from({ length: i % cols }, () => "w0").join("+")}_${Math.floor(i / cols) === 0 ? "0" : Array.from({ length: Math.floor(i / cols) }, () => "h0").join("+")}`).join("|")}:fill=black`, "-frames:v", "1", out]);
  await tile(land, 4, 480, path.join(OUT, "sheet-landscape.png"));
  await tile(vert, 4, 270, path.join(OUT, "sheet-vertical.png"));
  console.log(`contact sheets: ${OUT}`);
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
