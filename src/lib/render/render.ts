import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type AssetRef, type RenderStatus, Timeline } from "@/lib/domain/types";
import { buildAss } from "./ass";
import { buildAudioGraph } from "./audio";
import { probe, runFfmpeg } from "./ffmpeg";
import { library, libraryReady } from "./library";
import { type PrepareContext, type PreparedAsset, prepareAsset } from "./prepare";
import { renderSegment } from "./segments";

export interface RenderOptions {
  workDir: string;
  outPath: string;
  draft?: boolean;
  cacheDir?: string;
  concurrency?: number;
  resolveLocal?: PrepareContext["resolveLocal"];
  onStage?: (status: RenderStatus, progress: number, message: string) => void | Promise<void>;
  log?: (msg: string) => void;
}

export interface RenderResult {
  outPath: string;
  duration: number;
  warnings: string[];
  segmentsRendered: number;
  segmentsCached: number;
  /** Clip id → the asset actually used (after automatic fallbacks). */
  usedAssets: Record<string, string | null>;
}

async function pool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]!, idx);
      }
    }),
  );
}

/**
 * Timeline → MP4. Stages: DOWNLOADING (prepare assets, with automatic fallback to alternate
 * candidates) → PREPARING/RENDERING (one cached segment per clip) → FINALIZING (concat, text
 * and captions via libass, audio mix) → COMPLETE.
 */
