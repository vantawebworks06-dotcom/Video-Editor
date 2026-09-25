import type {
  MemePlan,
  NormalizedAsset,
  ScenePlan,
  SfxCue,
  StyleProfile,
} from "@/lib/domain/types";
import { stableHash } from "@/lib/media/cache";
import { clamp } from "@/lib/pipeline/engines";
import type { SceneSegment } from "@/lib/pipeline/director";
import type { Sentence } from "@/lib/pipeline/transcript";
import { callStructured, type ClaudeContext, type UserContent } from "./client";
import { DIRECTOR_SYSTEM, RANKER_SYSTEM, REFERENCE_SYSTEM, REFINE_SYSTEM } from "./prompts";
import {
  MemeSuggestion,
  QueriesOutput,
  RankingOutput,
  ReferenceStyleOutput,
  ScenePlanOutput,
  ScenePlansOutput,
  SegmentationOutput,
  SfxSuggestion,
  TimelineRefinementOutput,
} from "./schemas";

export interface PlanContext {
  style: StyleProfile;
  memeFrequency: string;
  projectTitle: string;
  orientation: string;
}

const PLAN_BATCH = 4;

/**
 * Centralised Claude service. Every method is a single structured call (or a small
 * batch) whose output is schema-validated; results are cached by input hash so only
 * changed scenes cost tokens.
 */
export class ClaudeService {
  constructor(
    readonly ctx: ClaudeContext,
    readonly budgetMode: boolean,
  ) {}

  /** Understand the narration and divide it into semantic scenes (by sentence id). */
  async analyzeScript(sentences: Sentence[], ctx: PlanContext) {
    const lines = sentences.map((s) => `${s.id} [${s.start.toFixed(1)}-${s.end.toFixed(1)}s] ${s.text}`).join("\n");
    return callStructured(this.ctx, {
      fn: "analyzeScript",
      system: DIRECTOR_SYSTEM,
      schema: SegmentationOutput,
      content: `Project: ${ctx.projectTitle}
Target average shot length: ${ctx.style.averageShotDuration}s. Visual density: ${ctx.style.visualDensity}.

Divide this narration into semantic scenes. A scene is a coherent beat (typically 5-15 seconds; shorter for punchy moments). Every sentence must belong to exactly one scene; scenes are contiguous and in order. Give each scene an importance, intensities (0-1) and a one-line summary.

Sentences:
${lines}`,
    });
  }

  /** Determine strategy, visual needs + queries, text, meme, motion, transition and SFX for scenes. */
  async generateScenePlans(segments: SceneSegment[], ctx: PlanContext): Promise<Map<string, ScenePlanOutput>> {
    const out = new Map<string, ScenePlanOutput>();
    const pending: SceneSegment[] = [];
    const sceneKey = (s: SceneSegment, i: number) =>
      stableHash({ s, prev: segments[i - 1]?.summary ?? null, next: segments[i + 1]?.summary ?? null, ctx, model: this.ctx.model });

    // Per-scene cache: unchanged scenes are never re-planned.
    for (const [i, s] of segments.entries()) {
      const hit = await this.ctx.cache?.get("scenePlan", sceneKey(s, i)).catch(() => null);
      const ok = hit ? ScenePlanOutput.safeParse(hit) : null;
      if (ok?.success) out.set(s.sceneId, ok.data);
      else pending.push(s);
    }

    for (let b = 0; b < pending.length; b += PLAN_BATCH) {
      const batch = pending.slice(b, b + PLAN_BATCH);
      const describe = (s: SceneSegment) => {
        const i = segments.indexOf(s);
        return `### ${s.sceneId} (${(s.endTime - s.startTime).toFixed(1)}s, importance ${s.importance}, info density ${s.intensity.informationDensity.toFixed(2)}, emotional ${s.intensity.emotionalIntensity.toFixed(2)})
Previous scene: ${segments[i - 1]?.summary ?? "(start of video)"}
Narration: "${s.narration}"`;
      };
      const result = await callStructured(this.ctx, {
        fn: "generateScenePlan",
        system: DIRECTOR_SYSTEM,
        schema: ScenePlansOutput,
        maxTokens: 24000,
        content: `Project: ${ctx.projectTitle}. Output orientation: ${ctx.orientation}.
Style profile: ${JSON.stringify(ctx.style)}
Meme frequency setting: ${ctx.memeFrequency} (OFF means never insert).

Plan each scene below. For each:
- analysis: topic, people, locations, events, objects and historical era mentioned; emotional tone; and whether archival footage, photographs, article/screenshot visuals, or a meme/reaction would genuinely help.
- visualStrategy (one of the allowed strategies).
- visualNeeds: split the scene into shots whose durations add up to the scene duration and vary around the target pace (high information 2-3s, normal 3-5s, slow/emotional 5-8s). Types: video, photo, archival, screenshot, article (article/screenshot = newspaper or document scans), reaction. For each need give ranked queries: literal (what is named), conceptual (what it evokes) and a final "ranked" list (best first, 3-7 queries).
- textOverlay: enabled only for a real key phrase, statistic, chapter title or dramatic line (sparingly). Uppercase short text.
- meme: score the moment 0-100 on humorOpportunity, surprise, irony, absurdity, emotionalBreak, narrativePacing; set insert=true only for a genuine punchline/irony/absurd/revelation/tension-reset moment; give 2-4 GIPHY reaction queries (e.g. "shocked reaction", "facepalm").
- motion for photos (slow_zoom_in, pan_left, punch_in, ...), transition (mostly hard_cut), and sfx cues (whoosh, impact, click, camera_shutter, paper, notification, crowd, bass_hit, riser) at significant visual changes only.
Times (atSeconds) are relative to the scene start.

${batch.map(describe).join("\n\n")}`,
      });
      for (const plan of result.scenes) {
        const seg = batch.find((s) => s.sceneId === plan.sceneId);
        if (!seg) continue;
        out.set(seg.sceneId, plan);
        await this.ctx.cache?.set("scenePlan", sceneKey(seg, segments.indexOf(seg)), plan, { model: this.ctx.model }).catch(() => undefined);
      }
    }
    return out;
  }

