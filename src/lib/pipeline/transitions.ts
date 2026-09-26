/**
 * Transition allocator (sections 12-14 of the brief). The edit's transition MIX follows the
 * reference (e.g. 70 % hard cuts, 8 % dissolves, 21 % dips to black), but WHERE each one goes is
 * an editorial decision: every join is scored for how well each transition suits it (chapter
 * changes and aftermaths dip to black, calm still-to-still joins dissolve, climaxes flash,
 * escalation gets stylised accents), then the target number of each is assigned to the joins
 * that suit it best — never cycled, never randomly. Consecutive shots of the same person or
 * place are marked as match cuts.
 */
import type { ScenePlan, Transition } from "@/lib/domain/types";
import { isGraphic } from "./cards";
import type { SceneSelection } from "./generate";
import type { EditingTargets } from "./style";

export interface TransitionReport {
  joins: number;
  counts: Record<string, number>;
  matchCuts: number;
}

const STYLISED: Transition[] = ["zoom", "whip", "glitch", "film_burn", "shutter", "paper", "rgb_split", "shake", "motion_blur", "wipe", "luma_fade"];

export function allocateTransitions(selections: SceneSelection[], plans: ScenePlan[], targets: EditingTargets, onlySceneIds?: Set<string>): TransitionReport {
  const prim = selections.filter((s) => s.role === "primary").sort((a, b) => a.start - b.start);
  const plan = new Map(plans.map((p) => [p.sceneId, p]));
  const inScope = (s: SceneSelection) => !onlySceneIds || onlySceneIds.has(s.sceneId);
  const joins = prim.slice(1).map((s, k) => ({ s, prev: prim[k]!, i: k + 1 }));
  const n = joins.length;
  const want = {
    dip_to_black: Math.round(n * targets.transitionMix.dipToBlack),
    dissolve: Math.round(n * targets.transitionMix.dissolve),
    dip_to_white: Math.max(0, Math.round(n * targets.transitionMix.dipToWhite)),
    stylised: Math.round(n * targets.transitionMix.stylised),
  };

  const still = (s: SceneSelection) => s.asset.type !== "video";
  const attention = (s: SceneSelection) => plan.get(s.sceneId)?.storyboard?.attention ?? "context";
  const section = (s: SceneSelection) => plan.get(s.sceneId)?.storyboard?.context.section ?? "";
  const suits: Record<"dip_to_black" | "dissolve" | "dip_to_white" | "stylised", (j: (typeof joins)[number]) => number> = {
    dip_to_black: ({ s, prev }) => {
      let v = 0;
      if (s.sceneId !== prev.sceneId) v += 2;
      if (section(s) !== section(prev)) v += 3;
      if (["aftermath", "conclusion", "reveal"].includes(attention(s))) v += 3;
      if (attention(prev) === "climax" && attention(s) !== "climax") v += 3;
      if (isGraphic(s.asset) || isGraphic(prev.asset)) v += 2;
      if (["escalation", "climax", "buildup"].includes(attention(s)) && s.sceneId === prev.sceneId) v -= 4;
      if (s.duration < 1.2) v -= 3;
      return v;
    },
    dissolve: ({ s, prev }) => {
      let v = 0;
      if (still(s) && still(prev)) v += 3;
      if (["setup", "context", "aftermath", "conclusion"].includes(attention(s))) v += 2;
      if (s.asset.archival || prev.asset.archival) v += 1;
      if (s.sceneId === prev.sceneId) v += 1;
      if (["escalation", "climax", "hook"].includes(attention(s))) v -= 5;
      if (s.duration < 1.5 || prev.duration < 1.2) v -= 3;
      return v;
    },
    dip_to_white: ({ s, prev }) => (attention(s) === "climax" && attention(prev) !== "climax" ? 6 : attention(s) === "reveal" && s.sceneId !== prev.sceneId ? 3 : -5),
    stylised: ({ s, prev }) => {
      let v = 0;
      if (["escalation", "hook", "climax", "buildup"].includes(attention(s))) v += 3;
      if (s.transitionIn && STYLISED.includes(s.transitionIn)) v += 3; // the storyboard asked for it
      if (s.sceneId !== prev.sceneId) v += 1;
      if (s.duration < 0.9) v -= 2;
      return v;
    },
  };
  const stylisedFor = (s: SceneSelection, prev: SceneSelection): Transition => {
    if (s.transitionIn && STYLISED.includes(s.transitionIn)) return s.transitionIn;
    const a = attention(s);
    if (s.needType === "article" || s.needType === "screenshot") return "paper";
    if (s.asset.archival) return "film_burn";
    if (a === "climax") return prev.asset.type === "video" ? "rgb_split" : "shake";
    if (a === "escalation") return s.asset.type === "video" ? "whip" : "zoom";
    if (a === "hook") return "motion_blur";
    return still(s) ? "zoom" : "wipe";
  };

  // Keep the editor's original suggestion only as a hint; start from hard cuts.
  const chosen = new Map<number, Transition>();
  const reasons = new Map<number, string>();
  const takenNear = (i: number, gap: number) => [...chosen.keys()].some((k) => Math.abs(prim[k]!.start - prim[i]!.start) < gap && chosen.get(k) !== "hard_cut");
  const assign = (kind: keyof typeof want, t: (j: (typeof joins)[number]) => Transition, spacing: number, why: string) => {
    const ranked = joins.filter((j) => inScope(j.s) && !chosen.has(j.i)).map((j) => ({ j, v: suits[kind](j) })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
    let left = want[kind];
    for (const { j } of ranked) {
      if (left <= 0) break;
      if (takenNear(j.i, spacing)) continue;
      chosen.set(j.i, t(j));
      reasons.set(j.i, why);
      left--;
    }
  };
  assign("dip_to_white", () => "flash", 20, "flash into the climax");
  assign("dip_to_black", () => "dip_to_black", 6, "dip to black between chapters / after a big moment");
  assign("dissolve", () => "dissolve", 5, "soft dissolve in a calm still sequence");
  assign("stylised", (j) => stylisedFor(j.s, j.prev), 8, "stylised accent where the story escalates");

  // Match cuts: consecutive shots of the same named person or place.
  let matchCuts = 0;
  for (const j of joins) {
    if (chosen.has(j.i) || !inScope(j.s)) continue;
    const a = (j.prev.scores?.entityMatch ?? 0) >= 15 ? j.prev.queries[0] : null;
    const b = (j.s.scores?.entityMatch ?? 0) >= 15 ? j.s.queries[0] : null;
    if (a && b && a.split(" ")[0] === b.split(" ")[0] && j.prev.asset.id !== j.s.asset.id) {
      chosen.set(j.i, "match_cut");
      reasons.set(j.i, "match cut: same subject, different picture");
      matchCuts++;
    }
  }

  const counts: Record<string, number> = {};
  for (const j of joins) {
    if (!inScope(j.s)) continue;
    const t = chosen.get(j.i) ?? "hard_cut";
    j.s.transitionIn = t;
    counts[t] = (counts[t] ?? 0) + 1;
  }
  if (prim[0] && inScope(prim[0])) prim[0].transitionIn = "fade"; // open from black
  return { joins: n, counts, matchCuts };
}
