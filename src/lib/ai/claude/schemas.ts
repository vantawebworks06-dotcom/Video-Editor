// Zod schemas for every Claude response. These are sent as structured-output formats AND
// re-validated locally; nothing reaches the timeline or FFmpeg unless it passes.
// (Numeric ranges are enforced in code after parsing — the API does not support min/max.)
import { z } from "zod";
import {
  AnnotationKind,
  Layout,
  MotionType,
  SceneAnalysis,
  SfxKind,
  StyleProfile,
  TextAnimation,
  TextPosition,
  TextStyle,
  Transition,
  VisualNeedType,
  VisualStrategy,
} from "@/lib/domain/types";

export const SegmentationOutput = z.object({
  scenes: z.array(
    z.object({
      firstSentenceId: z.string(),
      lastSentenceId: z.string(),
      importance: z.enum(["low", "medium", "high"]),
      narrationIntensity: z.number(),
      emotionalIntensity: z.number(),
      informationDensity: z.number(),
      summary: z.string(),
    }),
  ),
});
export type SegmentationOutput = z.infer<typeof SegmentationOutput>;

export const QueriesOutput = z.object({
  literal: z.array(z.string()),
  conceptual: z.array(z.string()),
  ranked: z.array(z.string()),
});
export type QueriesOutput = z.infer<typeof QueriesOutput>;

export const MemeSuggestion = z.object({
  insert: z.boolean(),
  queries: z.array(z.string()),
  atSeconds: z.number(),
  durationSeconds: z.number(),
  reason: z.string(),
  humorOpportunity: z.number(),
  surprise: z.number(),
  irony: z.number(),
  absurdity: z.number(),
  emotionalBreak: z.number(),
  narrativePacing: z.number(),
});
export type MemeSuggestion = z.infer<typeof MemeSuggestion>;

export const SfxSuggestion = z.object({
  cues: z.array(z.object({ kind: SfxKind, atSeconds: z.number(), reason: z.string() })),
});

export const ScenePlanOutput = z.object({
  sceneId: z.string(),
  analysis: SceneAnalysis,
  visualStrategy: VisualStrategy,
  visualNeeds: z.array(
    z.object({
      type: VisualNeedType,
      durationSeconds: z.number(),
      description: z.string(),
      queries: QueriesOutput,
    }),
  ),
  textOverlay: z.object({
    enabled: z.boolean(),
    text: z.string(),
    style: TextStyle,
    position: TextPosition,
    animation: TextAnimation,
    atSeconds: z.number(),
    durationSeconds: z.number(),
  }),
  meme: MemeSuggestion,
  motion: z.object({ type: MotionType, intensity: z.number() }),
  transition: Transition,
  sfx: SfxSuggestion.shape.cues,
});
export type ScenePlanOutput = z.infer<typeof ScenePlanOutput>;

export const ScenePlansOutput = z.object({ scenes: z.array(ScenePlanOutput) });

export const RankingOutput = z.object({
  rankings: z.array(
    z.object({
      candidateId: z.string(),
      semanticRelevance: z.number(),
      visualRelevance: z.number(),
      historicalRelevance: z.number(),
      quality: z.number(),
      composition: z.number(),
      rightsSafety: z.number(),
      reason: z.string(),
    }),
  ),
});
export type RankingOutput = z.infer<typeof RankingOutput>;

export const TimelineRefinementOutput = z.object({
  clips: z.array(
    z.object({
      clipId: z.string(),
      layout: Layout,
      motion: MotionType,
      motionIntensity: z.number(),
      blackAndWhite: z.boolean(),
      annotations: z.array(
        z.object({
          kind: AnnotationKind,
          x: z.number(),
          y: z.number(),
          w: z.number(),
          h: z.number(),
          appearAtSeconds: z.number(),
        }),
      ),
    }),
  ),
});
export type TimelineRefinementOutput = z.infer<typeof TimelineRefinementOutput>;

export const ReferenceStyleOutput = z.object({
  frames: z.array(
    z.object({
      index: z.number(),
      kind: z.enum(["video", "photo", "screenshot", "article", "text", "meme", "interview", "map", "other"]),
      hasTextOverlay: z.boolean(),
      blackAndWhite: z.boolean(),
      paperLayout: z.boolean(),
    }),
  ),
  profile: StyleProfile,
  notes: z.string(),
});
export type ReferenceStyleOutput = z.infer<typeof ReferenceStyleOutput>;
