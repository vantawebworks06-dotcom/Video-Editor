/**
 * Visual intent: for one sentence, what kind of supporting material would strengthen it and
 * where it might be found. Rule-based and subject-agnostic — the rules read the *shape* of the
 * sentence (who/what/when is named, what it refers to), never a topic list, so the same code
 * serves music, history, crime, science, sport or business documentaries.
 */
import type { AssetSuggestion, DateMention, GraphicOpportunity, IntentType, Mention, Reference, Statistic, VisualIntent } from "./types";

export interface IntentInput {
  text: string;
  mentions: Mention[];
  dates: DateMention[];
  statistics: Statistic[];
  quotes: string[];
  references: Reference[];
  topics: string[];
  claim: boolean;
}

export interface IntentContext {
  currentYear: number;
  /** Country/region the story is set in (appended to location graphics and place searches). */
  country: string | null;
  /** The project's own subject words — added to generic searches so "the rivalry" stays on-story. */
  storyTerms: string[];
  /** Person the narration last named — resolves "he"/"she"/"they" in this sentence. */
  lastPerson: string | null;
  /** Whether this is the first sentence naming the entity (introductions get name graphics). */
  firstMention: (name: string) => boolean;
  /** Subjects named in the previous sentences of the scene — context for lines that name nobody ("Fans started arguing"). */
  recentSubjects: string[];
  /** The two sides of the last conflict the narration described ("the rivalry" refers back to them). */
  lastConflict: string[];
}

// Words describing the reaction itself, not what people reacted to — useless in a post search.
const REACTION_WORDS = new Set(["fans", "arguing", "argued", "argue", "online", "people", "reacted", "reaction", "reactions", "comments", "internet", "users", "debate", "debated", "viewers"]);

const WORD_NUM: Record<string, string> = { a: "1", an: "1", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", twenty: "20", several: "SEVERAL", "a few": "A FEW", many: "MANY" };

const q = (...parts: (string | number | null | undefined | false)[]) => {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    for (const w of String(p).split(/\s+/)) {
      const k = w.toLowerCase();
      if (!w || seen.has(k)) continue;
      seen.add(k);
      words.push(w);
    }
  }
  return words.join(" ").trim();
};

const upper = (s: string) => s.toUpperCase();
const fmtValue = (v: number) => (v >= 1e9 ? `${+(v / 1e9).toFixed(1)} BILLION` : v >= 1e6 ? `${+(v / 1e6).toFixed(1)} MILLION` : v.toLocaleString("en-US"));

function graphicFor(inp: IntentInput, type: IntentType, ctx: IntentContext, persons: string[], places: string[]): GraphicOpportunity | null {
  const rel = inp.dates.find((d) => d.kind === "relative");
  if (rel && inp.text.trim().toLowerCase().startsWith(rel.text.toLowerCase().split(" ")[0]!) || (rel && /^(fast[- ]forward|by|then,?)/i.test(inp.text.trim()))) {
    const m = rel.text.match(/^(\S+(?:\s+few)?)\s+(\S+)\s+(\S+)/);
    if (m) {
      const n = WORD_NUM[m[1]!.toLowerCase()] ?? m[1]!;
      const unit = n === "1" ? m[2]!.replace(/s$/i, "") : m[2]!.replace(/([^s])$/i, "$1s");
      return { kind: "time_jump", text: upper(`${n} ${unit} ${m[3]}`), sub: null };
    }
    return { kind: "time_jump", text: upper(rel.text), sub: null };
  }
  const full = inp.dates.find((d) => d.iso);
  if (full && (type === "legal_event" || type === "news_event" || type === "event" || type === "historical_context" || inp.claim)) {
    const d = new Date(`${full.iso}T12:00:00Z`);
    const text = upper(d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }));
    return { kind: "date_event", text, sub: places[0] ? upper(places[0]) : null };
  }
  if (inp.statistics.length) {
    const s = inp.statistics[0]!;
    const unit = s.unit === "%" ? "%" : s.unit && /^[$€£]|dollars|euros|pounds/.test(s.unit) ? "" : s.unit ? ` ${upper(s.unit)}` : "";
    const money = s.unit && /^[$€£]$/.test(s.unit) ? s.unit : s.unit === "dollars" ? "$" : s.unit === "euros" ? "€" : s.unit === "pounds" ? "£" : "";
    const year = inp.dates.find((d) => d.year)?.year;
    return { kind: "statistic", text: `${money}${fmtValue(s.value)}${unit}`.trim(), sub: year ? String(year) : null };
  }
  if (inp.quotes.length && inp.quotes[0]!.split(/\s+/).length >= 4) {
    return { kind: "quote", text: inp.quotes[0]!, sub: persons[0] ? upper(persons[0]) : null };
  }
  const placeCue = /\b(in|from|to|at|across|outside|inside|near|around|born in|based in|moved to|grew up in|began in|started in)\s+(?:the\s+)?$/i;
  for (const p of places) {
    const i = inp.text.indexOf(p);
    if (i > 0 && placeCue.test(inp.text.slice(0, i))) {
      const withCountry = ctx.country && !p.toLowerCase().includes(ctx.country.toLowerCase()) && p !== ctx.country ? `${p}, ${ctx.country}` : p;
      return { kind: "location", text: upper(withCountry), sub: null };
    }
  }
  const year = inp.dates.find((d) => d.kind === "absolute" && d.year && !d.iso);
  if (year && /^(in|by|back in|during|since)\b/i.test(inp.text.trim())) return { kind: "year", text: String(year.year), sub: places[0] ? upper(places[0]) : null };
  const decade = inp.dates.find((d) => d.kind === "decade");
  if (decade && /^(in|by|back in|during)\b/i.test(inp.text.trim())) return { kind: "year", text: upper(decade.text.replace(/^the\s+/i, "")), sub: null };
  const intro = inp.mentions.find((m) => m.kind === "person" && m.description && ctx.firstMention(m.name));
  if (intro) return { kind: "name", text: upper(intro.name), sub: intro.description ? upper(intro.description.slice(0, 48)) : null };
  return null;
}

