/**
 * Measure a narration file: loudness (EBU R128), noise floor and speech level (50 ms RMS windows),
 * sibilance and rumble (band energy relative to the speech band). Results are cached next to the
 * file's other derived data, keyed by path + size + mtime.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { stableHash } from "@/lib/media/cache";
import { ffmpegPath, runFfmpeg, spawnTracked } from "@/lib/render/ffmpeg";
import { type LoudnormMeasured, recommendVoice, resolveVoice, voiceChain, VoiceMeasurement, type VoiceProcessing } from "@/lib/domain/voice";

/** Run FFmpeg for its analysis output (stderr at info level). */
function analyse(input: string, filter: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-nostdin", "-nostats", "-i", input, "-vn", "-map", "0:a:0", "-af", filter, "-f", "null", "-"];
    const child = spawnTracked(() => spawn(ffmpegPath(), args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }));
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Measuring the narration timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    // Keep only what we parse: RMS lines can be many for long files.
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      if (err.length > 4_000_000) err = err.slice(-2_000_000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(err);
      else reject(new Error(`FFmpeg analysis failed: ${err.slice(-400)}`));
    });
  });
}

const meanVolume = (out: string) => {
  const m = out.match(/mean_volume: (-?[\d.]+|-inf) dB/);
  return !m || m[1] === "-inf" ? -120 : Number(m[1]);
};

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return -120;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]!;
}

export async function measureVoice(file: string, opts: { cacheDir?: string; timeoutMs?: number } = {}): Promise<VoiceMeasurement> {
  const st = await stat(file);
  const key = stableHash({ file: path.resolve(file), size: st.size, mtime: st.mtimeMs, v: 2 });
  const cacheFile = opts.cacheDir ? path.join(opts.cacheDir, `voice-measure-${key}.json`) : null;
  if (cacheFile && existsSync(cacheFile)) {
    const hit = VoiceMeasurement.safeParse(JSON.parse(await readFile(cacheFile, "utf8")));
    if (hit.success) return hit.data;
  }
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const mono = "aresample=48000,aformat=channel_layouts=mono";
  const [loud, windows, speechBand, sibBand, lowBand] = await Promise.all([
    analyse(file, `${mono},loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json`, timeoutMs),
    // 50 ms windows (2400 samples at 48 kHz): one RMS value per window.
    analyse(file, `${mono},asetnsamples=n=2400:p=0,astats=metadata=1:reset=1:measure_overall=RMS_level:measure_perchannel=none,ametadata=print:key=lavfi.astats.Overall.RMS_level`, timeoutMs),
    analyse(file, `${mono},highpass=f=300:poles=2,lowpass=f=4000:poles=2,volumedetect`, timeoutMs),
    analyse(file, `${mono},highpass=f=5000:poles=2,highpass=f=5000:poles=2,lowpass=f=9000:poles=2,volumedetect`, timeoutMs),
    analyse(file, `${mono},lowpass=f=80:poles=2,lowpass=f=80:poles=2,volumedetect`, timeoutMs),
  ]);

  const json = loud.slice(loud.lastIndexOf("{"), loud.lastIndexOf("}") + 1);
  const ln = JSON.parse(json) as { input_i: string; input_tp: string; input_lra: string };
  const rms = [...windows.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => (m[1] === "-inf" ? -120 : Number(m[1]))).filter((v) => Number.isFinite(v));
  // Digital silence counts as a perfectly clean floor (clamped at −100 dBFS).
  const sorted = rms.map((v) => Math.max(-100, v)).sort((a, b) => a - b);
  const noiseFloor = percentile(sorted, 0.1);
  const speechLevel = percentile(sorted, 0.9);
  const speech = meanVolume(speechBand);
  // Noise-only stretch: the longest run (≥ 0.4 s) of windows within 4 dB of the floor, trimmed
  // 0.1 s at each end so no speech edge is learned as noise. Digital silence teaches nothing.
  let best: { start: number; end: number } | null = null;
  if (noiseFloor > -95) {
    let from = -1;
    rms.forEach((v, i) => {
      const quiet = v <= noiseFloor + 4 && v > -100;
      if (quiet && from < 0) from = i;
      if ((!quiet || i === rms.length - 1) && from >= 0) {
        const to = quiet ? i + 1 : i;
        if ((to - from) * 0.05 >= 0.4 && (!best || to - from > (best.end - best.start) / 0.05)) best = { start: from * 0.05, end: to * 0.05 };
        from = -1;
      }
    });
  }
  const noiseSample = best ? { start: Math.round(((best as { start: number }).start + 0.1) * 100) / 100, end: Math.round(((best as { end: number }).end - 0.1) * 100) / 100 } : null;
  const num = (s: string, d: number) => (Number.isFinite(Number(s)) ? Number(s) : d);
  const m: VoiceMeasurement = {
    noiseFloor: Math.round(noiseFloor * 10) / 10,
    speechLevel: Math.round(speechLevel * 10) / 10,
    snr: Math.round((speechLevel - noiseFloor) * 10) / 10,
    loudness: num(ln.input_i, -70),
    truePeak: num(ln.input_tp, -70),
    lra: num(ln.input_lra, 0),
    sibilance: Math.round((meanVolume(sibBand) - speech) * 10) / 10,
    rumble: Math.round((meanVolume(lowBand) - speech) * 10) / 10,
    duration: Math.round(rms.length * 0.05 * 100) / 100,
    noiseSample,
  };
  if (cacheFile) {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(m));
  }
  return m;
}

