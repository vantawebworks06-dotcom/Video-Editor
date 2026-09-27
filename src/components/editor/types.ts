import type { SourceAudio } from "@/lib/domain/sourceAudio";
import type { Annotation, NormalizedAsset, ProjectSettings, ScenePlan, Word } from "@/lib/domain/types";

export interface Clip {
  rowId: string;
  assetRowId: string;
  userApproved: boolean;
  clipId: string;
  sceneId: string;
  start: number;
  duration: number;
  needType: string;
  needDescription: string;
  queries: string[];
  asset: NormalizedAsset;
  scores: Record<string, number> | null;
  overall: number | null;
  reason: string;
  role: "primary" | "meme" | "source";
  /** Source clips: narration pause/duck/overlap/visual-only behaviour. */
  sourceAudio?: SourceAudio;
  mediaItemId?: string | null;
  selectedBy: "ai" | "heuristic" | "user";
  layout: string;
  motion: string;
  motionIntensity: number;
  blackAndWhite: boolean;
  annotations: Annotation[];
  trimStart: number;
  /** How the clip enters (editorial transition), when set. */
  transitionIn?: string;
}

export interface EditData {
  plans: ScenePlan[];
  clips: Clip[];
  words: Word[];
  duration: number;
}

export interface JobInfo {
  id: string;
  status: string;
  progress: number;
  current_stage: string | null;
  error: string | null;
  kind?: string;
  format?: string;
  warnings?: string[];
  result?: {
    director?: string;
    warnings?: string[];
    searchErrors?: Record<string, number>;
    ai?: { calls: number; cachedCalls: number; inputTokens: number; outputTokens: number; costUsd: number };
    metrics?: Record<string, number>;
    method?: string;
    estimated?: string[];
    score?: { total: number; topicRelevance: number; narrationMatch: number; visualVariety: number; pacing: number; referenceStyle: number; soundDesign: number; musicDynamics: number; transitionVariety: number; notes: string[] } | null;
    refinement?: { pass: number; total: number; actions: string[] }[];
    targets?: { source: string; shotSeconds: number } | null;
  } | null;
  created_at: string;
}

export interface StatusData {
  project: {
    id: string;
    name: string;
    status: string;
    isDemo: boolean;
    lastError: string | null;
    timelineVersion: number;
    hasNarration: boolean;
    hasScript: boolean;
    hasReference: boolean;
    hasMusic: boolean;
    narrationDuration: number | null;
    styleProfileId: string | null;
    settings: ProjectSettings;
  };
  pipelineJob: JobInfo | null;
  /** Recent background tasks (media import, capture, narration processing). */
  tasks: (JobInfo & { kind: string; payload?: Record<string, unknown> | null; completed_at?: string | null })[];
  renderJob: JobInfo | null;
  latestExport: { id: string; format: string; url: string | null; downloadUrl: string | null; local: boolean; size_bytes: number | null; duration: number | null; attributions: string[]; created_at: string } | null;
  narrationPath: string | null;
  /** null while the editor already holds a valid signed URL for `narrationPath` (see the status route). */
  narrationUrl: string | null;
  usage: { calls: number; cached_calls: number; input_tokens: number; output_tokens: number; cost_usd: number };
}

export type Candidate = NormalizedAsset & { overall?: number; scores?: Record<string, number>; reason?: string };
