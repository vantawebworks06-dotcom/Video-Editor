/**
 * The project's editorial bible: the user's VIDEO TOPIC and context turned into the global
 * context every stage uses — entity linking, queries, relevance (topic score), music and review.
 * Built deterministically from the topic text, the narration and the linked entities.
 */
import type { EntityIndex } from "./entities";

export interface EditorialBible {
  topic: string;
  context: string;
  /** Key subjects of the topic ("Gully Gaza rivalry", "Jamaican dancehall"). */
  primarySubjects: string[];
  geography: string[];
  timePeriod: { from: number; to: number } | null;
  importantEntities: string[];
  /** Topic vocabulary: lower-case term → weight. An asset's topic relevance is judged against it. */
  vocabulary: Map<string, number>;
  /** 1-3 short words that keep generic searches on topic ("dancehall", "Jamaica"). */
  anchors: string[];
  /** Proper names from the topic that are the story's own terms ("Gully", "Gaza"). */
  storyTerms: string[];
  tone: string;
  audience: string;
}

const STOP = new Set(
  "a an the and or but of in on at to for with from by as is are was were be been being this that these those it its into over under about how what why who whom which when where their there they them his her he she we our you your i me my not no yes so if then than also just only even very more most much many some any all each every other such own same too can could would should will may might must do does did done has have had having video documentary in-depth depth indepth youtube audience focus primarily intended story episode part involved developed affected impact major events escalated artists artist".split(
    " ",
  ),
);

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

/** Capitalised runs in the topic ("Gully Gaza", "Jamaican"), plus the noun that follows a subject adjective. */
function subjects(topic: string): string[] {
  const out: string[] = [];
  const re = /(\p{Lu}[\p{L}'-]+(?:\s+\p{Lu}[\p{L}'-]+)*)(?:\s+(\p{Ll}[\p{L}'-]{3,}))?/gu;
  for (const m of topic.matchAll(re)) {
    const head = m[1]!.trim();
    const tail = m[2] && !STOP.has(m[2].toLowerCase()) ? m[2] : "";
    const phrase = `${head}${tail ? ` ${tail}` : ""}`.trim();
    if (phrase.split(/\s+/).every((w) => STOP.has(w.toLowerCase()))) continue;
    if (/^(An|A|The|This|It)$/i.test(head)) continue;
    out.push(phrase);
  }
  return [...new Set(out)].slice(0, 6);
}

export function buildBible(topic: string, context: string, index: EntityIndex, narration: string): EditorialBible {
  const vocabulary = new Map<string, number>();
  const add = (w: string, weight: number) => {
    const k = w.toLowerCase();
    if (k.length < 3 || STOP.has(k)) return;
    vocabulary.set(k, Math.max(vocabulary.get(k) ?? 0, weight));
  };
  for (const w of words(topic)) add(w, 3);
  for (const w of words(context)) add(w, 2);
  const important = index.entities.filter((e) => e.kind !== "term" || e.description?.startsWith("story term")).sort((a, b) => b.mentions - a.mentions);
  for (const e of important.slice(0, 12)) {
    for (const w of words(e.name)) add(w, e.kind === "person" ? 3 : 2);
    for (const a of e.aliases) if (a.split(" ").length === 1) add(a, 2);
    // What the linked entities are ("Jamaican dancehall deejay") says what the topic's world is.
    if (e.description && e.mentions >= 2) for (const w of words(e.description)) if (!/^\d/.test(w) && w !== "born") add(w, 1);
  }
  const geography = [...new Set([...(index.country ? [index.country] : []), ...index.entities.filter((e) => e.kind === "place").map((e) => e.name)])];
  for (const g of geography) for (const w of words(g)) add(w, 3);
  // Demonyms of the story's country ("Jamaican") count like the country.
  if (index.country) add(`${index.country}n`, 3);

  const years = [...`${topic} ${context} ${narration}`.matchAll(/\b(1[89]\d\d|20[0-3]\d)\b/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  const timePeriod = years.length ? { from: years[Math.floor(years.length * 0.1)]!, to: years[Math.floor(years.length * 0.9)]! } : null;

  // Anchors: the topic's genre/subject word(s) most shared with the entities' world, plus the place.
  // (Places and demonyms are geography, not the genre: "Jamaican" must not become the anchor.)
  const placeStem = (w: string) => geography.some((g) => w.startsWith(g.toLowerCase().slice(0, Math.max(4, g.length - 1))));
  const scored = [...vocabulary.entries()].filter(([w]) => !placeStem(w) && !/^\p{Lu}/u.test(w));
  const descWords = new Set(important.flatMap((e) => (e.description ? words(e.description) : [])));
  const genre = scored.filter(([w]) => descWords.has(w) && words(topic).includes(w)).sort((a, b) => b[1] - a[1]).map(([w]) => w);
  const anchors = [...new Set([...genre.slice(0, 1), ...(index.country ? [index.country] : [])])];

  const storyTerms = [...new Set([...index.entities.filter((e) => e.description?.startsWith("story term")).map((e) => e.name)])];
  const tone = /\b(comed|funny|humou?r|meme)/i.test(`${topic} ${context}`) ? "light documentary" : /\b(tragic|death|crime|murder|war|violence)/i.test(`${topic} ${context}`) ? "serious documentary" : "documentary";
  const audience = context.match(/\b(youtube|tiktok|instagram|tv|broadcast|classroom|students)\b/i)?.[1] ?? "YouTube";
  return {
    topic,
    context,
    primarySubjects: subjects(topic),
    geography,
    timePeriod,
    importantEntities: important.slice(0, 10).map((e) => e.name),
    vocabulary,
    anchors,
    storyTerms,
    tone,
    audience,
  };
}

/** A serialisable summary (stored on the job result and shown in the editor). */
export function bibleSummary(b: EditorialBible) {
  return {
    topic: b.topic,
    primarySubjects: b.primarySubjects,
    geography: b.geography,
    timePeriod: b.timePeriod,
    importantEntities: b.importantEntities,
    anchors: b.anchors,
    tone: b.tone,
    audience: b.audience,
    vocabulary: [...b.vocabulary.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([w]) => w),
  };
}