/** Decide what the sentence is mainly doing, in priority order. */
function classify(inp: IntentInput, persons: string[], places: string[]): { type: IntentType; reasons: string[] } {
  const r = new Set(inp.references);
  const has = (x: Reference) => r.has(x);
  const reasons: string[] = [];
  const pick = (type: IntentType, why: string) => {
    reasons.unshift(why);
    return { type, reasons };
  };
  for (const x of inp.references) reasons.push(`refers to ${x.replace("_", " ")}`);
  if (inp.quotes.length && inp.quotes[0]!.split(/\s+/).length >= 4) return pick("quote", "contains a quotation");
  if (has("interview")) return pick("interview_reference", "mentions an interview or on-record conversation");
  if (has("social") && /\b(fans|people|users|followers|viewers|internet|online|reactions?|reacted|arguing|argued|debated?|comments?|posted|tweeted|trending|viral)\b/i.test(inp.text)) return pick("social_reaction", "describes public/online reaction");
  if (inp.statistics.length) return pick("statistic", `gives a figure (${inp.statistics[0]!.text})`);
  if (has("document")) return pick("document_evidence", "refers to a document or record");
  if (has("legal")) return pick("legal_event", "describes a legal/police event");
  if (inp.dates.some((d) => d.kind === "relative") && /^(\S+\s+){0,2}(years?|months?|weeks?|days?|decades?)\s+(later|after)/i.test(inp.text.trim())) return pick("time_jump", "jumps forward in time");
  if (has("announcement")) return pick("product_announcement", "describes an announcement/launch");
  if (has("news")) return pick("news_event", "refers to news coverage");
  if (has("performance")) return pick("performance", "refers to a performance/show");
  if (has("song") || has("album")) return pick("music_reference", "refers to a song or album");
  if (has("conflict")) return pick("conflict", "describes a conflict/rivalry");
  if (has("sports")) return pick("sports_moment", "describes a sporting moment");
  if (has("science")) return pick("science_explanation", "explains research/science");
  if (has("historical")) return pick("historical_context", "sets historical context");
  if (places.length && !persons.length) return pick("location", `is about a place (${places[0]})`);
  if (persons.length) return pick("person_intro", `is about ${persons[0]}`);
  if (inp.mentions.some((m) => m.kind === "event")) return pick("event", "names an event");
  if (has("emotional")) return pick("emotional", "carries emotional weight");
  return pick("explanation", "explains or connects ideas");
}

