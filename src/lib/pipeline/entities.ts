/**
 * Entity understanding for the editorial storyboard: who, where, what and when the narration is
 * about. Mentions are pulled from the narration, then linked to Wikipedia (keyless, typo-tolerant
 * search) — which both corrects speech-recognition errors ("Vibes Cartel" → Vybz Kartel,
 * "Portmoor" → Portmore) and says what each entity is ("Jamaican deejay" → person). Unlinked
 * mentions are fuzzy-matched against the articles the main entities link to ("Baudiciller" →
 * Bounty Killer). Everything degrades gracefully: offline, the raw mentions are used as-is.
 */
import { stableHash, type SearchCache } from "@/lib/media/cache";
import { fetchJson } from "@/lib/media/providers/http";

export type EntityKind = "person" | "place" | "organization" | "event" | "work" | "term";

export interface Entity {
  /** Display/search name, e.g. "Vybz Kartel", "Portmore" (Wikipedia title without the "(singer)" part). */
  name: string;
  kind: EntityKind;
  /** Wikipedia short description ("Jamaican deejay"), when linked. */
  description: string | null;
  wikiTitle: string | null;
  /** Surface forms as they appear in the narration (lower-cased), used to find mentions. */
  aliases: string[];
  mentions: number;
}

export interface EntityIndex {
  entities: Entity[];
  /** Country/region the story is set in (for disambiguating generic queries). */
  country: string | null;
  /** Subject words from the project title and narration ("gaza", "gully", "dancehall"). */
  topic: string[];
  /** The story's main people (most mentioned), shown when a line is about "the rivalry" itself. */
  cast: Entity[];
  /** Entities mentioned in a text, in order of first appearance. */
  find(text: string): Entity[];
}

const WIKI = "https://en.wikipedia.org/w/api.php";

