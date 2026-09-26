/**
 * Pass 2 of the two-pass edit (sections 29-30 of the brief): a second, sceptical editor reviews
 * the complete timeline and fixes weak spots before anything is rendered — it never assumes the
 * first pick was right. Every finding is returned (and logged) with the action taken.
 */
import type { ScenePlan, VisualNeed } from "@/lib/domain/types";
import { cardAsset, isGraphic } from "./cards";
import type { SceneSelection } from "./generate";
import { accepts, MIN_RELEVANCE, type RelevanceContext, type RelevanceResult, spacedReuseOk } from "./relevance";

export interface ReviewIssue {
  sceneId: string;
  clipId: string | null;
  problem:
    | "visual_mismatch"
    | "generic_stock"
    | "repeated_visual"
    | "provider_run"
    | "excessive_duration"
    | "card_run"
    | "repeated_transition"
    | "weak_climax";
  reason: string;
  action: "replaced" | "card" | "split" | "changed" | "kept";
}

const STOCK = new Set(["pexels", "pixabay"]);
/** Longest a single visual may hold, by pacing (seconds). */
const MAX_HOLD: Record<string, number> = { slow: 6.5, normal: 5, fast: 3.2, rapid: 2 };

function needFor(plan: ScenePlan | undefined, clipId: string): VisualNeed | undefined {
  const n = Number(clipId.match(/_c(\d+)/)?.[1] ?? 0);
  return plan?.visualNeeds[n - 1];
}

