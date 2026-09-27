/**
 * Export quality control: measure the finished file (EBU R128 loudness and true peak, black
 * stretches, silent stretches, format) and bring the mix to the delivery loudness target.
 */
import { spawn } from "node:child_process";
import { rename, stat } from "node:fs/promises";
import { ffmpegPath, probe, runFfmpeg, spawnTracked } from "./ffmpeg";

export interface QcReport {
  width: number | null;
  height: number | null;
  fps: number | null;
  duration: number | null;
  sizeBytes: number;
  /** Average total bitrate, kbit/s. */
  bitrateKbps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  /** Integrated loudness (LUFS), loudness range (LU), true peak (dBTP) of the final mix. */
  loudness: number | null;
  lra: number | null;
  truePeak: number | null;
  loudnessTarget: number | null;
  /** Stretches of (near-)black picture ≥ 1 s. */
  black: { start: number; end: number }[];
  /** Stretches of silence (< −50 dBFS) ≥ 2 s. */
  silence: { start: number; end: number }[];
}

function analyse(file: string, filterComplex: string, maps: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-nostdin", "-nostats", "-i", file, "-filter_complex", filterComplex, ...maps.flatMap((m) => ["-map", m]), "-f", "null", "-"];
    const child = spawnTracked(() => spawn(ffmpegPath(), args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }));
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Quality check timed out"));
    }, timeoutMs);
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      if (err.length > 3_000_000) err = err.slice(-1_000_000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(err);
      else reject(new Error(`Quality check failed: ${err.slice(-300)}`));
    });
  });
}

const num = (s: string | undefined) => (s === undefined || !Number.isFinite(Number(s)) ? null : Number(s));

/** Loudness (EBU R128 summary) of a file's audio: integrated, range, true peak. */
export async function measureLoudness(file: string, timeoutMs = 20 * 60_000): Promise<{ loudness: number | null; lra: number | null; truePeak: number | null }> {
  const out = await analyse(file, "[0:a]ebur128=peak=true", [], timeoutMs);
  const summary = out.slice(out.lastIndexOf("Summary:"));
  return { loudness: num(summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]), lra: num(summary.match(/LRA:\s+(-?[\d.]+) LU/)?.[1]), truePeak: num(summary.match(/Peak:\s+(-?[\d.]+) dBFS/)?.[1]) };
}

export async function qcReport(file: string, loudnessTarget: number | null, timeoutMs = 30 * 60_000): Promise<QcReport> {
  const info = await probe(file);
  const size = (await stat(file)).size;
  const parts: string[] = [];
  const maps: string[] = [];
  if (info.hasVideo) {
    parts.push("[0:v]blackdetect=d=1:pix_th=0.10[bv]");
    maps.push("[bv]");
  }
  if (info.hasAudio) {
    parts.push("[0:a]ebur128=peak=true,silencedetect=n=-50dB:d=2[ba]");
    maps.push("[ba]");
  }
  const out = parts.length ? await analyse(file, parts.join(";"), maps, timeoutMs) : "";
  const summary = out.slice(out.lastIndexOf("Summary:"));
  const black = [...out.matchAll(/black_start:(-?[\d.]+) black_end:(-?[\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
  const starts = [...out.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...out.matchAll(/silence_end: (-?[\d.]+)/g)].map((m) => Number(m[1]));
  const silence = starts.map((s, i) => ({ start: Math.max(0, s), end: ends[i] ?? info.duration ?? s }));
  return {
    width: info.width,
    height: info.height,
    fps: info.frameRate ? Math.round(info.frameRate * 100) / 100 : null,
    duration: info.duration,
    sizeBytes: size,
    bitrateKbps: info.duration ? Math.round((size * 8) / info.duration / 1000) : null,
    videoCodec: info.videoCodec,
    audioCodec: info.audioCodec,
    loudness: num(summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]),
    lra: num(summary.match(/LRA:\s+(-?[\d.]+) LU/)?.[1]),
    truePeak: num(summary.match(/Peak:\s+(-?[\d.]+) dBFS/)?.[1]),
    loudnessTarget,
    black,
    silence,
  };
}

/**
 * Bring the final mix to `target` LUFS with one exact gain (video stream copied, audio re-encoded).
 * If the gain would push true peaks above −1 dBTP, a limiter holds them there. Returns the gain.
 */
export async function normalizeLoudness(file: string, target: number, opts: { timeoutMs?: number } = {}): Promise<{ gainDb: number; limited: boolean; skipped: boolean }> {
  const m = await measureLoudness(file, opts.timeoutMs);
  if (m.loudness === null || m.loudness < -60) return { gainDb: 0, limited: false, skipped: true };
  const gain = target - m.loudness;
  const limited = (m.truePeak ?? -99) + gain > -1.2;
  if (Math.abs(gain) < 0.3 && !limited) return { gainDb: 0, limited: false, skipped: true };
  const tmp = `${file}.norm.mp4`;
  const af = `volume=${gain.toFixed(2)}dB${limited ? `,alimiter=limit=${Math.pow(10, -1.5 / 20).toFixed(4)}:attack=2:release=50:level=disabled` : ""}`;
  await runFfmpeg(["-i", file, "-map", "0:v", "-map", "0:a", "-c:v", "copy", "-af", af, "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", tmp], { timeoutMs: opts.timeoutMs ?? 20 * 60_000 });
  await rename(tmp, file);
  return { gainDb: Math.round(gain * 10) / 10, limited, skipped: false };
}
