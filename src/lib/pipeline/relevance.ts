/**
 * Editorial relevance scoring (sections 7, 26 of the brief). A candidate is judged on whether it
 * shows WHAT the narration is about — the named entity, the event, the time — not on whether its
 * title shares a word with a query. Scores (max): entity 30, event 25, time 15, topic 15,
 * visual fit 10, quality 5 = 100, minus penalties for wrong country/era, avoid-list terms,
 * stock footage where specifics are needed, and repetition.
 */
import type { EditorialVisualType, NormalizedAsset, VisualNeed } from "@/lib/domain/types";
import { clamp } from "./engines";

export interface RelevanceScores {
  entityMatch: number;
  eventMatch: number;
  timeMatch: number;
  topicMatch: number;
  visualMatch: number;
  quality: number;
  penalty: number;
  /** 1 when the picture is tagged with the story's country/place (atmosphere must be local). */
  placeMatch: number;
  /** Beat-concept words found in the picture's metadata ("recording", "studio", "microphone"). */
  conceptMatch: number;
  confidence: number;
}

export interface RelevanceResult {
  asset: NormalizedAsset;
  total: number;
  scores: RelevanceScores;
  reason: string;
}

export interface RelevanceContext {
  country: string | null;
  /** Other country/region words that mean "this picture is from somewhere else". */
  foreign: RegExp;
  /** Assets used so far, and the providers/kinds of the last few clips (diversity, section 10). */
  used: Set<string>;
  /** When each used asset was last on screen (seconds) and the start of the beat being judged. */
  usedAt?: Map<string, number>;
  now?: number;
  /** Names/aliases of everyone and everything the story mentions (a photo of them isn't "someone else"). */
  storyNames?: string[];
  /** Typical year the story is set in (median of years mentioned). */
  storyYear?: number | null;
  recentProviders: string[];
  recentKinds: string[];
  /** Designed cards shown so far: text → start time (the same name card shouldn't keep returning). */
  recentCards?: Map<string, number>;
}

/** Accept automatically at or above this; below it the fallback chain continues. */
export const MIN_RELEVANCE = 50;
/** An entity beat needs at least this entity score (the named thing must be in the picture). */
export const MIN_ENTITY = 18;

const STOCK = new Set(["pexels", "pixabay"]);
const COMMON = new Set("the and of in on at to for with from by a an is was were his her their this that new old man woman people city street photo image video file jpg png".split(" "));

const normalise = (s: string) =>
  ` ${s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[_./()[\],:;!?"“”'’-]+/g, " ")
    .replace(/\s+/g, " ")} `;

function yearOf(asset: NormalizedAsset): number | null {
  const d = asset.date?.match(/\b(1[89]\d\d|20[0-3]\d)\b/)?.[1] ?? `${asset.title} ${asset.description ?? ""}`.match(/\b(1[89]\d\d|20[0-3]\d)\b/)?.[1];
  return d ? Number(d) : null;
}

/** 0-30: is the named entity in the picture's metadata? */
function entityScore(hay: string, names: string[]): { score: number; matched: string | null } {
  let best = 0;
  let matched: string | null = null;
  for (const n of names) {
    const full = normalise(n).trim();
    if (!full) continue;
    const tokens = full.split(" ").filter((t) => t.length >= 3 && !COMMON.has(t));
    let s = 0;
    if (hay.includes(` ${full} `)) s = 30;
    else if (tokens.length > 1 && tokens.every((t) => hay.includes(` ${t} `))) s = 26;
    else if (tokens.length && hay.includes(` ${tokens.at(-1)!} `) && tokens.at(-1)!.length >= 5) s = 18; // surname / distinctive word
    else if (tokens.some((t) => t.length >= 6 && hay.includes(` ${t} `))) s = 10;
    if (s > best) [best, matched] = [s, n];
  }
  return { score: best, matched };
}

const PLACEISH = /^(Jamaica|Kingston|Portmore|Montego|Ocho|Spanish|Negril|Port|Saint|St|North|South|East|West|New|Old|Downtown|Central|Aerial|View|Street|Beach|Bay|Blue|Mount|Lake|River|The|A|An|Flickr|File|Photo|Image|IMG|DSC|Map)$/i;

/**
 * Does the title name some other person ("Damian-Marley-Smile…", "FyaVerse in 2025 at …",
 * "Sizzla live")? Showing a different musician while the narration talks about ours is the
 * worst kind of mismatch. Names the story itself mentions are fine.
 */