const COMMON_CAPS = new Set(
  "the a an and but so or if then when while this that these those it its he she they we you i his her their our your my me him them us there here what which who whom whose how why where yes no not now just also after before because by in on at to for from of with as into over under about than until since during both each every some any all most many more much very one two three first last next another such own same other only even still yet again once however eventually suddenly meanwhile instead finally later today tonight tomorrow yesterday mr mrs ms dr st".split(
    " ",
  ),
);
const MONTHS = /^(January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/;
const TITLE_WORDS = /^(Prime|Minister|President|Mayor|Governor|King|Queen|Prince|Princess|Sir|Lady|Lord|General|Captain)$/;

export const KNOWN_COUNTRIES =
  /\b(Jamaica|Trinidad|Barbados|Haiti|Cuba|Bahamas|Guyana|Nigeria|Ghana|Kenya|South Africa|England|Britain|United Kingdom|Ireland|Scotland|France|Germany|Spain|Italy|Portugal|Russia|Ukraine|China|Japan|Korea|India|Pakistan|Brazil|Mexico|Canada|United States|America|Australia|Egypt|Israel|Iran|Iraq|Turkey)\b/g;

// ---------------------------------------------------------------------------
// String similarity (speech-recognition errors are mostly phonetic)
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

/** Rough phonetic skeleton: similar-sounding spellings collapse to the same key. */
export function skeleton(s: string): string {
  let t = norm(s)
    .replace(/ph/g, "f")
    .replace(/ck|q|c(?=[aou])|c$/g, "k")
    .replace(/c/g, "s")
    .replace(/z/g, "s")
    .replace(/v/g, "b")
    .replace(/dh|th/g, "d")
    .replace(/g(?=[ei])/g, "j")
    .replace(/y/g, "i");
  const first = t[0] ?? "";
  t = first + t.slice(1).replace(/[aeiouhw]/g, "");
  return t.replace(/(.)\1+/g, "$1");
}

function jaroWinkler(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true;
      m++;
      break;
    }
  }
  if (!m) return 0;
  let k = 0;
  let tr = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) tr++;
    k++;
  }
  const jaro = (m / a.length + m / b.length + (m - tr / 2) / m) / 3;
  let p = 0;
  while (p < 4 && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

/** 0-1: how likely `mention` is a (mis)spelling of `name`. */
export function nameSimilarity(mention: string, name: string): number {
  const a = norm(mention);
  const b = norm(name);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const spelled = jaroWinkler(a, b);
  const sa = skeleton(mention);
  const sb = skeleton(name);
  const sounded = sa.length >= 2 && sb.length >= 2 ? jaroWinkler(sa, sb) : 0;
  return Math.max(spelled, sounded * 0.97) * (0.75 + 0.25 * lenRatio);
}

// ---------------------------------------------------------------------------
// Mention extraction
// ---------------------------------------------------------------------------

interface Mention {
  text: string;
  count: number;
  acronym: boolean;
  /** Seen at least once away from a sentence start (so it is capitalised for a reason). */
  midSentence: boolean;
}

export function extractMentions(text: string): Mention[] {
  const found = new Map<string, Mention>();
  const add = (t: string, mid: boolean, acronym = false) => {
    const key = t.toLowerCase();
    const m = found.get(key) ?? { text: t, count: 0, acronym, midSentence: false };
    m.count++;
    m.midSentence ||= mid;
    found.set(key, m);
  };
  const tokens = text.split(/(\s+)/);
  let run: string[] = [];
  let runMid = false;
  let sentenceStart = true;
  const flush = () => {
    // Trim leading/trailing common words ("The Alliance" keeps "Alliance" as the core).
    while (run.length && COMMON_CAPS.has(run[0]!.toLowerCase())) run.shift();
    while (run.length && COMMON_CAPS.has(run.at(-1)!.toLowerCase())) run.pop();
    const words = run.filter((w) => !MONTHS.test(w) && !TITLE_WORDS.test(w));
    if (words.length && words.join(" ").length >= 3) add(words.join(" "), runMid);
    run = [];
    runMid = false;
  };
  for (const raw of tokens) {
    if (!raw.trim()) continue;
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’-]+$/gu, "").replace(/['’]s$/, "");
    const endsSentence = /[.!?]["')\]]*$/.test(raw);
    const breaks = /[,;:)"]$/.test(raw) || endsSentence;
    if (/['’](d|m|ve|ll|re|t)$/i.test(word)) {
      flush(); // contractions ("I'd", "It'll") are never names
    } else if (/^[A-Z]{2,5}$/.test(word)) {
      flush();
      add(word, true, true);
    } else if (/^\p{Lu}[\p{L}'’-]+$/u.test(word) && !(sentenceStart && COMMON_CAPS.has(word.toLowerCase()))) {
      if (!run.length) runMid = !sentenceStart;
      run.push(word);
      if (breaks) flush();
    } else {
      flush();
    }
    sentenceStart = endsSentence;
  }
  flush();
  return [...found.values()].filter((m) => m.acronym || m.midSentence || m.count >= 2);
}

// ---------------------------------------------------------------------------
// Wikipedia linking
// ---------------------------------------------------------------------------

interface WikiHit {
  title: string;
}

async function cached<T>(cache: SearchCache | undefined, key: unknown, fn: () => Promise<T>): Promise<T> {
  const k = stableHash({ wiki: key });
  const hit = cache ? await cache.get(k).catch(() => null) : null;
  if (hit) return hit.results as unknown as T;
  const value = await fn();
  await cache?.set(k, { provider: "wikipedia", query: JSON.stringify(key).slice(0, 200), results: value as never, timestamp: Date.now() }).catch(() => undefined);
  return value;
}

async function wikiSearch(q: string, cache?: SearchCache): Promise<{ hits: WikiHit[]; suggestion: string | null }> {
  return cached(cache, ["search", q], async () => {
    const url = `${WIKI}?action=query&format=json&list=search&srlimit=5&srinfo=suggestion&srprop=&srsearch=${encodeURIComponent(q)}`;
    const j = await fetchJson<{ query?: { search?: WikiHit[]; searchinfo?: { suggestion?: string } } }>("wikipedia", url, { timeoutMs: 8000 });
    return { hits: j.query?.search ?? [], suggestion: j.query?.searchinfo?.suggestion ?? null };
  });
}

async function wikiDescriptions(titles: string[], cache?: SearchCache): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < titles.length; i += 40) {
    const batch = titles.slice(i, i + 40);
    const got = await cached(cache, ["desc", batch], async () => {
      const url = `${WIKI}?action=query&format=json&redirects=1&prop=description&titles=${encodeURIComponent(batch.join("|"))}`;
      const j = await fetchJson<{ query?: { pages?: Record<string, { title: string; description?: string }>; redirects?: { from: string; to: string }[] } }>("wikipedia", url, { timeoutMs: 8000 });
      const map: [string, string][] = [];
      for (const p of Object.values(j.query?.pages ?? {})) if (p.description) map.push([p.title, p.description]);
      for (const r of j.query?.redirects ?? []) {
        const d = map.find(([t]) => t === r.to)?.[1];
        if (d) map.push([r.from, d]);
      }
      return map;
    });
    for (const [t, d] of got) out.set(t, d);
  }
  return out;
}

async function wikiLinks(title: string, cache?: SearchCache): Promise<string[]> {
  return cached(cache, ["links", title], async () => {
    const url = `${WIKI}?action=query&format=json&redirects=1&prop=links&pllimit=max&plnamespace=0&titles=${encodeURIComponent(title)}`;
    const j = await fetchJson<{ query?: { pages?: Record<string, { links?: { title: string }[] }> } }>("wikipedia", url, { timeoutMs: 8000 });
    return Object.values(j.query?.pages ?? {}).flatMap((p) => (p.links ?? []).map((l) => l.title));
  });
}

const baseTitle = (t: string) => t.replace(/\s*\(.*\)$/, "").replace(/,.*$/, "").replace(/^The\s+/, "").trim();

const DEMONYMS =
  /\b(American|British|English|Irish|Scottish|Welsh|French|German|Spanish|Italian|Portuguese|Russian|Ukrainian|Chinese|Japanese|Korean|Indian|Pakistani|Filipino|Philippine|Lithuanian|Polish|Dutch|Belgian|Swedish|Norwegian|Danish|Finnish|Greek|Turkish|Israeli|Palestinian|Iranian|Iraqi|Egyptian|Nigerian|Ghanaian|Kenyan|South African|Australian|Canadian|Mexican|Brazilian|Argentine|Kosovo|Serbian|Croatian|Czech|Hungarian|Romanian|Bulgarian|Vietnamese|Thai|Indonesian|Malaysian|Trinidadian|Barbadian|Haitian|Cuban)\b/;

// Extra country/region names used only to recognise "this article is about somewhere else".
const OTHER_PLACES =
  /\b(Lithuania|Latvia|Estonia|Poland|Netherlands|Belgium|Sweden|Norway|Denmark|Finland|Greece|Austria|Switzerland|Czech|Slovakia|Hungary|Romania|Bulgaria|Serbia|Croatia|Bosnia|Kosovo|Albania|Philippines|Vietnam|Thailand|Indonesia|Malaysia|Singapore|Taiwan|Argentina|Chile|Peru|Colombia|Venezuela|Ecuador|Bolivia|New Zealand|Morocco|Algeria|Tunisia|Ethiopia|Somalia|Sudan|Uganda|Tanzania|Zimbabwe|Zambia|Saudi|Syria|Lebanon|Jordan|Afghanistan|Bangladesh|Sri Lanka|Nepal|UK|New York|NYC|Queens|Brooklyn|Manhattan|Bronx|Okinawa|CDMX|Mexico City|Bristol|Stokes Croft|Iowa|Vermont|Kansas|Missouri|Kentucky|Tennessee|Carolina|Maine|Massachusetts|Pennsylvania|Wisconsin|Minnesota|Nebraska|Nevada|Utah|Idaho|Montana|Wyoming|Dakota|Oklahoma|Arkansas|Louisiana|Mississippi|Indiana|Maryland|Delaware|New Jersey|Connecticut|New Hampshire|Rhode Island|Hawaii|New Mexico|Alabama|Alaska|Arizona|California|Colorado|Florida|Georgia|Illinois|Michigan|Ohio|Oregon|Texas|Virginia|Washington)\b/;

/**
 * How well a Wikipedia description fits the story's setting: +0.3 when it names the story's
 * country, −0.4 for another country, −1 for disambiguation pages (never a real entity).
 */
export function contextFit(description: string | null, country: string | null): number {
  if (!description) return 0;
  if (/disambiguation|topics referred to|may refer to|index of|list of/i.test(description)) return -1;
  const stem = country ? country.toLowerCase().slice(0, Math.max(4, country.length - 1)) : null;
  const d = description.toLowerCase();
  if (stem && d.includes(stem)) return 0.3;
  const other = new RegExp(`(?:${KNOWN_COUNTRIES.source})`).test(description) || DEMONYMS.test(description) || OTHER_PLACES.test(description);
  if (country && other) return -0.4;
  return 0;
}

export function kindFromDescription(d: string | null, fallback: EntityKind): EntityKind {
  if (!d) return fallback;
  if (/\b(genre|style of music|music style|language|dialect|creole)\b/i.test(d)) return "term";
  if (/\b(singer|deejay|dj|rapper|musician|artist|producer|actor|actress|politician|footballer|cricketer|athlete|player|minister|president|journalist|writer|author|businessman|activist|born|died)\b/i.test(d)) return "person";
  if (/\b(newspaper|political party|party|company|band|group|record label|label|organi[sz]ation|agency|government|police|force|broadcaster|station|network|team|club|university|church|gang|crew|collective)\b/i.test(d)) return "organization";
  if (/\b(festival|concert|election|war|battle|riot|protest|massacre|incident|event|tournament|championship|ceremony|show)\b/i.test(d)) return "event";
  if (/\b(song|single|album|film|book|mixtape|episode|series)\b/i.test(d)) return "work";
  if (/\b(city|town|country|nation|island|parish|district|community|neighbourhood|neighborhood|capital|village|region|state|province|county|municipality|suburb|area|street|road|settlement)\b/i.test(d)) return "place";
  return fallback;
}

export interface EntityOptions {
  cache?: SearchCache;
  /** Max mentions to look up on Wikipedia (each is one small request). */
  maxLookups?: number;
  log?: (m: string) => void;
  signal?: AbortSignal;
}

/** Build the entity index for a whole narration (call once per project). */
export async function buildEntityIndex(fullText: string, projectTitle: string, opts: EntityOptions = {}): Promise<EntityIndex> {
  const log = opts.log ?? (() => undefined);
  const mentions = extractMentions(fullText).sort((a, b) => b.count - a.count);

  // Where the story happens: the most mentioned known country.
  const countryCounts = new Map<string, number>();
  for (const m of fullText.matchAll(KNOWN_COUNTRIES)) countryCounts.set(m[1]!, (countryCounts.get(m[1]!) ?? 0) + 1);
  const country = [...countryCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const titleTerms = projectTitle
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2 && !["the", "and", "part", "episode", "documentary", "story", "video"].includes(w));
  const context = [...new Set([...titleTerms, country?.toLowerCase()].filter(Boolean))].join(" ");

  const entities: Entity[] = [];
  const byTitle = new Map<string, Entity>();
  const unresolved: Mention[] = [];
  const addEntity = (m: Mention, e: Omit<Entity, "aliases" | "mentions">) => {
    const key = e.wikiTitle ?? e.name.toLowerCase();
    const existing = byTitle.get(key);
    if (existing) {
      existing.aliases = [...new Set([...existing.aliases, m.text.toLowerCase()])];
      existing.mentions += m.count;
      return existing;
    }
    const ent: Entity = { ...e, aliases: [m.text.toLowerCase()], mentions: m.count };
    byTitle.set(key, ent);
    entities.push(ent);
    return ent;
  };

  // 0. Words from the project title are the story's own terms ("Gaza", "Gully"): never linked
  //    (Wikipedia's "Gaza" is the Gaza Strip), and misheard variants ("Goli") fold into them.
  const storyTerms = new Map<string, Entity>();
  const remaining: Mention[] = [];
  const countryStem = country ? country.toLowerCase().slice(0, Math.max(4, country.length - 1)) : null;
  for (const m of mentions) {
    if (countryStem && m.text.toLowerCase() !== country!.toLowerCase() && m.text.toLowerCase().startsWith(countryStem) && !m.text.includes(" ")) continue;
    const term = titleTerms.find((t) => m.text.split(" ").length === 1 && nameSimilarity(m.text, t) >= 0.86);
    if (!term) {
      remaining.push(m);
      continue;
    }
    const e = storyTerms.get(term) ?? { name: term[0]!.toUpperCase() + term.slice(1), kind: "term" as EntityKind, description: "story term (project title)", wikiTitle: null, aliases: [term], mentions: 0 };
    e.aliases = [...new Set([...e.aliases, m.text.toLowerCase()])];
    e.mentions += m.count;
    storyTerms.set(term, e);
  }
  for (const e of storyTerms.values()) {
    entities.push(e);
    byTitle.set(e.name.toLowerCase(), e);
  }

  // 1. Link mentions to Wikipedia. Candidates from a few searches are judged on how much the
  //    title resembles the mention AND whether the article belongs to this story's world
  //    ("Movado" → Mavado the Jamaican singer, not the American watchmaker).
  const lookups = remaining.slice(0, opts.maxLookups ?? 45);
  const candidates = new Map<Mention, Set<string>>();
  let online = true;
  const queue = [...lookups];
  const worker = async () => {
    while (online && queue.length) {
      opts.signal?.throwIfAborted();
      const m = queue.shift()!;
      const set = new Set<string>();
      try {
        const r1 = await wikiSearch(`${m.text} ${context}`.trim(), opts.cache);
        r1.hits.slice(0, 4).forEach((h) => set.add(h.title));
        if (r1.suggestion) (await wikiSearch(r1.suggestion, opts.cache)).hits.slice(0, 3).forEach((h) => set.add(h.title));
        (await wikiSearch(m.text, opts.cache)).hits.slice(0, 3).forEach((h) => set.add(h.title));
      } catch (err) {
        log(`wikipedia lookup failed (${(err as Error).message}); continuing without entity linking`);
        online = false;
      }
      candidates.set(m, set);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  const allTitles = [...new Set([...candidates.values()].flatMap((s) => [...s]))];
  const descs = online && allTitles.length ? await wikiDescriptions(allTitles, opts.cache).catch(() => new Map<string, string>()) : new Map<string, string>();
  const fit = (d: string | null) => contextFit(d, country);
  for (const m of remaining) {
    let best: { title: string; score: number } | null = null;
    for (const title of candidates.get(m) ?? []) {
      const d = descs.get(title) ?? null;
      const ctxScore = fit(d);
      if (ctxScore <= -1) continue; // disambiguation page / clearly another country's
      const base = baseTitle(title);
      const single = m.text.split(" ").length === 1;
      const surname = base.split(" ").at(-1) ?? base;
      let sim = Math.max(nameSimilarity(m.text, base), single && base.includes(" ") ? nameSimilarity(m.text, surname) * 0.93 : 0);
      if (m.acronym) {
        const initials = base.split(/\s+/).filter((w) => /^\p{Lu}/u.test(w)).map((w) => w[0]).join("");
        sim = initials === m.text ? 0.95 : 0;
      }
      const kind = kindFromDescription(d, "term");
      if (ctxScore < 0 && !(sim >= 0.97 && /\b(newspaper|magazine|broadcaster|news agency|television)\b/i.test(d ?? ""))) continue;
      // A generic concept ("Coalition of individuals…") is not an entity of this story.
      if (kind === "term" && ctxScore <= 0) continue;
      // Partial (surname/acronym) matches must belong to the story's world.
      if ((m.acronym || sim < 0.97) && ctxScore < 0.2 && kind !== "place") continue;
      if (sim < (m.text.length <= 5 ? 0.9 : m.text.includes(" ") ? 0.9 : 0.8)) continue;
      const score = sim + ctxScore;
      if (!best || score > best.score) best = { title, score };
    }
    if (!best) {
      unresolved.push(m);
      continue;
    }
    const description = descs.get(best.title) ?? null;
    addEntity(m, { name: baseTitle(best.title), kind: kindFromDescription(description, "term"), description, wikiTitle: best.title });
  }

  // 2. Gazetteer: names the main linked entities' articles link to ("Bounty Killer",
  //    "Portmore, Jamaica", "Jamaica Gleaner"). Unlinked mentions fuzzy-match against it.
  const hubs = entities.filter((e) => e.kind === "person" || e.kind === "organization").sort((a, b) => b.mentions - a.mentions).slice(0, 3);
  const gazetteer = new Set<string>();
  if (online) {
    for (const h of hubs) for (const t of await wikiLinks(h.wikiTitle!, opts.cache).catch(() => [])) gazetteer.add(t);
  }
  const known = [...entities.flatMap((e) => (e.wikiTitle ? [e.wikiTitle] : [])), ...gazetteer];
  const mainPeople = new Set(entities.filter((e) => e.kind === "person" && e.mentions >= 5).map((e) => e.wikiTitle));
  const matches: { m: Mention; title: string }[] = [];
  for (const m of unresolved) {
    let best: { title: string; s: number } | null = null;
    for (const t of known) {
      const base = baseTitle(t);
      const parts = base.split(" ");
      const s = Math.max(
        nameSimilarity(m.text, base),
        // "Gleaner" ↔ "Jamaica Gleaner", "Kartel" ↔ "Vybz Kartel": match on the distinctive last word.
        parts.length > 1 && m.text.split(" ").length === 1 ? nameSimilarity(m.text, parts.at(-1)!) * 0.93 : 0,
      );
      const boosted = mainPeople.has(t) ? s + 0.06 : s;
      if (!best || boosted > best.s) best = { title: t, s: boosted };
    }
    if (best && best.s >= 0.84) matches.push({ m, title: best.title });
  }
  const gdescs = matches.length ? await wikiDescriptions([...new Set(matches.map((x) => x.title))], opts.cache).catch(() => new Map<string, string>()) : new Map<string, string>();
  const stillUnresolved = new Set(unresolved);
  for (const { m, title } of matches) {
    const existing = byTitle.get(title);
    const description = existing?.description ?? gdescs.get(title) ?? null;
    if (!existing && contextFit(description, country) < 0) continue;
    const qualifier = title.match(/(([^)]+))$/)?.[1] ?? null;
    addEntity(m, { name: baseTitle(title), kind: existing?.kind ?? kindFromDescription(description ?? qualifier, qualifier ? "organization" : "term"), description: description ?? qualifier, wikiTitle: title });
    stillUnresolved.delete(m);
  }

  // 3. Whatever is left keeps its narration spelling (still better than a generic keyword).
  for (const m of stillUnresolved) {
    if (m.count < 2 && !m.acronym) continue;
    const isCountry = new RegExp(`^(?:${KNOWN_COUNTRIES.source})$`).test(m.text);
    // Unlinked acronyms are often mis-heard ("BNP" for PNP): keep them as plain terms, never as
    // something to search for on their own (it finds Nick Griffin and BNP Paribas).
    addEntity(m, { name: m.text, kind: isCountry ? "place" : "term", description: isCountry ? null : "unresolved mention", wikiTitle: null });
  }

  // Aliases also cover each person's surname, so "Kartel … he" style references resolve.
  for (const e of entities) {
    if (e.kind === "person" && e.name.includes(" ")) e.aliases.push(e.name.split(" ").at(-1)!.toLowerCase());
    e.aliases.push(e.name.toLowerCase());
    e.aliases = [...new Set(e.aliases)].filter((a) => a.length >= 3);
  }
  log(`entities: ${entities.map((e) => `${e.name}[${e.kind}]`).join(", ")}`);

  const topic = [...new Set([...titleTerms])];
  const cast = entities.filter((e) => e.kind === "person" && e.mentions >= 3).sort((a, b) => b.mentions - a.mentions).slice(0, 3);
  const index: EntityIndex = {
    entities,
    country,
    topic,
    cast,
    find(text: string) {
      const lower = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}'\s-]/gu, " ")} `;
      const hits: { e: Entity; at: number }[] = [];
      for (const e of entities) {
        let at = -1;
        for (const a of e.aliases) {
          const i = lower.search(new RegExp(`[\\s-]${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:'s)?[\\s-]`));
          if (i >= 0 && (at < 0 || i < at)) at = i;
        }
        if (at >= 0) hits.push({ e, at });
      }
      return hits.sort((a, b) => a.at - b.at).map((h) => h.e);
    },
  };
  return index;
}

/** Matches country/region names other than the story's own (for spotting off-topic media). */
export function foreignRegex(country: string | null): RegExp {
  const skip = country?.toLowerCase().slice(0, Math.max(4, country.length - 1)) ?? "\u0000";
  const words = [KNOWN_COUNTRIES.source, DEMONYMS.source, OTHER_PLACES.source]
    .join("|")
    .replaceAll("\\b", "")
    .replace(/[()]/g, "")
    .split("|")
    .filter((w) => w && !w.toLowerCase().startsWith(skip) && !/^(America|American|United States)$/.test(w));
  return new RegExp(`\\s(${words.join("|")})\\s`, "i");
}
