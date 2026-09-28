/** Narrator helpers shared by the routes, the worker and the UI. */
import type { Transcript } from "@/lib/domain/types";
import { Narrator, type SentencePlan } from "./types";

/** Apply the pronunciation dictionary (whole words, case-insensitive). */
export function applyPronunciations(text: string, dict: Record<string, string>): string {
  let out = text;
  for (const [word, say] of Object.entries(dict)) {
    if (!word.trim() || !say.trim()) continue;
    const esc = word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "giu"), say.trim());
  }
  return out;
}

/** What a sentence's audio was made from (voice, spoken text, delivery). Different key = audio out of date. */
export function sentenceKey(voice: string, text: string, plan: Pick<SentencePlan, "speed" | "pitch" | "gainDb" | "tilt" | "emphasis" | "beat">): string {
  return JSON.stringify([voice, text, plan.speed, plan.pitch, plan.gainDb, plan.tilt, plan.emphasis, plan.beat]);
}

/** The stored narrator, or an empty one if missing/invalid. */
export function parseNarrator(raw: unknown): Narrator {
  const r = Narrator.safeParse(raw ?? {});
  return r.success ? r.data : Narrator.parse({});
}

/**
 * What the generated narration depends on. Stored with the output; when the current value differs,
 * the output is out of date (script, delivery, voice or processing changed since).
 */
export function outputBasis(n: Pick<Narrator, "sentences" | "style" | "controls" | "processing" | "voice" | "profileId">, profileVersion: string | null): string {
  return JSON.stringify({
    s: n.sentences.map((s) => [s.id, s.take, s.override]),
    st: n.style,
    c: n.controls,
    p: n.processing,
    v: n.voice,
    pr: n.profileId,
    pv: profileVersion,
  });
}

/** The script as plain text (paragraphs separated by blank lines). */
export function narratorText(n: Pick<Narrator, "sentences">): string {
  const paras: string[][] = [];
  for (const s of n.sentences) (paras[s.paragraph] ??= []).push(s.text);
  return paras.filter(Boolean).map((p) => p.join(" ")).join("\n\n");
}

/**
 * A transcript from the generated sentence timings: exact sentence boundaries, words spread over
 * each sentence by length (the engine does not report word times). Far closer than aligning the
 * script to the audio blindly.
 */
export function transcriptFromTimings(n: Pick<Narrator, "sentences">, timings: { id: string; start: number; end: number }[], duration: number): Transcript {
  const byId = new Map(n.sentences.map((s) => [s.id, s]));
  const words: Transcript["words"] = [];
  for (const t of timings) {
    const s = byId.get(t.id);
    if (!s) continue;
    const ws = s.text.split(/\s+/).filter(Boolean);
    const weights = ws.map((w) => Math.max(2, w.replace(/[^\p{L}\p{N}]/gu, "").length + (/[,;:]$/.test(w) ? 3 : 0)));
    const total = weights.reduce((a, b) => a + b, 0);
    let at = t.start;
    ws.forEach((w, i) => {
      const d = ((t.end - t.start) * weights[i]!) / total;
      words.push({ word: w, start: Math.round(at * 1000) / 1000, end: Math.round((at + d) * 1000) / 1000 });
      at += d;
    });
  }
  return { text: narratorText(n), words, duration, source: "narrator" };
}
