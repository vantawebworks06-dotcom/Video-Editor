/**
 * The editorial storyboard: what a documentary editor decides BEFORE searching for media.
 *
 * For every scene — read together with the scenes around it — it classifies what the narration
 * is doing (conflict, reveal, explanation…), places it on a whole-video intensity curve, picks
 * what the viewer should feel, the music mood and pacing, and splits the narration into visual
 * beats at clause boundaries and cue words ("but", "then", "that changed everything"). Each beat
 * gets a visual type, the entity it is about, entity-first search queries, a fallback chain and
 * an avoid list. Searching and ranking (generate.ts / relevance.ts) then execute this plan.
 *
 * Rule-based and deterministic, so it runs without an AI key; the same structure can be filled
 * by an AI director later.
 */
import type {
  CardSpec,
  EditorialIntent,
  EditorialVisualType,
  MusicMood,
  SfxCue,
  StoryBeat,
  Storyboard,
  StyleProfile,
  Transition,
  VisualFallback,
  Word,
} from "@/lib/domain/types";
import { clamp } from "./engines";
import { CLICHES } from "./relevance";
import type { Entity, EntityIndex } from "./entities";

export interface StoryboardScene {
  sceneId: string;
  startTime: number;
  endTime: number;
  narration: string;
}

export interface SceneBoard {
  storyboard: Storyboard;
  /** Full beat plans (fallback chains, cards, avoid lists) — the storyboard keeps the summary. */
  beats: PlannedBeat[];
  sfx: SfxCue[];
  transition: Transition;
  /** Short on-screen text worth showing (statistic, name, dramatic line), if any. */
  text: { text: string; style: "statistic" | "dramatic" | "keyword" | "chapter_title"; position: "center" | "bottom" } | null;
  /** Memes are allowed only where the storyboard found a comedic/ironic moment in a light scene. */
  memeAllowed: boolean;
}

// ---------------------------------------------------------------------------
// Lexicons
// ---------------------------------------------------------------------------

