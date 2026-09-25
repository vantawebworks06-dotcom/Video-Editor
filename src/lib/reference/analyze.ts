import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ClaudeService } from "@/lib/ai/claude/service";
import { getPreset } from "@/lib/domain/presets";
import type { StyleProfile } from "@/lib/domain/types";
import { clamp } from "@/lib/pipeline/engines";
import { ffmpegPath, probe, runFfmpeg, spawnTracked } from "@/lib/render/ffmpeg";

export interface ReferenceMetrics {
  analysedSeconds: number;
  shotCount: number;
  averageShotDuration: number;
  medianShotDuration: number;
  minShotDuration: number;
  maxShotDuration: number;
  cutsPerMinute: number;
  staticShotShare: number; // shots mostly frozen (still images without motion)
  blackAndWhiteShare: number;
}

export interface ReferenceAnalysis {
  metrics: ReferenceMetrics;
  profile: StyleProfile;
  /** Which profile fields were measured vs. estimated. */
  measured: string[];
  estimated: string[];
  method: "measured+claude" | "measured+defaults";
  notes: string;
}

function ffmpegStderr(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnTracked(() => spawn(ffmpegPath(), ["-hide_banner", "-nostdin", ...args], { windowsHide: true }));
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(err));
  });
}

/**
 * Analyse a reference video's editing characteristics. Only statistics and small sampled
 * frames are used; no footage is copied into the user's project.
 */
