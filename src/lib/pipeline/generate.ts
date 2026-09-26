import type {
  Annotation,
  Layout,
  MotionType,
  NormalizedAsset,
  ProjectSettings,
  ProviderId,
  ScenePlan,
  StyleProfile,
  Transcript,
  Transition,
  VisualNeed,
} from "@/lib/domain/types";
import type { SearchCache } from "@/lib/media/cache";
import type { ProviderCredentials } from "@/lib/media/providers/types";
import { createLimiter } from "@/lib/limiter";
import { searchMedia, type SearchError, type SearchRequest, type SearchResponse } from "@/lib/media/searchOrchestrator";
import type { Director, DirectorContext, SceneSegment } from "./director";
import { assetTypesForNeed, kindOf, shouldInsertMeme, type VisualKind } from "./engines";
import { isGraphic } from "./cards";
import { editorialSearch, selectEditorial } from "./editorialSelect";
import { buildEntityIndex, foreignRegex } from "./entities";
import { HeuristicDirector } from "./heuristicDirector";
import type { RelevanceContext, RelevanceResult } from "./relevance";
import { reviewEdit, type ReviewIssue } from "./review";
import { buildStoryboards, type SceneBoard } from "./storyboard";
import { sentencesFromWords } from "./transcript";

export interface SceneSelection {
  clipId: string;
  sceneId: string;
  start: number; // absolute seconds
  duration: number;
  needType: VisualNeed["type"];
  needDescription: string;
  queries: string[];
  asset: NormalizedAsset;
  alternates: NormalizedAsset[];
  /** Relevance breakdown (entityMatch, eventMatch, …, confidence) or legacy AI scores. */
  scores: Record<string, number> | null;
  overall: number | null;
  reason: string;
  role: "primary" | "meme";
  selectedBy: "ai" | "heuristic" | "user";
  layout: Layout;
  motion: MotionType;
  motionIntensity: number;
  blackAndWhite: boolean;
  annotations: Annotation[];
  trimStart: number;
  /** How this clip enters (beat- or scene-level editorial choice). */
  transitionIn?: Transition;
}

export interface GenerateInput {
  projectTitle: string;
  transcript: Transcript;
  settings: ProjectSettings;
  style: StyleProfile;
  orientation: "landscape" | "portrait";
  /** When set, only these scenes are re-planned/re-selected; others are kept from `existing`. */
  onlySceneIds?: Set<string>;
  existing?: { plans: ScenePlan[]; selections: SceneSelection[] };
}

export interface GenerateDeps {
  director: Director;
  creds: ProviderCredentials;
  searchCache?: SearchCache;
  onProgress?: (stage: string, progress: number) => void | Promise<void>;
  log?: (msg: string) => void;
  /** Aborting stops searches that haven't started yet (the job was cancelled). */
  signal?: AbortSignal;
  /** The user's own saved/uploaded media, preferred when relevant (section 21). */
  library?: NormalizedAsset[];
}

export interface GenerateResult {
  plans: ScenePlan[];
  selections: SceneSelection[];
  warnings: string[];
  searchErrors: SearchError[];
  /** Pass-2 editorial review: what was flagged and what was done about it. */
  review?: ReviewIssue[];
}

const ARCHIVE_PROVIDERS: ProviderId[] = ["wikimedia", "internet_archive"];

function providersForNeed(need: VisualNeed, enabled: ProviderId[]): ProviderId[] {
  if (need.type === "reaction") return enabled.filter((p) => p === "giphy");
  const base = enabled.filter((p) => p !== "giphy");
  if (need.type === "archival" || need.type === "article" || need.type === "screenshot") {
    const archival = base.filter((p) => ARCHIVE_PROVIDERS.includes(p));
    return archival.length ? archival : base;
  }
  return base;
}

