/**
 * Refinement passes driven by the editorial score (quality.ts). Each action targets one weak
 * dimension and changes the edit itself — relevance swaps better candidates in (or a card),
 * pacing splits/merges shots towards the target length, sound design adds/removes cues. The
 * score is recomputed afterwards; nothing here edits the score directly.
 */
import type { ScenePlan, SfxCue } from "@/lib/domain/types";
import { cardAsset, isGraphic } from "./cards";
import type { SceneSelection } from "./generate";
import { type EditorialScore, measureEdit } from "./quality";
import { accepts, type RelevanceResult } from "./relevance";
import type { EditingTargets } from "./style";

export interface RefineAction {
  dimension: string;
  action: string;
  count: number;
}

function needFor(plans: Map<string, ScenePlan>, s: SceneSelection) {
  const n = Number(s.clipId.match(/_c(\d+)/)?.[1] ?? 0);
  return plans.get(s.sceneId)?.visualNeeds[n - 1];
}

/** Replace the weakest pictures with clearly better candidates, or with the planned card. */
export function refineRelevance(selections: SceneSelection[], plans: ScenePlan[], pool: Map<string, RelevanceResult[]>, bar: number): RefineAction {
  const byScene = new Map(plans.map((p) => [p.sceneId, p]));
  const used = new Set(selections.map((s) => s.asset.id));
  let n = 0;
  for (const s of selections) {
    if (s.role !== "primary" || isGraphic(s.asset) || s.asset.provider === "uploaded" || s.overall === null || s.overall >= bar) continue;
    if (/^Designed|^Closest available/.test(s.reason)) continue;
    const need = needFor(byScene, s);
    const better = (pool.get(s.clipId) ?? []).find((r) => !used.has(r.asset.id) && r.total >= s.overall! + 8 && (!need || accepts(r, need, "fallback")));
    if (better) {
      used.add(better.asset.id);
      Object.assign(s, { asset: better.asset, scores: { ...better.scores }, overall: better.total, reason: `Replaced in refinement (relevance ${s.overall} → ${better.total}). ${better.reason}`, trimStart: 0 });
      n++;
    } else if (s.overall < bar - 12 && need?.card) {
      const reason = `Replaced in refinement with a designed ${need.card.kind} card (relevance ${s.overall} was too low for this line).`;
      Object.assign(s, { asset: cardAsset(need.card, reason), scores: null, overall: null, reason, needType: "graphic", trimStart: 0 });
      n++;
    }
  }
  return { dimension: "relevance", action: `upgraded weak visuals (bar ${bar})`, count: n };
}