export async function analyzeReferenceVideo(
  file: string,
  opts: { workDir: string; claude?: ClaudeService; maxSeconds?: number },
): Promise<ReferenceAnalysis> {
  const info = await probe(file);
  if (!info.hasVideo || !info.duration) throw new Error("Reference file has no video stream");
  const seconds = Math.min(info.duration, opts.maxSeconds ?? 600);

  // Cut detection (scene change score).
  const sceneLog = await ffmpegStderr(["-t", String(seconds), "-i", file, "-an", "-vf", "scale=320:-2,select='gt(scene,0.32)',showinfo", "-f", "null", "-"]);
  const cuts = [...sceneLog.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.2);
  const bounds = [0, ...cuts, seconds];
  const shots = bounds.slice(1).map((end, i) => ({ start: bounds[i]!, end })).filter((s) => s.end - s.start > 0.15);

  // Static (frozen) intervals → share of shots that are still images.
  const freezeLog = await ffmpegStderr(["-t", String(seconds), "-i", file, "-an", "-vf", "scale=320:-2,freezedetect=n=0.003:d=0.8", "-f", "null", "-"]);
  const freezes: { start: number; end: number }[] = [];
  let fs: number | null = null;
  for (const line of freezeLog.split(/\r?\n/)) {
    const s = line.match(/freeze_start: ([\d.]+)/);
    const e = line.match(/freeze_end: ([\d.]+)/);
    if (s) fs = Number(s[1]);
    if (e && fs !== null) {
      freezes.push({ start: fs, end: Number(e[1]) });
      fs = null;
    }
  }
  if (fs !== null) freezes.push({ start: fs, end: seconds });
  const frozenShare = (s: { start: number; end: number }) =>
    freezes.reduce((acc, f) => acc + Math.max(0, Math.min(f.end, s.end) - Math.max(f.start, s.start)), 0) / (s.end - s.start);
  const staticShots = shots.filter((s) => frozenShare(s) > 0.6).length;

  // Sample one frame per shot (max 24) for B&W measurement and Claude classification.
  await mkdir(opts.workDir, { recursive: true });
  const step = Math.max(1, Math.ceil(shots.length / 24));
  const sampled = shots.filter((_, i) => i % step === 0).slice(0, 24);
  const frames: { index: number; path: string; saturation: number | null }[] = [];
  for (const [i, s] of sampled.entries()) {
    const out = path.join(opts.workDir, `ref_${i}.jpg`);
    await runFfmpeg(["-ss", ((s.start + s.end) / 2).toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "4", out]);
    const stats = await ffmpegStderr(["-i", out, "-vf", "signalstats,metadata=print:key=lavfi.signalstats.SATAVG", "-f", "null", "-"]);
    const sat = stats.match(/SATAVG=([\d.]+)/);
    frames.push({ index: i, path: out, saturation: sat ? Number(sat[1]) : null });
  }
  const bw = frames.filter((f) => f.saturation !== null && f.saturation < 6).length;

  const durations = shots.map((s) => s.end - s.start).sort((a, b) => a - b);
  const avg = durations.reduce((a, b) => a + b, 0) / Math.max(1, durations.length);
  const metrics: ReferenceMetrics = {
    analysedSeconds: Math.round(seconds),
    shotCount: shots.length,
    averageShotDuration: round(avg),
    medianShotDuration: round(durations[Math.floor(durations.length / 2)] ?? avg),
    minShotDuration: round(durations[0] ?? avg),
    maxShotDuration: round(durations.at(-1) ?? avg),
    cutsPerMinute: round((cuts.length / seconds) * 60),
    staticShotShare: round(staticShots / Math.max(1, shots.length)),
    blackAndWhiteShare: round(bw / Math.max(1, frames.length)),
  };

  const base = getPreset("documentary").profile;
  const measuredProfile: StyleProfile = {
    ...base,
    averageShotDuration: clamp(metrics.averageShotDuration, 1, 12),
    minShotDuration: clamp(Math.max(1, metrics.minShotDuration), 0.8, 6),
    maxShotDuration: clamp(metrics.maxShotDuration, 3, 15),
    photoPercentage: Math.round(metrics.staticShotShare * 100),
    videoPercentage: Math.round((1 - metrics.staticShotShare) * 100),
    blackAndWhiteFrequency: metrics.blackAndWhiteShare,
    visualDensity: metrics.averageShotDuration < 3 ? "high" : metrics.averageShotDuration < 5 ? "medium" : "low",
  };
  const measured = ["averageShotDuration", "minShotDuration", "maxShotDuration", "photoPercentage", "videoPercentage", "blackAndWhiteFrequency", "visualDensity"];

  if (opts.claude && frames.length) {
    const images = await Promise.all(frames.map(async (f) => ({ index: f.index, jpegBase64: (await readFile(f.path)).toString("base64") })));
    const out = await opts.claude.analyzeReferenceStyle(metrics as unknown as Record<string, unknown>, images);
    const p = out.profile;
    return {
      metrics,
      profile: {
        ...p,
        // Measured values win over model estimates.
        averageShotDuration: measuredProfile.averageShotDuration,
        minShotDuration: measuredProfile.minShotDuration,
        maxShotDuration: measuredProfile.maxShotDuration,
        photoPercentage: clamp(p.photoPercentage, 0, 100),
        videoPercentage: clamp(p.videoPercentage, 0, 100),
        archivalPercentage: clamp(p.archivalPercentage, 0, 100),
        screenshotPercentage: clamp(p.screenshotPercentage, 0, 100),
        textEmphasisFrequency: clamp(p.textEmphasisFrequency, 0, 1),
        memeFrequency: clamp(p.memeFrequency, 0, 1),
        zoomFrequency: clamp(p.zoomFrequency, 0, 1),
        blackAndWhiteFrequency: clamp(p.blackAndWhiteFrequency, 0, 1),
        paperLayoutFrequency: clamp(p.paperLayoutFrequency, 0, 1),
        sfxFrequency: clamp(p.sfxFrequency, 0, 1),
      },
      measured: ["averageShotDuration", "minShotDuration", "maxShotDuration"],
      estimated: ["photo/video/archival/screenshot mix", "text, meme, zoom, paper-layout and B&W frequency (Claude, from sampled frames)", "sfxFrequency (not measurable from frames)"],
      method: "measured+claude",
      notes: out.notes,
    };
  }

  return {
    metrics,
    profile: measuredProfile,
    measured,
    estimated: ["archival, screenshot, text, meme, zoom, paper-layout and SFX frequencies use Documentary defaults (add a Claude key to classify frames)"],
    method: "measured+defaults",
    notes: "Shot timing, still-vs-moving share and black-and-white share were measured with FFmpeg.",
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
