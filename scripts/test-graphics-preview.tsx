/**
 * Preview ↔ render parity for designed graphics:  npm run test:graphics-preview
 * (run npm run test:graphics first — it makes the libass frames). Renders the live-preview
 * component (GraphicOverlay) in headless Chrome at the same moment and size, with the same font
 * files, and compares it with the libass frame: the difference inside the graphic's region must
 * be small next to the graphic itself. Writes side-by-side sheets for review.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";
import { GraphicOverlay } from "@/components/workstation/GraphicOverlay";
import { FONTS, GRAPHIC_FIELDS, type GraphicClip, type GraphicKind, type GraphicTheme, resolvePosition, THEMES } from "@/lib/domain/graphics";
import { findBrowser } from "@/lib/capture/browser";
import { ffmpegPath, runFfmpeg } from "@/lib/render/ffmpeg";
import { library } from "@/lib/render/library";
import { spawn } from "node:child_process";

const OUT = path.resolve(".cache/graphics-test");

/** blur > 0: compare after a Gaussian blur, so offsets of a few pixels and antialiasing don't count. */
function diff(a: string, b: string, crop: [number, number, number, number], blur = 0): Promise<number> {
  const [x, y, w, h] = crop;
  return new Promise((resolve, reject) => {
    const pre = blur ? `[0:v]gblur=sigma=${blur}[p0];[1:v]gblur=sigma=${blur}[p1];[p0][p1]` : "[0:v][1:v]";
    const fc = `${pre}blend=all_mode=difference,crop=iw*${w}:ih*${h}:iw*${x}:ih*${y},signalstats,metadata=print`;
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
  top_left: [0, 0, 0.55, 0.4], top: [0.1, 0, 0.8, 0.4], top_right: [0.45, 0, 0.55, 0.4], center: [0.1, 0.2, 0.8, 0.6],
  bottom_left: [0, 0.55, 0.55, 0.45], bottom: [0.1, 0.55, 0.8, 0.45], bottom_right: [0.45, 0.55, 0.55, 0.45],
};

async function main() {
  const W = 1920;
  const H = 1080;
  const bg = path.join(OUT, `bg-${W}x${H}.png`);
  if (!existsSync(bg)) throw new Error("Run npm run test:graphics first (it renders the libass frames).");
  const bgData = (await readFile(bg)).toString("base64");
  const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true });
  let failures = 0;
  const check = (ok: boolean, label: string) => {
    console.log(`    ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failures++;
  };
  const pairs: string[] = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H });
    // Serve /api/fonts/* from the render library, exactly as the app route does.
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const m = req.url().match(/\/api\/fonts\/([^/?#]+)/);
      if (m && Object.values(FONTS).some((f) => f.file === m[1])) {
        void readFile(path.join(library.fontsDir, m[1]!)).then((body) => req.respond({ status: 200, contentType: "font/ttf", body }));
      } else if (req.url().startsWith("http://preview.test/")) {
        void req.respond({ status: 200, contentType: "text/html", body: "<!doctype html><html><body></body></html>" });
      } else void req.continue();
    });
    // A real origin, so the component's /api/fonts/… URLs resolve (about:blank cannot).
    await page.goto("http://preview.test/");
    const cases: { name: string; g: GraphicClip }[] = [];
    for (const kind of Object.keys(GRAPHIC_FIELDS) as GraphicKind[]) {
      const [title, sub] = GRAPHIC_FIELDS[kind].example;
      cases.push({ name: `${W}x${H}-${kind}`, g: { id: kind, sceneId: "s", kind, title, sub, start: 0.5, duration: 3, position: "auto", animation: "auto", theme: "documentary", accent: THEMES.documentary.accent, scale: 1 } });
    }
    for (const theme of (Object.keys(THEMES) as GraphicTheme[]).filter((t) => t !== "documentary")) {
      cases.push({ name: `${W}x${H}-lower_third-${theme}`, g: { id: theme, sceneId: "s", kind: "lower_third", title: "Delroy Marsh", sub: "Sound system engineer", start: 0.5, duration: 3, position: "auto", animation: "auto", theme, accent: THEMES[theme].accent, scale: 1 } });
    }
    for (const c of cases) {
      const libass = path.join(OUT, c.name, "mid.png");
      if (!existsSync(libass)) throw new Error(`missing ${libass} — run npm run test:graphics`);
      const html = renderToStaticMarkup(<GraphicOverlay graphics={[c.g]} t={c.g.start + 1.6} captionsBottom={false} />);
      await page.setContent(`<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;position:relative;overflow:hidden;background:url(data:image/png;base64,${bgData})">${html}</body></html>`, { waitUntil: "load" });
      await page.evaluate("document.fonts.ready");
      const failed = await page.evaluate("[...document.fonts].filter((f) => f.status === 'error').map((f) => f.family)");
      if ((failed as string[]).length) throw new Error(`fonts failed to load: ${(failed as string[]).join(", ")}`);
      const shot = path.join(OUT, c.name, "preview.png");
      await page.screenshot({ path: shot as `${string}.png`, captureBeyondViewport: false });
      const region = REGION[resolvePosition(c.g)]!;
      // Both measured with the same blur: the graphic's own signal vs. what differs between the two.
      const drawn = await diff(bg, libass, region, 3);
      const mismatch = await diff(libass, shot, region, 3);
      console.log(`${c.name.padEnd(36)} graphic ${drawn.toFixed(2)} · preview vs render ${mismatch.toFixed(2)} (${Math.round((mismatch / drawn) * 100)}%)`);
      check(mismatch < drawn * 0.75, "preview matches the render closely");
      // Side by side: render | preview.
      const pair = path.join(OUT, c.name, "pair.png");
      await runFfmpeg(["-i", libass, "-i", shot, "-filter_complex", "[0:v]scale=640:-2[a];[1:v]scale=640:-2[b];[a][b]hstack", "-frames:v", "1", pair]);
      pairs.push(pair);
    }
  } finally {
    await browser.close();
  }
  await runFfmpeg([...pairs.flatMap((p) => ["-i", p]), "-filter_complex", `${pairs.map((_, i) => `[${i}:v]`).join("")}vstack=inputs=${pairs.length}`, "-frames:v", "1", path.join(OUT, "parity.png")]);
  await writeFile(path.join(OUT, "parity.txt"), "left: libass render · right: live preview\n");
  console.log(`side by side: ${path.join(OUT, "parity.png")}`);
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
