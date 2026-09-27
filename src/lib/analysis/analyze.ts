/**
 * Transcript analysis engine: narration/script → sentences (timed) → entities, dates, figures,
 * quotes, claims and references per sentence → a visual intent per sentence → scenes.
 *
 * The rule-based engine is the default (no AI key needed) and is always labelled "rules" in the
 * result. Entity linking uses Wikipedia (keyless); when it is unreachable the raw mentions are used
 * and the analysis carries a warning instead of pretending.
 */
import type { ScenePlan, Word } from "@/lib/domain/types";
import { type SearchCache, stableHash } from "@/lib/media/cache";
import { buildEntityIndex, type Entity, type EntityIndex, extractMentions } from "@/lib/pipeline/entities";
import { sentencesFromWords } from "@/lib/pipeline/transcript";
import { detectClaim, extractDates, extractQuotes, extractReferences, extractStatistics, extractWorks, PLATFORMS, topicWords } from "./extract";
import { buildIntent } from "./intent";
import type { GlobalEntity, Mention, MentionKind, SceneSummary, SentenceAnalysis, TranscriptAnalysis } from "./types";

export interface AnalyzeInput {
  /** Timed words of the narration transcript (preferred). */
  words?: Word[] | null;
  /** Script text, used when no transcript exists yet (times are then estimated). */
  script?: string | null;
  projectTitle: string;
  /** "What is this video about?" — global context. */
  topic: string;
  /** Scenes of the generated edit: when present, analysis scenes follow them (timeline linking). */
  plans?: Pick<ScenePlan, "sceneId" | "startTime" | "endTime">[];
}

export interface AnalyzeOptions {
  cache?: SearchCache;
  /** Skip Wikipedia entity linking (tests/offline). */
  offline?: boolean;
  currentYear?: number;
  log?: (m: string) => void;
  signal?: AbortSignal;
}

export function analysisSourceHash(input: Pick<AnalyzeInput, "words" | "script" | "topic">): string {
  const text = input.words?.length ? input.words.map((w) => `${w.word}@${w.start}`).join(" ") : (input.script ?? "");
  return stableHash({ v: 1, text, topic: input.topic });
}

const WORDS_PER_SECOND = 2.6;