export interface ProcessedVoice {
  /** 48 kHz mono PCM, processed and at the target loudness. */
  path: string;
  measurement: VoiceMeasurement;
  values: ReturnType<typeof resolveVoice>;
  notes: string[];
  /** Identifies the source file + resolved settings (same hash = same audio). */
  hash: string;
}

const MONO = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono";

/**
 * The narration with voice processing applied, cached by source file + resolved settings.
 * Two passes: the processed signal's loudness is measured, then one exact gain brings it to target.
 */
export async function processVoice(file: string, v: VoiceProcessing, opts: { cacheDir: string; timeoutMs?: number; onProgress?: (p: number) => void }): Promise<ProcessedVoice> {
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const measurement = await measureVoice(file, { cacheDir: opts.cacheDir, timeoutMs });
  const values = resolveVoice(v, measurement);
  const notes = v.preset === "auto" ? recommendVoice(measurement).notes : [];
  const st = await stat(file);
  const hash = stableHash({ file: path.resolve(file), size: st.size, mtime: st.mtimeMs, values, v: 1 }).slice(0, 16);
  const out = path.join(opts.cacheDir, `voice-${hash}.wav`);
  if (!existsSync(out)) {
    await mkdir(opts.cacheDir, { recursive: true });
    opts.onProgress?.(0.1);
    const measureLoudness = async (chain: string) => {
      const outText = await analyse(file, `${MONO},${chain},loudnorm=I=${values.loudness}:TP=-1.5:LRA=11:print_format=json`, timeoutMs);
      return JSON.parse(outText.slice(outText.lastIndexOf("{"), outText.lastIndexOf("}") + 1)) as LoudnormMeasured;
    };
    let pre = voiceChain(values, measurement, { loudnorm: "none" });
    let ln = await measureLoudness(pre);
    // One linear gain can only reach the target if the peaks leave room under the −1.5 dBTP ceiling;
    // otherwise limit the peaks just enough first (loud targets such as −14 LUFS).
    const room = -2 - values.loudness;
    if (Number(ln.input_tp) - Number(ln.input_i) > room) {
      const ceiling = Math.pow(10, (Number(ln.input_i) + room) / 20);
      pre = `${pre},alimiter=limit=${ceiling.toFixed(5)}:attack=3:release=60:level=disabled`;
      ln = await measureLoudness(pre);
    }
    opts.onProgress?.(0.5);
    const chain = `${pre},${voiceChain(values, measurement, { loudnorm: ln }).split(",").filter((x) => x.startsWith("loudnorm")).join(",")}`;
    await runFfmpeg(["-i", file, "-vn", "-map", "0:a:0", "-af", `${MONO},${chain},aresample=48000`, "-c:a", "pcm_s16le", `${out}.tmp.wav`], { timeoutMs, durationSeconds: measurement.duration, onProgress: (p) => opts.onProgress?.(0.5 + p * 0.5) });
    await rename(`${out}.tmp.wav`, out);
  }
  return { path: out, measurement, values, notes, hash };
}