export function reviewEdit(
  plans: ScenePlan[],
  selections: SceneSelection[],
  pool: Map<string, RelevanceResult[]>,
  opts: { onlySceneIds?: Set<string>; rel: RelevanceContext },
): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const planOf = new Map(plans.map((p) => [p.sceneId, p]));
  const inScope = (s: SceneSelection) => s.role === "primary" && (!opts.onlySceneIds || opts.onlySceneIds.has(s.sceneId));
  const used = new Map<string, number>();
  for (const s of selections) used.set(s.asset.id, (used.get(s.asset.id) ?? 0) + 1);

  const swap = (s: SceneSelection, pred: (r: RelevanceResult) => boolean, relax = 0): RelevanceResult | null => {
    const need = needFor(planOf.get(s.sceneId), s.clipId);
    for (const r of pool.get(s.clipId) ?? []) {
      if (r.asset.id === s.asset.id || (used.get(r.asset.id) ?? 0) > 0) continue;
      if (!pred(r)) continue;
      const ok = need ? accepts({ ...r, total: r.total + relax }, need, "fallback") : r.total + relax >= MIN_RELEVANCE;
      if (!ok) continue;
      return r;
    }
    return null;
  };
  const apply = (s: SceneSelection, r: RelevanceResult, why: string) => {
    used.set(s.asset.id, (used.get(s.asset.id) ?? 1) - 1);
    used.set(r.asset.id, (used.get(r.asset.id) ?? 0) + 1);
    Object.assign(s, { asset: r.asset, scores: { ...r.scores }, overall: r.total, reason: `Replaced in review (${why}). ${r.reason}` });
    if (r.asset.type !== "video") s.trimStart = 0;
  };
  const toCard = (s: SceneSelection, why: string) => {
    const need = needFor(planOf.get(s.sceneId), s.clipId);
    const card = need?.card ?? { kind: "chapter" as const, text: (need?.description ?? "").toUpperCase().slice(0, 40), sub: null };
    const reason = `Replaced in review with a designed ${card.kind} card (${why}).`;
    used.set(s.asset.id, (used.get(s.asset.id) ?? 1) - 1);
    Object.assign(s, { asset: cardAsset(card, reason), scores: null, overall: null, reason, needType: "graphic", trimStart: 0 });
  };

  const prim = selections.filter((s) => s.role === "primary").sort((a, b) => a.start - b.start);

  // 1. Irrelevant visuals and stock footage where the narration names something specific.
  for (const s of prim.filter(inScope)) {
    if (isGraphic(s.asset) || s.asset.provider === "uploaded") continue;
    const need = needFor(planOf.get(s.sceneId), s.clipId);
    if (!need?.visualType) continue;
    // Only overturn clearly weak picks; the selector's deliberate fallbacks (a location shot when no
    // photo of the person exists) and near matches are its documented decisions.
    const deliberate = /^(Fallback|Closest available)/.test(s.reason);
    const weak = s.overall !== null && (s.overall < MIN_RELEVANCE - 10 || Number(s.scores?.confidence ?? 1) < 0.2);
    const genericStock = STOCK.has(s.asset.provider) && need.stockAllowed === false && !deliberate;
    if (!weak && !genericStock) continue;
    const problem = genericStock ? "generic_stock" : "visual_mismatch";
    const reason = genericStock ? `stock footage for a beat about ${need.entities?.[0] ?? need.description}` : `relevance ${s.overall} is below the bar for "${need.description}"`;
    const better = swap(s, (r) => !(genericStock && STOCK.has(r.asset.provider)));
    if (better) {
      apply(s, better, reason);
      issues.push({ sceneId: s.sceneId, clipId: s.clipId, problem, reason, action: "replaced" });
    } else {
      toCard(s, reason);
      issues.push({ sceneId: s.sceneId, clipId: s.clipId, problem, reason, action: "card" });
    }
  }

  // 2. The same picture twice — unless it is a deliberate, spaced re-use (a person's portrait
  //    after 25 s, a location after 90 s; see relevance.ts).
  const seenAt = new Map<string, number>();
  for (const s of prim) {
    if (isGraphic(s.asset) || s.asset.provider === "uploaded") continue;
    const last = seenAt.get(s.asset.id);
    seenAt.set(s.asset.id, s.start);
    if (last === undefined) continue;
    const need = needFor(planOf.get(s.sceneId), s.clipId);
    const entityMatched = Number(s.scores?.entityMatch ?? 0) >= 18 && (need?.entities?.length ?? 0) > 0;
    if (spacedReuseOk(need?.visualType, s.duration, s.start - last, entityMatched)) continue;
    if (!inScope(s)) continue;
    const reason = `"${s.asset.title.slice(0, 50)}" already appears earlier`;
    const better = swap(s, () => true, 4);
    if (better) apply(s, better, reason);
    else toCard(s, reason);
    issues.push({ sceneId: s.sceneId, clipId: s.clipId, problem: "repeated_visual", reason, action: better ? "replaced" : "card" });
  }

  // 3. Long runs from one provider (e.g. 15 Wikimedia stills in a row).
  let run = 1;
  for (let i = 1; i < prim.length; i++) {
    const s = prim[i]!;
    const same = !isGraphic(s.asset) && s.asset.provider === prim[i - 1]!.asset.provider;
    run = same ? run + 1 : 1;
    if (run < 4 || !inScope(s)) continue;
    const better = swap(s, (r) => r.asset.provider !== s.asset.provider && r.total >= (s.overall ?? 0) - 8);
    if (better) {
      const reason = `${run} clips in a row from ${s.asset.provider}`;
      apply(s, better, reason);
      issues.push({ sceneId: s.sceneId, clipId: s.clipId, problem: "provider_run", reason, action: "replaced" });
      run = 1;
    }
  }

  // 4. A visual held too long for the scene's pacing → split it into two shots.
  for (const s of [...prim]) {
    if (!inScope(s)) continue;
    const plan = planOf.get(s.sceneId);
    const max = MAX_HOLD[plan?.storyboard?.pacing ?? "normal"] ?? 5;
    if (s.duration <= max * 1.15) continue;
    const reason = `${s.duration.toFixed(1)}s is too long for ${plan?.storyboard?.pacing ?? "normal"} pacing`;
    const second = isGraphic(s.asset) ? null : swap(s, () => true, 6);
    const half = Math.round((s.duration / 2) * 1000) / 1000;
    const tail: SceneSelection = { ...s, clipId: `${s.clipId}_b`, start: s.start + half, duration: s.duration - half, transitionIn: undefined, annotations: [] };
    if (second) {
      Object.assign(tail, { asset: second.asset, scores: { ...second.scores }, overall: second.total, reason: `Second shot added in review (${reason}). ${second.reason}`, trimStart: 0 });
      used.set(second.asset.id, (used.get(second.asset.id) ?? 0) + 1);
    } else if (s.asset.type === "video") {
      tail.trimStart = s.trimStart + half; // continue the same footage from a new cut point
    } else {
      continue; // one still held long is better than a random second picture
    }
    s.duration = half;
    selections.splice(selections.indexOf(s) + 1, 0, tail);
    prim.splice(prim.indexOf(s) + 1, 0, tail);
    issues.push({ sceneId: s.sceneId, clipId: s.clipId, problem: "excessive_duration", reason, action: "split" });
  }

  // 5. Three designed cards in a row reads like a slideshow: give the middle one real media if
  //    anything reasonably relevant exists.
  for (let i = 1; i < prim.length - 1; i++) {
    const [a, b, c] = [prim[i - 1]!, prim[i]!, prim[i + 1]!];
    if (!(isGraphic(a.asset) && isGraphic(b.asset) && isGraphic(c.asset)) || !inScope(b)) continue;
    // Never lower the bar: a card is better than an unrelated picture (section 25).
    const better = swap(b, () => true);
    const reason = "three text cards in a row";
    if (better) apply(b, better, reason);
    issues.push({ sceneId: b.sceneId, clipId: b.clipId, problem: "card_run", reason, action: better ? "replaced" : "kept" });
  }

  // 6. The same stylised transition twice in a row.
  let last: string | null = null;
  for (const s of prim) {
    const t = s.transitionIn;
    if (!t || t === "hard_cut") continue;
    if (t === last && inScope(s)) {
      s.transitionIn = "hard_cut";
      issues.push({ sceneId: s.sceneId, clipId: s.clipId, problem: "repeated_transition", reason: `${t} used twice in a row`, action: "changed" });
      continue;
    }
    last = t;
  }

  // 7. A climax that doesn't land (no impact transition).
  for (const p of plans) {
    if (p.storyboard?.intents.includes("climax") && !["flash", "glitch", "zoom"].includes(p.transition) && (!opts.onlySceneIds || opts.onlySceneIds.has(p.sceneId))) {
      p.transition = "flash";
      const first = prim.find((s) => s.sceneId === p.sceneId);
      if (first) first.transitionIn = "flash";
      issues.push({ sceneId: p.sceneId, clipId: first?.clipId ?? null, problem: "weak_climax", reason: "climax had no impact transition", action: "changed" });
    }
  }
  return issues;
}
