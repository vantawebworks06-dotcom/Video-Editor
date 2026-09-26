/**
 * Measured analysis of a reference video's editing language (no footage is kept or copied).
 *
 * Two FFmpeg passes produce per-frame and per-100 ms series:
 *   video @10 fps, 160×90: scene-change score, luma (YAVG), saturation (SATAVG), frame difference
 *     (YDIF) and image entropy
 *   audio: momentary loudness (EBU R128, 100 ms) and silences
 * Everything below is derived from those series — shot boundaries, hard cuts vs gradual
 * transitions (dissolves), dips to black/white, still vs animated-still vs live shots, graphic
 * frames (cards, screenshots), silences, impact hits on cuts, loudness builds and drops, and the
 * pacing curve across the video. Values that can't be measured this way are left out, never
 * invented.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ffmpegPath, probe, spawnTracked } from "@/lib/render/ffmpeg";

export interface FrameSample {
  t: number;
  scene: number;
  yavg: number;
  sat: number;
  ydif: number;
  entropy: number;
}

export interface Shot {
  start: number;
  end: number;
  /** How the shot was entered. */
  transitionIn: "hard_cut" | "dissolve" | "dip_to_black" | "dip_to_white" | "start";
  kind: "still" | "animated_still" | "live" | "graphic" | "black";
  bw: boolean;
  /** Diagnostics: mean and relative spread of frame difference, entropy, saturation, luma. */
  f: { md: number; cv: number; ent: number; sat: number; lum: number };
}

export interface ReferenceMeasurements {
  analysedSeconds: number;
  shotCount: number;
  averageShotDuration: number;
  medianShotDuration: number;
  shortestShot: number;
  longestShot: number;
  /** Standard deviation / mean of shot durations (0 = metronome). */
  shotDurationVariation: number;
  cutsPerMinute: number;
  transitions: { hardCut: number; dissolve: number; dipToBlack: number; dipToWhite: number };
  shotKinds: { still: number; animatedStill: number; live: number; graphic: number };
  /** Share of still images that move (zoom/pan). */
  photoAnimationShare: number;
  blackAndWhiteShare: number;
  audio: {
    silencesPerMinute: number;
    impactsPerMinute: number;
    buildsPerMinute: number;
    dropsPerMinute: number;
    loudnessRange: number;
  };
  /** Relative cut density in 10 equal parts of the video (1 = average). */
  pacingCurve: number[];
  introCutRate: number;
  outroCutRate: number;
  highIntensitySections: { start: number; end: number }[];
  lowIntensitySections: { start: number; end: number }[];
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnTracked(() => spawn(ffmpegPath(), ["-hide_banner", "-nostdin", ...args], { windowsHide: true }));
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(err));
  });
}