function looksLikePortraitOfSomeoneElse(title: string, names: string[], storyNames: string[]): boolean {
  const clean = title.replace(/[-_]+/g, " ").trim();
  const lower = clean.toLowerCase();
  if ([...names, ...storyNames].some((n) => n.length >= 3 && lower.includes(n.toLowerCase()))) return false;
  const words = clean.split(/\s+/);
  const [a, b] = [words[0] ?? "", words[1] ?? ""];
  const nameLike = (w: string) => /^[A-Z][a-z]+[A-Za-z]*$/.test(w) && w.length >= 3 && !PLACEISH.test(w);
  if (nameLike(a) && nameLike(b)) return true; // "Damian Marley …"
  // "Sizzla live", "FyaVerse in 2025 at …", "Beenie Man performs…"
  return nameLike(a) && /^(live|performs|performing|on|in|at|onstage|concert|backstage|portrait|headshot)$/i.test(b) && !/^(Street|Market|Downtown|Kingston|Jamaica)$/i.test(a);
}

const JUNK = new Set("panoramio flickr img dsc dscn jpg jpeg png file photo image picture view photograph copy cropped edited crop version panorama pano wikimedia commons loc jan feb mar apr may jun jul aug sep sept oct nov dec january february march april june july august september october november december".split(" "));

/** Does the title/description say anything about the content beyond place, date and camera junk? */
function informative(asset: NormalizedAsset, ctx: RelevanceContext): boolean {
  const places = new Set((ctx.storyNames ?? []).concat(ctx.country ? [ctx.country] : []).flatMap((n) => normalise(n).trim().split(" ")));
  // Drop photo-site credits ("- panoramio - pismay", "by JLaw45") and capitalised names/places in
  // the title: what's left should describe the content ("market", "concert", "police").
  const title = asset.title.replace(/\s[-–]\s(panoramio|flickr)\b.*$/i, "").replace(/\bby\s+\S+$/i, "");
  const titleWords = title.split(/[\s_,.()-]+/).filter((w) => w && !/^\p{Lu}/u.test(w));
  const words = normalise(`${titleWords.join(" ")} ${asset.description ?? ""}`)
    .trim()
    .split(" ")
    .filter((w) => w.length >= 4 && !/\d/.test(w) && !JUNK.has(w) && !places.has(w) && !COMMON.has(w));
  // Stock tags ("jamaica, culture, people, man…") and real captions both pass; bare dates don't.
  return words.length >= 2 || asset.provider === "pexels" || asset.provider === "pixabay";
}

/** Jamaica clichés and drug imagery: never, unless the narration is about them. */
export const CLICHES = ["bob marley", "marley", "marijuana", "marihuana", "cannabis", "ganja", "weed", "hemp", "thc", "narcotic", "rastafarian", "rasta", "hippie", "psychedelic"];

/**
 * Free photos of a specific person are scarce (a handful on Commons). Editors re-show the same
 * portrait later with a different move; so may we, once it has been off screen for a while.
 * Location shots may return after longer. Everything else is used once.
 */
function reuseAllowed(asset: NormalizedAsset, need: VisualNeed, ctx: RelevanceContext, entityMatched: boolean): boolean {
  const last = ctx.usedAt?.get(asset.id);
  if (last === undefined || ctx.now === undefined) return false;
  return spacedReuseOk(need.visualType, need.duration, ctx.now - last, entityMatched);
}

/** Shared by selection and the review pass: may a picture seen `gap` seconds ago appear again? */
export function spacedReuseOk(visualType: string | undefined, duration: number, gap: number, entityMatched: boolean): boolean {
  // In a rapid montage (sub-1.3 s shots) the same few portraits may flash by again sooner.
  if (entityMatched && ["person_photo", "event_photo"].includes(visualType ?? "")) return gap >= (duration < 1.3 ? 8 : 25);
  if (["location_photo", "establishing_shot", "b_roll"].includes(visualType ?? "")) return gap >= 90;
  return false;
}

function tokensOf(s: string): string[] {
  return normalise(s)
    .trim()
    .split(" ")
    .filter((t) => t.length >= 4 && !COMMON.has(t));
}

function wantsType(t: EditorialVisualType | undefined, asset: NormalizedAsset, hay: string): number {
  const video = asset.type === "video";
  switch (t) {
    case "person_photo":
    case "location_photo":
    case "album_art":
      return video ? 7 : 10;
    case "event_photo":
      return 10;
    case "newspaper":
    case "news_screenshot":
    case "document":
      return /\b(newspaper|headline|gazette|gleaner|times|press|article|page|document|letter|report)\b/.test(hay) ? 10 : 3;
    case "archival_video":
      return asset.archival ? 10 : video ? 6 : 5;
    case "establishing_shot":
    case "b_roll":
    case "abstract_background":
    case "interview":
      return video ? 10 : 6;
    default:
      return video ? 8 : 7;
  }
}

