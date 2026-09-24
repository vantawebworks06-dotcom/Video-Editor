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
  alternates: NormalizedAsset[];
  scores: Record<string, number> | null;
  overall: number | null;
  reason: string;
  role: "primary" | "meme";
  selectedBy: "ai" | "heuristic" | "user";
  layout: string;
  motion: string;
  motionIntensity: number;
  blackAndWhite: boolean;
  annotations: Annotation[];
  trimStart: number;
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
    script: string | null;
    hasReference: boolean;
    hasMusic: boolean;
    narrationDuration: number | null;
    styleProfileId: string | null;
    settings: ProjectSettings;
  };
  pipelineJob: JobInfo | null;
  renderJob: JobInfo | null;
  latestExport: { id: string; format: string; url: string | null; size_bytes: number | null; duration: number | null; attributions: string[]; created_at: string } | null;
  narrationUrl: string | null;
  usage: { calls: number; cached_calls: number; input_tokens: number; output_tokens: number; cost_usd: number };
}

export type Candidate = NormalizedAsset & { overall?: number; scores?: Record<string, number>; reason?: string };
