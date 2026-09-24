import type {
  Annotation,
  Layout,
  MotionType,
  NormalizedAsset,
  ProjectSettings,
  SceneIntensity,
  ScenePlan,
  StyleProfile,
  Transcript,
  VisualNeed,
  VisualStrategy,
} from "@/lib/domain/types";
import { clamp, diversityPenalty, type VisualKind } from "./engines";
import type { Sentence } from "./transcript";

export interface SceneSegment {
  sceneId: string;
  startTime: number;
  endTime: number;
  narration: string;
  importance: "low" | "medium" | "high";
  intensity: SceneIntensity;
  summary: string;
}

export interface DirectorContext {
  style: StyleProfile;
  settings: ProjectSettings;
  projectTitle: string;
  orientation: "landscape" | "portrait";
}

export interface CandidateScores {
  semanticRelevance: number;
  visualRelevance: number;
  historicalRelevance: number;
  quality: number;
  composition: number;
  rightsSafety: number;
}

export interface RankedCandidate {
  asset: NormalizedAsset;
  scores: CandidateScores;
  overall: number;
  reason: string;
}

export interface RankInput {
  narration: string;
  strategy: VisualStrategy;
  need: VisualNeed;
  candidates: NormalizedAsset[];
  recentKinds: VisualKind[];
  usedAssetIds: Set<string>;
}

export interface DraftClip {
  clipId: string;
  narration: string;
  strategy: VisualStrategy;
  needType: VisualNeed["type"];
  asset: NormalizedAsset;
  duration: number;
  previousMotion: MotionType | undefined;
  suggestedMotion: MotionType | undefined;
}

export interface ClipDecision {
  clipId: string;
  layout: Layout;
  motion: MotionType;
  motionIntensity: number;
  blackAndWhite: boolean;
  annotations: Annotation[];
}

/** The AI director contract. Claude and the heuristic fallback both implement it. */
export interface Director {
  readonly kind: "claude" | "heuristic";
  readonly label: string;
  segmentScenes(transcript: Transcript, sentences: Sentence[], ctx: DirectorContext): Promise<SceneSegment[]>;
  planScenes(segments: SceneSegment[], ctx: DirectorContext): Promise<ScenePlan[]>;
  rankCandidates(input: RankInput, ctx: DirectorContext): Promise<RankedCandidate[]>;
  refineClips(clips: DraftClip[], ctx: DirectorContext): Promise<ClipDecision[]>;
}

/** Weighted overall score with diversity and repetition penalties applied in code. */
export function combineScores(
  s: CandidateScores,
  kind: VisualKind,
  recent: VisualKind[],
  alreadyUsed: boolean,
): number {
  const weighted =
    0.3 * s.semanticRelevance +
    0.2 * s.visualRelevance +
    0.1 * s.historicalRelevance +
    0.15 * s.quality +
    0.1 * s.composition +
    0.15 * s.rightsSafety;
  const repetition = alreadyUsed ? 40 : 0;
  return Math.round(clamp(weighted - diversityPenalty(kind, recent) - repetition, 0, 100));
}

export function clampScores(s: CandidateScores): CandidateScores {
  return {
    semanticRelevance: clamp(s.semanticRelevance, 0, 100),
    visualRelevance: clamp(s.visualRelevance, 0, 100),
    historicalRelevance: clamp(s.historicalRelevance, 0, 100),
    quality: clamp(s.quality, 0, 100),
    composition: clamp(s.composition, 0, 100),
    rightsSafety: clamp(s.rightsSafety, 0, 100),
  };
}

/** Sentences → scene segments, used when AI segmentation is unavailable or leaves gaps. */
export function groupSentences(sentences: Sentence[], targetSeconds: number): Sentence[][] {
  const groups: Sentence[][] = [];
  let current: Sentence[] = [];
  for (const s of sentences) {
    current.push(s);
    const len = current.at(-1)!.end - current[0]!.start;
    if (len >= targetSeconds) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) {
    const len = current.at(-1)!.end - current[0]!.start;
    if (groups.length && len < targetSeconds * 0.4) groups.at(-1)!.push(...current);
    else groups.push(current);
  }
  return groups;
}

export function sceneIdFor(index: number) {
  return `scene_${String(index + 1).padStart(3, "0")}`;
}
