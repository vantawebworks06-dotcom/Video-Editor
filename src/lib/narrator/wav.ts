/** Minimal mono WAV I/O (PCM 16-bit and float 32-bit) for the narrator's sentence assembly. */
import { readFile, writeFile } from "node:fs/promises";

export async function writeWav(file: string, samples: Float32Array, sampleRate: number): Promise<void> {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  await writeFile(file, Buffer.concat([h, data]));
}

/** Read a mono (or first channel of a) PCM16 / float32 WAV. */
export async function readWav(file: string): Promise<{ samples: Float32Array; sampleRate: number }> {
  const b = await readFile(file);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file} is not a WAV file`);
  let pos = 12;
  let fmt = 1;
  let channels = 1;
  let rate = 48000;
  let bits = 16;
  while (pos + 8 <= b.length) {
    const id = b.toString("ascii", pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      fmt = b.readUInt16LE(body);
      channels = b.readUInt16LE(body + 2);
      rate = b.readUInt32LE(body + 4);
      bits = b.readUInt16LE(body + 14);
      if (fmt === 0xfffe) fmt = b.readUInt16LE(body + 24);
    } else if (id === "data") {
      const bytes = bits / 8;
      const end = Math.min(b.length, body + size);
      const n = Math.floor((end - body) / (bytes * channels));
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const at = body + i * bytes * channels;
        out[i] = fmt === 3 ? b.readFloatLE(at) : b.readInt16LE(at) / 32768;
      }
      return { samples: out, sampleRate: rate };
    }
    pos = body + size + (size % 2);
  }
  throw new Error(`${file} has no audio data`);
}

/** Trim leading/trailing near-silence (10 ms windows below `thresholdDb`), keeping `padMs` of air. */
export function trimSilence(samples: Float32Array, sampleRate: number, thresholdDb = -45, padMs = 40): Float32Array {
  const win = Math.max(1, Math.round(sampleRate * 0.01));
  const thr = Math.pow(10, thresholdDb / 20);
  const loud = (start: number) => {
    let s = 0;
    const end = Math.min(samples.length, start + win);
    for (let i = start; i < end; i++) s += samples[i]! * samples[i]!;
    return Math.sqrt(s / Math.max(1, end - start)) > thr;
  };
  let a = 0;
  while (a < samples.length && !loud(a)) a += win;
  let z = samples.length - win;
  while (z > a && !loud(z)) z -= win;
  if (a >= samples.length) return samples.slice(0, 0);
  const pad = Math.round((sampleRate * padMs) / 1000);
  return samples.slice(Math.max(0, a - pad), Math.min(samples.length, z + win + pad));
}