export async function renderTimeline(input: Timeline, opts: RenderOptions): Promise<RenderResult> {
  // Never trust the caller: re-validate the whole edit decision list.
  const timeline = Timeline.parse(input);
  if (!libraryReady()) throw new Error("Asset library missing. Run `npm run assets:generate` first.");
  const cacheDir = opts.cacheDir ?? path.join(process.cwd(), ".cache");
  const mediaDir = path.join(cacheDir, "media");
  const segDir = path.join(cacheDir, "segments");
  await mkdir(opts.workDir, { recursive: true });
  await mkdir(segDir, { recursive: true });
  await mkdir(path.dirname(opts.outPath), { recursive: true });
  const warnings: string[] = [];
  const log = opts.log ?? (() => undefined);
  const stage = async (s: RenderStatus, p: number, m: string) => {
    log(`[${s}] ${Math.round(p * 100)}% ${m}`);
    await opts.onStage?.(s, p, m);
  };

  // 1. DOWNLOADING — every clip gets a prepared asset or a documented fallback.
  await stage("DOWNLOADING", 0, `Preparing ${timeline.visuals.length} visuals`);
  const prepared = new Map<string, PreparedAsset | null>();
  const usedAssets: Record<string, string | null> = {};
  let done = 0;
  await pool(timeline.visuals, 3, async (clip) => {
    const tries: AssetRef[] = [clip.asset, ...clip.alternates];
    let result: PreparedAsset | null = null;
    for (const ref of tries) {
      try {
        result = await prepareAsset(ref, { trimStart: clip.trimStart, duration: clip.duration }, { cacheDir: mediaDir, resolveLocal: opts.resolveLocal, draft: opts.draft });
        usedAssets[clip.id] = ref.assetId;
        if (ref !== clip.asset) warnings.push(`${clip.id}: primary asset failed; used alternate ${ref.assetId}.`);
        break;
      } catch (err) {
        log(`asset ${ref.assetId} failed: ${(err as Error).message}`);
      }
    }
    if (!result) {
      usedAssets[clip.id] = null;
      warnings.push(`${clip.id}: all candidate assets failed; rendered a paper background instead.`);
    }
    prepared.set(clip.id, result);
    done++;
    await stage("DOWNLOADING", done / timeline.visuals.length, `Prepared ${done}/${timeline.visuals.length}`);
  });

  // 2-3. PREPARING / RENDERING — per-clip segments, cached by content hash.
  await stage("PREPARING", 0, "Building filter graphs");
  const segments: string[] = new Array(timeline.visuals.length);
  let rendered = 0;
  let cached = 0;
  let finished = 0;
  await stage("RENDERING", 0, "Rendering segments");
  await pool(timeline.visuals, opts.concurrency ?? 2, async (clip, i) => {
    const spec = {
      clip,
      asset: prepared.get(clip.id) ?? null,
      width: timeline.width,
      height: timeline.height,
      fps: timeline.fps,
      paper: timeline.paperStyle,
      draft: Boolean(opts.draft),
    };
    try {
      const r = await renderSegment(spec, segDir);
      segments[i] = r.path;
      if (r.cached) cached++;
      else rendered++;
    } catch (err) {
      // A broken filter graph for one clip must not sink the render: fall back to a paper card.
      warnings.push(`${clip.id}: segment render failed (${(err as Error).message.slice(0, 160)}); used fallback.`);
      const r = await renderSegment({ ...spec, asset: null, clip: { ...clip, annotations: [], motion: { type: "slow_zoom_in", intensity: 0.05 } } }, segDir);
      segments[i] = r.path;
    }
    finished++;
    await stage("RENDERING", finished / timeline.visuals.length, `Segment ${finished}/${timeline.visuals.length}${cached ? ` (${cached} cached)` : ""}`);
  });

  // 4. FINALIZING — concat + libass text/captions + audio mix.
  await stage("FINALIZING", 0, "Mixing audio and compositing text");
  const listFile = path.join(opts.workDir, "segments.txt");
  await writeFile(listFile, segments.map((s) => `file '${s.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
  const assFile = path.join(opts.workDir, "overlay.ass");
  await writeFile(assFile, buildAss(timeline), "utf8");
  // Relative paths (cwd = workDir) keep Windows drive colons out of filter arguments.
  const fontsRel = path.relative(opts.workDir, library.fontsDir).replace(/\\/g, "/");

  const audio = buildAudioGraph(timeline, 1);
  const hasText = timeline.texts.length > 0 || timeline.captions.mode !== "OFF";
  const videoFilter = hasText ? `[0:v]ass=overlay.ass:fontsdir='${fontsRel}',format=yuv420p[vout]` : `[0:v]format=yuv420p[vout]`;
  const filters = [videoFilter, ...audio.filters].join(";");
  const tmpOut = `${opts.outPath}.tmp.mp4`;
  await runFfmpeg(
    [
      "-f", "concat", "-safe", "0", "-i", listFile,
      ...audio.inputs,
      "-filter_complex", filters,
      "-map", "[vout]",
      ...(audio.label ? ["-map", `[${audio.label}]`] : []),
      "-t", timeline.duration.toFixed(3),
      "-c:v", "libx264",
      "-preset", opts.draft ? "ultrafast" : "medium",
      "-crf", opts.draft ? "26" : "20",
      // Cap the bitrate at YouTube's recommended level (8 Mbps for 1080p30) so files stay a
      // sensible size; grain and constant motion otherwise balloon a CRF-only encode.
      "-maxrate", opts.draft ? "2500k" : "8M",
      "-bufsize", opts.draft ? "5M" : "16M",
      "-pix_fmt", "yuv420p",
      "-r", String(timeline.fps),
      ...(audio.label ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"] : []),
      "-movflags", "+faststart",
      tmpOut,
    ],
    {
      cwd: opts.workDir,
      durationSeconds: timeline.duration,
      onProgress: (p) => void stage("FINALIZING", p, "Encoding final video").catch(() => undefined),
      timeoutMs: 60 * 60_000,
    },
  );
  await rename(tmpOut, opts.outPath);

  const info = await probe(opts.outPath);
  if (!info.hasVideo || Math.abs((info.duration ?? 0) - timeline.duration) > 1.5) {
    throw new Error(`Output verification failed (duration ${info.duration} vs ${timeline.duration})`);
  }
  await stage("COMPLETE", 1, "Render complete");
  return { outPath: opts.outPath, duration: info.duration ?? timeline.duration, warnings, segmentsRendered: rendered, segmentsCached: cached, usedAssets };
}
