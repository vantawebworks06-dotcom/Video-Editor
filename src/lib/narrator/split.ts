/**
 * Script → paragraphs → sentences, with stable ids: an unchanged sentence keeps its id (and so its
 * generated audio, take and overrides) when the script around it is edited.
 */
import type { NarratorSentence } from "./types";

// Abbreviations whose full stop does not end a sentence.
const ABBREV = /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|Ft|Gen|Col|Lt|Sgt|Capt|Gov|Sen|Rep|Rev|Hon|No|Vol|Fig|vs|etc|approx|dept|est|inc|ltd|co|corp|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|U\.S|U\.K|e\.g|i\.e|a\.m|p\.m)\.$/i;

/** Sentences of one paragraph (keeps closing quotes/brackets with their sentence). */
export function splitSentences(paragraph: string): string[] {
  const text = paragraph.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const out: string[] = [];
  let start = 0;
  // A terminator run (. ! ? …), optional closing quotes/brackets, then whitespace + a sentence start.
  const re = /([.!?…]+)(["'”’)\]]*)\s+(?=["'“‘(\[]?[A-Z0-9])/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[1]!.length + m[2]!.length;
    const candidate = text.slice(start, end);
    // "Dr. Smith", "U.S. Army", single initials ("J. Smith") and decimals don't end a sentence.
    if (m[1] === "." && (ABBREV.test(candidate) || /(?:^|\s)[A-Z]\.$/.test(candidate))) continue;
    out.push(candidate.trim());
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  // Very long sentences are hard to deliver in one breath: split at a semicolon or dash if possible.
  return out.flatMap((s) => (s.length > 320 ? s.split(/(?<=;)\s+|\s+—\s+(?=[a-z])/).filter(Boolean) : [s]));
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Split a script and carry over what the previous sentences had (audio, take, override) when the
 * text is unchanged. Ids are `hash(text)` plus an occurrence counter, so repeated lines stay distinct.
 */
export function splitScript(script: string, previous: NarratorSentence[] = []): NarratorSentence[] {
  const prev = new Map(previous.map((s) => [s.id, s]));
  const seen = new Map<string, number>();
  const paragraphs = script.replace(/\r\n?/g, "\n").split(/\n\s*\n+/);
  const out: NarratorSentence[] = [];
  let p = 0;
  for (const para of paragraphs) {
    const sentences = splitSentences(para);
    if (!sentences.length) continue;
    for (const text of sentences) {
      const base = hash(text);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const id = n ? `${base}-${n}` : base;
      const old = prev.get(id);
      out.push({ id, text, paragraph: p, take: old?.take ?? 0, override: old?.override ?? null, audio: old?.audio ?? null });
    }
    p++;
  }
  return out;
}
