import { readFile } from "node:fs/promises";
import type { Transcript } from "@/lib/domain/types";

/**
 * Speech-to-text with word timestamps via OpenAI's transcription API (whisper-1).
 * Claude does not transcribe audio, so this is the optional STT provider; without it,
 * narration is aligned to a user-supplied script instead.
 * Input should be a compact mono audio file (the worker extracts one with FFmpeg; limit 25 MB).
 */
export async function transcribeWithWhisper(audioPath: string, apiKey: string, duration: number): Promise<Transcript> {
  const bytes = await readFile(audioPath);
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("Audio for transcription exceeds the 25 MB API limit");

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/mpeg" }), "narration.mp3");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (res.status === 401) throw new Error("Transcription API key was rejected (OPENAI_API_KEY).");
  if (res.status === 429) throw new Error("Transcription API rate limited; try again later.");
  if (!res.ok) throw new Error(`Transcription failed: HTTP ${res.status}`);

  const data = (await res.json()) as { text: string; words?: { word: string; start: number; end: number }[] };
  const words = (data.words ?? []).map((w) => ({ word: w.word.trim(), start: w.start, end: w.end })).filter((w) => w.word);
  if (!words.length) throw new Error("Transcription returned no word timings");

  // Whisper words lack punctuation; restore sentence ends from the full text so scenes split sensibly.
  const punctuated = data.text.split(/\s+/).filter(Boolean);
  if (Math.abs(punctuated.length - words.length) <= Math.max(3, words.length * 0.05)) {
    for (let i = 0; i < Math.min(words.length, punctuated.length); i++) {
      const p = punctuated[i]!;
      if (p.replace(/[^\p{L}\p{N}']/gu, "").toLowerCase() === words[i]!.word.replace(/[^\p{L}\p{N}']/gu, "").toLowerCase()) {
        words[i]!.word = p;
      }
    }
  }
  return { text: data.text, words, duration, source: "whisper" };
}
