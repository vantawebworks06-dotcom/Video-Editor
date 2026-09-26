/**
 * Deterministic fallback director used when no Claude API key is configured (and in the
 * offline demo). It is rule-based keyword analysis — clearly labelled in the UI as such —
 * not a stand-in pretending to be AI.
 */
import type {
  EditorialVisualType,
  MemePlan,
  SceneAnalysis,
  ScenePlan,
  SfxCue,
  TextOverlayPlan,
  Transcript,
  VisualNeed,
  VisualStrategy,
} from "@/lib/domain/types";
import { RIGHTS_RANK } from "@/lib/media/rights";
import {
  type ClipDecision,
  combineScores,
  type Director,
  type DirectorContext,
  type DraftClip,
  groupSentences,
  type RankedCandidate,
  type RankInput,
  sceneIdFor,
  type SceneSegment,
} from "./director";
import { chooseMotion, clamp, kindOf, preferredNeedType, seeded, splitSceneDurations, targetShotDuration } from "./engines";
import type { SceneBoard } from "./storyboard";
import type { Sentence } from "./transcript";

const STOP = new Set(
  "the a an of in on at to for and or but with from by as is are was were be been being this that these those it its into over under about than then there their they them he she his her we our you your i me my not no yes so if when while what which who whom whose how why where all any some more most much many very just also only even still yet had has have having do does did done can could would should will shall may might must one two three every each other another such own same too out up down off again further once here because until against between through during before after above below both few nor".split(
    " ",
  ),
);

const EMOTION = /\b(death|died|killed|murder|war|love|lost|loss|grief|tragic|tragedy|fear|violence|shot|funeral|cried|pain|broke|heart|alone)\b/i;
const MEME_CUES = /\b(somehow|worse|of course|apparently|turns out|ironically|genius|disaster|nobody|literally|obviously|surprisingly|plot twist|awkward|chaos|embarrass\w*|ridiculous|absurd|wait)\b/i;
// News, articles, controversies, social media, YouTube, statistics and quotes → article/screenshot visuals.
const ARTICLE_CUES = /\b(newspapers?|headlines?|reported|reports|article|wrote|published|the gleaner|the observer|press|magazine|front page|tweets?|tweeted|posted|statement|controvers\w*|social media|youtube|instagram|twitter|facebook|tiktok|viral|comments?|statistics?|percent|survey|poll|quoted?|called it)\b/i;
const INTERVIEW_CUES = /\b(said|told|interview|explained|recalled|remembers|according to)\b/i;
const MAP_CUES = /\b(map|border|island|country|region|city of|miles|kilometres|kilometers|located)\b/i;
const YEAR = /\b(1[89]\d\d|20[0-2]\d)s?\b/;

function words(text: string) {
  return text.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, "")).filter(Boolean);
}

// Filler, time words and common verbs that make poor stock-media queries.
const FILLER = new Set(
  "thing things somehow someone something everyone anything nothing anyway still even worse called started showing began turned became loudest louder bigger biggest rarer same new young whole friendly within today year years night week time times people way lot kind sort place day days first last next another another's entire noticed built named stole played won anyway borrowed say says said says know knew think thought went got made make makes making come came take took give gave going show shows thousand thousands hundred hundreds million millions billion dozen obsession opinions playing".split(" "),
);

function isContent(w: string) {
  const l = w.toLowerCase();
  return l.length > 2 && !STOP.has(l) && !FILLER.has(l) && !/^\d+$/.test(l) && !/(ly|ed)$/.test(l);
}

/** Places: capitalised phrases introduced by a location preposition ("on Harbour Street", "in Kingston"). */
function places(text: string): string[] {
  const out: string[] = [];
  const re = /\b(?:in|on|at|from|to|across|near|of)\s+((?:[A-Z][\p{L}'-]+)(?:\s+[A-Z][\p{L}'-]+)*)/gu;
  for (const m of text.matchAll(re)) out.push(m[1]!);
  return [...new Set(out)];
}

