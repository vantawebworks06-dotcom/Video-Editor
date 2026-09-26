/**
 * Storyboard-driven media selection. Each beat is searched for exactly what the storyboard asked
 * for (entity-first queries, archive providers for specifics, stock only for atmosphere), every
 * candidate is scored for relevance, and only a candidate that clears the bar is used. Otherwise
 * the beat walks its fallback chain; if nothing relevant exists it becomes a designed card —
 * never a random clip (sections 7, 9, 25 of the brief).
 */
import type { AssetType, EditorialVisualType, NormalizedAsset, ProjectSettings, ProviderId, ScenePlan, VisualNeed } from "@/lib/domain/types";
import { searchMedia, type SearchError, type SearchRequest, type SearchResponse } from "@/lib/media/searchOrchestrator";
import { cardAsset } from "./cards";
import type { DirectorContext } from "./director";
import type { GenerateDeps, SceneSelection } from "./generate";
import { accepts, type RelevanceContext, type RelevanceResult, scoreRelevance } from "./relevance";

const STOCK: ProviderId[] = ["pexels", "pixabay"];

function typesFor(t: EditorialVisualType | undefined): AssetType[] {
  switch (t) {
    case "archival_video":
    case "event_photo":
      return ["photo", "video"];
    case "b_roll":
    case "establishing_shot":
    case "abstract_background":
    case "interview":
    case "music_video_reference":
      return ["video", "photo"];
    default:
      return ["photo"];
  }
}

/** Specific beats search the archives (Wikimedia, Internet Archive); atmosphere may use stock. */
function providersFor(t: EditorialVisualType | undefined, stockAllowed: boolean, enabled: ProviderId[]): ProviderId[] {
  const archive: ProviderId[] = ["wikimedia"];
  // Internet Archive is slow and mostly film/newsreels: only where that is what's wanted.
  if (t === "archival_video" || t === "event_photo" || t === "newspaper" || t === "document") archive.push("internet_archive");
  const list: ProviderId[] = stockAllowed ? [...STOCK, ...archive] : archive;
  return list.filter((p) => enabled.includes(p));
}

export function editorialSearch(
  visualType: EditorialVisualType | undefined,
  queries: string[],
  stockAllowed: boolean,
  need: VisualNeed,
  ctx: DirectorContext,
  settings: ProjectSettings,
): SearchRequest {
  const types = typesFor(visualType);
  return {
    queries,
    types,
    providers: providersFor(visualType, stockAllowed, settings.enabledProviders),
    orientation: ctx.orientation,
    minDuration: types.includes("video") ? Math.min(need.duration + 0.5, 20) : undefined,
    perQuery: settings.budgetMode ? 6 : 10,
    maxQueries: settings.budgetMode ? 2 : 3,
    preferArchival: visualType === "archival_video",
    allowReview: false,
    allowUnknown: false,
    gifRating: settings.gifRating,
    limit: 30,
  };
}

export interface EditorialPick {
  selection: SceneSelection;
  /** Every scored candidate (best first) — the quality-control pass swaps from these. */
  ranked: RelevanceResult[];
}

/** Candidates from the user's own library that fit this beat (section 21). */
function libraryCandidates(lib: NormalizedAsset[] | undefined, types: AssetType[]): NormalizedAsset[] {
  return (lib ?? []).filter((a) => types.includes(a.type));
}