export function buildIntent(inp: IntentInput, ctx: IntentContext): VisualIntent {
  const of = (k: Mention["kind"]) => [...new Set(inp.mentions.filter((m) => m.kind === k).map((m) => m.name))];
  let persons = of("person");
  const orgs = of("organization");
  const places = of("place");
  const events = of("event");
  const works = [...of("song"), ...of("album"), ...of("work")];
  const platforms = of("platform");
  // Names the linker couldn't classify (offline, or not on Wikipedia) still name the subject.
  const terms = of("term");
  const resolved = !persons.length && ctx.lastPerson && /\b(he|she|his|her|him|they|their|them)\b/i.test(inp.text) ? ctx.lastPerson : null;
  if (resolved) persons = [resolved];
  const { type, reasons } = classify(inp, persons, places);
  if (resolved) reasons.push(`"he/she/they" resolved to ${resolved} (previous sentences)`);

  const year = inp.dates.find((d) => d.year)?.year ?? null;
  const old = year !== null && year <= ctx.currentYear - 20;
  const era = year ? (old ? `${Math.floor(year / 10) * 10}s` : String(year)) : null;
  const subjects = persons.length ? persons : terms;
  const inherited = !subjects.length && !orgs.length && ctx.recentSubjects.length ? ctx.recentSubjects.slice(0, 2) : [];
  if (inherited.length) reasons.push(`no one is named — searches use the scene's subjects (${inherited.join(", ")})`);
  const who = (subjects.length ? subjects : inherited).slice(0, 2).join(" ");
  const topicQ = inp.topics.slice(0, 3).join(" ");
  const story = ctx.storyTerms.slice(0, 2).join(" ");
  const place = places[0] ?? null;

  const out: AssetSuggestion[] = [];
  // A name searches best on its own: extra topic words ("refrigerators") or story terms ("gaza") pull in unrelated images.
  const personQuery = (name: string) => name;
  const add = (label: string, category: AssetSuggestion["category"], providers: string[], query: string, why: string) => {
    const query2 = query.trim();
    if (!query2 || out.some((s) => (s.query.toLowerCase() === query2.toLowerCase() || s.label.toLowerCase() === label.toLowerCase()) && s.category === category)) return;
    out.push({ label, category, providers, query: query2, why });
  };

  // --- driven by what the sentence refers to --------------------------------------------------
  switch (type) {
    case "interview_reference": {
      const outlet = orgs[0] ?? (persons.length ? terms[0] : terms[1]) ?? platforms[0] ?? null;
      const interviewee = persons[0] ?? (terms[0] && terms[0] !== outlet ? terms[0] : null);
      add(`${interviewee ?? "the"} interview${outlet ? ` with ${outlet}` : ""}`, "interview", ["youtube", "brave"], q(interviewee, outlet, "interview", year && String(year), !interviewee && !outlet && (story || topicQ)), "the narration refers to an interview — the actual footage is the strongest evidence");
      add(`news coverage of the ${outlet ? `${outlet} ` : ""}interview`, "article", ["brave", "gdelt"], q(interviewee, outlet, "interview", topicQ), "articles quote and date the interview");
      break;
    }
    case "social_reaction": {
      const about = inp.topics.filter((t) => !REACTION_WORDS.has(t)).slice(0, 2).join(" ");
      const subject = q(who, orgs[0], events[0], works[0], about || (who ? "" : story));
      add(`public posts reacting to ${subject}`, "social", ["x", "reddit"], subject, "the line describes people reacting online — real public posts show it");
      add(`coverage of the reaction to ${subject}`, "article", ["brave", "gdelt"], q(subject, "reaction"), "news write-ups summarise the reaction with sources");
      if (platforms.includes("YouTube")) add(`YouTube videos about ${subject}`, "video", ["youtube"], subject, "the line names YouTube");
      break;
    }
    case "statistic":
      add(`source for "${inp.statistics[0]!.text}"`, "article", ["brave", "gdelt", "wikipedia"], q(who, orgs[0], inp.statistics[0]!.text, topicQ), "figures should be backed by a citable source");
      break;
    case "document_evidence":
      add(`the document itself (${topicQ || "record"})`, "document", ["brave", "internet_archive", "wikimedia"], q(who, orgs[0], topicQ, "document", year && String(year)), "the line refers to a document — showing it is evidence");
      add("reporting on the document", "article", ["brave", "gdelt"], q(who, orgs[0], topicQ), "articles give the document's context and date");
      break;
    case "legal_event":
      add(`news reports of the ${topicQ || "case"}`, "article", ["brave", "gdelt"], q(who, place, topicQ, year && String(year)), "legal events are documented in news reports and court records");
      add("court or police records", "document", ["brave"], q(who, "court", topicQ), "primary documents where public");
      if (persons.length) add(`photographs of ${who}`, "photo", ["wikimedia", "brave"], q(who), "identify who the case is about");
      break;
    case "product_announcement": {
      const co = orgs[0] ?? (who || null);
      add(`${co ?? "the"} announcement video`, "video", ["youtube"], q(co, works[0], topicQ, "announcement", year && String(year)), "the announcement itself is usually on video");
      add(`${co ?? "the"} press release`, "article", ["brave"], q(co, topicQ, "press release", year && String(year)), "the primary source for what was announced");
      add(`${topicQ || "product"} photographs`, "photo", ["wikimedia", "brave", "pexels"], q(co, topicQ), "shows what was announced");
      add("news coverage", "article", ["gdelt", "brave"], q(co, topicQ, "launch"), "independent reporting");
      add("social posts about it", "social", ["x", "reddit"], q(co, topicQ), "public reaction at the time");
      break;
    }
    case "news_event":
      add(`news coverage: ${q(who, orgs[0], topicQ)}`, "article", ["gdelt", "brave"], q(who, orgs[0], place, topicQ, year && String(year)), "the narration refers to reporting");
      add("broadcast news footage", "video", ["youtube", "internet_archive"], q(who, place, topicQ, "news"), "TV reports put the event on screen");
      break;
    case "performance":
      add(`${who || "performance"} live footage`, "video", ["youtube", "internet_archive"], q(who, events[0], place, "live performance", year && String(year)), "the line refers to a performance");
      add(`stage photographs of ${who || events[0] || "the show"}`, "photo", ["wikimedia", "brave"], q(who, events[0], "performing"), "stills of the performance");
      break;
    case "music_reference": {
      const title = works[0] ?? null;
      add(`${title ? `"${title}"` : "the song"} ${who ? `by ${who}` : ""} — official video/audio`.replace(/\s+/g, " "), "video", ["youtube"], q(who, title, "official"), "reference to the music itself (preview/embed only; use requires a licence)");
      add(`${title ? `${title} ` : ""}cover art`, "photo", ["brave", "wikimedia"], q(who, title, "album cover"), "artwork is the recognisable visual of a release");
      break;
    }
    case "conflict": {
      const named = [...persons, ...orgs, ...terms];
      const sides = named.length >= 2 ? named.slice(0, 2) : named.length === 1 ? [named[0]!, ...ctx.lastConflict.filter((x) => x !== named[0])].slice(0, 2) : ctx.lastConflict.length ? ctx.lastConflict : inherited;
      if (!named.length && ctx.lastConflict.length) reasons.push(`"the ${topicQ.split(" ")[0] || "conflict"}" refers back to ${ctx.lastConflict.join(" vs ")}`);
      for (const s of sides) add(`photograph of ${s}`, "photo", ["wikimedia", "brave"], q(s), "put a face to each side of the conflict");
      add(`coverage of the ${topicQ || "conflict"}`, "article", ["brave", "gdelt"], q(sides.join(" "), topicQ || "feud"), "documented history of the conflict");
      add("public discussion of it", "social", ["reddit", "x"], q(sides.join(" "), topicQ), "how the public saw it");
      add("archival footage of the two", "video", ["youtube", "internet_archive"], q(sides.join(" "), events[0], year && String(year)), "moving images of the conflict");
      break;
    }
    case "sports_moment":
      add(`${q(who, orgs[0], events[0])} highlights`, "video", ["youtube"], q(who, orgs[0], events[0], topicQ, year && String(year), "highlights"), "the moment itself on video");
      add("match photographs", "photo", ["wikimedia", "brave"], q(who, orgs[0], events[0]), "stills of the moment");
      break;
    case "science_explanation":
      add(`diagram: ${topicQ}`, "photo", ["wikimedia", "brave"], q(topicQ, "diagram"), "explanations read better with a diagram");
      add(`${topicQ} footage`, "video", ["pexels", "pixabay", "wikimedia"], q(topicQ), "visual illustration of the subject");
      add("the study or report", "article", ["brave"], q(orgs[0], topicQ, "study"), "the primary source for the finding");
      break;
    case "historical_context":
      add(`archival photographs${era ? ` (${era})` : ""}: ${q(who, place, topicQ)}`, "photo", ["wikimedia", "internet_archive"], q(who, events[0], place, topicQ, year && String(year)), "period photographs anchor historical context");
      add("newspaper headlines from the time", "document", ["internet_archive", "wikimedia", "brave"], q(events[0] ?? topicQ, place, year && String(year), "newspaper"), "contemporary headlines show how it was reported");
      add("archival film footage", "video", ["internet_archive", "youtube"], q(events[0] ?? topicQ, place, era), "moving images from the period");
      break;
    case "location":
      add(`${place} — establishing footage`, "video", ["pexels", "pixabay", "wikimedia"], q(place, ctx.country && place !== ctx.country ? ctx.country : null, topicQ), "establish where the story is");
      add(`map of ${place}`, "photo", ["wikimedia"], q(place, "location map"), "orient the viewer geographically");
      add(`photographs of ${place}`, "photo", ["wikimedia", "brave"], q(place, topicQ), "a recognisable view of the place");
      break;
    case "person_intro":
      add(`photograph of ${persons[0]}`, "photo", ["wikimedia", "brave"], personQuery(persons[0]!), `show who ${persons[0]} is`);
      if (!old) add(`${persons[0]} on video`, "video", ["youtube"], q(persons[0], topicQ || story), "moving footage of the person");
      break;
    case "event":
      add(`footage of ${events[0]}`, "video", ["youtube", "internet_archive", "wikimedia"], q(events[0], year && String(year)), "the event itself");
      add(`photographs of ${events[0]}`, "photo", ["wikimedia", "brave"], q(events[0], year && String(year)), "stills of the event");
      add(`coverage of ${events[0]}`, "article", ["brave", "gdelt"], q(events[0], year && String(year)), "reporting on the event");
      break;
    case "time_jump":
    case "quote":
    case "emotional":
    case "explanation":
      break;
  }

  // --- always useful: who/where is named, and atmosphere --------------------------------------
  for (const p of subjects.slice(0, 2)) add(`photograph of ${p}`, "photo", ["wikimedia", "brave"], personQuery(p), `the sentence is about ${p}`);
  if (place && type !== "location") add(`${place} establishing shot`, "video", ["pexels", "pixabay", "wikimedia"], q(place, topicQ.split(" ")[0]), `the sentence is set in ${place}`);
  if (type === "quote" && persons[0]) add(`${persons[0]} saying it (interview/video)`, "interview", ["youtube"], q(persons[0], inp.quotes[0]!.split(/\s+/).slice(0, 6).join(" ")), "the recording of the quote is stronger than text");
  if (inp.claim && !out.some((s) => s.category === "article")) add("a source for this claim", "article", ["brave", "gdelt", "wikipedia"], q(who, orgs[0], place, topicQ, year && String(year)), "factual claims need a citable source");
  if (type === "emotional" || type === "explanation" || type === "time_jump" || !out.length) {
    const mood = topicQ || story;
    if (mood) add(`${mood} b-roll`, "video", ["pexels", "pixabay"], q(topicQ || story, place), "atmospheric footage that matches the line's subject");
  }

  const graphic = graphicFor(inp, type, ctx, persons, places);
  const tone: VisualIntent["tone"] = inp.references.includes("emotional")
    ? "somber"
    : type === "conflict" || type === "legal_event"
      ? "tense"
      : type === "historical_context" || type === "document_evidence"
        ? "serious"
        : type === "product_announcement" || type === "sports_moment"
          ? "uplifting"
          : /!|\b(shocking|stunned|explosive|never before|suddenly)\b/i.test(inp.text)
            ? "dramatic"
            : "neutral";
  const strong = new Set<IntentType>(["quote", "interview_reference", "social_reaction", "statistic", "document_evidence", "legal_event", "conflict", "time_jump", "product_announcement"]);
  const importance = Math.min(1, 0.3 + (inp.claim ? 0.15 : 0) + (strong.has(type) ? 0.2 : 0) + Math.min(0.2, inp.references.length * 0.05) + (graphic ? 0.1 : 0) + (persons.length ? 0.05 : 0));
  const signals = inp.references.length + inp.mentions.length + inp.dates.length + inp.statistics.length;
  const confidence = Math.min(0.85, 0.35 + signals * 0.08);

  return {
    type,
    entities: [...new Set([...persons, ...orgs, ...places, ...events, ...works, ...terms])].slice(0, 8),
    topics: inp.topics,
    suggestedAssets: out.slice(0, 7),
    graphic,
    importance: Math.round(importance * 100) / 100,
    tone,
    era,
    basis: "rules",
    confidence: Math.round(confidence * 100) / 100,
    reasons: reasons.slice(0, 6),
  };
}