/** Sentences with times: from the transcript, or estimated from the script at speaking pace. */
function timedSentences(input: AnalyzeInput): { text: string; start: number; end: number }[] {
  if (input.words?.length) return sentencesFromWords(input.words).map((s) => ({ text: s.text, start: s.start, end: s.end }));
  const script = (input.script ?? "").replace(/\s+/g, " ").trim();
  if (!script) return [];
  const parts = script.match(/[^.!?]+[.!?]+["”')\]]*|[^.!?]+$/g) ?? [script];
  let t = 0;
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((text) => {
      const d = Math.max(1, text.split(/\s+/).length / WORDS_PER_SECOND);
      const s = { text, start: round(t), end: round(t + d) };
      t += d + 0.3;
      return s;
    });
}

const mentionKind = (e: Entity): MentionKind => e.kind;
const describe = (e: Entity) => (e.description === "unresolved mention" ? null : e.description);

function offlineIndex(text: string): EntityIndex {
  const mentions = extractMentions(text);
  const entities: Entity[] = mentions.map((m) => ({ name: m.text, kind: "term", description: null, wikiTitle: null, aliases: [m.text.toLowerCase()], mentions: m.count }));
  return {
    entities,
    country: null,
    topic: [],
    cast: [],
    find(t: string) {
      const lower = ` ${t.toLowerCase()} `;
      return entities.filter((e) => e.aliases.some((a) => lower.includes(` ${a} `) || lower.includes(` ${a}'`) || lower.includes(` ${a},`) || lower.includes(` ${a}.`)));
    },
  };
}

const SCENE_CUE = /^(meanwhile|elsewhere|years later|months later|decades later|fast[- ]forward|but (?:then|in|by)|by (?:19|20)\d\d|in (?:19|20)\d\d|now,|today,|so how|so what|chapter)\b/i;

function segmentScenes(sentences: SentenceAnalysis[]): { start: number; end: number; from: number; to: number }[] {
  const scenes: { start: number; end: number; from: number; to: number; ents: Set<string> }[] = [];
  for (const s of sentences) {
    const cur = scenes.at(-1);
    const ents = new Set(s.intent.entities.map((e) => e.toLowerCase()));
    const shareEntity = cur ? [...ents].some((e) => cur.ents.has(e)) : false;
    const count = cur ? s.idx - cur.from + 1 : 0;
    const dur = cur ? s.end - cur.start : 0;
    const gap = cur ? s.start - cur.end : 0;
    const newScene =
      !cur ||
      gap > 1.5 ||
      dur > 40 ||
      (SCENE_CUE.test(s.text.trim()) && count >= 2) ||
      (ents.size > 0 && !shareEntity && count >= 3 && dur > 14) ||
      s.intent.type === "time_jump";
    if (newScene) scenes.push({ start: s.start, end: s.end, from: s.idx, to: s.idx, ents });
    else {
      cur.end = s.end;
      cur.to = s.idx;
      for (const e of ents) cur.ents.add(e);
    }
  }
  return scenes;
}

export async function analyzeTranscript(input: AnalyzeInput, opts: AnalyzeOptions = {}): Promise<TranscriptAnalysis> {
  const log = opts.log ?? (() => undefined);
  const currentYear = opts.currentYear ?? new Date().getFullYear();
  const warnings: string[] = [];
  const raw = timedSentences(input);
  const fullText = raw.map((s) => s.text).join(" ");

  let index: EntityIndex;
  if (opts.offline || !fullText) index = offlineIndex(fullText);
  else {
    try {
      index = await buildEntityIndex(fullText, input.projectTitle, { cache: opts.cache, topic: input.topic, maxLookups: 40, log, signal: opts.signal });
    } catch (err) {
      warnings.push(`Wikipedia entity linking was unavailable (${(err as Error).message}); names are used as spelled in the transcript and are not classified.`);
      index = offlineIndex(fullText);
    }
  }
  if (!input.words?.length) warnings.push("No narration transcript yet — sentence times are estimated from the script at ~2.6 words/second.");

  // Names Wikipedia doesn't know (private people, local places, fictional characters) still matter
  // to a documentary: keep every capitalised mention the linker dropped, as an unclassified name.
  const linked = (text: string) => index.find(text).length > 0;
  const extraNames = extractMentions(fullText).filter((m) => !m.acronym || m.count >= 2).map((m) => m.text).filter((t) => !linked(` ${t} `) && !index.entities.some((e) => e.aliases.includes(t.toLowerCase())));

  const seen = new Set<string>();
  let lastPerson: string | null = index.cast[0]?.name ?? null;
  const recent: string[][] = []; // subjects of the previous two sentences
  let lastConflict: string[] = [];
  const storyTerms = [...new Set([...index.topic, ...topicWords(input.topic, [], 4)])];
  const sentences: SentenceAnalysis[] = raw.map((s, idx) => {
    const mentions: Mention[] = index.find(s.text).map((e) => ({ text: e.name, kind: mentionKind(e), name: e.name, description: describe(e), wikiTitle: e.wikiTitle }));
    for (const n of extraNames) {
      const re = new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "u");
      if (re.test(s.text) && !mentions.some((m) => m.name.toLowerCase().includes(n.toLowerCase()) || n.toLowerCase().includes(m.name.toLowerCase()))) {
        // "…named Delroy Marsh", "Delroy Marsh, a young engineer", "Marsh, who…" introduce a person.
        const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const person = new RegExp(`\\b(named|called|nicknamed|by)\\s+${esc}\\b|\\b${esc}\\s*,\\s*(a|an|the|who|whose)\\b|\\b${esc}\\s+(who|said|says|told|recalled|remembers)\\b`, "i").test(s.text) && n.includes(" ");
        mentions.push({ text: n, kind: person ? "person" : "term", name: n, description: null, wikiTitle: null });
      }
    }
    for (const w of extractWorks(s.text)) if (!mentions.some((m) => m.name === w.title)) mentions.push({ text: w.title, kind: w.kind, name: w.title });
    for (const p of PLATFORMS) if (p.re.test(s.text)) mentions.push({ text: p.name, kind: "platform", name: p.name });
    const dates = extractDates(s.text, currentYear);
    const statistics = extractStatistics(s.text);
    const quotes = extractQuotes(s.text);
    const references = extractReferences(s.text, dates.map((d) => d.year).filter((y): y is number => y !== null), currentYear);
    const topics = topicWords(s.text, mentions.map((m) => m.name));
    const claim = detectClaim(s.text, mentions.some((m) => m.kind !== "platform" && m.kind !== "term"), statistics, dates);
    const firstMention = (name: string) => !seen.has(name.toLowerCase());
    const recentSubjects = [...new Set(recent.flat())];
    const intent = buildIntent({ text: s.text, mentions, dates, statistics, quotes, references, topics, claim: Boolean(claim) }, { currentYear, country: index.country, storyTerms, lastPerson, firstMention, recentSubjects, lastConflict });
    for (const m of mentions) seen.add(m.name.toLowerCase());
    // People first: they are what "the fans reacted" or "the feud" is about.
    const rank = (k: MentionKind) => (k === "person" ? 0 : k === "term" ? 1 : 2);
    const subjects = mentions
      .filter((m) => m.kind === "person" || m.kind === "organization" || m.kind === "term" || m.kind === "event")
      .sort((a, b) => rank(a.kind) - rank(b.kind))
      .map((m) => m.name);
    if (intent.type === "conflict" && subjects.length >= 2) lastConflict = subjects.slice(0, 2);
    recent.unshift(subjects.length ? subjects : recentSubjects.slice(0, 2));
    recent.length = Math.min(recent.length, 2);
    const person = mentions.find((m) => m.kind === "person");
    if (person) lastPerson = person.name;
    return { idx, text: s.text, start: s.start, end: s.end, scene: 0, mentions, dates, statistics, quotes, claim, references, intent };
  });

  // Scenes: follow the generated edit when there is one (so research links to timeline scenes).
  let spans: { key: string; start: number; end: number; from: number; to: number }[];
  if (input.plans?.length && input.words?.length) {
    spans = [];
    for (const p of input.plans) {
      const inside = sentences.filter((s) => {
        const mid = (s.start + s.end) / 2;
        return mid >= p.startTime && mid < p.endTime;
      });
      if (!inside.length) continue;
      spans.push({ key: p.sceneId, start: p.startTime, end: p.endTime, from: inside[0]!.idx, to: inside.at(-1)!.idx });
    }
    // Sentences outside every plan (e.g. a trailing line) join the nearest scene.
    for (const s of sentences) {
      if (spans.some((sp) => s.idx >= sp.from && s.idx <= sp.to)) continue;
      const near = spans.reduce((best, sp) => (Math.abs(sp.start - s.start) < Math.abs(best.start - s.start) ? sp : best), spans[0]!);
      if (near) {
        near.from = Math.min(near.from, s.idx);
        near.to = Math.max(near.to, s.idx);
      }
    }
    spans.sort((a, b) => a.from - b.from);
  } else {
    spans = segmentScenes(sentences).map((sp, i) => ({ key: `script_${String(i + 1).padStart(3, "0")}`, ...sp }));
  }

  const scenes: SceneSummary[] = spans.map((sp, i) => {
    const members = sentences.slice(sp.from, sp.to + 1);
    for (const m of members) m.scene = i;
    const entCounts = new Map<string, number>();
    for (const m of members) for (const e of m.intent.entities) entCounts.set(e, (entCounts.get(e) ?? 0) + 1);
    const entities = [...entCounts.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e).slice(0, 6);
    const topics = topicWords(members.map((m) => m.text).join(" "), entities, 4);
    const title = entities[0] ? `${entities[0]}${topics[0] ? ` — ${topics[0]}` : ""}` : topics.slice(0, 2).join(", ") || members[0]!.text.split(/\s+/).slice(0, 6).join(" ");
    return { idx: i, key: sp.key, start: sp.start, end: sp.end, sentences: [sp.from, sp.to], title, entities, topics };
  });

  const globals = new Map<string, GlobalEntity>();
  for (const s of sentences) {
    for (const m of s.mentions) {
      const g = globals.get(m.name) ?? { name: m.name, kind: m.kind, description: m.description ?? null, wikiTitle: m.wikiTitle ?? null, mentions: 0, firstSentence: s.idx };
      g.mentions++;
      globals.set(m.name, g);
    }
  }

  return {
    version: 1,
    basis: "rules",
    createdAt: new Date().toISOString(),
    sourceHash: analysisSourceHash(input),
    timed: Boolean(input.words?.length),
    topic: input.topic,
    country: index.country,
    sentences,
    scenes,
    entities: [...globals.values()].sort((a, b) => b.mentions - a.mentions),
    warnings,
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