/** Move shot lengths towards the target: split over-long shots, merge runs of very short ones. */
export function refinePacing(selections: SceneSelection[], plans: ScenePlan[], pool: Map<string, RelevanceResult[]>, targets: EditingTargets): RefineAction {
  const m = measureEdit(selections, plans);
  const target = targets.shotSeconds;
  const prim = selections.filter((s) => s.role === "primary").sort((a, b) => a.start - b.start);
  const used = new Set(selections.map((s) => s.asset.id));
  let n = 0;
  if (m.medianShot > target * 1.08) {
    for (const s of prim) {
      if (s.duration < target * 1.6 || isGraphic(s.asset)) continue;
      const alt = (pool.get(s.clipId) ?? []).find((r) => !used.has(r.asset.id) && r.total >= (s.overall ?? 50) - 10 && r.scores.penalty < 14);
      if (!alt && s.asset.type !== "video") continue;
      const half = Math.round((s.duration / 2) * 1000) / 1000;
      const tail: SceneSelection = { ...s, clipId: `${s.clipId}_p`, start: s.start + half, duration: s.duration - half, transitionIn: "hard_cut", annotations: [] };
      if (alt) {
        used.add(alt.asset.id);
        Object.assign(tail, { asset: alt.asset, scores: { ...alt.scores }, overall: alt.total, reason: `Second shot added to match the reference pacing. ${alt.reason}`, trimStart: 0 });
      } else tail.trimStart = s.trimStart + half;
      s.duration = half;
      selections.splice(selections.indexOf(s) + 1, 0, tail);
      n++;
    }
    return { dimension: "pacing", action: `split ${n} long shots (median ${m.medianShot.toFixed(1)}s > target ${target.toFixed(1)}s)`, count: n };
  }
  if (m.medianShot < target * 0.65) {
    for (let i = prim.length - 1; i > 0; i--) {
      const [a, b] = [prim[i - 1]!, prim[i]!];
      if (a.sceneId !== b.sceneId || a.duration + b.duration > target * 1.3 || a.duration > target * 0.6 || b.duration > target * 0.6) continue;
      if (plans.find((p) => p.sceneId === a.sceneId)?.storyboard?.pacing === "rapid") continue; // montages stay rapid
      a.duration += b.duration;
      selections.splice(selections.indexOf(b), 1);
      n++;
    }
    return { dimension: "pacing", action: `merged ${n} very short shots (median ${m.medianShot.toFixed(1)}s < target ${target.toFixed(1)}s)`, count: n };
  }
  // Rhythm: a reference with bursts and holds has uneven shot lengths. Hold longer where the story
  // is calm (merge neighbours) and cut faster where it escalates (split), so the edit breathes.
  const wantVar = Math.min(0.85, targets.shotVariation);
  if (m.shotVariation < wantVar * 0.8) {
    const attention = (s: SceneSelection) => plans.find((p) => p.sceneId === s.sceneId)?.storyboard?.attention ?? "context";
    const calm = new Set(["setup", "context", "aftermath", "conclusion"]);
    let merged = 0;
    for (let i = prim.length - 1; i > 0 && merged < prim.length / 8; i--) {
      const [a, b] = [prim[i - 1]!, prim[i]!];
      if (a.sceneId !== b.sceneId || !calm.has(attention(a)) || isGraphic(a.asset) || a.duration + b.duration > target * 3) continue;
      a.duration += b.duration;
      selections.splice(selections.indexOf(b), 1);
      prim.splice(i, 1);
      merged++;
    }
    let split = 0;
    for (const s of [...prim]) {
      if (!["escalation", "climax", "buildup", "hook"].includes(attention(s)) || s.duration < target * 1.1 || split >= prim.length / 10) continue;
      const alt = (pool.get(s.clipId) ?? []).find((r) => !used.has(r.asset.id) && r.total >= (s.overall ?? 50) - 10 && r.scores.penalty < 14);
      if (!alt) continue;
      used.add(alt.asset.id);
      const half = Math.round((s.duration / 2) * 1000) / 1000;
      const tail: SceneSelection = { ...s, clipId: `${s.clipId}_r`, start: s.start + half, duration: s.duration - half, transitionIn: "hard_cut", annotations: [], asset: alt.asset, scores: { ...alt.scores }, overall: alt.total, reason: `Quick second shot: the story escalates here. ${alt.reason}`, trimStart: 0 };
      s.duration = half;
      selections.splice(selections.indexOf(s) + 1, 0, tail);
      split++;
    }
    return { dimension: "pacing", action: `rhythm: ${merged} holds in calm stretches, ${split} quick cuts in escalation (variation ${m.shotVariation.toFixed(2)} → target ${wantVar.toFixed(2)})`, count: merged + split };
  }
  return { dimension: "pacing", action: "no change needed", count: 0 };
}

/** Bring SFX density towards the target: add hits on cuts in intense scenes / drop the least important. */
export function refineSound(plans: ScenePlan[], selections: SceneSelection[], targets: EditingTargets): RefineAction {
  const m = measureEdit(selections, plans);
  const minutes = Math.max(0.1, ((plans.at(-1)?.endTime ?? 60) - (plans[0]?.startTime ?? 0)) / 60);
  const want = Math.round(targets.sfxPerMinute * minutes);
  const have = plans.reduce((a, p) => a + p.sfx.length, 0);
  let n = 0;
  if (targets.sfxPerMinute > 0 && m.sfxPerMinute < targets.sfxPerMinute * 0.75) {
    const ranked = [...plans].sort((a, b) => (b.storyboard?.intensity ?? 0) - (a.storyboard?.intensity ?? 0));
    for (const p of ranked) {
      if (have + n >= want) break;
      const cut = selections.filter((s) => s.sceneId === p.sceneId && s.role === "primary").sort((a, b) => a.start - b.start)[1];
      const at = cut ? cut.start - p.startTime : 0.05;
      if (p.sfx.some((c) => Math.abs(c.at - at) < 1)) continue;
      const kind: SfxCue["kind"] = (p.storyboard?.intensity ?? 0) >= 7 ? "impact" : "whoosh";
      p.sfx.push({ kind, at: Math.round((kind === "whoosh" ? at - 0.12 : at) * 100) / 100, reason: "sound bridge on a cut (reference density)" });
      n++;
    }
    return { dimension: "sound", action: `added ${n} cut-point effects`, count: n };
  }
  if (m.sfxPerMinute > targets.sfxPerMinute * 1.5) {
    const low = ["typing", "vinyl", "crowd", "radio_static", "notification", "whoosh"];
    for (const kind of low) {
      for (const p of plans) {
        if (have - n <= want) break;
        const i = p.sfx.findIndex((c) => c.kind === kind);
        if (i >= 0) {
          p.sfx.splice(i, 1);
          n++;
        }
      }
    }
    return { dimension: "sound", action: `removed ${n} low-priority effects`, count: n };
  }
  return { dimension: "sound", action: "no change needed", count: 0 };
}

export interface RefinementHistory {
  pass: number;
  score: EditorialScore;
  actions: RefineAction[];
}