export function scoreRelevance(asset: NormalizedAsset, need: VisualNeed, ctx: RelevanceContext): RelevanceResult {
  const hay = normalise(`${asset.title} ${asset.description ?? ""} ${asset.categories.join(" ")}`);
  const names = need.entities ?? [];
  // A name in the title is the subject; a name only in the description may be incidental
  // ("FyaVerse at a festival" whose caption mentions the headliner). If the title names someone
  // else, the picture is of them.
  const inTitle = entityScore(normalise(asset.title), names);
  const anywhere = entityScore(hay, names);
  const someoneElse = looksLikePortraitOfSomeoneElse(asset.title, names, ctx.storyNames ?? []);
  const ent =
    inTitle.score >= anywhere.score
      ? inTitle
      : { score: someoneElse ? Math.min(anywhere.score, 8) : Math.min(anywhere.score, 20), matched: anywhere.matched };
  const entityMatch = names.length ? ent.score : 12; // atmospheric beats aren't about a named thing

  const topic = need.topic ?? [];
  const eventHits = topic.filter((t) => hay.includes(` ${normalise(t).trim()} `));
  // Event words matter for pictures OF the event; atmosphere isn't marked down for lacking them.
  const eventShot = ["event_photo", "archival_video", "newspaper", "document"].includes(need.visualType ?? "");
  const eventMatch = eventHits.length ? clamp(eventHits.length * 13, 0, 25) : topic.length && eventShot ? 0 : 10;

  const want = need.year ?? null;
  const got = yearOf(asset);
  let timeMatch = 8;
  let eraPenalty = 0;
  if (want && got) {
    const gap = Math.abs(want - got);
    timeMatch = gap === 0 ? 15 : gap <= 3 ? 12 : Math.floor(got / 10) === Math.floor(want / 10) ? 9 : gap <= 10 ? 4 : 0;
    if (gap > 25) eraPenalty = 12; // an 1833 racehorse for a 2008 story
  } else if (want && !got) timeMatch = 6;

  // Topic: the beat's own query words, plus the story's country.
  const qTokens = [...new Set(need.queries.flatMap(tokensOf))].filter((t) => !names.some((n) => normalise(n).includes(` ${t} `)));
  const overlap = qTokens.length ? qTokens.filter((t) => hay.includes(` ${t} `)).length / Math.min(qTokens.length, 4) : 0;
  const countryHit = ctx.country && hay.includes(` ${ctx.country.toLowerCase()} `) ? 6 : 0;
  const placeHit = names.some((n) => hay.includes(` ${normalise(n).trim()} `));
  const topicMatch = clamp(Math.round(overlap * 9) + countryHit, 0, 15);

  const visualMatch = wantsType(need.visualType, asset, hay);
  const w = asset.width ?? 0;
  const quality = asset.type === "gif" ? 3 : w >= 1600 ? 5 : w >= 1000 ? 4 : w >= 640 ? 3 : w ? 1 : 2;

  // Penalties.
  let penalty = eraPenalty;
  // Where a photo of the named person was taken doesn't matter ("Vybz Kartel in Barbados").
  const foreign = Boolean(ctx.country && ctx.foreign.test(hay)) && !(names.length && ent.score >= 26);
  // "Indian political department", "UK party affiliation", "'Song of Jamaica' (a plant) in China".
  if (foreign) penalty += countryHit ? 14 : 20;
  // A picture of some other named person is worse than no picture: on beats that aren't about a
  // person, penalise titles that look like "Firstname Lastname …" (e.g. "Damian-Marley-Smile…").
  if (!(names.length && ent.score >= MIN_ENTITY) && someoneElse) penalty += 25;
  // A title that only says where/when ("22 Oct 2008 Newmarket Jamaica - panoramio") tells us nothing
  // about what's in the picture; it may not win a non-location beat on date and place alone.
  const locationBeat = ["location_photo", "establishing_shot"].includes(need.visualType ?? "");
  if (!locationBeat && !(names.length && ent.score >= MIN_ENTITY) && !informative(asset, ctx)) penalty += 12;
  // A photo from long before the story's era jars in a present-day passage (1915 Kingston for 2008).
  if (!need.year && ctx.storyYear && got && got < ctx.storyYear - 45 && need.visualType !== "archival_video") penalty += 14;
  // Avoid-list hits are the storyboard saying "this is the wrong kind of picture": hard penalty.
  if ((need.avoid ?? []).some((a) => hay.includes(` ${normalise(a).trim()} `))) penalty += 22;
  if (STOCK.has(asset.provider) && need.stockAllowed === false) penalty += 10;
  if (ctx.used.has(asset.id)) penalty += reuseAllowed(asset, need, ctx, names.length > 0 && ent.score >= MIN_ENTITY) ? 6 : 40;
  const lastTwo = ctx.recentProviders.slice(-2);
  if (lastTwo.length === 2 && lastTwo.every((p) => p === asset.provider)) penalty += 6;
  const kind = asset.type === "video" ? "video" : asset.archival ? "archival" : "photo";
  if (ctx.recentKinds.slice(-3).filter((k) => k === kind).length === 3) penalty += 5;

  const total = clamp(Math.round(entityMatch + eventMatch + timeMatch + topicMatch + visualMatch + quality - penalty), 0, 100);
  const strongEntity = names.length > 0 && ent.score >= MIN_ENTITY;
  const confidence = clamp((total - 30) / 55 + (strongEntity ? 0.12 : 0) - (foreign ? 0.2 : 0), 0, 1);

  return {
    asset,
    total,
    scores: { entityMatch, eventMatch, timeMatch, topicMatch, visualMatch, quality, penalty, placeMatch: countryHit || placeHit ? 1 : 0, conceptMatch: qTokens.filter((t) => hay.includes(` ${t} `) && t !== ctx.country?.toLowerCase()).length, confidence: Math.round(confidence * 100) / 100 },
    reason: explain(need, asset, { ent, eventHits, want, got, foreign: Boolean(foreign), countryHit: countryHit > 0 }),
  };
}