  /** Targeted literal + conceptual search queries for one visual need ("Find better footage"). */
  async generateSearchQueries(narration: string, need: string, avoid: string[] = []) {
    return callStructured(this.ctx, {
      fn: "generateSearchQueries",
      system: DIRECTOR_SYSTEM,
      schema: QueriesOutput,
      content: `Narration: "${narration}"
Visual needed: ${need}
${avoid.length ? `Already tried (give different angles): ${avoid.join("; ")}` : ""}
Write literal and conceptual stock-media search queries, then a ranked list (best first, up to 7).`,
    });
  }

  /** Rank candidate assets for one shot. Thumbnails are included unless Budget Mode is on. */
  async rankMedia(narration: string, need: string, candidates: NormalizedAsset[], recentKinds: string[]) {
    const withImages = !this.budgetMode;
    const blocks: Exclude<UserContent, string> = [
      {
        type: "text",
        text: `Narration for this shot: "${narration}"
Visual needed: ${need}
Recently used visual types (avoid repetition): ${recentKinds.slice(-5).join(", ") || "none"}
Candidates follow${withImages ? " (each preceded by its thumbnail)" : ""}.`,
      },
    ];
    for (const c of candidates) {
      if (withImages && c.thumbnailUrl?.startsWith("https://")) {
        blocks.push({ type: "image", source: { type: "url", url: c.thumbnailUrl } });
      }
      blocks.push({
        type: "text",
        text: `id=${c.id} | ${c.type}${c.archival ? " (archival)" : ""} | ${c.width ?? "?"}x${c.height ?? "?"}${c.duration ? ` | ${c.duration.toFixed(1)}s` : ""} | rights=${c.rightsStatus} | provider=${c.provider} | title: ${c.title.slice(0, 120)}${c.description ? ` | ${c.description.slice(0, 160)}` : ""}`,
      });
    }
    const result = await callStructured(this.ctx, { fn: "rankMedia", system: RANKER_SYSTEM, schema: RankingOutput, content: blocks });
    const ids = new Set(candidates.map((c) => c.id));
    return result.rankings.filter((r) => ids.has(r.candidateId));
  }

  /** Finalise per-clip layout, motion, B&W and annotations for the edit decision list. */
  async createTimeline(
    clips: { clipId: string; narration: string; needType: string; asset: NormalizedAsset; duration: number; previousMotion?: string }[],
  ) {
    const blocks: Exclude<UserContent, string> = [
      { type: "text", text: `Finalise these ${clips.length} clips in timeline order.` },
    ];
    for (const c of clips) {
      const annotate = (c.needType === "article" || c.needType === "screenshot") && !this.budgetMode;
      if (annotate && c.asset.thumbnailUrl?.startsWith("https://")) {
        blocks.push({ type: "image", source: { type: "url", url: c.asset.thumbnailUrl } });
      }
      blocks.push({
        type: "text",
        text: `clipId=${c.clipId} | need=${c.needType} | ${c.asset.type}${c.asset.archival ? " archival" : ""} ${c.asset.width ?? "?"}x${c.asset.height ?? "?"} | ${c.duration.toFixed(1)}s | previous motion: ${c.previousMotion ?? "none"} | narration: "${c.narration.slice(0, 200)}" | title: ${c.asset.title.slice(0, 100)}`,
      });
    }
    return callStructured(this.ctx, { fn: "createTimeline", system: REFINE_SYSTEM, schema: TimelineRefinementOutput, content: blocks });
  }