/** Parse `metadata=print` output: blocks of `frame:… pts_time:…` followed by key=value lines. */
function parseMetadata(text: string): Record<string, number>[] {
  const out: Record<string, number>[] = [];
  let cur: Record<string, number> | null = null;
  for (const line of text.split(/\r?\n/)) {
    const head = line.match(/pts_time:([\d.]+)/);
    if (head) {
      cur = { t: Number(head[1]) };
      out.push(cur);
      continue;
    }
    const kv = line.match(/^lavfi\.([\w.]+)=(-?[\d.]+|inf|-inf)/);
    if (kv && cur) cur[kv[1]!] = Number(kv[2]);
  }
  return out;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export async function measureReference(file: string, opts: { workDir: string; maxSeconds?: number }): Promise<{ measurements: ReferenceMeasurements; shots: Shot[] }> {
  const info = await probe(file);
  if (!info.hasVideo || !info.duration) throw new Error("Reference file has no video stream");
  const seconds = Math.min(info.duration, opts.maxSeconds ?? 900);
  await mkdir(opts.workDir, { recursive: true });
  const vfile = path.join(opts.workDir, "frames.txt");
  const afile = path.join(opts.workDir, "loudness.txt");

  // --- video series ---------------------------------------------------------------------
  // FFmpeg writes the metadata file relative to its cwd (Windows drive colons break filter
  // arguments), so it runs from the work dir.
  await runIn(opts.workDir, ["-t", String(seconds), "-i", file, "-an", "-vf", "fps=10,scale=160:90,select='gte(scene,0)',signalstats,entropy,metadata=print:file=frames.txt", "-f", "null", "-"]);
  const vtext = await readFile(vfile, "utf8").catch(() => "");
  const frames: FrameSample[] = parseMetadata(vtext).map((f) => ({
    t: f.t ?? 0,
    scene: f["scene_score"] ?? 0,
    yavg: f["signalstats.YAVG"] ?? 0,
    sat: f["signalstats.SATAVG"] ?? 0,
    ydif: f["signalstats.YDIF"] ?? 0,
    entropy: f["entropy.normalized_entropy.normal.Y"] ?? f["entropy.entropy.normal.Y"] ?? 0,
  }));
  if (frames.length < 20) throw new Error("Could not read frames from the reference video");

  // --- audio series ---------------------------------------------------------------------
  const loud: { t: number; m: number }[] = [];
  const silences: { start: number; end: number }[] = [];
  if (info.hasAudio) {
    await runIn(opts.workDir, ["-t", String(seconds), "-i", file, "-vn", "-af", `ebur128=metadata=1,ametadata=print:key=lavfi.r128.M:file=loudness.txt`, "-f", "null", "-"]);
    const rows = parseMetadata(await readFile(afile, "utf8").catch(() => ""));
    // Keep one value per 100 ms.
    let last = -1;
    for (const r of rows) {
      if (r.t - last < 0.099 || r["r128.M"] === undefined || !Number.isFinite(r["r128.M"])) continue;
      loud.push({ t: r.t, m: Math.max(-70, r["r128.M"]) });
      last = r.t;
    }
    const sil = await run(["-t", String(seconds), "-i", file, "-vn", "-af", "silencedetect=noise=-38dB:d=0.25", "-f", "null", "-"]);
    let s: number | null = null;
    for (const line of sil.split(/\r?\n/)) {
      const a = line.match(/silence_start: ([\d.]+)/);
      const b = line.match(/silence_end: ([\d.]+)/);
      if (a) s = Number(a[1]);
      if (b && s !== null) {
        silences.push({ start: s, end: Number(b[1]) });
        s = null;
      }
    }
  }
  await rm(vfile, { force: true });
  await rm(afile, { force: true });

  // --- shots and transitions --------------------------------------------------------------
  const cuts: { t: number; kind: Shot["transitionIn"] }[] = [];
  const dark = (f: FrameSample) => f.yavg < 22;
  const white = (f: FrameSample) => f.yavg > 228 && f.sat < 12;
  for (let i = 1; i < frames.length - 1; i++) {
    const f = frames[i]!;
    const prev = frames[i - 1]!;
    const next = frames[i + 1]!;
    // Hard cut: a single-frame spike well above its neighbours.
    if (f.scene > 0.3 && f.scene > prev.scene * 2 && f.scene > next.scene * 1.5) {
      const kind = dark(prev) || dark(f) ? "dip_to_black" : white(prev) || white(f) ? "dip_to_white" : "hard_cut";
      cuts.push({ t: f.t, kind });
      continue;
    }
    // Gradual transition (dissolve): ≥4 consecutive frames of moderate change summing to a full
    // image change, bracketed by calmer frames.
    if (f.scene > 0.05 && prev.scene <= 0.05) {
      let j = i;
      let sum = 0;
      while (j < frames.length && frames[j]!.scene > 0.04 && frames[j]!.scene < 0.3 && j - i < 20) sum += frames[j++]!.scene;
      const len = j - i;
      if (len >= 4 && sum > 0.45) {
        const mid = frames[Math.floor((i + j) / 2)]!;
        const through = frames.slice(i, j);
        const kind = through.some(dark) ? "dip_to_black" : through.some(white) ? "dip_to_white" : "dissolve";
        cuts.push({ t: mid.t, kind });
        i = j;
      }
    }
  }
  // Dips and flashes from brightness: a short run of near-black (or near-white) frames between
  // normal ones. The scene score barely moves during a fade, so it can't see these.
  const lit = (f: FrameSample | undefined) => Boolean(f && f.yavg > 32);
  for (let i = 1; i < frames.length - 1; i++) {
    const isDark = dark(frames[i]!);
    const isWhite = white(frames[i]!);
    if (!isDark && !isWhite) continue;
    let j = i;
    while (j < frames.length && (isDark ? dark(frames[j]!) : white(frames[j]!))) j++;
    const len = j - i;
    const around = lit(frames[i - 3] ?? frames[i - 1]) && lit(frames[j + 2] ?? frames[j]);
    if (around && len <= (isDark ? 12 : 4)) {
      const t = frames[Math.min(j, frames.length - 1)]!.t; // the new shot starts as the dip ends
      const kind = isDark ? "dip_to_black" : "dip_to_white";
      const near = cuts.find((c) => Math.abs(c.t - t) < 0.7);
      if (near) near.kind = kind;
      else cuts.push({ t, kind });
    }
    i = j;
  }
  cuts.sort((a, b) => a.t - b.t);
  // Merge cuts closer than 0.25 s (one transition detected twice).
  const merged = cuts.filter((c, k) => k === 0 || c.t - cuts[k - 1]!.t > 0.25);
  const bounds = [{ t: 0, kind: "start" as const }, ...merged, { t: seconds, kind: "start" as const }];
  const shots: Shot[] = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const start = bounds[k]!.t;
    const end = bounds[k + 1]!.t;
    if (end - start < 0.2) continue;
    const inside = frames.filter((f) => f.t > start + 0.15 && f.t < end - 0.15);
    const diffs = inside.map((f) => f.ydif);
    const md = mean(diffs);
    const sd = Math.sqrt(mean(diffs.map((d) => (d - md) ** 2)));
    const ent = mean(inside.map((f) => f.entropy));
    const lum = mean(inside.map((f) => f.yavg));
    const sat = mean(inside.map((f) => f.sat));
    const cv = sd / Math.max(0.01, md);
    // Thresholds calibrated on a render whose true clip types are known (see scripts/measure-video.ts):
    // cards/graphics have low entropy and almost no colour; animated stills change steadily
    // (low spread); live footage changes unevenly.
    let kind: Shot["kind"];
    if (inside.length && inside.every(dark)) kind = "black";
    else if (ent < 0.72 && sat < 8 && md < 1.5) kind = "graphic";
    else if (md < 0.35) kind = "still";
    else if (cv < 0.45 && md < 6) kind = "animated_still";
    else kind = "live";
    shots.push({ start, end, transitionIn: bounds[k]!.kind === "start" && k === 0 ? "start" : (bounds[k]!.kind as Shot["transitionIn"]), kind, bw: mean(inside.map((f) => f.sat)) < 5 && lum > 25, f: { md: round(md), cv: round(sd / Math.max(0.01, md)), ent: round(ent, 3), sat: round(mean(inside.map((f) => f.sat)), 1), lum: round(lum, 1) } });
  }

  // --- statistics ----------------------------------------------------------------------------
  const durs = shots.map((s) => s.end - s.start).sort((a, b) => a - b);
  const avg = mean(durs);
  const sdDur = Math.sqrt(mean(durs.map((d) => (d - avg) ** 2)));
  const entered = shots.filter((s) => s.transitionIn !== "start");
  const share = (k: Shot["transitionIn"]) => round(entered.filter((s) => s.transitionIn === k).length / Math.max(1, entered.length));
  const visible = shots.filter((s) => s.kind !== "black");
  const kshare = (k: Shot["kind"]) => round(visible.filter((s) => s.kind === k).length / Math.max(1, visible.length));
  const minutes = seconds / 60;

  // Pacing curve: cut density in 10 slices relative to the average.
  const slices = Array.from({ length: 10 }, (_, i) => merged.filter((c) => c.t >= (seconds * i) / 10 && c.t < (seconds * (i + 1)) / 10).length);
  const avgSlice = mean(slices) || 1;
  const rateIn = (a: number, b: number) => (merged.filter((c) => c.t >= a && c.t < b).length / Math.max(1, b - a)) * 60;
  const introCutRate = rateIn(0, Math.min(60, seconds / 5));
  const outroCutRate = rateIn(Math.max(0, seconds - Math.min(60, seconds / 5)), seconds);

  // Audio events.
  const smooth = loud.map((p, i) => ({ t: p.t, m: mean(loud.slice(Math.max(0, i - 15), i + 15).map((x) => x.m)) })); // 3 s window
  let impacts = 0;
  for (const c of merged) {
    const before = loud.filter((p) => p.t > c.t - 0.6 && p.t < c.t - 0.1).map((p) => p.m);
    const after = loud.filter((p) => p.t >= c.t - 0.05 && p.t < c.t + 0.35).map((p) => p.m);
    if (before.length && after.length && Math.max(...after) - mean(before) > 7) impacts++;
  }
  let builds = 0;
  let drops = 0;
  for (let i = 0; i < smooth.length; i += 10) {
    const now = smooth[i]!;
    const back = smooth.filter((p) => p.t >= now.t - 12 && p.t <= now.t - 5);
    if (back.length && now.m - Math.min(...back.map((p) => p.m)) > 6 && now.m > mean(smooth.map((p) => p.m)) + 2) {
      builds++;
      i += 150; // one build per 15 s at most
    }
  }
  for (let i = 5; i < loud.length - 5; i++) {
    const pre = mean(loud.slice(i - 5, i).map((p) => p.m));
    const post = mean(loud.slice(i, i + 5).map((p) => p.m));
    if (pre > -35 && pre - post > 12) {
      drops++;
      i += 30;
    }
  }
  const lvals = loud.map((p) => p.m).filter((m) => m > -60).sort((a, b) => a - b);
  const loudnessRange = lvals.length ? lvals[Math.floor(lvals.length * 0.95)]! - lvals[Math.floor(lvals.length * 0.1)]! : 0;

  // High / low intensity sections: 20 s windows by cut rate + loudness, top and bottom fifth.
  const windows: { start: number; end: number; score: number }[] = [];
  for (let a = 0; a + 20 <= seconds; a += 20) {
    const cutRate = rateIn(a, a + 20) / 60;
    const l = mean(smooth.filter((p) => p.t >= a && p.t < a + 20).map((p) => p.m));
    windows.push({ start: a, end: a + 20, score: cutRate * 2 + (Number.isFinite(l) ? l / 10 : 0) });
  }
  const sortedW = [...windows].sort((a, b) => b.score - a.score);
  const fifth = Math.max(1, Math.floor(windows.length / 5));

  return {
    shots,
    measurements: {
      analysedSeconds: Math.round(seconds),
      shotCount: shots.length,
      averageShotDuration: round(avg),
      medianShotDuration: round(durs[Math.floor(durs.length / 2)] ?? avg),
      shortestShot: round(durs[0] ?? avg),
      longestShot: round(durs.at(-1) ?? avg),
      shotDurationVariation: round(sdDur / Math.max(0.01, avg)),
      cutsPerMinute: round(merged.length / minutes, 1),
      transitions: { hardCut: share("hard_cut"), dissolve: share("dissolve"), dipToBlack: share("dip_to_black"), dipToWhite: share("dip_to_white") },
      shotKinds: { still: kshare("still"), animatedStill: kshare("animated_still"), live: kshare("live"), graphic: kshare("graphic") },
      photoAnimationShare: round(visible.filter((s) => s.kind === "animated_still").length / Math.max(1, visible.filter((s) => s.kind === "animated_still" || s.kind === "still").length)),
      blackAndWhiteShare: round(visible.filter((s) => s.bw).length / Math.max(1, visible.length)),
      audio: {
        silencesPerMinute: round(silences.length / minutes, 1),
        impactsPerMinute: round(impacts / minutes, 1),
        buildsPerMinute: round(builds / minutes, 2),
        dropsPerMinute: round(drops / minutes, 2),
        loudnessRange: round(loudnessRange, 1),
      },
      pacingCurve: slices.map((s) => round(s / avgSlice)),
      introCutRate: round(introCutRate, 1),
      outroCutRate: round(outroCutRate, 1),
      highIntensitySections: sortedW.slice(0, fifth).map(({ start, end }) => ({ start, end })).sort((a, b) => a.start - b.start),
      lowIntensitySections: sortedW.slice(-fifth).map(({ start, end }) => ({ start, end })).sort((a, b) => a.start - b.start),
    },
  };
}

function runIn(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnTracked(() => spawn(ffmpegPath(), ["-hide_banner", "-nostdin", ...args], { windowsHide: true, cwd }));
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(err));
  });
}