function explain(
  need: VisualNeed,
  asset: NormalizedAsset,
  f: { ent: { score: number; matched: string | null }; eventHits: string[]; want: number | null; got: number | null; foreign: boolean; countryHit: boolean },
): string {
  const parts: string[] = [];
  const t = need.visualType?.replace(/_/g, " ") ?? need.type;
  if (f.ent.matched && f.ent.score >= 26) parts.push(`Exact match for ${f.ent.matched}, named in this narration`);
  else if (f.ent.matched && f.ent.score >= MIN_ENTITY) parts.push(`Shows ${f.ent.matched} (name in the source's title)`);
  else if (need.entities?.length) parts.push(`No picture of ${need.entities[0]} was found; related ${t}`);
  if (f.eventHits.length) parts.push(`matches the event (${f.eventHits.slice(0, 2).join(", ")})`);
  if (f.want && f.got && Math.abs(f.want - f.got) <= 3) parts.push(`from ${f.got}, the period described`);
  if (!need.entities?.length) parts.push(`${t} for "${need.description}"${f.countryHit ? " in the right place" : ""}`);
  if (f.foreign) parts.push("⚠ appears to be from another country");
  if (asset.provider === "pexels" || asset.provider === "pixabay") parts.push("stock footage used for atmosphere");
  return `${parts.join("; ")}.`.replace(/^./, (c) => c.toUpperCase());
}

/** Does this candidate clear the bar for automatic use in this beat? */
export function accepts(r: RelevanceResult, need: VisualNeed, stage: "primary" | "fallback"): boolean {
  if (r.scores.penalty >= 40) return false; // already used
  const named = (need.entities?.length ?? 0) > 0;
  const specific = named && ["person_photo", "event_photo", "document", "album_art"].includes(need.visualType ?? "");
  if (specific && r.scores.entityMatch < MIN_ENTITY) return false;
  // Atmosphere (b-roll, establishing, location) isn't about a named thing but must be local and
  // on-tone: a Jamaican street, not a street in Seoul.
  const atmospheric = !specific && ["b_roll", "establishing_shot", "location_photo", "abstract_background", "archival_video"].includes(need.visualType ?? "");
  if (atmospheric) {
    const fits = need.local === false ? r.scores.conceptMatch >= 2 : r.scores.placeMatch === 1;
    return fits && r.scores.penalty < 14 && r.total >= (stage === "primary" ? 46 : 44);
  }
  if (r.scores.confidence < 0.35) return false;
  return r.total >= (stage === "primary" ? MIN_RELEVANCE : MIN_RELEVANCE - 4);
}
