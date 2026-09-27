import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type AssetRef, type RenderStatus, Timeline } from "@/lib/domain/types";
import { buildAss } from "./ass";
import { buildAudioGraph } from "./audio";
import { normalizeLoudness, type QcReport, qcReport } from "./qc";
import { processVoice } from "@/lib/audio/voiceMeasure";
import { isAllowedMediaUrl, NETWORK_INPUT_ARGS, probe, runFfmpeg } from "./ffmpeg";
import { stableHash } from "@/lib/media/cache";
import { existsSync } from "node:fs";
import { library, libraryReady } from "./library";
import { type PrepareContext, type PreparedAsset, prepareAsset } from "./prepare";
import { BLEND_TRANSITIONS, blendSegment, renderSegment } from "./segments";

export interface RenderOptions {
  workDir: string;
  outPath: string;
  draft?: boolean;
  cacheDir?: string;
  concurrency?: number;
  resolveLocal?: PrepareContext["resolveLocal"];
  onStage?: (status: RenderStatus, progress: number, message: string) => void | Promise<void>;
  /** Final export settings: encode quality, delivery loudness (LUFS; null = leave the mix as is), burned-in captions. */
  quality?: "standard" | "high";
  loudnessTarget?: number | null;
  burnCaptions?: boolean;
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
  /** Measured file (format, loudness, black/silent stretches). */
  qc: QcReport;
  loudness: { gainDb: number; limited: boolean; skipped: boolean } | null;
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

  // 1b. Source footage audio (interviews/news): the section of the original file's audio track.
  const sourceAudio: Record<string, string> = {};
  const withAudio = timeline.visuals.filter((v) => v.role === "source" && v.sourceAudio && v.sourceAudio.mode !== "visual_only");
  if (withAudio.length) {
    await stage("PREPARING", 0, `Extracting audio of ${withAudio.length} source clip(s)`);
    const dir = path.join(cacheDir, "source-audio");
    await mkdir(dir, { recursive: true });
    for (const v of withAudio) {
      const local = (await opts.resolveLocal?.(v.asset)) ?? v.asset.localPath;
      const input = local ?? (isAllowedMediaUrl(v.asset.url) ? v.asset.url : null);
      if (!input) {
        warnings.push(`${v.id}: source audio unavailable (media host not allowed); played as visual only.`);
        continue;
      }
      const info = await probe(input).catch(() => null);
      if (!info?.hasAudio) {
        warnings.push(`${v.id}: the source file has no audio track; played as visual only.`);
        continue;
      }
      const out = path.join(dir, `${stableHash({ input, trim: v.trimStart, d: v.duration })}.wav`);
      if (!existsSync(out)) {
        await runFfmpeg([...(local ? [] : NETWORK_INPUT_ARGS), "-ss", v.trimStart.toFixed(3), "-i", input, "-t", (v.duration + 0.2).toFixed(3), "-vn", "-map", "0:a:0", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", `${out}.tmp.wav`], { timeoutMs: 5 * 60_000 });
        await rename(`${out}.tmp.wav`, out);
      }
      sourceAudio[v.id] = out;
    }
  }

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

  // 3b. Blend transitions (dissolve, luma fade, wipe, motion blur, dip to white) need both shots.
  const blends = timeline.visuals.map((v, i) => ({ v, i })).filter(({ v, i }) => i > 0 && BLEND_TRANSITIONS[v.transitionIn]);
  if (blends.length) {
    await stage("RENDERING", 1, `Blending ${blends.length} transitions`);
    const original = [...segments];
    await pool(blends, opts.concurrency ?? 2, async ({ v, i }) => {
      try {
        segments[i] = await blendSegment(original[i - 1]!, original[i]!, v.transitionIn, Math.max(1, Math.round(v.duration * timeline.fps)) / timeline.fps, timeline.fps, Boolean(opts.draft), segDir);
      } catch (err) {
        warnings.push(`${v.id}: ${v.transitionIn} transition failed (${(err as Error).message.slice(0, 120)}); used a cut.`);
      }
    });
  }

  // 4. FINALIZING — concat + libass text/captions + audio mix.
  await stage("FINALIZING", 0, "Mixing audio and compositing text");
  const listFile = path.join(opts.workDir, "segments.txt");
  await writeFile(listFile, segments.map((s) => `file '${s.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
  const assFile = path.join(opts.workDir, "overlay.ass");
  // Captions only as a delivered file (not burned in) when the export asks for that.
  const burned = opts.burnCaptions === false ? { ...timeline, captions: { ...timeline.captions, mode: "OFF" as const } } : timeline;
  await writeFile(assFile, buildAss(burned), "utf8");
  // Relative paths (cwd = workDir) keep Windows drive colons out of filter arguments.
  const fontsRel = path.relative(opts.workDir, library.fontsDir).replace(/\\/g, "/");

  // Narration processing: rendered once into a cached file (the same audio the A/B preview plays).
  let voiceTimeline = timeline;
  const vp = timeline.audio.voiceProcessing;
  if (vp && vp.preset !== "off" && timeline.audio.voice) {
    if (/^https?:/i.test(timeline.audio.voice)) warnings.push("Voice processing skipped: the narration is not a local file.");
    else {
      await stage("PREPARING", 0, "Processing narration");
      const processed = await processVoice(timeline.audio.voice, vp, { cacheDir: path.join(cacheDir, "voice") });
      voiceTimeline = { ...timeline, audio: { ...timeline.audio, voice: processed.path } };
      opts.log?.(`voice processed (${vp.preset}): ${processed.hash}`);
    }
  }
  const audio = buildAudioGraph(voiceTimeline, 1, sourceAudio, { voicePreprocessed: voiceTimeline !== timeline });
  const hasText = burned.texts.length > 0 || burned.captions.mode !== "OFF" || Boolean(burned.graphics?.length);
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
      "-preset", opts.draft ? "ultrafast" : opts.quality === "high" ? "slow" : "medium",
      "-crf", opts.draft ? "26" : opts.quality === "high" ? "17" : "20",
      // Cap the bitrate (standard: YouTube's recommended 8 Mbps for 1080p30) so files stay a
      // sensible size; grain and constant motion otherwise balloon a CRF-only encode.
      "-maxrate", opts.draft ? "2500k" : opts.quality === "high" ? "16M" : "8M",
      "-bufsize", opts.draft ? "5M" : opts.quality === "high" ? "32M" : "16M",
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
  // Delivery loudness, then measure the finished file.
  let loudness: RenderResult["loudness"] = null;
  if (opts.loudnessTarget != null && info.hasAudio) {
    await stage("FINALIZING", 0.97, `Setting loudness to ${opts.loudnessTarget} LUFS`);
    loudness = await normalizeLoudness(opts.outPath, opts.loudnessTarget);
    log(`loudness: ${loudness.skipped ? "already on target" : `${loudness.gainDb > 0 ? "+" : ""}${loudness.gainDb} dB${loudness.limited ? " (peaks limited)" : ""}`}`);
  }
  await stage("FINALIZING", 0.99, "Checking the finished file");
  const qc = await qcReport(opts.outPath, opts.loudnessTarget ?? null);
  if (qc.black.some((b) => b.end - b.start >= 2)) warnings.push(`Black picture for ${qc.black.filter((b) => b.end - b.start >= 2).map((b) => `${b.start.toFixed(1)}–${b.end.toFixed(1)} s`).join(", ")}.`);
  await stage("COMPLETE", 1, "Render complete");
  return { outPath: opts.outPath, duration: info.duration ?? timeline.duration, warnings, segmentsRendered: rendered, segmentsCached: cached, usedAssets, qc, loudness };
}
