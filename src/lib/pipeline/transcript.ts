import type { Transcript, Word } from "@/lib/domain/types";

export interface Pause {
  start: number;
  end: number;
}

export interface Sentence {
  id: string;
  text: string;
  start: number;
  end: number;
  wordStart: number;
  wordEnd: number; // exclusive
}

export function tokenizeScript(script: string): string[] {
  return script
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * Estimate word timings for a known script over narration audio when no speech-to-text
 * is configured. Words are spread across speech time only (silences detected by FFmpeg
 * are skipped), weighted by length with extra time before punctuation.
 */
export function alignScriptToAudio(script: string, duration: number, pauses: Pause[] = []): Transcript {
  const tokens = tokenizeScript(script);
  if (!tokens.length) return { text: "", words: [], duration, source: "script_alignment" };

  const silences = pauses
    .filter((p) => p.end > p.start && p.start < duration)
    .map((p) => ({ start: Math.max(0, p.start), end: Math.min(duration, p.end) }))
    .sort((a, b) => a.start - b.start);
  // Speech intervals = [0, duration] minus silences.
  const speech: Pause[] = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor) speech.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < duration) speech.push({ start: cursor, end: duration });
  const speechTotal = speech.reduce((a, s) => a + (s.end - s.start), 0) || duration;

  const weights = tokens.map((t) => t.replace(/[^\p{L}\p{N}]/gu, "").length + 2 + (/[.!?]$/.test(t) ? 3 : /[,;:]$/.test(t) ? 1.5 : 0));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const toTime = (speechOffset: number) => {
    let remaining = speechOffset;
    for (const s of speech) {
      const len = s.end - s.start;
      if (remaining <= len) return s.start + remaining;
      remaining -= len;
    }
    return duration;
  };

  let acc = 0;
  const words: Word[] = tokens.map((word, i) => {
    const start = toTime((acc / totalWeight) * speechTotal);
    acc += weights[i]!;
    const end = toTime((acc / totalWeight) * speechTotal);
    return { word, start: round(start), end: round(Math.max(start + 0.05, end)) };
  });
  return { text: tokens.join(" "), words, duration, source: "script_alignment" };
}

/** Group words into sentences; very long sentences are split at commas or every ~25 words. */
export function sentencesFromWords(words: Word[], maxSeconds = 12): Sentence[] {
  const out: Sentence[] = [];
  let startIdx = 0;
  const flush = (endIdx: number) => {
    if (endIdx <= startIdx) return;
    const slice = words.slice(startIdx, endIdx);
    out.push({
      id: `s${out.length}`,
      text: slice.map((w) => w.word).join(" "),
      start: slice[0]!.start,
      end: slice.at(-1)!.end,
      wordStart: startIdx,
      wordEnd: endIdx,
    });
    startIdx = endIdx;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const len = w.end - words[startIdx]!.start;
    const count = i - startIdx + 1;
    if (/[.!?]["')\]]?$/.test(w.word)) flush(i + 1);
    else if ((len > maxSeconds || count > 25) && /[,;:—-]$/.test(w.word)) flush(i + 1);
    else if (len > maxSeconds * 1.5 || count > 40) flush(i + 1);
  }
  flush(words.length);
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
