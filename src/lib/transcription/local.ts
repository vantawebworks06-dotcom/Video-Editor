import { spawn } from "node:child_process";
import path from "node:path";
import type { Transcript, Word } from "@/lib/domain/types";
import { ffmpegPath, spawnTracked } from "@/lib/render/ffmpeg";

/**
 * Free, local speech-to-text: OpenAI's Whisper model running on this machine through
 * transformers.js (ONNX Runtime). No API key; the model (~150 MB) downloads once to
 * .cache/models. Produces word-level timestamps.
 */
export const LOCAL_WHISPER_MODEL = process.env.WHISPER_MODEL || "Xenova/whisper-base.en";

/** Decode any audio/video file to 16 kHz mono float32 PCM with FFmpeg. */
function decodePcm16k(file: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawnTracked(() => spawn(ffmpegPath(), ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"], { windowsHide: true }));
    const chunks: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Audio decode failed: ${err.slice(0, 300)}`));
      const buf = Buffer.concat(chunks);
      const aligned = new Uint8Array(buf.byteLength);
      aligned.set(buf);
      resolve(new Float32Array(aligned.buffer, 0, Math.floor(buf.byteLength / 4)));
    });
  });
}

type AsrOutput = { text: string; chunks?: { text: string; timestamp: [number, number | null] }[] };
type AsrPipeline = (audio: Float32Array, opts: Record<string, unknown>) => Promise<AsrOutput>;
let cached: Promise<AsrPipeline> | null = null;

async function getPipeline(): Promise<AsrPipeline> {
  if (!cached) {
    cached = (async () => {
      const tf = await import("@huggingface/transformers");
      tf.env.cacheDir = path.join(process.cwd(), ".cache", "models");
      tf.env.allowLocalModels = false;
      return (await tf.pipeline("automatic-speech-recognition", LOCAL_WHISPER_MODEL, { dtype: "q8" })) as unknown as AsrPipeline;
    })();
    cached.catch(() => (cached = null));
  }
  return cached;
}

/** Transcribe narration locally with word timestamps. */
export async function transcribeLocally(
  file: string,
  duration: number,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<Transcript> {
  const pcm = await decodePcm16k(file);
  if (pcm.length < 16000) throw new Error("Narration audio is too short to transcribe.");
  const asr = await getPipeline();

  // Transcribe in 30 s windows so progress can be reported and memory stays bounded.
  const WINDOW = 30 * 16000;
  const words: Word[] = [];
  const texts: string[] = [];
  for (let offset = 0; offset < pcm.length; offset += WINDOW) {
    signal?.throwIfAborted();
    const slice = pcm.subarray(offset, Math.min(pcm.length, offset + WINDOW));
    if (slice.length < 8000) break; // <0.5 s tail
    const base = offset / 16000;
    const out = await asr(slice, { return_timestamps: "word", chunk_length_s: 30 });
    texts.push(out.text.trim());
    for (const c of out.chunks ?? []) {
      const w = c.text.trim();
      if (!w) continue;
      const start = base + (c.timestamp[0] ?? 0);
      const end = base + (c.timestamp[1] ?? c.timestamp[0] ?? 0);
      words.push({ word: w, start: round(start), end: round(Math.max(start + 0.05, end)) });
    }
    onProgress?.(Math.min(1, (offset + WINDOW) / pcm.length));
  }
  if (!words.length) throw new Error("No speech was detected in the narration.");
  // Whisper word chunks can overlap slightly at window edges; keep them monotonic.
  for (let i = 1; i < words.length; i++) {
    if (words[i]!.start < words[i - 1]!.end) words[i]!.start = words[i - 1]!.end;
    if (words[i]!.end < words[i]!.start) words[i]!.end = words[i]!.start + 0.05;
  }
  return { text: texts.join(" "), words, duration, source: "whisper" };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
