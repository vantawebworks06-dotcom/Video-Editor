/**
 * Sentence-level extraction that needs no network: dates, statistics, quotes, factual claims,
 * references to media (interviews, posts, documents…) and topic words. Deliberately generic —
 * nothing here knows about any particular subject; lexicons describe kinds of things, not topics.
 */
import type { DateMention, Reference, Statistic } from "./types";

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH = "(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?";
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, dozen: 12, "a": 1, "an": 1,
};
const SCALE: Record<string, number> = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, billion: 1e9, bn: 1e9, b: 1e9, trillion: 1e12 };

const monthIndex = (m: string) => MONTH_NAMES.findIndex((n) => n.startsWith(m.toLowerCase().replace(".", "").slice(0, 3)));
const pad = (n: number) => String(n).padStart(2, "0");

/** Dates in a sentence, most specific first. `currentYear` bounds plausible years. */
export function extractDates(text: string, currentYear = new Date().getFullYear()): DateMention[] {
  const out: DateMention[] = [];
  const taken: [number, number][] = [];
  const free = (i: number, len: number) => !taken.some(([a, b]) => i < b && i + len > a);
  const push = (m: RegExpMatchArray, d: DateMention) => {
    if (!free(m.index!, m[0].length)) return;
    taken.push([m.index!, m.index! + m[0].length]);
    out.push(d);
  };
  // January 4, 2011 / Jan 4th 2011
  for (const m of text.matchAll(new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "g"))) {
    const y = Number(m[3]);
    push(m, { text: m[0], year: y, iso: `${y}-${pad(monthIndex(m[1]!) + 1)}-${pad(Number(m[2]))}`, kind: "absolute" });
  }
  // 4 January 2011
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH},?\\s+(\\d{4})\\b`, "g"))) {
    const y = Number(m[3]);
    push(m, { text: m[0], year: y, iso: `${y}-${pad(monthIndex(m[2]!) + 1)}-${pad(Number(m[1]))}`, kind: "absolute" });
  }
  // January 2011
  for (const m of text.matchAll(new RegExp(`\\b${MONTH}\\s+(\\d{4})\\b`, "g"))) {
    push(m, { text: m[0], year: Number(m[2]), iso: null, kind: "absolute" });
  }
  // the 1990s / the '90s / the nineties
  for (const m of text.matchAll(/\b(?:the\s+)?(?:early\s+|mid\s+|late\s+|mid-)?((?:1[0-9]|20)\d0)s\b/gi)) {
    push(m, { text: m[0], year: Number(m[1]), iso: null, kind: "decade" });
  }
  for (const m of text.matchAll(/\b(?:the\s+)?['’](\d)0s\b/gi)) {
    const d = Number(m[1]);
    push(m, { text: m[0], year: d >= 3 ? 1900 + d * 10 : 2000 + d * 10, iso: null, kind: "decade" });
  }
  // Bare years: 1998, 2005 — only plausible ones, not "2000 people".
  for (const m of text.matchAll(/\b(1[0-9]\d\d|20\d\d)\b(?!\s*(?:%|percent|people|men|women|fans|dollars|copies|units|votes|troops|soldiers|miles|km|kilometres|kilometers|feet|metres|meters|times))/g)) {
    const y = Number(m[1]);
    if (y > currentYear + 1 || y < 1000) continue;
    push(m, { text: m[0], year: y, iso: null, kind: "absolute" });
  }
  // Relative time jumps: three years later, a decade later, months after
  for (const m of text.matchAll(/\b((?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|several|a few|many)\s+(?:years?|months?|weeks?|days?|decades?|hours?))\s+(later|after|earlier|before|on|ago)\b/gi)) {
    push(m, { text: m[0], year: null, iso: null, kind: "relative" });
  }
  for (const m of text.matchAll(/\b(fast[- ]forward(?: to)?|the (?:next|following) (?:day|morning|week|month|year))\b/gi)) {
    push(m, { text: m[0], year: null, iso: null, kind: "relative" });
  }
  return out;
}

function parseNumber(raw: string): number | null {
  const s = raw.toLowerCase().replace(/,/g, "").trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (NUMBER_WORDS[s] !== undefined) return NUMBER_WORDS[s]!;
  const parts = s.split(/[\s-]+/);
  if (parts.every((p) => NUMBER_WORDS[p] !== undefined)) return parts.reduce((a, p) => (NUMBER_WORDS[p]! >= 100 ? Math.max(1, a) * NUMBER_WORDS[p]! : a + NUMBER_WORDS[p]!), 0);
  return null;
}

// Nouns that turn a number into a statistic ("12 countries", "3,000 people") vs. filler ("two of them").
const STAT_NOUN =
  /^(percent|per cent|%|people|persons|fans|followers|subscribers|views|streams|downloads|copies|units|records|albums|songs|singles|awards|countries|nations|cities|states|stores|locations|employees|workers|staff|members|users|customers|votes|voters|seats|deaths|dead|victims|casualties|injured|arrests|cases|homicides|murders|shootings|soldiers|troops|ships|planes|cars|miles|kilometres|kilometers|km|metres|meters|feet|tons|tonnes|acres|hectares|dollars|euros|pounds|yen|times|goals|points|wins|titles|championships|medals|games|matches|years|hours|minutes|days|children|students|patients|species|languages|books|films|episodes|companies|products|devices|users)$/i;

/** Numbers that carry information (amounts, counts, percentages) — years are dates, not statistics. */
export function extractStatistics(text: string): Statistic[] {
  const out: Statistic[] = [];
  const re = /(\$|€|£|US\$)?\b(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|a hundred|a thousand|dozens?)\s*(thousand|million|billion|trillion|bn|k|m)?\b\s*(%|percent|per cent)?\s*([A-Za-z]+)?/gi;
  for (const m of text.matchAll(re)) {
    const [whole, currency, num, scale, pct, noun] = m;
    let value = parseNumber(num!.replace(/^dozens?$/i, "12"));
    if (value === null) continue;
    if (!currency && !pct && !scale && /^\d{4}$/.test(num!) && Number(num) >= 1000 && Number(num) <= 2100 && !(noun && STAT_NOUN.test(noun))) continue; // a year
    if (scale) value *= SCALE[scale.toLowerCase()] ?? 1;
    const isMoney = Boolean(currency) || (noun ? /^(dollars|euros|pounds|yen)$/i.test(noun) : false);
    const unit = pct ? "%" : isMoney ? (currency ?? noun ?? "$") : noun && STAT_NOUN.test(noun) ? noun.toLowerCase() : null;
    if (!unit && !scale) continue; // "two of them" is not a statistic
    // Word numbers below ten with a time unit ("three years") are narrative, not data.
    if (unit && /^(years|hours|minutes|days)$/.test(unit) && value < 10) continue;
    out.push({ text: whole.trim(), value, unit });
  }
  return out;
}

/** Quoted speech or titles: “…”, "…" (≥2 words). */
export function extractQuotes(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[“"]([^”"]{3,300})[”"]/g)) {
    if (m[1]!.trim().split(/\s+/).length >= 2) out.push(m[1]!.trim());
  }
  return out;
}

/** Titles of songs/albums/works near a cue word: album "Kingston Story", the song Romping Shop. */
export function extractWorks(text: string): { title: string; kind: "song" | "album" | "work" }[] {
  const out: { title: string; kind: "song" | "album" | "work" }[] = [];
  const kindOf = (cue: string): "song" | "album" | "work" => (/album|mixtape|lp|ep\b/i.test(cue) ? "album" : /song|single|track|hit|anthem|record|diss/i.test(cue) ? "song" : "work");
  for (const m of text.matchAll(/\b(song|single|track|hit|anthem|record|diss(?: track)?|album|mixtape|LP|EP|film|movie|book|novel|documentary|series|show|podcast)\s*,?\s*(?:called|titled|named)?\s*[“"]([^”"]{2,80})[”"]/gi)) {
    out.push({ title: m[2]!.trim(), kind: kindOf(m[1]!) });
  }
  for (const m of text.matchAll(/[“"]([^”"]{2,80})[”"]\s*,?\s*(?:was|became|is)?\s*(?:a|an|the|his|her|their)?\s*(song|single|track|hit|album|mixtape|film|movie|book)\b/gi)) {
    if (!out.some((w) => w.title === m[1]!.trim())) out.push({ title: m[1]!.trim(), kind: kindOf(m[2]!) });
  }
  // Unquoted: "the album Kingston Story" (capitalised run right after the cue word).
  for (const m of text.matchAll(/\b(?:the|his|her|their|debut|hit)\s+(song|single|album|mixtape|film|movie|book)\s+((?:[A-Z][\w'’-]*\s?){1,6})/g)) {
    const title = m[2]!.trim();
    if (title && !out.some((w) => w.title === title)) out.push({ title, kind: kindOf(m[1]!) });
  }
  return out;
}

export const PLATFORMS: { name: string; re: RegExp }[] = [
  { name: "YouTube", re: /\byoutube\b/i },
  { name: "X (Twitter)", re: /\b(twitter|tweet(?:s|ed)?|x\.com|on x)\b/i },
  { name: "Instagram", re: /\b(instagram|insta|ig live|ig story)\b/i },
  { name: "Facebook", re: /\bfacebook\b/i },
  { name: "TikTok", re: /\btik ?tok\b/i },
  { name: "Reddit", re: /\breddit\b/i },
  { name: "Snapchat", re: /\bsnapchat\b/i },
  { name: "Twitch", re: /\btwitch\b/i },
];

const REF_RULES: [Reference, RegExp][] = [
  ["interview", /\b(interview(?:ed|s)?|sat down with|sit-?down|spoke (?:to|with)|told (?:reporters|the press|journalists)|in conversation with|podcast|talk show|appear(?:ed|ance) on|on (?:the )?air with|q&a|press conference)\b/i],
  ["video", /\b(videos?|footage|clips?|filmed|recorded (?:on camera|a video)|livestream(?:ed)?|live stream|broadcast|aired|televised|camera|documentary|vlog|music video)\b/i],
  ["photo", /\b(photo(?:graph)?s?|pictures?|pictured|snapshots?|images?|portraits?|selfies?|mugshots?)\b/i],
  ["document", /\b(documents?|court (?:records|documents|filings?|papers)|indictment|affidavit|report(?:s)? (?:found|showed|said)|letters?|memos?|contracts?|transcripts?|lawsuits?|filed|patents?|press release|official statement|records show|the report)\b/i],
  ["news", /\b(news|headlines?|reported|reporters?|the press|newspapers?|journalists?|coverage|article|according to|front page|breaking)\b/i],
  ["social", /\b(social media|online|posted|posts?|went viral|viral|trending|hashtags?|followers|comments? section|comment(?:ed|s)? on|timeline|dms?|subtweet(?:ed)?|live on (?:instagram|ig|facebook))\b/i],
  ["performance", /\b(perform(?:ed|ing|ance|ances)?|concerts?|on stage|onstage|festival|tour(?:ed|ing)?|live show|gig|headlin(?:ed|ing)|sound ?clash|stage show)\b/i],
  ["song", /\b(songs?|singles?|tracks?|hits?|lyrics|verse|chorus|riddims?|diss(?: track)?|anthem|released a (?:song|track|single))\b/i],
  ["album", /\b(albums?|mixtapes?|\bEPs?\b|\bLPs?\b|debut record|discography)\b/i],
  ["conflict", /\b(beef|feud(?:ed|ing)?|rival(?:ry|ries|s)?|clash(?:ed|es)?|war(?:s)?|battle(?:d|s)?|fight(?:s|ing)?|fought|conflict|dispute|tensions?|diss(?:ed)?|versus|\bvs\.?|against each other|at odds|fallout|fell out|confrontation)\b/i],
  ["legal", /\b(arrest(?:ed|s)?|charged|charges|convicted|conviction|trial|court|sentenced|sentence|police|detectives?|murder(?:ed)?|jail(?:ed)?|prison|verdict|appeal(?:ed)?|investigat(?:ion|ed|ors)|acquitted|guilty|indicted|lawsuit|sued)\b/i],
  ["announcement", /\b(announc(?:ed|ement|es)|launch(?:ed|es)?|unveil(?:ed|s)?|introduc(?:ed|es)|revealed|press conference|keynote|went public|ipo|acquired|acquisition|merger|partnership)\b/i],
  ["product", /\b(products?|devices?|smartphones?|phones?|apps?|software|platform|model|prototype|version|release)\b/i],
  ["science", /\b(research(?:ers)?|scientists?|study|studies|discover(?:ed|y)|experiments?|laborator(?:y|ies)|theory|physics|chemistry|biology|climate|virus|vaccine|species|telescope|nasa|genome|algorithm)\b/i],
  ["sports", /\b(match(?:es)?|game(?:s)?|season|championships?|league|goals?|scored|coach(?:es)?|teams?|olympics?|world cup|finals?|tournament|athletes?|stadium|playoffs?|knockout|title fight)\b/i],
  ["geography", /\b(mountains?|rivers?|oceans?|seas?|islands?|coast(?:line)?|cit(?:y|ies)|villages?|regions?|borders?|capital|continent|desert|valley|streets?|neighbou?rhoods?|communit(?:y|ies)|parish(?:es)?|district)\b/i],
  ["historical", /\b(histor(?:y|ic|ical)|centur(?:y|ies)|decades? ago|ancient|empire|colonial|independence|revolution|dynasty|medieval|era|world war|the (?:18|19)\d0s)\b/i],
  ["emotional", /\b(tragic|tragedy|heartbreak(?:ing)?|devastat(?:ed|ing)|mourn(?:ed|ing)?|grief|died|death|killed|funeral|tears|cried|shocked|horrified|heartbroken|loss|lost (?:his|her|their) life)\b/i],
];

export function extractReferences(text: string, years: number[], currentYear = new Date().getFullYear()): Reference[] {
  const refs = REF_RULES.filter(([, re]) => re.test(text)).map(([r]) => r);
  // "online"/"posts" alone are weak: a social reference needs people reacting or a platform.
  if (refs.includes("social") && !PLATFORMS.some((p) => p.re.test(text)) && !/\b(fans|people|users|followers|viewers|internet|online|reactions?|reacted|arguing|debated?|comments?)\b/i.test(text)) {
    refs.splice(refs.indexOf("social"), 1);
  }
  if (PLATFORMS.some((p) => p.re.test(text)) && !refs.includes("social")) refs.push("social");
  if (years.some((y) => y <= currentYear - 25) && !refs.includes("historical")) refs.push("historical");
  // "product"/"version"/"release" are too common on their own; keep only next to an announcement.
  if (refs.includes("product") && !refs.includes("announcement")) refs.splice(refs.indexOf("product"), 1);
  return refs;
}

const CLAIM_ALLEGATION = /\b(allegedly|reportedly|accused|alleged|claims?|claimed|rumou?red|was said to|according to|sources say)\b/i;
const CLAIM_ATTRIBUTION = /\b(said|says|told|stated|wrote|tweeted|posted|announced|confirmed|denied|admitted)\b/i;
const CLAIM_FACT = /\b(was|were|became|had|won|sold|earned|made|reached|killed|died|born|founded|arrested|released|signed|built|opened|closed|record|first|largest|biggest|most|only|never|always)\b/i;

/** Factual statements the documentary should be able to source. Opinions and transitions are not claims. */
export function detectClaim(text: string, hasEntity: boolean, stats: Statistic[], dates: DateMention[]): { kind: "factual" | "allegation" | "statistic" | "attribution"; text: string } | null {
  const t = text.trim();
  if (t.split(/\s+/).length < 5) return null;
  if (/\?$/.test(t)) return null;
  if (/^(but|so|and|now|then|well|let'?s|imagine|think about|here'?s)\b/i.test(t) && !stats.length && !dates.some((d) => d.kind !== "relative")) return null;
  if (CLAIM_ALLEGATION.test(t)) return { kind: "allegation", text: t };
  if (stats.length) return { kind: "statistic", text: t };
  if (hasEntity && CLAIM_ATTRIBUTION.test(t)) return { kind: "attribution", text: t };
  if (hasEntity && (dates.some((d) => d.kind !== "relative") || CLAIM_FACT.test(t))) return { kind: "factual", text: t };
  return null;
}

const STOP = new Set(
  "a an the and or but if then so of to in on at by for with from as into onto over under about after before during between through without within across against among around behind beyond near off out up down this that these those there here it its it's he she they we you i his her their our your my me him them us who whom whose which what when where why how is are was were be been being am do does did done has have had having will would shall should can could may might must not no nor only own same than too very just also even still yet ever never again once more most much many some any all each every both either neither such other another one two three first last next new old big small good bad great little long short high low really actually basically literally something someone somebody anything anyone everything everyone nothing thing things way ways time times year years day days people man men woman women guy guys lot lots kind sort part point fact story moment later earlier ago back away soon now then today tonight yesterday tomorrow well like get got getting go goes went gone going come came coming make made making take took taken say said says tell told see saw seen know knew known think thought want wanted need needed look looked become became start started begin began keep kept let put set seem seemed call called give gave find found".split(
    " ",
  ),
);

// Words that describe rather than name the subject ("a major beef", "was still going").
const FILLER = new Set("major huge massive entire whole real true still going began begun started finally minor serious famous infamous popular several various certain became become around world".split(" "));

/** Content words of a sentence, most specific first (proper names excluded — they are entities). */
export function topicWords(text: string, exclude: string[] = [], n = 5): string[] {
  const ex = new Set(exclude.flatMap((e) => e.toLowerCase().split(/\s+/)));
  const counts = new Map<string, number>();
  const tokens = text.replace(/[“”"]/g, " ").split(/\s+/);
  tokens.forEach((raw, i) => {
    const w = raw.replace(/[^\p{L}\p{N}'-]/gu, "").replace(/['’]s$/, "");
    const lower = w.toLowerCase();
    if (lower.length < 4 || STOP.has(lower) || ex.has(lower) || /^\d/.test(lower) || FILLER.has(lower)) return;
    if (lower.length > 5 && lower.endsWith("ly")) return; // adverbs ("immediately") say nothing searchable
    // Proper names are entities: capitalised mid-sentence, or a capitalised run at the start ("Vybz Kartel had…").
    if (/^\p{Lu}/u.test(w) && (i > 0 || /^\p{Lu}/u.test(tokens[1] ?? ""))) return;
    counts.set(lower, (counts.get(lower) ?? 0) + 1 + Math.min(1, lower.length / 10));
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}