const CONFLICT = /\b(beef|feud|rival\w*|war|warfare|fight\w*|clash\w*|violen\w*|shots?|fired|attack\w*|threat\w*|hostil\w*|dangerous|battle\w*|enem\w*|dis+|diss\w*|tension|tensions|conflict\w*|territorial|tribal\w*|gun\w*|armed|sending shots|lyrical)\b/gi;
const SHOCK = /\b(everything changed|that changed everything|suddenly|exploded|explod\w*|shock\w*|nobody expected|then it happened|it wasn't\.|it wasn't$|for a moment|turned deadly|out of control|became island wide|island.?wide|much bigger)\b/gi;
const GRAVE = /\b(dead|death|died|killed|murder\w*|arrest\w*|police|court|trial|convict\w*|prison|jail\w*|charged|scandal|funeral|shooting|intervened|government)\b/gi;
const CALM = /\b(understand|explain\w*|research\w*|academic|history|historically|describes?|began|begin|first|originally|in fact|basically|essentially)\b/gi;
const REVEAL = /\b(this is where|but then|then,? things|but behind|turns out|the truth|what (?:really|actually)|here's the thing|controversial|it wasn't|however)\b/i;
const HOOK = /\b(what if|imagine|picture this|have you ever)\b/i;
const TRANSITION_CUES = /^(so,?|now,?|but first|to understand|let's|this is where|and this is where|before we|meanwhile)\b/i;
const EMOTION = /\b(death|died|killed|murder|grief|tragic|tragedy|fear|funeral|cried|pain|heartbreak\w*|alone|lost everything)\b/i;
const TRIUMPH = /\b(won|victory|success\w*|triumph\w*|major star|superstar|rose to|breakthrough|celebrat\w*|number one|#1|hit record)\b/i;
const POLITICAL = /\b(politic\w*|government|party|parties|election\w*|parliament|minister|garrison\w*|PNP|JLP|vote\w*|campaign)\b/i;
const CULTURAL = /\b(culture|cultural|identity|identities|music|dance\w*|genre|street|communit\w*|fans?|style|fashion|slang|graffiti|lyrics?)\b/i;
const EXPLAIN = /\b(because|which means|in other words|explain\w*|describes?|research|the reason|so that|meaning)\b/i;
const QUOTE = /(["“][^"”]{6,}["”]|\b(said|told|calling for|according to|in (?:his|her|their) words|quote)\b)/i;
const STAT = /\b(\d[\d,.]*\s?(%|percent|million|billion|thousand|people|times)|\d+ out of \d+)\b/i;
const MEME_CUES = /\b(somehow|worse|of course|apparently|turns out|ironically|genius|disaster|literally|obviously|plot twist|awkward|chaos|embarrass\w*|ridiculous|absurd)\b/i;
const YEAR = /\b(1[89]\d\d|20[0-3]\d)s?\b/g;

/** Cue words/phrases that open a new visual beat (section 12 of the brief). */
const CUT_CUES =
  /^(but|then|however|eventually|until|after|before|because|suddenly|meanwhile|and then|and suddenly|and eventually|years later|the next day|that changed everything|everything changed|things got worse|by \d{4}|in \d{4}|this time|so,|instead|still|yet|while)\b/i;

const EVENT_TERMS =
  /\b(press conference|conference|concert|stage show|festival|clash|sound clash|election|riot|protest|arrest|trial|court case|funeral|shooting|graffiti|ban|banned|release|released|record|track|song|album|tour|interview|meeting|rally|parade|performance|award\w*|chart)\b/gi;

const CONCEPT_BROLL: [RegExp, string][] = [
  [/\b(graffiti|walls?)\b/i, "graffiti wall street"],
  [/\b(radio|airplay|dj|selector)\b/i, "radio studio microphone"],
  [/\b(record|track|song|single|lyrics?|diss|studio)\b/i, "recording studio microphone"],
  [/\b(fans?|crowd|audience|supporters?)\b/i, "concert crowd night"],
  [/\b(sound system|speakers?|party|dance(?:hall)?|club)\b/i, "sound system speakers party"],
  [/\b(police|cops?|officers?)\b/i, "police officers"],
  [/\b(court|trial|judge)\b/i, "courthouse"],
  [/\b(prison|jail|cell)\b/i, "prison bars"],
  [/\b(newspaper|headline|reported|press)\b/i, "newspaper headline"],
  [/\b(social media|online|internet|twitter|instagram|youtube|viral)\b/i, "smartphone social media"],
  [/\b(communit\w*|neighbou?rhoods?|garrisons?|housing|inner city|streets?)\b/i, "neighbourhood street"],
  [/\b(poverty|poor)\b/i, "poor neighbourhood"],
  [/\b(money|cash|commercial|business|industry)\b/i, "money cash"],
  [/\b(politic\w*|election|vote|parties|government)\b/i, "election rally"],
  [/\b(research|academic|study|university)\b/i, "library books research"],
  [/\b(history|historical|independence|decades?)\b/i, "old archive photographs"],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const count = (re: RegExp, text: string) => (text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`)) ?? []).length;
const years = (text: string) => [...text.matchAll(YEAR)].map((m) => Number(m[1]));
/** Trim to about n characters at a word boundary (cards and summaries never end mid-word). */
const shorten = (s: string, n = 90) => {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const at = cut.lastIndexOf(" ");
  return `${(at > n * 0.5 ? cut.slice(0, at) : cut).replace(/[,;:\s]+$/, "")}…`;
};

function eventTerms(text: string): string[] {
  return [...new Set((text.match(EVENT_TERMS) ?? []).map((e) => e.toLowerCase()))];
}

function concept(text: string): string | null {
  for (const [re, q] of CONCEPT_BROLL) if (re.test(text)) return q;
  return null;
}

const PERSON_PRONOUN = /\b(he|his|him|himself|she|her|hers|herself)\b/i;
const PLURAL_PRONOUN = /\b(they|them|their|these two|both artists|the two artists|the two)\b/i;

// ---------------------------------------------------------------------------
// Intensity curve (section 24)
// ---------------------------------------------------------------------------

function rawIntensity(text: string): number {
  let v = 3;
  v += Math.min(3, count(CONFLICT, text) * 0.9);
  v += Math.min(3, count(SHOCK, text) * 1.6);
  v += Math.min(2.5, count(GRAVE, text) * 0.9);
  v += /!/.test(text) ? 0.8 : 0;
  v += HOOK.test(text) ? 1 : 0;
  v -= Math.min(2, count(CALM, text) * 0.7);
  return clamp(v, 1, 10);
}

/** Whole-video curve: raw scores, lightly smoothed, then shaped into buildups/climaxes/aftermaths. */
export function intensityCurve(texts: string[]): { value: number[]; role: ("buildup" | "climax" | "aftermath" | null)[] } {
  const raw = texts.map(rawIntensity);
  const n = raw.length;
  // Gentle overall arc: stories tend to escalate towards the last third.
  const arc = raw.map((_, i) => (n > 3 ? 0.8 * Math.sin((Math.PI * i) / (n - 1)) * (i / (n - 1)) : 0));
  const smooth = raw.map((v, i) => 0.25 * (raw[i - 1] ?? v) + 0.5 * v + 0.25 * (raw[i + 1] ?? v) + arc[i]!);
  const base = smooth.map((v, i) => clamp(Math.max(v, raw[i]! - 0.5), 1, 10));
  // Intensity is relative within a video: blend the absolute score with its rank so a story
  // told in a steady voice still gets calm stretches and real peaks.
  const sorted = [...base].sort((a, b) => a - b);
  const pct = (v: number) => (n > 1 ? sorted.lastIndexOf(v) / (n - 1) : 0.5);
  const value = base.map((v) => clamp(0.5 * v + 0.5 * (2 + 7 * pct(v)), 1, 10));
  const role: ("buildup" | "climax" | "aftermath" | null)[] = value.map(() => null);
  for (let i = 0; i < n; i++) {
    const v = value[i]!;
    const peak = v >= 7.5 && v >= (value[i - 1] ?? 0) && v >= (value[i + 1] ?? 0);
    if (peak) role[i] = "climax";
  }
  for (let i = 0; i < n; i++) {
    if (role[i]) continue;
    if (role[i + 1] === "climax" && value[i]! < value[i + 1]!) {
      role[i] = "buildup";
      value[i] = Math.max(value[i]!, value[i + 1]! - 2); // tension rises into the climax
    } else if (role[i - 1] === "climax" && value[i]! <= value[i - 1]! - 2) {
      role[i] = "aftermath";
    }
  }
  return { value: value.map((v) => Math.round(v)), role };
}

// ---------------------------------------------------------------------------
// Classification (section 2)
// ---------------------------------------------------------------------------

function classify(text: string, ents: Entity[], role: string | null, intensity: number): EditorialIntent[] {
  const out: EditorialIntent[] = [];
  const ys = years(text);
  if (role === "climax") out.push("climax");
  if (role === "buildup") out.push("buildup");
  if (role === "aftermath") out.push("aftermath");
  if (REVEAL.test(text) || count(SHOCK, text)) out.push("dramatic_reveal");
  if (count(CONFLICT, text) >= 1) out.push("conflict");
  if (ys.length && (eventTerms(text).length || count(GRAVE, text))) out.push("historical_event");
  if (ys.some((y) => y < 2000)) out.push("archival");
  if (POLITICAL.test(text) || ents.some((e) => e.kind === "organization" && /party|government/i.test(e.description ?? ""))) out.push("political");
  if (ents.some((e) => e.kind === "person")) out.push("person");
  if (STAT.test(text)) out.push("statistic");
  if (QUOTE.test(text)) out.push(/\b(said|told)\b/i.test(text) ? "interview" : "quote");
  if (EXPLAIN.test(text) || count(CALM, text) >= 2) out.push("explanation");
  if (CULTURAL.test(text)) out.push("cultural");
  if (ents.some((e) => e.kind === "place") && !ents.some((e) => e.kind === "person")) out.push("location");
  if (EMOTION.test(text)) out.push("emotional");
  if (MEME_CUES.test(text) && intensity < 7) out.push(/\b(ironically|of course|obviously|genius)\b/i.test(text) ? "ironic" : "comedic");
  if (HOOK.test(text) || /\b(until|but no one knew|little did)\b/i.test(text)) out.push("suspense");
  if (TRANSITION_CUES.test(text.trim())) out.push("transition");
  if (!out.length) out.push("fact");
  return [...new Set(out)];
}

const PRIORITY: EditorialIntent[] = [
  "climax", "dramatic_reveal", "aftermath", "buildup", "conflict", "historical_event", "emotional", "political", "statistic",
  "quote", "interview", "person", "comedic", "ironic", "suspense", "explanation", "cultural", "location", "archival", "transition", "fact",
];

function feelFor(intents: EditorialIntent[], intensity: number, text: string): string {
  if (intents.includes("climax") || (intents.includes("dramatic_reveal") && intensity >= 8)) return "shock";
  if (intents.includes("emotional")) return "sadness";
  if (intents.includes("aftermath")) return "reflection";
  if (TRIUMPH.test(text)) return "triumph";
  if (intents.includes("comedic") || intents.includes("ironic")) return "amusement";
  if (intents.includes("buildup")) return "tension";
  // A rivalry story mentions its rivalry constantly; only genuinely intense conflict is tense.
  if (intents.includes("conflict") && intensity >= 5) return intensity >= 7 ? "tension" : "unease";
  if (intents.includes("suspense") || intents.includes("dramatic_reveal")) return "intrigue";
  if (intents.includes("explanation") || intents.includes("political")) return "curiosity";
  return intensity <= 3 ? "calm" : "interest";
}

function musicFor(feel: string, intents: EditorialIntent[], intensity: number): MusicMood {
  switch (feel) {
    case "shock":
      return intensity >= 9 ? "aggressive" : "dark";
    case "sadness":
      return "sad";
    case "reflection":
      return "reflective";
    case "triumph":
      return "triumphant";
    case "amusement":
      return "comedic";
    case "tension":
      return intents.includes("buildup") ? "suspenseful" : "tense";
    case "unease":
      return "tense";
    case "intrigue":
      return "mysterious";
    case "curiosity":
      return intents.includes("political") && intensity >= 5 ? "tense" : "neutral";
    default:
      return intents.includes("cultural") && intensity >= 5 ? "energetic" : intensity <= 3 ? "calm" : "neutral";
  }
}

function pacingFor(intensity: number, role: string | null): Storyboard["pacing"] {
  if (role === "climax" || intensity >= 9) return "rapid";
  if (intensity >= 7 || role === "buildup") return "fast";
  if (intensity <= 3 || role === "aftermath") return "slow";
  return "normal";
}

/** Beat length range (seconds) per pacing, before the style profile's scale (section 13). */
const BEAT_RANGE: Record<Storyboard["pacing"], [number, number]> = {
  slow: [4, 6],
  normal: [2.9, 4.4],
  fast: [1.8, 2.8],
  rapid: [0.9, 1.6],
};

// ---------------------------------------------------------------------------
// Beats (sections 11-12)
// ---------------------------------------------------------------------------

interface Clause {
  start: number;
  end: number;
  text: string;
  cue: string | null;
}

function clauses(words: Word[], sceneStart: number, sceneEnd: number): Clause[] {
  const out: Clause[] = [];
  let cur: Word[] = [];
  let cue: string | null = null;
  const push = () => {
    if (!cur.length) return;
    out.push({ start: cur[0]!.start, end: cur.at(-1)!.end, text: cur.map((w) => w.word).join(" "), cue });
    cur = [];
    cue = null;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const ahead = words.slice(i, i + 4).map((x) => x.word.replace(/[^\p{L}\p{N}',]/gu, "")).join(" ");
    const m = ahead.match(CUT_CUES);
    if (m && cur.length >= 2) {
      push();
      cue = m[1]!.toLowerCase().replace(/,$/, "");
    }
    cur.push(w);
    if (/[.!?;:,]["')\]]*$/.test(w.word)) push();
  }
  push();
  if (!out.length) out.push({ start: sceneStart, end: sceneEnd, text: "", cue: null });
  return out;
}

/** Group clauses into beats whose lengths suit the pacing; long clauses are subdivided. */
function beatSpans(cls: Clause[], range: [number, number], sceneStart: number, sceneEnd: number): { start: number; end: number; text: string; cut: string }[] {
  const [lo, hi] = range;
  const spans: { start: number; end: number; text: string; cut: string }[] = [];
  let cur: { start: number; end: number; text: string; cut: string } | null = null;
  for (const c of cls) {
    const strongCue = Boolean(c.cue);
    if (!cur) {
      cur = { start: c.start, end: c.end, text: c.text, cut: c.cue ? `cue: ${c.cue}` : "clause" };
      continue;
    }
    const curLen = cur.end - cur.start;
    const merged = c.end - cur.start;
    // Cut at a cue word as soon as the current beat is long enough to stand on its own.
    if ((strongCue && curLen >= lo * 0.7) || merged > hi || curLen >= (lo + hi) / 2) {
      spans.push(cur);
      cur = { start: c.start, end: c.end, text: c.text, cut: c.cue ? `cue: ${c.cue}` : "clause" };
    } else {
      cur.end = c.end;
      cur.text = `${cur.text} ${c.text}`;
    }
  }
  if (cur) spans.push(cur);
  // Subdivide beats that are still too long (one clip must not carry a whole paragraph).
  const out: typeof spans = [];
  for (const s of spans) {
    const len = s.end - s.start;
    const parts = len > hi ? Math.ceil(len / hi) : 1;
    const words = s.text.split(/\s+/);
    for (let k = 0; k < parts; k++) {
      const a = s.start + (len * k) / parts;
      const b = s.start + (len * (k + 1)) / parts;
      const slice = words.slice(Math.floor((words.length * k) / parts), Math.ceil((words.length * (k + 1)) / parts)).join(" ");
      out.push({ start: a, end: b, text: slice || s.text, cut: k ? (hi <= 1.6 ? "rapid sequence" : "long clause split") : s.cut });
    }
  }
  // Merge a too-short tail into its neighbour.
  for (let i = out.length - 1; i > 0; i--) {
    if (out[i]!.end - out[i]!.start < lo * 0.55) {
      out[i - 1]!.end = out[i]!.end;
      out[i - 1]!.text += ` ${out[i]!.text}`;
      out.splice(i, 1);
    }
  }
  // Contiguous beats covering the whole scene.
  out[0]!.start = sceneStart;
  for (let i = 1; i < out.length; i++) out[i]!.start = out[i - 1]!.end;
  out.at(-1)!.end = sceneEnd;
  return out;
}

// ---------------------------------------------------------------------------
// Visual planning per beat (sections 4-9)
// ---------------------------------------------------------------------------

/** B-roll concepts that look the same anywhere (so they needn't be tagged with the country). */
const PLACE_FREE_CONCEPTS = new Set(["radio studio microphone", "recording studio microphone", "sound system speakers party", "concert crowd night", "police officers", "courthouse", "prison bars", "newspaper headline", "smartphone social media", "money cash", "library books research", "old archive photographs"]);

const STOCK_OK: EditorialVisualType[] =["establishing_shot", "b_roll", "abstract_background", "location_photo"];

export interface PlannedBeat extends StoryBeat {
  entities: string[];
  year: number | null;
  topic: string[];
  stockAllowed: boolean;
  fallbacks: VisualFallback[];
  card: CardSpec;
  avoid: string[];
  transition: Transition;
  local: boolean;
  line: string;
}

const q = (...parts: (string | null | undefined | number)[]) => parts.filter((p) => p !== null && p !== undefined && String(p).trim()).join(" ").replace(/\s+/g, " ").trim();

function pickEntity(ents: Entity[]): Entity | null {
  const order: Entity["kind"][] = ["person", "event", "organization", "work", "place", "term"];
  for (const k of order) {
    const e = ents.find((x) => x.kind === k);
    if (e) return e;
  }
  return null;
}

/** What the editor remembers while walking through the story (continuity between beats/scenes). */
interface BeatMemory {
  person: Entity | null;
  people: Entity[];
  lastType: EditorialVisualType | null;
  lastFocus: string | null;
  /** People whose name card was shown, by scene index (introduce each person once). */
  carded: Map<string, number>;
  sceneIndex: number;
  /** Running beat counter (rotates queries/cast so neighbouring beats differ). */
  beat: number;
  lastIdea: string | null;
  /** Alternates which main character stands in for "the rivalry". */
  castTurn: number;
  /** People already given a beat in the current scene. */
  shownInScene: Set<string>;
}

function planBeat(
  span: { start: number; end: number; text: string; cut: string },
  i: number,
  scene: { text: string; intents: EditorialIntent[]; intensity: number; year: number | null; pacing: Storyboard["pacing"] },
  index: EntityIndex,
  memory: BeatMemory,
): PlannedBeat {
  const text = span.text;
  // Story terms ("Gaza") and unresolved mentions (mis-heard "BNP") are never searched on their own.
  const real = (e: Entity) => e.kind !== "term" || !(e.description?.startsWith("story term") || e.description === "unresolved mention");
  const found = index.find(text);
  const sceneEnts = index.find(scene.text);
  // When a line names several people ("Vybz Kartel and Mavado"), give each of them a beat in turn.
  const namedPeople = found.filter((e) => e.kind === "person");
  const scenePeople = sceneEnts.filter((e) => e.kind === "person");
  let focus =
    namedPeople.length > 1
      ? namedPeople.find((e) => !memory.shownInScene.has(e.name)) ?? namedPeople[i % namedPeople.length]!
      : pickEntity(found.filter(real));
  if (!focus && scenePeople.length > 1 && !PERSON_PRONOUN.test(text)) focus = scenePeople.find((e) => !memory.shownInScene.has(e.name)) ?? null;
  // "he/his" → the last person; "they/the two" → the pair being discussed.
  if (!focus && PERSON_PRONOUN.test(text) && memory.person) focus = memory.person;
  if (!focus && PLURAL_PRONOUN.test(text) && memory.people.length) focus = memory.people[i % memory.people.length]!;
  // Story terms ("Gaza", "Gully") are the rivalry itself: show its protagonists, alternating
  // between them, rather than searching the bare word (which finds the Gaza Strip).
  const storyTerm = found.some((e) => !real(e));
  const aboutRivalry = storyTerm || /\b(rival\w*|beef|feud|versus|vs\.?|two artists|both artists|each other|sides|diss\w*|shots at)\b/i.test(text);
  if (!focus && aboutRivalry && index.cast.length && memory.beat % 3 !== 2) focus = index.cast[memory.castTurn++ % index.cast.length]!;
  // Otherwise stay with the scene's subject so the sequence reads as one story (section 19).
  if (!focus) focus = pickEntity(sceneEnts.filter(real));
  const people = [...new Set([...found, ...sceneEnts].filter((e) => e.kind === "person"))];
  const place = [...found, ...sceneEnts].find((e) => e.kind === "place" && e.name !== index.country)?.name ?? null;
  const country = index.country;
  const events = eventTerms(text);
  const event = events[0] ?? null;
  // Only a year said in this scene counts (a year from minutes ago must not leak into queries).
  const year = years(text)[0] ?? scene.year;
  const idea = concept(text) ?? concept(scene.text);
  // Event words the picture should show; the story's title words ("Gaza", "Gully") are not events.
  const topicTerms = [...events];

  let type: EditorialVisualType;
  const named = focus?.kind === "person" ? memory.carded.get(focus.name) : undefined;
  const firstIntroduction = focus?.kind === "person" && (named === undefined || memory.sceneIndex - named > 12);
  if (STAT.test(text)) type = "statistic_graphic";
  // A year that anchors a historical event opens with a timeline card ("2007").
  else if (i === 0 && years(text).length && scene.intents.includes("historical_event") && memory.lastType !== "timeline_graphic") type = "timeline_graphic";
  else if (/\b(newspaper|gleaner|guardian|observer|headline|reported|article|front page|press)\b/i.test(text)) type = "newspaper";
  else if (/\b(social media|tweet\w*|instagram|facebook|youtube|posted|viral|comments?)\b/i.test(text)) type = "social_screenshot";
  else if (/["“].{6,}["”]|\b(calling for|declared)\b/i.test(text) && scene.intents.includes("quote") && memory.lastType !== "text_card") type = "text_card";
  else if (focus?.kind === "person") {
    // A person is introduced with their photo (and name card once); after that, alternate how
    // they are shown so a scene about one artist isn't five photos of them in a row.
    if (memory.lastType === "person_photo" && memory.lastFocus === focus.name) type = event ? "event_photo" : firstIntroduction ? "text_card" : idea ? "b_roll" : "location_photo";
    else type = "person_photo";
  } else if (focus?.kind === "organization") type = /party|government/i.test(focus.description ?? "") ? "event_photo" : "document";
  else if (focus?.kind === "event" || (event && years(text).length)) type = "event_photo";
  else if (focus?.kind === "place") type = memory.lastType === "location_photo" || memory.lastType === "establishing_shot" ? (idea ? "b_roll" : "location_photo") : i === 0 ? "establishing_shot" : "location_photo";
  else if (scene.year && scene.year < 2000 && scene.intents.includes("archival")) type = "archival_video";
  else if (scene.intents.includes("transition") && i === 0 && memory.lastType !== "text_card") type = "text_card";
  else if (idea) type = memory.lastIdea === idea && country ? "location_photo" : "b_roll";
  else type = scene.intensity >= 7 ? "abstract_background" : country ? "location_photo" : "b_roll";
  if (type === "text_card" && focus?.kind === "person") memory.carded.set(focus.name, memory.sceneIndex);
  memory.lastIdea = type === "b_roll" ? idea : memory.lastIdea;

  const name = focus?.name ?? null;
  const partner = people.find((p) => p.name !== name)?.name ?? null;
  let queries: string[];
  let description: string;
  switch (type as EditorialVisualType) {
    case "person_photo":
      queries = [q(name), q(name, year), q(name, event), q(name, country), q(name, "performing")];
      description = `Photo of ${name}${year ? ` around ${year}` : ""}`;
      break;
    case "event_photo":
      queries = [q(name, event, year), q(name, event), q(event, place ?? country, year), q(name, year), q(event, country)];
      description = `${event ?? "The event"}${name ? ` involving ${name}` : ""}${year ? ` (${year})` : ""}`;
      break;
    case "newspaper":
    case "news_screenshot":
      queries = [q(found.find((e) => e.kind === "organization")?.name, "newspaper"), q(name, "newspaper"), q(index.topic.join(" "), country, "newspaper"), q(country, "newspaper", year), "newspaper headline"];
      description = `Newspaper coverage${name ? ` of ${name}` : ""}`;
      break;
    case "social_screenshot":
      queries = [q(name, "social media"), "smartphone social media feed", "phone scrolling social media"];
      description = "Social media reaction";
      break;
    case "document":
      queries = [q(name), q(name, "logo"), q(name, country), q(name, year)];
      description = `${name ?? "Document"}`;
      break;
    case "establishing_shot":
    case "location_photo": {
      // Serious scenes are set in the city, not at the beach: prefer the story's city for urban
      // subjects and street-level angles over scenic ones.
      const serious = scene.intensity >= 5 || scene.intents.some((x) => ["political", "conflict", "historical_event", "emotional"].includes(x));
      const city = index.entities.find((e) => e.kind === "place" && e.name !== country && /\b(capital|city)\b/i.test(e.description ?? ""))?.name ?? null;
      const loc = (focus?.kind === "place" ? name : null) ?? place ?? (serious && city ? city : country);
      const ctry = loc !== country ? country : null;
      // Rotate the angle so consecutive location shots aren't the same search.
      const angles = serious
        ? [q(loc, "street", ctry), q(loc, "downtown", ctry), q(loc, "neighbourhood", ctry), q(loc, "market", ctry), q(loc, "people", ctry), q(loc, "city", ctry), q(loc, "houses", ctry), q(loc, "traffic", ctry)]
        : [q(loc, ctry), q(loc, "street", ctry), q(loc, "aerial"), q(loc, idea?.split(" ")[0], ctry), q(loc, "city life")];
      const k = memory.beat % angles.length;
      queries = [...angles.slice(k), ...angles.slice(0, k)];
      description = `${type === "establishing_shot" ? "Establishing shot" : "Location"}: ${loc}`;
      break;
    }
    case "archival_video":
      queries = [q(name ?? place ?? country, year), q(country, year ? `${Math.floor(year / 10) * 10}s` : null), q(name ?? idea, "archive"), q(country, "history")];
      description = `Archival material from ${year ?? "the period"}`;
      break;
    case "text_card":
    case "statistic_graphic":
    case "timeline_graphic":
      queries = [];
      description = "Designed text card";
      break;
    default: {
      const own = concept(text);
      const variants = [q(idea, place ?? country), q(idea), q(own ?? idea, "night"), q(place ?? country, "street life")];
      const k = own ? 0 : memory.beat % variants.length;
      queries = [...variants.slice(k), ...variants.slice(0, k)];
      description = idea ? `B-roll: ${idea}` : `Atmosphere for: ${shorten(text, 60)}`;
    }
  }
  queries = [...new Set(queries.filter((x) => x.length >= 3))].slice(0, 5);

  // Fallback chain (section 7): exact event → person photo → location → related archival →
  // newspaper → designed card. Stock is only a fallback where the beat is atmospheric.
  const fallbacks: VisualFallback[] = [];
  const fb = (visualType: EditorialVisualType, qs: string[], d: string, stock = false) => {
    const qq = [...new Set(qs.filter((x) => x.length >= 3))];
    if (qq.length && visualType !== type) fallbacks.push({ visualType, queries: qq.slice(0, 4), description: d, stockAllowed: stock });
  };
  if (event && name) fb("event_photo", [q(name, event), q(event, country, year)], `${event} (${name})`);
  if (name && focus?.kind === "person") fb("person_photo", [q(name), q(name, country)], `Photo of ${name}`);
  if (partner) fb("person_photo", [q(partner)], `Photo of ${partner}`);
  if (place || country) fb("location_photo", [q(place ?? country, idea ? idea.split(" ")[0] : null), q(place ?? country)], `Location: ${place ?? country}`, true);
  fb("archival_video", [q(country, year), q(index.topic.join(" "), country)], "Related archival imagery");
  if (idea) fb("b_roll", [q(idea, place ?? country), q(idea)], `B-roll: ${idea}`, true);

  const card: CardSpec =
    type === "timeline_graphic" && year
      ? { kind: "year", text: String(year), sub: shorten(keyLine(text), 60) }
      : type === "statistic_graphic"
      ? { kind: "statistic", text: (text.match(STAT)?.[0] ?? "").toUpperCase(), sub: shorten(text, 70) }
      : type === "text_card" && /["“]/.test(text)
        ? { kind: "quote", text: shorten(text.match(/["“]([^"”]+)["”]/)?.[1] ?? text, 80), sub: name }
        : year && (scene.intents.includes("historical_event") || type === "archival_video")
          ? { kind: "year", text: String(year), sub: name ?? event ?? null }
          : name && (focus?.kind === "person" || focus?.kind === "organization" || focus?.kind === "event")
            ? { kind: "name", text: name.toUpperCase(), sub: focus?.description ?? null }
            : { kind: scene.intensity >= 7 ? "headline" : "chapter", text: shorten(keyLine(text), 48).toUpperCase(), sub: null };

  // Tone: a scene about politics, violence or a feud must not cut to holiday imagery; and no
  // plants/animals unless the narration is about them.
  const seriousTone = scene.intensity >= 5 || scene.intents.some((x) => ["political", "conflict", "historical_event", "emotional", "dramatic_reveal"].includes(x));
  // Holiday imagery only when the narration is about holidays; serious scenes also lose scenery.
  const tourism = /\b(beach|resort|holiday|vacation|tourism|tourists?)\b/i.test(scene.text) ? [] : seriousTone ? [...TOURISM, ...SCENERY] : TOURISM;
  const nature = /\b(plant|flower|tree|animal|bird|garden|nature|farm\w*|coast|sea|island|landscape|scenery)\b/i.test(scene.text) ? [] : [...NATURE, ...SCENERY];
  const military = /\b(army|military|soldiers?|navy|troops|marines?|war)\b/i.test(scene.text) ? [] : MILITARY;
  const cliches = /\b(marley|marijuana|ganja|weed|cannabis|rasta\w*|hippie)\b/i.test(scene.text) ? [] : CLICHES;
  const avoid = [...genericAvoid(type), ...tourism, ...nature, ...military, ...cliches, ...(focus?.kind === "person" ? ["crowd", "people walking", "businessman", "model", "portrait of a man"] : [])];
  return {
    start: span.start,
    end: span.end,
    text,
    visualType: type,
    focus: name,
    description,
    queries,
    cut: span.cut,
    // What must be IN the picture: the person/event/organisation for specific shots, the place
    // for location shots, nothing for atmosphere.
    entities: (["person_photo", "event_photo", "document", "album_art", "newspaper"].includes(type)
      ? [name, ...(type === "event_photo" && partner ? [partner] : [])]
      : type === "location_photo" || type === "establishing_shot"
        ? [(focus?.kind === "place" ? name : null) ?? place]
        : []
    ).filter((x): x is string => Boolean(x) && x !== country),
    year,
    topic: topicTerms,
    stockAllowed: STOCK_OK.includes(type),
    // Streets, neighbourhoods and rallies must be local; a studio microphone can be anywhere.
    // A card needs a whole thought: fragments of a rapid beat ("ABOUT TO BECOME") use the scene's key line.
    line: shorten(keyLine(text.split(/\s+/).length >= 6 ? text : scene.text), 56).replace(/[,;:]+$/, "").toUpperCase(),
    local: !(type === "b_roll" && idea !== null && PLACE_FREE_CONCEPTS.has(idea)),
    fallbacks,
    card,
    avoid,
    transition: "hard_cut",
  };
}

const TOURISM = ["beach", "resort", "vacation", "holiday", "turquoise", "cliffside", "romantic", "pier", "luxury", "tourist", "honeymoon", "lifeguard", "life guard", "beach hut", "sunbathing", "cartoon", "anime", "illustration", "wallpaper", "clipart"];
const MILITARY = ["regiment", "army", "navy", "soldier", "soldiers", "military", "marine", "marines", "aviation", "joint task force", "cpl", "sgt", "battalion", "airmen", "sailors", "uss"];
const SCENERY = ["sunset", "palm", "tropical", "clouds", "coastal", "coast", "drone shot", "ocean", "waterfall", "mountains", "hurricane"];
const NATURE = ["flower", "plant", "species", "cultivar", "orchid", "leaf", "leaves", "butterfly", "insect", "bird", "lizard", "frog", "fish", "reflexa", "botanical", "succulent"];

function genericAvoid(t: EditorialVisualType): string[] {
  if (t === "b_roll" || t === "establishing_shot" || t === "abstract_background") return [];
  return ["stock footage", "abstract", "illustration", "3d render", "cartoon"];
}

/** The most "headline-like" part of a line, for text cards. */
function keyLine(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const best = sentences.sort((a, b) => rawIntensity(b) - rawIntensity(a) || a.length - b.length)[0] ?? text;
  return best.replace(/^(and|but|so|then)\s+/i, "").replace(/[.!?]+$/, "");
}

// ---------------------------------------------------------------------------
// Transitions (section 18) and SFX (section 17)
// ---------------------------------------------------------------------------

function transitionFor(
  intents: EditorialIntent[],
  intensity: number,
  firstBeat: EditorialVisualType,
  prev: Transition | null,
  i: number,
  style: StyleProfile,
  text: string,
): { t: Transition; why: string } {
  if (i === 0) return { t: "fade", why: "opening fade in" };
  const soft = style.transitionStyle !== "mostly_hard_cut";
  let t: Transition = "hard_cut";
  let why = "hard cut keeps the story moving";
  if (intents.includes("climax")) [t, why] = prev === "flash" ? ["glitch", "climax impact (varied from the last flash)"] : ["flash", "climax impact"];
  else if (intents.includes("aftermath")) [t, why] = ["dip_to_black", "pause after the big moment"];
  else if (intents.includes("emotional")) [t, why] = ["fade", "gentle transition for an emotional beat"];
  else if (intents.includes("transition") || /^(and )?this is where\b/i.test(text.trim())) [t, why] = ["dip_to_black", "new chapter of the story"];
  else if (firstBeat === "newspaper" || firstBeat === "document" || firstBeat === "news_screenshot") [t, why] = ["paper", "document on screen"];
  else if (intents.includes("archival") || firstBeat === "archival_video") [t, why] = [soft ? "film_burn" : "shutter", "archival material"];
  else if (intents.includes("dramatic_reveal") && intensity >= 6) [t, why] = ["zoom", "reveal — push in"];
  else if (intents.includes("cultural") && intensity >= 6 && soft) [t, why] = ["whip", "energetic cultural section"];
  else if (firstBeat === "person_photo" && intensity >= 5) [t, why] = ["shutter", "photo reveal of a key person"];
  // Never the same stylised transition twice in a row.
  if (t !== "hard_cut" && t === prev) [t, why] = ["hard_cut", "avoid repeating the previous transition"];
  // Hard-cut-heavy styles keep only the transitions with a strong editorial reason.
  if (!soft && !["flash", "dip_to_black", "fade", "shutter", "paper"].includes(t)) [t, why] = ["hard_cut", "style prefers hard cuts"];
  return { t, why };
}

function sfxFor(
  board: { intents: EditorialIntent[]; intensity: number; beats: PlannedBeat[]; transition: Transition; role: string | null },
  sceneStart: number,
  sceneDur: number,
  style: StyleProfile,
  text: string,
): { cues: SfxCue[]; why: string } {
  const cues: SfxCue[] = [];
  const add = (kind: SfxCue["kind"], at: number, reason: string) => cues.push({ kind, at: Math.round(at * 100) / 100, reason });
  const rel = (abs: number) => abs - sceneStart;
  // Transition-linked sounds.
  if (board.transition === "glitch") add("glitch", 0, "glitch transition");
  if (board.transition === "shutter") add("camera_shutter", 0.02, "photo reveal");
  if (board.transition === "paper") add("paper", 0, "document transition");
  if (board.transition === "film_burn") add("vinyl", 0, "old-film texture under archival");
  if (board.transition === "whip" || board.transition === "zoom") add("whoosh", -0.12, `${board.transition} transition`);
  // Story-linked sounds.
  if (board.role === "climax") {
    add("riser", -1.8, "build into the climax");
    add("bass_hit", 0, "climax impact");
  }
  if (board.role === "buildup" && sceneDur >= 4) add("heartbeat", Math.max(0, sceneDur - 3.2), "tension building");
  if (board.intents.includes("dramatic_reveal") && board.role !== "climax" && board.intensity >= 6) add("impact", 0.05, "reveal accent");
  for (const b of board.beats) {
    if (b.visualType === "newspaper") add("news_ambience", rel(b.start), "news coverage");
    else if (b.visualType === "social_screenshot") add("notification", rel(b.start) + 0.2, "social media");
    else if (b.visualType === "text_card" || b.visualType === "statistic_graphic") add("typing", rel(b.start) + 0.1, "text card");
  }
  if (/\b(radio|airplay)\b/i.test(text)) add("radio_static", 0.3, "radio mentioned");
  if (/\b(it wasn't\.|or so (?:we|they) thought|not quite)\b/i.test(text) && board.intensity < 8) add("record_scratch", 0.1, "ironic reversal");
  if (/\b(crowd|fans|audience)\b/i.test(text) && board.intensity >= 5) add("crowd", 0.4, "crowd mentioned");

  // Budget: not on every cut (≈ one per 5 s, scaled by the style), climaxes may exceed it.
  const budget = Math.max(1, Math.round((sceneDur / 5) * (0.5 + style.sfxFrequency)));
  const priority = ["bass_hit", "riser", "glitch", "impact", "camera_shutter", "paper", "news_ambience", "heartbeat", "record_scratch", "whoosh", "typing", "notification", "radio_static", "vinyl", "crowd"];
  const sorted = cues.sort((a, b) => priority.indexOf(a.kind) - priority.indexOf(b.kind));
  const seen = new Set<string>();
  const kept = sorted.filter((c) => !seen.has(c.kind) && seen.add(c.kind)).slice(0, board.role === "climax" ? budget + 1 : budget);
  return { cues: kept.sort((a, b) => a.at - b.at), why: kept.length ? kept.map((c) => `${c.kind} (${c.reason})`).join(", ") : "no effect — the narration carries this scene" };
}

// ---------------------------------------------------------------------------
// Whole-video storyboard
// ---------------------------------------------------------------------------

export function buildStoryboards(scenes: StoryboardScene[], words: Word[], index: EntityIndex, style: StyleProfile): Map<string, SceneBoard> {
  const texts = scenes.map((s) => s.narration);
  const curve = intensityCurve(texts);
  const out = new Map<string, SceneBoard>();
  const styleScale = clamp(style.averageShotDuration / 3.8, 0.6, 1.6);
  const memory: BeatMemory = { person: null, people: [], lastType: null, lastFocus: null, carded: new Map(), sceneIndex: 0, beat: 0, lastIdea: null, castTurn: 0, shownInScene: new Set() };
  let prevTransition: Transition | null = null;
  let era: number | null = null;
  let eraScene = -99;
  let section = "Introduction";

  scenes.forEach((s, i) => {
    memory.sceneIndex = i;
    memory.shownInScene = new Set();
    const text = s.narration;
    const ents = index.find(text);
    const intensity = clamp(curve.value[i]!, 1, 10);
    const role = curve.role[i]!;
    const intents = classify(text, ents, role, intensity);
    const intent = PRIORITY.find((p) => intents.includes(p)) ?? "fact";
    const feel = feelFor(intents, intensity, text);
    const pacing = pacingFor(intensity, role);
    const musicMood = musicFor(feel, intents, intensity);
    const y = years(text);
    // A year stays "current" for the next scene only; older years must not leak into queries.
    if (y.length) [era, eraScene] = [y.at(-1)!, i];
    else if (i - eraScene > 1) era = null;
    // Sections change at transition cues / chapter-like lines.
    if (intents.includes("transition") || /\bthis is where\b/i.test(text)) section = shorten(keyLine(text), 60);

    const sceneWords = words.filter((w) => w.start >= s.startTime - 0.05 && w.end <= s.endTime + 0.05);
    const [lo, hi] = BEAT_RANGE[pacing];
    const range: [number, number] = [lo * styleScale, hi * styleScale];
    const spans = beatSpans(clauses(sceneWords, s.startTime, s.endTime), range, s.startTime, s.endTime);
    const beats = spans.map((span, bi) => {
      const b = planBeat(span, bi, { text, intents, intensity, year: era, pacing }, index, memory);
      memory.lastType = b.visualType;
      memory.lastFocus = b.focus;
      if (b.focus) memory.shownInScene.add(b.focus);
      memory.beat++;
      return b;
    });
    // After the reveal: hold the first image of an aftermath a little longer (brief visual pause).
    if (role === "aftermath" && beats.length > 1) {
      const extra = Math.min(1.2, (beats[1]!.end - beats[1]!.start) * 0.4);
      beats[0]!.end += extra;
      beats[1]!.start += extra;
    }
    const people = ents.filter((e) => e.kind === "person");
    if (people.length) {
      memory.person = people.at(-1)!;
      memory.people = people;
    }

    const tr = transitionFor(intents, intensity, beats[0]!.visualType, prevTransition, i, style, text);
    prevTransition = tr.t === "hard_cut" ? prevTransition : tr.t;
    // Inside rapid climaxes, the first quick cut punches in.
    if (pacing === "rapid" && beats.length > 2) beats[1]!.transition = "zoom";

    const sfx = sfxFor({ intents, intensity, beats, transition: tr.t, role }, s.startTime, s.endTime - s.startTime, style, text);
    const memeOk = (intents.includes("comedic") || intents.includes("ironic")) && intensity < 7 && !intents.includes("emotional") && !intents.includes("political");
    const memeReason = memeOk
      ? `meme_opportunity = true: ${intents.includes("ironic") ? "ironic" : "comedic"} line in a light scene`
      : `meme_opportunity = false: ${intents.includes("emotional") ? "emotional scene" : intensity >= 7 ? "high-intensity scene" : intents.includes("political") ? "serious political context" : "no comedic or ironic moment"}`;

    const name = beats.find((b) => b.focus)?.focus ?? null;
    const text2 = STAT.test(text)
      ? { text: (text.match(STAT)?.[0] ?? "").toUpperCase(), style: "statistic" as const, position: "center" as const }
      : role === "climax" && text.split(/\s+/).length > 3
        ? { text: shorten(keyLine(text), 34).toUpperCase(), style: "dramatic" as const, position: "center" as const }
        : null;

    const storyboard: Storyboard = {
      intent,
      intents,
      feel,
      intensity,
      pacing,
      musicMood,
      visualGoal: visualGoal(intent, name, beats),
      context: { previous: i ? shorten(texts[i - 1]!, 120) : null, next: texts[i + 1] ? shorten(texts[i + 1]!, 120) : null, section },
      entities: ents.map((e) => ({ name: e.name, kind: e.kind })),
      avoid: [...new Set(beats.flatMap((b) => b.avoid))],
      sfxDirection: sfx.why,
      transitionReason: tr.why,
      memeReason,
      beats: beats.map(({ start, end, text: t, visualType, focus, description, queries, cut }) => ({ start, end, text: t, visualType, focus, description, queries, cut })),
    };
    out.set(s.sceneId, { storyboard, beats, sfx: sfx.cues, transition: tr.t, text: text2, memeAllowed: memeOk });
  });
  return out;
}

function visualGoal(intent: EditorialIntent, name: string | null, beats: PlannedBeat[]): string {
  const kinds = [...new Set(beats.map((b) => b.visualType.replace(/_/g, " ")))].join(", ");
  const who = name ? ` centred on ${name}` : "";
  switch (intent) {
    case "climax":
      return `Rapid, high-impact sequence${who}: ${kinds}`;
    case "buildup":
      return `Tension rising${who}; quicker cuts and darker imagery: ${kinds}`;
    case "aftermath":
      return `Let the moment land; slower, reflective imagery: ${kinds}`;
    case "conflict":
      return `Show the two sides of the conflict${who}: ${kinds}`;
    case "historical_event":
      return `Evidence of the actual event${who}: ${kinds}`;
    case "political":
      return `Ground the politics in real parties, places and people: ${kinds}`;
    case "explanation":
      return `Clarify the idea with concrete context: ${kinds}`;
    default:
      return `Support the narration${who}: ${kinds}`;
  }
}
