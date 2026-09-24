import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function ffmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const p = require("ffmpeg-static") as string | null;
  if (!p) throw new Error("FFmpeg binary not found. Install ffmpeg-static or set FFMPEG_PATH.");
  return p;
}

export function ffprobePath(): string {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  return (require("ffprobe-static") as { path: string }).path;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    public readonly stderrTail: string,
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

export interface RunOptions {
  cwd?: string;
  /** Total expected output duration, for progress reporting. */
  durationSeconds?: number;
  onProgress?: (fraction: number) => void;
  timeoutMs?: number;
}

/**
 * Run FFmpeg with an argument array (never a shell string), so no user-provided value can
 * inject commands. Callers only build arguments from validated timeline structures.
 */
export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const full = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-progress", "pipe:1", ...args];
    const child = spawn(ffmpegPath(), full, { cwd: opts.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdoutBuf = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new FfmpegError(`FFmpeg timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s`, stderr.slice(-2000)));
    }, opts.timeoutMs ?? 30 * 60_000);

    child.stdout.on("data", (d: Buffer) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m && opts.durationSeconds && opts.onProgress) {
          opts.onProgress(Math.min(1, Number(m[1]) / 1e6 / opts.durationSeconds));
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-20000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new FfmpegError(`Failed to start FFmpeg: ${err.message}`, ""));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new FfmpegError(`FFmpeg exited with code ${code}: ${stderr.trim().split(/\r?\n/).slice(-3).join(" | ")}`, stderr.slice(-4000)));
    });
  });
}

export interface ProbeResult {
  duration: number | null;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  formatName: string | null;
  frameRate: number | null;
}

export function probe(input: string, timeoutMs = 60_000): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffprobePath(),
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input],
      { windowsHide: true },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new FfmpegError(`ffprobe failed: ${err.trim().slice(0, 300)}`, err));
      try {
        const j = JSON.parse(out) as {
          format?: { duration?: string; format_name?: string };
          streams?: { codec_type: string; codec_name?: string; width?: number; height?: number; duration?: string; r_frame_rate?: string }[];
        };
        const v = j.streams?.find((s) => s.codec_type === "video");
        const a = j.streams?.find((s) => s.codec_type === "audio");
        const dur = Number(j.format?.duration ?? v?.duration ?? a?.duration);
        const [num, den] = (v?.r_frame_rate ?? "").split("/").map(Number);
        resolve({
          duration: Number.isFinite(dur) ? dur : null,
          width: v?.width ?? null,
          height: v?.height ?? null,
          hasVideo: Boolean(v),
          hasAudio: Boolean(a),
          videoCodec: v?.codec_name ?? null,
          audioCodec: a?.codec_name ?? null,
          formatName: j.format?.format_name ?? null,
          frameRate: num && den ? num / den : null,
        });
      } catch {
        reject(new FfmpegError("ffprobe returned invalid JSON", err));
      }
    });
  });
}

/** Detect pauses in narration (used to anchor script alignment). */
export async function detectSilences(input: string, minSilence = 0.3, noiseDb = -35): Promise<{ start: number; end: number }[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath(),
      ["-hide_banner", "-nostdin", "-i", input, "-af", `silencedetect=noise=${noiseDb}dB:d=${minSilence}`, "-f", "null", "-"],
      { windowsHide: true },
    );
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", () => {
      const out: { start: number; end: number }[] = [];
      let start: number | null = null;
      for (const line of err.split(/\r?\n/)) {
        const s = line.match(/silence_start: (-?[\d.]+)/);
        const e = line.match(/silence_end: ([\d.]+)/);
        if (s) start = Math.max(0, Number(s[1]));
        if (e && start !== null) {
          out.push({ start, end: Number(e[1]) });
          start = null;
        }
      }
      resolve(out);
    });
  });
}

/** Hosts media may be downloaded from (provider CDNs). Anything else is refused. */
const ALLOWED_HOST_SUFFIXES = [
  "pexels.com",
  "pixabay.com",
  "wikimedia.org",
  "archive.org",
  "giphy.com",
  "supabase.co",
];

export function isAllowedMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    return ALLOWED_HOST_SUFFIXES.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Protocol whitelist for network inputs so FFmpeg can't be pointed at local/special protocols. */
export const NETWORK_INPUT_ARGS = ["-protocol_whitelist", "https,tls,tcp,http,crypto"];
