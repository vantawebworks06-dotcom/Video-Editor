/**
 * Find the part of a long video that matches a narration sentence.
 *  - Chapters: the uploader's own timestamps in the description ("06:42 Talks about the feud").
 *  - Transcript: word timings of an authorised copy the user imported (worker transcribes it).
 * Results are always suggestions with a confidence; the editor can set in/out points by hand.
 */
import type { SegmentSuggestion } from "@/lib/domain/media";
import type { Word } from "@/lib/domain/types";

const STOP = new Set("the a an and or of to in on at by for with from as is are was were be been this that his her their he she they it its about into after before over than then what which who when where why how not no part full video official clip".split(" "));
const toks = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));

export function parseTimestamp(t: string): number | null {
  const parts = t.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** YouTube-style chapter lines: a timestamp at the start (or end) of a line, first one at 0:00. */
export function parseChapters(description: string | null | undefined): { start: number; title: string }[] {
  if (!description) return [];
  const out: { start: number; title: string }[] = [];
  for (const line of description.split(/\r?\n/)) {
    // "06:42 Title", "[06:42] - Title", or "Title - 06:42".
    const lead = line.match(/^\s*[[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*[-–—:|.)]*\s*(.+?)\s*$/);
    const trail = lead ? null : line.match(/^\s*(.+?)\s*[-–—|:(]\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\)?\s*$/);
    if (!lead && !trail) continue;
    const stamp = lead ? lead[1]! : trail![2]!;
    const title = lead ? lead[2]! : trail![1]!;
    const s = parseTimestamp(stamp);
    if (s === null || !title || title.length > 140) continue;
    out.push({ start: s, title: title.trim() });
  }
  out.sort((x, y) => x.start - y.start);
  // Real chapter lists start at 0:00 and have at least three entries; stray timestamps don't count.
  return out.length >= 3 && out[0]!.start === 0 ? out : [];
}

/** Best chapter for the query/entities, as a labelled suggestion. */
export function segmentFromChapters(chapters: { start: number; title: string }[], duration: number | null, want: { query: string; entities: string[]; sentence: string }): SegmentSuggestion | null {
  if (!chapters.length) return null;
  const q = new Set([...toks(want.query), ...toks(want.sentence)]);
  const ents = want.entities.flatMap((e) => toks(e));
  let best: { i: number; score: number; hits: string[] } | null = null;
  chapters.forEach((ch, i) => {
    const t = toks(ch.title);
    const hits = t.filter((w) => q.has(w) || ents.includes(w));
    const score = hits.length + hits.filter((h) => ents.includes(h)).length * 0.5;
    if (score > 0 && (!best || score > best.score)) best = { i, score, hits };
  });
  if (!best) return null;
  const b = best as { i: number; score: number; hits: string[] };
  const ch = chapters[b.i]!;
  const end = chapters[b.i + 1]?.start ?? duration ?? ch.start + 60;
  return {
    start: ch.start,
    end: Math.max(ch.start + 1, end),
    basis: "chapters",
    confidence: Math.min(0.75, 0.3 + b.score * 0.12),
    label: ch.title,
    reason: `The uploader's chapter “${ch.title}” matches ${b.hits.slice(0, 4).map((h) => `“${h}”`).join(", ")}. Check it before using — chapter titles can be loose.`,
  };
}

/**
 * Locate a sentence in a transcribed video: slide a window over its words and score overlap with
 * the query + sentence + entities. Returns a clip around the best window (±padding).
 */
export function segmentFromTranscript(words: Word[], want: { query: string; entities: string[]; sentence: string }, opts: { windowSeconds?: number; pad?: number } = {}): SegmentSuggestion | null {
  if (words.length < 5) return null;
  const windowS = opts.windowSeconds ?? 25;
  const pad = opts.pad ?? 2;
  const target = new Set([...toks(want.query), ...toks(want.sentence)]);
  const ents = new Set(want.entities.flatMap((e) => toks(e)));
  if (!target.size && !ents.size) return null;
  const norm = words.map((w) => toks(w.word)[0] ?? "");
  let best = { score: 0, from: 0, to: 0, hits: new Set<string>() };
  let j = 0;
  for (let i = 0; i < words.length; i++) {
    while (j < words.length && words[j]!.end - words[i]!.start <= windowS) j++;
    const hits = new Set<string>();
    let score = 0;
    for (let k = i; k < j; k++) {
      const w = norm[k]!;
      if (!w) continue;
      if (ents.has(w)) {
        score += hits.has(w) ? 0.3 : 2;
        hits.add(w);
      } else if (target.has(w)) {
        score += hits.has(w) ? 0.2 : 1;
        hits.add(w);
      }
    }
    if (score > best.score) best = { score, from: i, to: j - 1, hits };
  }
  if (best.score < 2) return null;
  // Tighten to where the matches actually are inside the window.
  let first = best.to;
  let last = best.from;
  for (let k = best.from; k <= best.to; k++) {
    const w = norm[k]!;
    if (w && (ents.has(w) || target.has(w))) {
      first = Math.min(first, k);
      last = Math.max(last, k);
    }
  }
  best = { ...best, from: first, to: Math.max(first, last) };
  const start = Math.max(0, words[best.from]!.start - pad);
  const end = words[best.to]!.end + pad;
  const coverage = best.hits.size / Math.max(1, Math.min(8, target.size + ents.size));
  return {
    start: Math.round(start * 10) / 10,
    end: Math.round(end * 10) / 10,
    basis: "transcript",
    confidence: Math.min(0.9, 0.35 + coverage * 0.55),
    label: words.slice(best.from, Math.min(best.to + 1, best.from + 14)).map((w) => w.word).join(" "),
    reason: `The speech here mentions ${[...best.hits].slice(0, 5).map((h) => `“${h}”`).join(", ")}. Suggested from the transcript of your copy — preview it to confirm.`,
  };
}