export async function generateEdit(input: GenerateInput, deps: GenerateDeps): Promise<GenerateResult> {
  const { director } = deps;
  const warnings: string[] = [];
  const searchErrors: SearchError[] = [];
  const log = deps.log ?? (() => undefined);
  const ctx: DirectorContext = {
    style: input.style,
    settings: input.settings,
    projectTitle: input.projectTitle,
    orientation: input.orientation,
  };

  // 1-2. Understand the story (who/where/when), storyboard every scene in context, then plan
  //      (reuse untouched scenes when regenerating a subset). Nothing is searched before this.
  await deps.onProgress?.("Understanding scenes…", 0.05);
  const fullText = input.transcript.words.map((w) => w.word).join(" ");
  const entityIndex = await buildEntityIndex(fullText, input.projectTitle, { cache: deps.searchCache, log, signal: deps.signal });
  let plans: ScenePlan[];
  let boards: Map<string, SceneBoard>;
  if (input.onlySceneIds && input.existing) {
    boards = buildStoryboards(input.existing.plans, input.transcript.words, entityIndex, input.style);
    const targets = input.existing.plans.filter((p) => input.onlySceneIds!.has(p.sceneId));
    await deps.onProgress?.("Understanding scenes…", 0.1);
    const segments: SceneSegment[] = targets.map((p) => ({
      sceneId: p.sceneId,
      startTime: p.startTime,
      endTime: p.endTime,
      narration: p.narration,
      importance: p.importance,
      intensity: p.intensity,
      summary: p.narration.slice(0, 140),
      board: boards.get(p.sceneId),
    }));
    const replanned = await director.planScenes(segments, ctx);
    plans = input.existing.plans.map((p) => replanned.find((r) => r.sceneId === p.sceneId) ?? p);
  } else {
    const sentences = sentencesFromWords(input.transcript.words);
    if (!sentences.length) throw new Error("The transcript has no words to edit.");
    const segments = await director.segmentScenes(input.transcript, sentences, ctx);
    log(`segmented into ${segments.length} scenes`);
    boards = buildStoryboards(segments, input.transcript.words, entityIndex, input.style);
    for (const seg of segments) seg.board = boards.get(seg.sceneId);
    await deps.onProgress?.("Understanding scenes…", 0.15);
    plans = await director.planScenes(segments, ctx);
  }
  for (const p of plans) if (!p.storyboard && boards.get(p.sceneId)) p.storyboard = boards.get(p.sceneId)!.storyboard;
  const rel: RelevanceContext = { country: entityIndex.country, foreign: foreignRegex(entityIndex.country), used: new Set(), recentProviders: [], recentKinds: [], recentCards: new Map(), usedAt: new Map(), storyNames: entityIndex.entities.filter((e) => e.kind === "person" || e.kind === "organization").flatMap((e) => [e.name, ...e.aliases]), storyYear: medianYear(fullText) };
  const pool = new Map<string, RelevanceResult[]>();

  // 3-5. Search, rank and select media per visual need.
  const kept = input.onlySceneIds && input.existing
    ? input.existing.selections.filter((s) => !input.onlySceneIds!.has(s.sceneId))
    : [];
  const selections: SceneSelection[] = [];
  const used = new Set(kept.map((s) => s.asset.id));
  const recent: VisualKind[] = [];
  let scenesSinceMeme = 99;
  const targets = plans.filter((p) => !input.onlySceneIds || input.onlySceneIds.has(p.sceneId));

  // Searching doesn't depend on earlier picks (only ranking does, via `used`/`recent`), so every
  // visual's primary search starts now, a few at a time, while selection below still runs in
  // timeline order and awaits each result. Was: one search after another.
  const searchSlots = createLimiter(SEARCH_CONCURRENCY, deps.signal);
  const prefetched = new Map<string, Promise<SearchResponse>>();
  for (const plan of targets) {
    plan.visualNeeds.forEach((need, ni) => {
      if (need.type === "graphic" || (need.visualType && !need.queries.length)) return;
      const req = need.visualType ? editorialSearch(need.visualType, need.queries, need.stockAllowed ?? false, need, ctx, input.settings) : primarySearch(need, need.queries, ctx, input.settings);
      const p = searchSlots(() => searchMedia(req, { creds: deps.creds, cache: deps.searchCache }));
      p.catch(() => undefined); // awaited (and surfaced) in selectForNeed
      prefetched.set(`${plan.sceneId}_c${ni + 1}`, p);
    });
  }

  for (const [pi, plan] of plans.entries()) {
    if (!targets.includes(plan)) {
      const keptHere = kept.filter((s) => s.sceneId === plan.sceneId);
      selections.push(...keptHere);
      for (const s of keptHere) recent.push(kindOf(s.asset, s.needType));
      scenesSinceMeme = keptHere.some((s) => s.role === "meme") ? 0 : scenesSinceMeme + 1;
      continue;
    }
    await deps.onProgress?.(`Searching for footage… (scene ${pi + 1}/${plans.length})`, 0.2 + 0.6 * (pi / Math.max(1, plans.length)));

    let cursor = plan.startTime;
    const sceneSelections: SceneSelection[] = [];
    for (const [ni, need] of plan.visualNeeds.entries()) {
      const clipId = `${plan.sceneId}_c${ni + 1}`;
      let chosen: SceneSelection | null;
      if (need.visualType || need.type === "graphic") {
        rel.used = used;
        const pick = await selectEditorial(plan, need, clipId, cursor, ctx, deps, rel, searchErrors, input.settings, prefetched.get(clipId), videoTrimStart);
        chosen = pick.selection;
        pool.set(clipId, pick.ranked);
        rel.usedAt!.set(chosen.asset.id, cursor);
        rel.recentProviders.push(chosen.asset.provider);
        rel.recentKinds.push(isGraphic(chosen.asset) ? "graphic" : chosen.asset.type === "video" ? "video" : chosen.asset.archival ? "archival" : "photo");
      } else {
        chosen = await selectForNeed(plan, need, clipId, cursor, ctx, deps, used, recent, searchErrors, input.settings, prefetched.get(clipId));
      }
      if (chosen && ni === 0 && !need.transition) chosen.transitionIn = plan.transition;
      if (chosen) {
        sceneSelections.push(chosen);
        used.add(chosen.asset.id);
        recent.push(kindOf(chosen.asset, need.type));
      } else if (sceneSelections.length) {
        // No usable media: extend the previous shot instead of failing the scene.
        sceneSelections.at(-1)!.duration += need.duration;
        warnings.push(`${clipId}: no usable media found for "${need.queries[0]}"; extended previous shot.`);
      } else {
        warnings.push(`${clipId}: no usable media found for "${need.queries[0]}".`);
      }
      cursor += need.duration;
    }
    if (!sceneSelections.length && selections.length) {
      selections.at(-1)!.duration += plan.endTime - plan.startTime;
      warnings.push(`${plan.sceneId}: no media found; previous shot extended over this scene.`);
    }

    // Meme / reaction insertion with threshold + cooldown.
    const board = boards.get(plan.sceneId);
    const gate = board && !board.memeAllowed ? { insert: false, score: 0, reason: board.storyboard.memeReason } : shouldInsertMeme(plan.meme, input.settings.memeFrequency, scenesSinceMeme);
    let memeAdded = false;
    if (gate.insert && sceneSelections.length) {
      if (!input.settings.enabledProviders.includes("giphy")) {
        warnings.push(`${plan.sceneId}: meme moment found but GIPHY is disabled.`);
      } else if (!input.settings.allowReviewAssets) {
        warnings.push(`${plan.sceneId}: meme moment found but review-required assets (GIPHY) are not allowed in auto edits.`);
      } else {
        await deps.onProgress?.(`Adding reactions… (${plan.sceneId})`, 0.2 + 0.6 * ((pi + 0.9) / Math.max(1, plans.length)));
        const meme = await insertMeme(plan, sceneSelections, deps, input.settings, searchErrors, used);
        if (meme) {
          memeAdded = true;
          used.add(meme.asset.id);
          log(`${plan.sceneId}: meme inserted (${gate.score.toFixed(2)}) ${meme.asset.title}`);
        }
      }
    }
    scenesSinceMeme = memeAdded ? 0 : scenesSinceMeme + 1;
    selections.push(...sceneSelections.sort((a, b) => a.start - b.start));
  }

  // Pass 2: review the whole edit like a second editor and fix weak spots (sections 29-30).
  await deps.onProgress?.("Reviewing the edit…", 0.83);
  const review = reviewEdit(plans, selections, pool, { onlySceneIds: input.onlySceneIds, rel });
  for (const r of review) log(`review: ${r.clipId ?? r.sceneId} ${r.problem} → ${r.action}`);

  // 6. Per-clip layout/motion/annotation decisions.
  await deps.onProgress?.("Adding effects…", 0.85);
  for (const s of selections) if (isGraphic(s.asset)) Object.assign(s, { layout: "fullscreen", motion: "slow_zoom_in", motionIntensity: 0.05 });
  const toRefine = selections.filter((s) => s.role === "primary" && !isGraphic(s.asset) && (!input.onlySceneIds || input.onlySceneIds.has(s.sceneId)));
  for (let i = 0; i < toRefine.length; i += 20) {
    const chunk = toRefine.slice(i, i + 20);
    const prevSel = selections[selections.indexOf(chunk[0]!) - 1];
    try {
      const decisions = await director.refineClips(
        chunk.map((s, k) => ({
          clipId: s.clipId,
          narration: plans.find((p) => p.sceneId === s.sceneId)?.narration ?? "",
          strategy: plans.find((p) => p.sceneId === s.sceneId)?.visualStrategy ?? "documentary",
          needType: s.needType,
          asset: s.asset,
          duration: s.duration,
          previousMotion: k === 0 ? prevSel?.motion : undefined,
          suggestedMotion: plans.find((p) => p.sceneId === s.sceneId)?.motion.type,
        })),
        ctx,
      );
      for (const d of decisions) {
        const s = chunk.find((c) => c.clipId === d.clipId);
        if (!s) continue;
        Object.assign(s, { layout: d.layout, motion: d.motion, motionIntensity: d.motionIntensity, blackAndWhite: d.blackAndWhite, annotations: d.annotations });
      }
    } catch (err) {
      warnings.push(`Shot design step failed (${(err as Error).message}); default layouts used.`);
    }
  }

  await deps.onProgress?.("Building timeline…", 0.95);
  return { plans, selections, warnings, searchErrors, review };
}

