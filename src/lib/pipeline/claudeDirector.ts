import type { ScenePlan, Transcript } from "@/lib/domain/types";
import { ClaudeService, toScenePlan } from "@/lib/ai/claude/service";
import {
  type ClipDecision,
  clampScores,
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
import { chooseMotion, clamp, kindOf } from "./engines";
import { HeuristicDirector } from "./heuristicDirector";
import type { Sentence } from "./transcript";

/** Claude-backed director. Any structurally unusable AI answer falls back to the heuristic for that step. */
export class ClaudeDirector implements Director {
  readonly kind = "claude" as const;
  readonly label: string;
  private fallback = new HeuristicDirector();

  constructor(
    private claude: ClaudeService,
    private maxCandidates = 12,
  ) {
    this.label = `Claude (${claude.ctx.model}${claude.budgetMode ? ", Budget Mode" : ""})`;
  }

  private planCtx(ctx: DirectorContext) {
    return {
      style: ctx.style,
      memeFrequency: ctx.settings.memeFrequency,
      projectTitle: ctx.projectTitle,
      orientation: ctx.orientation,
    };
  }

  async segmentScenes(transcript: Transcript, sentences: Sentence[], ctx: DirectorContext): Promise<SceneSegment[]> {
    const out = await this.claude.analyzeScript(sentences, this.planCtx(ctx));
    const index = new Map(sentences.map((s, i) => [s.id, i]));
    const segments: SceneSegment[] = [];
    let expected = 0;
    for (const sc of out.scenes) {
      const a = index.get(sc.firstSentenceId);
      const b = index.get(sc.lastSentenceId);
      if (a === undefined || b === undefined || b < a || a !== expected) {
        // Not contiguous — reject Claude's segmentation rather than render something inconsistent.
        return this.fallback.segmentScenes(transcript, sentences, ctx);
      }
      const group = sentences.slice(a, b + 1);
      segments.push({
        sceneId: sceneIdFor(segments.length),
        startTime: group[0]!.start,
        endTime: group.at(-1)!.end,
        narration: group.map((s) => s.text).join(" "),
        importance: sc.importance,
        intensity: {
          narrationIntensity: clamp(sc.narrationIntensity, 0, 1),
          importance: sc.importance === "high" ? 0.85 : sc.importance === "medium" ? 0.55 : 0.3,
          emotionalIntensity: clamp(sc.emotionalIntensity, 0, 1),
          informationDensity: clamp(sc.informationDensity, 0, 1),
        },
        summary: sc.summary,
      });
      expected = b + 1;
    }
    if (expected !== sentences.length) {
      // Claude missed trailing sentences: append them as heuristic scenes.
      for (const g of groupSentences(sentences.slice(expected), 8)) {
        segments.push({
          sceneId: sceneIdFor(segments.length),
          startTime: g[0]!.start,
          endTime: g.at(-1)!.end,
          narration: g.map((s) => s.text).join(" "),
          importance: "medium",
          intensity: { narrationIntensity: 0.5, importance: 0.5, emotionalIntensity: 0.4, informationDensity: 0.5 },
          summary: g.map((s) => s.text).join(" ").slice(0, 140),
        });
      }
    }
    return segments;
  }

  async planScenes(segments: SceneSegment[], ctx: DirectorContext): Promise<ScenePlan[]> {
    const plans = await this.claude.generateScenePlans(segments, this.planCtx(ctx));
    const missing = segments.filter((s) => !plans.has(s.sceneId));
    const fallbackPlans = missing.length ? await this.fallback.planScenes(missing, ctx) : [];
    const storyboarded = await this.fallback.planScenes(segments.filter((s) => s.board), ctx);
    return segments.map((s) => {
      const p = plans.get(s.sceneId);
      const claudePlan = p ? toScenePlan(s, p) : fallbackPlans.find((f) => f.sceneId === s.sceneId)!;
      const board = storyboarded.find((b) => b.sceneId === s.sceneId);
      if (!board || !p) return claudePlan;
      // The storyboard decides beats, entities, fallbacks, transitions and sound; Claude's
      // conceptual queries are added to each beat's entity-first ones, and its text/meme ideas kept.
      const visualNeeds = board.visualNeeds.map((n, i) => {
        const extra = claudePlan.visualNeeds[Math.min(i, claudePlan.visualNeeds.length - 1)]?.queries ?? [];
        return n.type === "graphic" ? n : { ...n, queries: [...new Set([...n.queries, ...extra.slice(0, 2)])].slice(0, 6) };
      });
      return { ...board, visualNeeds, textOverlay: claudePlan.textOverlay.enabled ? claudePlan.textOverlay : board.textOverlay, analysis: claudePlan.analysis ?? board.analysis };
    });
  }

  async rankCandidates(input: RankInput, ctx: DirectorContext): Promise<RankedCandidate[]> {
    const pool = input.candidates.slice(0, this.maxCandidates);
    if (!pool.length) return [];
    const rankings = await this.claude.rankMedia(
      input.narration,
      `${input.need.type}: ${input.need.description} (queries: ${input.need.queries.slice(0, 3).join("; ")})`,
      pool,
      input.recentKinds,
    );
    if (!rankings.length) return this.fallback.rankCandidates(input);
    const byId = new Map(pool.map((c) => [c.id, c]));
    const ranked = rankings.map((r) => {
      const asset = byId.get(r.candidateId)!;
      const scores = clampScores(r);
      return {
        asset,
        scores,
        overall: combineScores(scores, kindOf(asset, input.need.type), input.recentKinds, input.usedAssetIds.has(asset.id)),
        reason: r.reason,
      };
    });
    void ctx;
    return ranked.sort((a, b) => b.overall - a.overall);
  }

  async refineClips(clips: DraftClip[], ctx: DirectorContext): Promise<ClipDecision[]> {
    if (!clips.length) return [];
    const out = await this.claude.createTimeline(
      clips.map((c) => ({ clipId: c.clipId, narration: c.narration, needType: c.needType, asset: c.asset, duration: c.duration, previousMotion: c.previousMotion })),
    );
    const heuristic = await this.fallback.refineClips(clips, ctx);
    const byId = new Map(out.clips.map((c) => [c.clipId, c]));
    let prev = clips[0]?.previousMotion;
    return clips.map((clip, i) => {
      const d = byId.get(clip.clipId);
      if (!d) return heuristic[i]!;
      // Enforce the no-repeat rule and still-only motion regardless of what the model said.
      const motion =
        clip.asset.type === "photo"
          ? d.motion === prev || d.motion === "none"
            ? chooseMotion(clip.asset.width, clip.asset.height, prev, undefined, clip.clipId)
            : d.motion
          : d.motion === "punch_in"
            ? "punch_in"
            : "none";
      prev = motion;
      return {
        clipId: clip.clipId,
        layout: clip.asset.type === "gif" ? "fullscreen" : d.layout,
        motion,
        motionIntensity: clamp(d.motionIntensity, 0.02, 0.25),
        blackAndWhite: d.blackAndWhite,
        annotations: d.annotations
          .map((a) => ({
            kind: a.kind,
            rect: { x: clamp(a.x, 0, 0.95), y: clamp(a.y, 0, 0.95), w: clamp(a.w, 0.03, 1), h: clamp(a.h, 0.02, 1) },
            appearAt: clamp(a.appearAtSeconds, 0, clip.duration),
          }))
          .slice(0, 3),
      };
    });
  }
}