/** Adjacent content-word pairs ("sound system", "record collection") ranked by frequency. */
function nounPhrases(text: string, n = 4): string[] {
  const ws = text.split(/\s+/);
  const counts = new Map<string, number>();
  for (let i = 0; i < ws.length - 1; i++) {
    if (/[.,!?;:]$/.test(ws[i]!)) continue; // don't pair across punctuation
    const a = ws[i]!.replace(/[^\p{L}'-]/gu, "");
    const b = ws[i + 1]!.replace(/[^\p{L}'-]/gu, "");
    if (!isContent(a) || !isContent(b) || /^[A-Z]/.test(a) || /^[A-Z]/.test(b)) continue;
    const k = `${a} ${b}`.toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).map(([k]) => k);
}

function keywords(text: string, n = 4): string[] {
  const counts = new Map<string, number>();
  for (const w of words(text)) {
    if (!isContent(w) || /^[A-Z]/.test(w)) continue;
    const l = w.toLowerCase();
    counts.set(l, (counts.get(l) ?? 0) + 1 + (w.length > 7 ? 0.5 : 0));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

/** The script's main subject: its most frequent content word ("dancehall", "records"). */
export function subjectAnchor(fullText: string): string | null {
  return keywords(fullText, 1)[0] ?? null;
}

/** The script's main location, used to keep generic queries in context. */
export function contextAnchor(fullText: string): string | null {
  const counts = new Map<string, number>();
  for (const p of places(fullText)) counts.set(p, (counts.get(p) ?? 0) + 1);
  for (const m of fullText.matchAll(/\b(Jamaica|Kingston|London|New York|Paris|Tokyo|Lagos|Chicago|Los Angeles|Toronto|Mexico|Brazil|India|China|Africa|Europe|America)\b/g)) {
    counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 2);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) return null;
  // "Kingston, Jamaica" → "Kingston Jamaica" (city + country disambiguates searches).
  const pair = fullText.match(new RegExp(`\\b${best[0]},?\\s+([A-Z][a-z]+)\\b`));
  if (pair && counts.has(pair[1]!)) return `${best[0]} ${pair[1]}`;
  return best[0];
}

function intensityOf(text: string, seconds: number) {
  const ws = words(text);
  const wps = ws.length / Math.max(1, seconds);
  const info = (ws.filter((w) => /\d/.test(w) || /^[A-Z]/.test(w) || w.length > 8).length / Math.max(1, ws.length)) * 2.2;
  return {
    narrationIntensity: clamp((wps - 1.8) / 2, 0, 1),
    importance: clamp((/[!]/.test(text) ? 0.3 : 0) + (EMOTION.test(text) ? 0.3 : 0) + (YEAR.test(text) ? 0.2 : 0) + 0.3, 0, 1),
    emotionalIntensity: EMOTION.test(text) ? 0.8 : 0.3,
    informationDensity: clamp(info, 0, 1),
  };
}

function strategyFor(text: string, style: DirectorContext["style"], seed: string): VisualStrategy {
  const year = text.match(YEAR);
  if (ARTICLE_CUES.test(text)) return "article_breakdown";
  if (year && Number(year[1]) < 2000) return style.preferredStrategies.includes("historical_timeline") ? "historical_timeline" : "archival_collage";
  if (INTERVIEW_CUES.test(text)) return "interview";
  if (MAP_CUES.test(text) && style.preferredStrategies.includes("map_sequence")) return "map_sequence";
  // Cue-dependent strategies (interview, article, map, memes, text) are only chosen when the narration cues them.
  const CUED: VisualStrategy[] = ["meme_reaction", "text_emphasis", "interview", "article_breakdown", "map_sequence", "screenshot_sequence"];
  const prefs = style.preferredStrategies.filter((s) => !CUED.includes(s));
  return prefs[Math.floor(seeded(seed)() * prefs.length)] ?? "documentary";
}

/** Capitalised names that are not places or sentence starts (people, bands, crews). */
function names(text: string): string[] {
  const where = new Set(places(text));
  const out: string[] = [];
  const re = /(?<![.!?]\s)(?<!^)\b([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)*)/gu;
  for (const m of text.matchAll(re)) {
    const n = m[1]!;
    if (where.has(n) || STOP.has(n.toLowerCase()) || FILLER.has(n.toLowerCase()) || n.length < 3) continue;
    if (/^(January|February|March|April|May|June|July|August|September|October|November|December|Prime|Minister|President)$/.test(n)) continue;
    out.push(n);
  }
  return [...new Set(out)];
}

const EVENT_WORDS = /\b(rivalry|clash|concert|election|war|fight\w*|riot|protest|festival|trial|murder|shooting|meeting|tour|release|ban|arrest|strike|celebration|funeral|dance|party|show|stage)\b/gi;

const KNOWN_PLACES =
  /\b(Jamaica|Kingston|Montego Bay|Spanish Town|Ocho Rios|Trinidad|Barbados|Haiti|Cuba|Caribbean|London|New York|Brooklyn|Miami|Toronto|Paris|Tokyo|Lagos|Accra|Nigeria|Ghana|Africa|Europe|America|Canada|Mexico|Brazil|India|China|England|Britain|France|Germany|Spain|Italy|California|Texas|Chicago|Los Angeles|Atlanta)\b/g;

/** Rule-based scene analysis (Claude fills the same structure when configured). */
function analysisFor(text: string, strategy: VisualStrategy, meme: MemePlan, anchor: string | null): SceneAnalysis {
  const year = text.match(YEAR)?.[1] ?? null;
  const funny = meme.insert;
  const tone: SceneAnalysis["tone"] = funny ? "humorous" : EMOTION.test(text) ? "somber" : /\b(war|fight|threat|rivalry|violence|clash)\b/i.test(text) ? "tense" : /[!]/.test(text) ? "dramatic" : "neutral";
  const locs = places(text);
  // Well-known places named without a preposition ("split Jamaica into…") are still places.
  for (const m of text.matchAll(KNOWN_PLACES)) if (!locs.includes(m[1]!)) locs.push(m[1]!);
  if (anchor && !locs.includes(anchor) && text.includes(anchor.split(" ")[0]!)) locs.push(anchor);
  return {
    topic: nounPhrases(text, 1)[0] ?? keywords(text, 2).join(" ") ?? text.slice(0, 40),
    people: names(text).filter((n) => !locs.includes(n)).slice(0, 6),
    locations: locs.slice(0, 6),
    events: [...new Set((text.match(EVENT_WORDS) ?? []).map((e) => e.toLowerCase()))].slice(0, 6),
    objects: keywords(text, 4),
    era: year ? `${year.slice(0, 3)}0s` : null,
    tone,
    archivalUseful: Boolean(year && Number(year) < 2012) || strategy === "archival_collage" || strategy === "historical_timeline",
    photoUseful: strategy !== "cinematic_broll",
    screenshotUseful: ARTICLE_CUES.test(text),
    memeAppropriate: funny,
  };
}

function queriesFor(text: string, anchor: string | null, topic: string | null = null): string[] {
  const where = places(text);
  const phrases = nounPhrases(text, 3);
  const kw = keywords(text, 4);
  const year = text.match(YEAR)?.[1];
  const decade = year ? `${year.slice(0, 3)}0s` : null;
  const ctx = where[0] ?? anchor;
  const q: string[] = [];
  if (phrases[0]) q.push(ctx ? `${phrases[0]} ${ctx}` : phrases[0]);
  if (phrases[0]) q.push(phrases[0]);
  if (where[0]) q.push(decade ? `${where[0]} ${decade}` : where[0]);
  if (kw[0]) q.push(ctx ? `${kw[0]} ${ctx}` : kw[0]);
  // Names are ambiguous on their own ("Gaza" → Gaza Strip), so always pair them with the
  // script's subject ("Gully Gaza dancehall").
  const who = names(text).filter((n) => !new RegExp(`^(?:${KNOWN_PLACES.source})$`).test(n) && !/\b(Prime|Minister|President|Mayor|Governor|King|Queen)\b/.test(n));
  const subject = topic ?? anchor?.split(" ")[0] ?? "";
  if (who.length >= 2) q.push(`${who[0]} ${who[1]} ${subject}`.trim());
  else if (who[0]) q.push(`${who[0]} ${subject}`.trim());
  if (phrases[1]) q.push(phrases[1]);
  if (kw.length >= 2) q.push(`${kw[0]} ${kw[1]}`);
  if (!q.length && anchor) q.push(anchor);
  if (!q.length) q.push(text.split(/\s+/).slice(0, 3).join(" "));
  return [...new Set(q)].slice(0, 6);
}

export function memeFor(text: string, sceneDuration: number): MemePlan {
  const cue = text.match(MEME_CUES);
  const hits = (text.match(new RegExp(MEME_CUES.source, "gi")) ?? []).length;
  const base = cue ? 55 + hits * 12 : 10;
  const query = /worse|disaster|chaos/i.test(text)
    ? "this is fine"
    : /somehow|apparently|turns out|wait/i.test(text)
      ? "confused reaction"
      : /genius|obviously|of course/i.test(text)
        ? "slow clap"
        : /awkward|embarrass/i.test(text)
          ? "awkward reaction"
          : "shocked reaction";
  return {
    insert: Boolean(cue),
    queries: [query, "surprised reaction", "facepalm"],
    at: clamp(sceneDuration * 0.65, 0, Math.max(0, sceneDuration - 1.6)),
    duration: 1.6,
    reason: cue ? `Narration cue "${cue[0]}"` : "No comedic cue",
    score: {
      humorOpportunity: clamp(base, 0, 100),
      surprise: clamp(base - 5, 0, 100),
      irony: /of course|ironically|obviously|genius/i.test(text) ? 85 : clamp(base - 15, 0, 100),
      absurdity: /absurd|ridiculous|chaos|literally/i.test(text) ? 85 : clamp(base - 20, 0, 100),
      emotionalBreak: EMOTION.test(text) ? 20 : 50,
      narrativePacing: 55,
    },
  };
}

function textFor(text: string, style: DirectorContext["style"], seed: string, sceneDuration: number): TextOverlayPlan {
  const stat = text.match(/\b(\d[\d,.]*\s?(%|percent|million|billion|thousand)|\d{4})\b/i);
  const rand = seeded(`${seed}:text`)();
  const shortDramatic = words(text).length <= 10 && /[.!]$/.test(text.trim());
  const enabled = Boolean(stat) || (shortDramatic && rand < 0.6) || rand < style.textEmphasisFrequency;
  const phrase = stat
    ? stat[0]
    : (places(text)[0] ?? nounPhrases(text, 1)[0] ?? keywords(text, 2).join(" ")).split(/\s+/).slice(0, 4).join(" ");
  return {
    enabled: enabled && Boolean(phrase),
    text: (phrase || "").toUpperCase(),
    style: stat ? "statistic" : shortDramatic ? "dramatic" : "key_phrase",
    position: "center",
    animation: "pop",
    at: clamp(sceneDuration * 0.15, 0, sceneDuration),
    duration: clamp(Math.min(2.4, sceneDuration * 0.5), 1, 3),
  };
}

export class HeuristicDirector implements Director {
  readonly kind = "heuristic" as const;
  readonly label = "Heuristic director (keyword rules — add ANTHROPIC_API_KEY for Claude)";

  async segmentScenes(_t: Transcript, sentences: Sentence[], ctx: DirectorContext): Promise<SceneSegment[]> {
    const target = Math.max(6, ctx.style.averageShotDuration * 2.2);
    return groupSentences(sentences, target).map((group, i) => {
      const narration = group.map((s) => s.text).join(" ");
      const start = group[0]!.start;
      const end = group.at(-1)!.end;
      const intensity = intensityOf(narration, end - start);
      return {
        sceneId: sceneIdFor(i),
        startTime: start,
        endTime: end,
        narration,
        importance: intensity.importance > 0.65 ? "high" : intensity.importance > 0.4 ? "medium" : "low",
        intensity,
        summary: narration.slice(0, 140),
      };
    });
  }

  async planScenes(segments: SceneSegment[], ctx: DirectorContext): Promise<ScenePlan[]> {
    const recent: ("video" | "photo" | "archival" | "screenshot" | "gif" | "text")[] = [];
    const allText = segments.map((s) => s.narration).join(" ");
    const anchor = contextAnchor(allText);
    const topic = subjectAnchor(allText);
    return segments.map((seg) => {
      if (seg.board) return planFromStoryboard(seg, seg.board, anchor);
      const dur = seg.endTime - seg.startTime;
      const strategy = strategyFor(seg.narration, ctx.style, seg.sceneId);
      const target = targetShotDuration(seg.intensity, ctx.style);
      const shots = splitSceneDurations(dur, target, seg.sceneId);
      const queries = queriesFor(seg.narration, anchor, topic);
      const needs: VisualNeed[] = shots.map((d, i) => {
        let type: VisualNeed["type"];
        if (strategy === "article_breakdown" && i === 0) type = "article";
        else if (strategy === "archival_collage" || strategy === "historical_timeline") type = i % 3 === 2 ? "video" : "archival";
        else type = preferredNeedType(ctx.style, recent, `${seg.sceneId}:${i}`);
        recent.push(type === "archival" ? "archival" : type === "article" ? "screenshot" : (type as "video" | "photo"));
        const rotated = [...queries.slice(i % queries.length), ...queries.slice(0, i % queries.length)];
        const q = type === "article" ? [`${queries[0]} newspaper`, "old newspaper headline", ...queries] : rotated;
        return { type, queries: q.slice(0, 5), duration: d, description: `${type} for: ${seg.summary.slice(0, 80)}` };
      });
      const text = textFor(seg.narration, ctx.style, seg.sceneId, dur);
      const meme = memeFor(seg.narration, dur);
      const sfx: SfxCue[] = [];
      if (seg.importance === "high") sfx.push({ kind: "whoosh", at: 0, reason: "important scene change" });
      if (text.enabled) sfx.push({ kind: "impact", at: text.at, reason: "text emphasis" });
      if (strategy === "archival_collage" || strategy === "historical_timeline") sfx.push({ kind: "camera_shutter", at: 0.05, reason: "archival photo" });
      if (strategy === "article_breakdown") sfx.push({ kind: "paper", at: 0, reason: "document on screen" });
      return {
        sceneId: seg.sceneId,
        startTime: seg.startTime,
        endTime: seg.endTime,
        narration: seg.narration,
        importance: seg.importance,
        intensity: seg.intensity,
        visualStrategy: strategy,
        visualNeeds: needs,
        textOverlay: text,
        meme,
        motion: { type: "slow_zoom_in", intensity: 0.08 },
        transition: seg.importance === "high" && ctx.style.transitionStyle !== "mostly_hard_cut" ? "flash" : "hard_cut",
        sfx,
        analysis: analysisFor(seg.narration, strategy, meme, anchor),
      } satisfies ScenePlan;
    });
  }

  async rankCandidates(input: RankInput): Promise<RankedCandidate[]> {
    return input.candidates
      .map((asset) => {
        const scores = {
          semanticRelevance: clamp(asset.score, 0, 100),
          visualRelevance: clamp(asset.score - 10, 0, 100),
          historicalRelevance: input.need.type === "archival" ? (asset.archival ? 90 : 40) : 50,
          quality: asset.width && asset.width >= 1280 ? 85 : asset.width && asset.width >= 800 ? 65 : 50,
          composition: 60,
          rightsSafety: RIGHTS_RANK[asset.rightsStatus],
        };
        const kind = kindOf(asset, input.need.type);
        return {
          asset,
          scores,
          overall: combineScores(scores, kind, input.recentKinds, input.usedAssetIds.has(asset.id)),
          reason: "Heuristic: keyword overlap, resolution, rights and diversity",
        };
      })
      .sort((a, b) => b.overall - a.overall);
  }

  async refineClips(clips: DraftClip[], ctx: DirectorContext): Promise<ClipDecision[]> {
    let prev = clips[0]?.previousMotion;
    return clips.map((c) => {
      const rand = seeded(c.clipId);
      const isStill = c.asset.type === "photo";
      const layout: ClipDecision["layout"] =
        c.needType === "article" || c.needType === "screenshot"
          ? "article"
          : isStill && (c.asset.archival || rand() < ctx.style.paperLayoutFrequency)
            ? rand() < 0.3
              ? "polaroid"
              : "paper_card"
            : "fullscreen";
      const motion = isStill ? chooseMotion(c.asset.width, c.asset.height, prev, c.suggestedMotion, c.clipId) : rand() < 0.25 ? "punch_in" : "none";
      prev = motion;
      const annotations: ClipDecision["annotations"] =
        layout === "article"
          ? [
              {
                // Vary the call-out: highlight, circle, underline or arrow on the headline area.
                kind: (["highlight", "red_circle", "underline", "arrow"] as const)[Math.floor(rand() * 4)]!,
                rect: { x: 0.12, y: 0.12 + rand() * 0.1, w: 0.76, h: 0.12 },
                appearAt: 0.5 + rand() * 0.6,
              },
            ]
          : [];
      return {
        clipId: c.clipId,
        layout,
        motion,
        motionIntensity: 0.1,
        blackAndWhite: c.asset.archival && rand() < ctx.style.blackAndWhiteFrequency * 3,
        annotations,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Storyboard-driven plans (the editorial path; see storyboard.ts)
// ---------------------------------------------------------------------------

/** Searchable need type for each editorial visual type. */
export function needTypeFor(t: EditorialVisualType): VisualNeed["type"] {
  switch (t) {
    case "text_card":
    case "statistic_graphic":
    case "timeline_graphic":
      return "graphic";
    case "newspaper":
    case "news_screenshot":
    case "document":
      return "article";
    case "social_screenshot":
      return "screenshot";
    case "archival_video":
      return "archival";
    case "b_roll":
    case "establishing_shot":
    case "abstract_background":
    case "interview":
    case "music_video_reference":
      return "video";
    case "reaction_gif":
    case "meme":
      return "reaction";
    default:
      return "photo";
  }
}

function strategyForIntent(sb: SceneBoard["storyboard"], beats: SceneBoard["beats"]): VisualStrategy {
  if (beats.some((b) => b.visualType === "newspaper" || b.visualType === "document")) return "article_breakdown";
  if (sb.intents.includes("historical_event") || sb.intents.includes("archival")) return "historical_timeline";
  if (sb.intent === "climax" || sb.intent === "buildup") return "cinematic_broll";
  if (sb.intents.includes("political")) return "evidence_board";
  if (beats.filter((b) => b.visualType === "person_photo").length >= 2) return "photograph_sequence";
  if (sb.intents.includes("conflict")) return "mixed_media";
  return "documentary";
}

function planFromStoryboard(seg: SceneSegment, board: SceneBoard, anchor: string | null): ScenePlan {
  const sb = board.storyboard;
  const dur = seg.endTime - seg.startTime;
  const I = sb.intensity;
  const needs: VisualNeed[] = board.beats.map((b) => ({
    type: needTypeFor(b.visualType),
    queries: b.queries,
    duration: b.end - b.start,
    description: b.description,
    visualType: b.visualType,
    entities: b.entities,
    year: b.year,
    topic: b.topic,
    stockAllowed: b.stockAllowed,
    fallbacks: b.fallbacks,
    card: b.card,
    avoid: b.avoid,
    local: b.local,
    line: b.line,
    transition: b.transition === "hard_cut" ? undefined : b.transition,
  }));
  const meme = memeFor(seg.narration, dur);
  const strategy = strategyForIntent(sb, board.beats);
  const text: TextOverlayPlan = board.text
    ? { enabled: true, text: board.text.text, style: board.text.style, position: board.text.position, animation: board.text.style === "dramatic" ? "pop" : "fade", at: clamp(dur * 0.12, 0, dur), duration: clamp(Math.min(2.4, dur * 0.5), 1, 3) }
    : { enabled: false, text: "", style: "key_phrase", position: "center", animation: "none", at: 0, duration: 1 };
  return {
    sceneId: seg.sceneId,
    startTime: seg.startTime,
    endTime: seg.endTime,
    narration: seg.narration,
    importance: I >= 8 ? "high" : I >= 5 ? "medium" : "low",
    intensity: { ...seg.intensity, importance: I / 10, emotionalIntensity: sb.intents.includes("emotional") ? 0.8 : seg.intensity.emotionalIntensity },
    visualStrategy: strategy,
    visualNeeds: needs,
    textOverlay: text,
    meme: { ...meme, insert: meme.insert && board.memeAllowed, reason: sb.memeReason },
    // Zoom strength follows the intensity curve: gentle in calm passages, stronger when it builds.
    motion: { type: I >= 8 ? "punch_in" : "slow_zoom_in", intensity: Math.round((0.05 + I * 0.011) * 1000) / 1000 },
    transition: board.transition,
    sfx: board.sfx,
    analysis: analysisFor(seg.narration, strategy, meme, anchor),
    storyboard: sb,
  };
}