export async function selectEditorial(
  plan: ScenePlan,
  need: VisualNeed,
  clipId: string,
  start: number,
  ctx: DirectorContext,
  deps: GenerateDeps,
  rel: RelevanceContext,
  searchErrors: SearchError[],
  settings: ProjectSettings,
  prefetched?: Promise<SearchResponse>,
  trimStartFor?: (assetDuration: number | null, needed: number, seed: string) => number,
): Promise<EditorialPick> {
  const base = (asset: NormalizedAsset, r: RelevanceResult | null, reason: string): SceneSelection => ({
    clipId,
    sceneId: plan.sceneId,
    start,
    duration: need.duration,
    needType: asset.provider === "graphic" ? "graphic" : need.type,
    needDescription: need.description,
    queries: need.queries,
    asset,
    alternates: [],
    scores: r ? { ...r.scores } : null,
    overall: r ? r.total : null,
    reason,
    role: "primary",
    selectedBy: deps.director.kind === "claude" ? "ai" : "heuristic",
    layout: "fullscreen",
    motion: asset.type === "photo" ? plan.motion.type : "none",
    motionIntensity: plan.motion.intensity || 0.08,
    blackAndWhite: false,
    annotations: [],
    trimStart: trimStartFor?.(asset.duration, need.duration, clipId) ?? 0,
    transitionIn: need.transition,
  });

  const card = () => {
    let c = need.card ?? { kind: "chapter" as const, text: need.description.toUpperCase().slice(0, 40), sub: null };
    // Never the same card twice in a row ("2007", "2007"): show the line itself instead.
    const last = rel.recentCards?.get(c.text);
    if (last !== undefined && start - last < 12) c = { kind: "headline", text: need.line ?? (c.sub ?? need.description).toUpperCase().slice(0, 60), sub: null };
    const why =
      need.type === "graphic"
        ? `Designed ${c.kind} card planned by the storyboard (${need.visualType?.replace(/_/g, " ") ?? "graphic"}).`
        : `No relevant media found for ${need.entities?.[0] ?? `"${need.description}"`} — a designed ${c.kind} card keeps the focus on the story instead of an unrelated clip.`;
    return base(cardAsset(c, why), null, why);
  };

  if (need.type === "graphic") return { selection: card(), ranked: [] };

  const attempts = [
    { visualType: need.visualType, queries: need.queries, stockAllowed: need.stockAllowed ?? false, stage: "primary" as const, description: need.description },
    ...(need.fallbacks ?? []).slice(0, 3).map((f) => ({ ...f, stage: "fallback" as const })),
  ];
  rel.now = start;
  const all: RelevanceResult[] = [];
  for (const [ai, a] of attempts.entries()) {
    if (!a.queries.length) continue;
    const req = editorialSearch(a.visualType, a.queries, a.stockAllowed, need, ctx, settings);
    const res = await (ai === 0 && prefetched ? prefetched : searchMedia(req, { creds: deps.creds, cache: deps.searchCache }));
    searchErrors.push(...res.errors);
    // Score against what THIS attempt is for (a fallback location shot isn't judged as a portrait).
    const judged: VisualNeed = ai === 0 ? need : { ...need, visualType: a.visualType, queries: a.queries, stockAllowed: a.stockAllowed, entities: a.visualType === "person_photo" || a.visualType === "event_photo" ? need.entities : [] };
    const scored = [...res.candidates, ...libraryCandidates(deps.library, req.types)]
      .map((c) => {
        const r = scoreRelevance(c, judged, rel);
        // The user's own library is preferred when it's relevant.
        return c.provider === "uploaded" || deps.library?.includes(c) ? { ...r, total: Math.min(100, r.total + 8) } : r;
      })
      .sort((x, y) => y.total - x.total);
    all.push(...scored);
    const best = scored.find((r) => accepts(r, judged, a.stage));
    if (best) {
      const prefix = a.stage === "fallback" ? `Fallback (${a.description}) — no strong ${need.visualType?.replace(/_/g, " ") ?? "match"} was found. ` : "";
      const sel = base(best.asset, best, `${prefix}${best.reason}`);
      sel.alternates = scored.filter((r) => r !== best && r.total >= best.total - 25 && r.scores.penalty < 40).slice(0, 4).map((r) => r.asset);
      return { selection: sel, ranked: all.sort((x, y) => y.total - x.total) };
    }
  }
  all.sort((x, y) => y.total - x.total);
  // The same name card seconds after the last one reads as a glitch: if something reasonably
  // related and on-tone exists, use it instead (flagged as a near match).
  const planned = need.card;
  const lastSame = planned ? rel.recentCards?.get(planned.text) : undefined;
  if (planned && lastSame !== undefined && start - lastSame < 30) {
    const near = all.find((r) => r.total >= 40 && r.scores.penalty < 14 && !rel.used.has(r.asset.id));
    if (near) {
      const sel = base(near.asset, near, `Closest available image (relevance ${near.total}) — no exact match, and a repeated ${planned.kind} card would stall the edit. ${near.reason}`);
      return { selection: sel, ranked: all };
    }
  }
  // Nothing relevant: a designed card, not whatever looked vaguely similar.
  const sel = card();
  rel.recentCards?.set(sel.asset.title, start);
  return { selection: sel, ranked: all };
}