/** Typical year a story is set in: the median of the years its narration mentions. */
function medianYear(text: string): number | null {
  const ys = [...text.matchAll(/\b(1[89]\d\d|20[0-3]\d)\b/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  return ys.length ? ys[Math.floor(ys.length / 2)]! : null;
}

/** Visuals searched at once; each search also fans out over queries × providers (see searchMedia). */
const SEARCH_CONCURRENCY = 3;

/** The provider search for one visual need (primary visuals: CLEAR / ATTRIBUTION_REQUIRED only). */
function primarySearch(need: VisualNeed, queries: string[], ctx: DirectorContext, settings: ProjectSettings): SearchRequest {
  return {
    queries,
    types: assetTypesForNeed(need.type),
    providers: providersForNeed(need, settings.enabledProviders),
    orientation: ctx.orientation,
    minDuration: need.type === "video" ? Math.min(need.duration + 0.5, 20) : undefined,
    perQuery: settings.budgetMode ? 6 : 10,
    maxQueries: settings.budgetMode ? 2 : 4,
    preferArchival: need.type === "archival" || ctx.style.archivalPercentage > 30,
    allowReview: false,
    allowUnknown: false,
    gifRating: settings.gifRating,
    limit: settings.budgetMode ? 8 : 16,
  };
}

async function selectForNeed(
  plan: ScenePlan,
  need: VisualNeed,
  clipId: string,
  start: number,
  ctx: DirectorContext,
  deps: GenerateDeps,
  used: Set<string>,
  recent: VisualKind[],
  searchErrors: SearchError[],
  settings: ProjectSettings,
  prefetched?: Promise<SearchResponse>,
): Promise<SceneSelection | null> {
  const attempt = async (queries: string[], started?: Promise<SearchResponse>) => {
    const r = await (started ?? searchMedia(primarySearch(need, queries, ctx, settings), { creds: deps.creds, cache: deps.searchCache }));
    searchErrors.push(...r.errors);
    return r.candidates;
  };

  let candidates = await attempt(need.queries, prefetched);
  if (!candidates.length) {
    // Broaden: individual keywords from the queries, then any photo/video type.
    const words = [...new Set(need.queries.join(" ").split(/\s+/).filter((w) => w.length > 4))].slice(0, 3);
    if (words.length) candidates = await attempt(words);
  }
  if (!candidates.length) return null;

  await deps.onProgress?.(`Selecting visuals… (${clipId})`, -1);
  const ranked = await deps.director.rankCandidates(
    { narration: plan.narration, strategy: plan.visualStrategy, need, candidates, recentKinds: recent, usedAssetIds: used },
    ctx,
  ).catch(async (err) => {
    searchErrors.push({ provider: "wikimedia", query: need.queries[0] ?? "", code: "AI_RANK_FAILED", message: (err as Error).message });
    return new HeuristicDirector().rankCandidates({
      narration: plan.narration, strategy: plan.visualStrategy, need, candidates, recentKinds: recent, usedAssetIds: used,
    });
  });
  const pick = ranked.find((r) => !used.has(r.asset.id)) ?? ranked[0];
  if (!pick) return null;
  return {
    clipId,
    sceneId: plan.sceneId,
    start,
    duration: need.duration,
    needType: need.type,
    needDescription: need.description,
    queries: need.queries,
    asset: pick.asset,
    alternates: ranked.filter((r) => r !== pick).slice(0, 4).map((r) => r.asset),
    scores: { ...pick.scores },
    overall: pick.overall,
    reason: pick.reason,
    role: "primary",
    selectedBy: deps.director.kind === "claude" ? "ai" : "heuristic",
    layout: "fullscreen",
    motion: pick.asset.type === "photo" ? plan.motion.type : "none",
    motionIntensity: plan.motion.intensity || 0.08,
    blackAndWhite: false,
    annotations: [],
    trimStart: videoTrimStart(pick.asset.duration, need.duration, clipId),
  };
}

/**
 * Where to start inside a longer video: skip leaders/title slates (archival films and
 * government footage usually open on one) and vary the offset between clips.
 */
export function videoTrimStart(assetDuration: number | null, needed: number, seed: string): number {
  if (!assetDuration || assetDuration < needed + 4) return 0;
  const lead = Math.min(8, assetDuration * 0.15);
  const room = assetDuration - needed - 1 - lead;
  if (room <= 0) return Math.round(lead * 10) / 10;
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return Math.round((lead + (h % 1000) / 1000 * Math.min(room, 20)) * 10) / 10;
}

export async function insertMeme(
  plan: ScenePlan,
  sceneSelections: SceneSelection[],
  deps: GenerateDeps,
  settings: ProjectSettings,
  searchErrors: SearchError[],
  used: Set<string>,
): Promise<SceneSelection | null> {
  const r = await searchMedia(
    {
      queries: plan.meme.queries,
      types: ["gif"],
      providers: ["giphy"],
      orientation: "landscape",
      allowReview: true, // GIPHY is USER_REVIEW; permitted here only because settings.allowReviewAssets is on
      allowUnknown: false,
      gifRating: settings.gifRating,
      maxQueries: 2,
      perQuery: 8,
      limit: 8,
    },
    { creds: deps.creds, cache: deps.searchCache },
  );
  searchErrors.push(...r.errors);
  const gif = r.candidates.find((c) => !used.has(c.id));
  if (!gif) return null;

  // Carve the meme out of the shot it lands on.
  const at = plan.startTime + plan.meme.at;
  const host = sceneSelections.find((s) => at >= s.start && at < s.start + s.duration);
  if (!host) return null;
  const dur = Math.min(plan.meme.duration, host.duration * 0.6);
  if (dur < 0.8) return null;
  const hostEnd = host.start + host.duration;
  const memeStart = Math.min(Math.max(at, host.start + 0.6), hostEnd - dur);
  const tailDur = hostEnd - (memeStart + dur);
  host.duration = memeStart - host.start;

  const meme: SceneSelection = {
    ...host,
    clipId: `${plan.sceneId}_meme`,
    start: memeStart,
    duration: dur,
    needType: "reaction",
    needDescription: plan.meme.reason,
    queries: plan.meme.queries,
    asset: gif,
    alternates: r.candidates.filter((c) => c !== gif).slice(0, 4),
    scores: null,
    overall: gif.score,
    reason: plan.meme.reason,
    role: "meme",
    layout: "fullscreen",
    motion: "none",
    blackAndWhite: false,
    annotations: [],
    trimStart: 0,
  };
  sceneSelections.push(meme);
  if (tailDur > 0.3) {
    // Resume the host visual after the reaction ("interruption" rather than replacement).
    sceneSelections.push({ ...host, clipId: `${host.clipId}_b`, start: memeStart + dur, duration: tailDur, trimStart: host.trimStart + host.duration + dur, annotations: [] });
  } else {
    host.duration += tailDur;
  }
  return meme;
}