  /** Turn measured cut statistics + sampled frames into a style profile. */
  async analyzeReferenceStyle(metrics: Record<string, unknown>, frames: { index: number; jpegBase64: string }[]) {
    const blocks: Exclude<UserContent, string> = [
      { type: "text", text: `Measured statistics from the reference video:\n${JSON.stringify(metrics, null, 1)}\nSampled frames follow (one per detected shot, in order).` },
    ];
    for (const f of frames) {
      blocks.push({ type: "text", text: `frame index=${f.index}` });
      blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.jpegBase64 } });
    }
    return callStructured(this.ctx, { fn: "analyzeReferenceStyle", system: REFERENCE_SYSTEM, schema: ReferenceStyleOutput, content: blocks });
  }

  /** Decide whether a reaction/meme fits this moment ("Add Meme"). */
  async suggestMeme(narration: string, previous: string | null, frequency: string): Promise<MemePlan> {
    const s = await callStructured(this.ctx, {
      fn: "suggestMeme",
      system: DIRECTOR_SYSTEM,
      schema: MemeSuggestion,
      content: `Meme frequency: ${frequency}. Previous line: "${previous ?? ""}"
Narration: "${narration}"
Score this moment for a reaction GIF interruption and propose GIPHY reaction queries. Only set insert=true for a genuine punchline, irony, absurdity, surprising revelation, comedic transition or tension reset.`,
    });
    return toMemePlan(s);
  }

  /** Suggest SFX for significant visual changes in a scene ("Add SFX"). */
  async suggestSoundEffects(narration: string, cuts: number[]): Promise<SfxCue[]> {
    const s = await callStructured(this.ctx, {
      fn: "suggestSoundEffects",
      system: DIRECTOR_SYSTEM,
      schema: SfxSuggestion,
      content: `Narration: "${narration}"
Visual cut points (seconds from scene start): ${cuts.map((c) => c.toFixed(2)).join(", ")}
Suggest sound effects only at significant visual changes (not every cut).`,
    });
    return s.cues.map((c) => ({ kind: c.kind, at: Math.max(0, c.atSeconds), reason: c.reason }));
  }
}

export function toMemePlan(s: MemeSuggestion): MemePlan {
  return {
    insert: s.insert,
    queries: s.queries.slice(0, 4),
    at: Math.max(0, s.atSeconds),
    duration: clamp(s.durationSeconds, 1, 3),
    reason: s.reason,
    score: {
      humorOpportunity: clamp(s.humorOpportunity, 0, 100),
      surprise: clamp(s.surprise, 0, 100),
      irony: clamp(s.irony, 0, 100),
      absurdity: clamp(s.absurdity, 0, 100),
      emotionalBreak: clamp(s.emotionalBreak, 0, 100),
      narrativePacing: clamp(s.narrativePacing, 0, 100),
    },
  };
}

/** Convert a validated Claude scene plan + segment timing into the domain ScenePlan. */
export function toScenePlan(seg: SceneSegment, p: ScenePlanOutput): ScenePlan {
  const dur = seg.endTime - seg.startTime;
  let needs = p.visualNeeds
    .filter((n) => n.queries.ranked.length || n.queries.literal.length)
    .map((n) => ({
      type: n.type,
      queries: [...new Set([...n.queries.ranked, ...n.queries.literal, ...n.queries.conceptual])].slice(0, 7),
      duration: Math.max(0.8, n.durationSeconds),
      description: n.description,
    }));
  if (!needs.length) needs = [{ type: "video", queries: [seg.summary.split(" ").slice(0, 4).join(" ")], duration: dur, description: seg.summary }];
  // Normalise shot durations so they exactly fill the scene.
  const sum = needs.reduce((a, n) => a + n.duration, 0);
  needs = needs.map((n) => ({ ...n, duration: (n.duration / sum) * dur }));
  const t = p.textOverlay;
  return {
    sceneId: seg.sceneId,
    startTime: seg.startTime,
    endTime: seg.endTime,
    narration: seg.narration,
    importance: seg.importance,
    intensity: seg.intensity,
    visualStrategy: p.visualStrategy,
    visualNeeds: needs,
    textOverlay: {
      enabled: t.enabled && t.text.trim().length > 0,
      text: t.text.trim().slice(0, 60),
      style: t.style,
      position: t.position,
      animation: t.animation,
      at: clamp(t.atSeconds, 0, Math.max(0, dur - 0.5)),
      duration: clamp(t.durationSeconds, 0.8, Math.max(0.8, dur)),
    },
    meme: toMemePlan(p.meme),
    motion: { type: p.motion.type, intensity: clamp(p.motion.intensity, 0, 0.3) },
    transition: p.transition,
    sfx: p.sfx.map((c) => ({ kind: c.kind, at: clamp(c.atSeconds, 0, dur), reason: c.reason })),
    analysis: p.analysis,
  };
}
