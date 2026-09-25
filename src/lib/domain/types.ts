import { z } from "zod";

// ---------------------------------------------------------------------------
// Rights
// ---------------------------------------------------------------------------

export const RightsStatus = z.enum([
  "CLEAR",
  "ATTRIBUTION_REQUIRED",
  "USER_REVIEW",
  "UNKNOWN",
  "RESTRICTED",
]);
export type RightsStatus = z.infer<typeof RightsStatus>;

/** Statuses the automatic editor may place on the timeline without explicit approval. */
export const AUTO_RENDERABLE: readonly RightsStatus[] = ["CLEAR", "ATTRIBUTION_REQUIRED"];

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export const ProviderId = z.enum([
  "pexels",
  "pixabay",
  "wikimedia",
  "internet_archive",
  "giphy",
  "uploaded",
  "library",
]);
export type ProviderId = z.infer<typeof ProviderId>;

export const AssetType = z.enum(["video", "photo", "gif", "sticker"]);
export type AssetType = z.infer<typeof AssetType>;

/** One internal format for every provider's search results. */
export const NormalizedAsset = z.object({
  id: z.string(), // `${provider}:${providerAssetId}`
  provider: ProviderId,
  providerAssetId: z.string(),
  type: AssetType,
  title: z.string(),
  description: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  mediaUrl: z.string(), // best-quality renderable URL
  previewUrl: z.string().nullable(),
  downloadUrl: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  duration: z.number().nullable(), // seconds, video/gif only
  author: z.string().nullable(),
  authorUrl: z.string().nullable(),
  sourceUrl: z.string(),
  license: z.string(),
  licenseUrl: z.string().nullable(),
  attribution: z.string().nullable(),
  attributionRequired: z.boolean(),
  rightsStatus: RightsStatus,
  rightsNotes: z.array(z.string()),
  retrievedAt: z.string(),
  date: z.string().nullable(),
  categories: z.array(z.string()),
  /** true for historical/archival material (Internet Archive, old Commons scans). */
  archival: z.boolean(),
  score: z.number(), // 0-100 heuristic score from the orchestrator
});
export type NormalizedAsset = z.infer<typeof NormalizedAsset>;

// ---------------------------------------------------------------------------
// Editorial vocabulary
// ---------------------------------------------------------------------------

export const VisualStrategy = z.enum([
  "documentary",
  "archival_collage",
  "photograph_sequence",
  "interview",
  "article_breakdown",
  "screenshot_sequence",
  "meme_reaction",
  "historical_timeline",
  "map_sequence",
  "evidence_board",
  "cinematic_broll",
  "text_emphasis",
  "mixed_media",
]);
export type VisualStrategy = z.infer<typeof VisualStrategy>;

export const VisualNeedType = z.enum(["video", "photo", "archival", "screenshot", "article", "reaction"]);
export type VisualNeedType = z.infer<typeof VisualNeedType>;

export const MotionType = z.enum([
  "none",
  "slow_zoom_in",
  "slow_zoom_out",
  "pan_left",
  "pan_right",
  "pan_up",
  "pan_down",
  "diagonal",
  "subtle_rotation",
  "punch_in",
]);
export type MotionType = z.infer<typeof MotionType>;

export const Transition = z.enum(["hard_cut", "flash", "fade"]);
export type Transition = z.infer<typeof Transition>;

export const Layout = z.enum(["fullscreen", "paper_card", "polaroid", "article", "picture_in_picture"]);
export type Layout = z.infer<typeof Layout>;

export const PaperStyle = z.enum(["white_paper", "crumpled_paper", "newspaper", "dark_paper", "corkboard", "document"]);
export type PaperStyle = z.infer<typeof PaperStyle>;

export const SfxKind = z.enum([
  "whoosh",
  "impact",
  "click",
  "camera_shutter",
  "paper",
  "notification",
  "crowd",
  "bass_hit",
  "riser",
]);
export type SfxKind = z.infer<typeof SfxKind>;

export const TextStyle = z.enum(["keyword", "key_phrase", "statement", "chapter_title", "statistic", "dramatic"]);
export type TextStyle = z.infer<typeof TextStyle>;

export const TextPosition = z.enum(["center", "top", "bottom", "left", "right"]);
export const TextAnimation = z.enum(["pop", "fade", "slide_up", "typewriter", "none"]);

export const AnnotationKind = z.enum(["red_circle", "underline", "highlight", "arrow", "magnifier", "cursor"]);
export type AnnotationKind = z.infer<typeof AnnotationKind>;
/** Normalised rectangle (0-1) relative to the visual's own frame. */
export const Rect = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export const Annotation = z.object({ kind: AnnotationKind, rect: Rect, appearAt: z.number() });
export type Annotation = z.infer<typeof Annotation>;

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export const Word = z.object({ word: z.string(), start: z.number(), end: z.number() });
export type Word = z.infer<typeof Word>;

export const Transcript = z.object({
  text: z.string(),
  words: z.array(Word),
  duration: z.number(),
  source: z.enum(["whisper", "script_alignment", "demo"]),
});
export type Transcript = z.infer<typeof Transcript>;

// ---------------------------------------------------------------------------
// Scene plan (what the director decides per scene)
// ---------------------------------------------------------------------------

export const VisualNeed = z.object({
  type: VisualNeedType,
  queries: z.array(z.string()), // ranked, most useful first
  duration: z.number(),
  description: z.string(),
});
export type VisualNeed = z.infer<typeof VisualNeed>;

export const TextOverlayPlan = z.object({
  enabled: z.boolean(),
  text: z.string(),
  style: TextStyle,
  position: TextPosition,
  animation: TextAnimation,
  at: z.number(), // seconds from scene start
  duration: z.number(),
});
export type TextOverlayPlan = z.infer<typeof TextOverlayPlan>;

export const MemePlan = z.object({
  insert: z.boolean(),
  queries: z.array(z.string()),
  at: z.number(), // seconds from scene start
  duration: z.number(),
  reason: z.string(),
  score: z.object({
    humorOpportunity: z.number(),
    surprise: z.number(),
    irony: z.number(),
    absurdity: z.number(),
    emotionalBreak: z.number(),
    narrativePacing: z.number(),
  }),
});
export type MemePlan = z.infer<typeof MemePlan>;

export const SfxCue = z.object({ kind: SfxKind, at: z.number(), reason: z.string() });
export type SfxCue = z.infer<typeof SfxCue>;

export const SceneIntensity = z.object({
  narrationIntensity: z.number(), // 0-1
  importance: z.number(),
  emotionalIntensity: z.number(),
  informationDensity: z.number(),
});
export type SceneIntensity = z.infer<typeof SceneIntensity>;

/** What a scene is about — drives visual needs and is shown in the editor. */
export const SceneAnalysis = z.object({
  topic: z.string(),
  people: z.array(z.string()),
  locations: z.array(z.string()),
  events: z.array(z.string()),
  objects: z.array(z.string()),
  era: z.string().nullable(),
  tone: z.enum(["neutral", "serious", "tense", "somber", "humorous", "uplifting", "dramatic"]),
  archivalUseful: z.boolean(),
  photoUseful: z.boolean(),
  screenshotUseful: z.boolean(),
  memeAppropriate: z.boolean(),
});
export type SceneAnalysis = z.infer<typeof SceneAnalysis>;

export const ScenePlan = z.object({
  sceneId: z.string(),
  startTime: z.number(),
  endTime: z.number(),
  narration: z.string(),
  importance: z.enum(["low", "medium", "high"]),
  intensity: SceneIntensity,
  visualStrategy: VisualStrategy,
  visualNeeds: z.array(VisualNeed),
  textOverlay: TextOverlayPlan,
  meme: MemePlan,
  motion: z.object({ type: MotionType, intensity: z.number() }),
  transition: Transition,
  sfx: z.array(SfxCue),
  analysis: SceneAnalysis.optional(),
});
export type ScenePlan = z.infer<typeof ScenePlan>;

// ---------------------------------------------------------------------------
// Timeline / edit decision list — the ONLY input the renderer accepts.
// ---------------------------------------------------------------------------

export const AssetRef = z.object({
  assetId: z.string(),
  type: AssetType,
  url: z.string(),
  /** Local file once downloaded/prepared; set by the renderer, never by AI. */
  localPath: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  duration: z.number().nullable(),
  rightsStatus: RightsStatus,
});
export type AssetRef = z.infer<typeof AssetRef>;

export const VisualClip = z.object({
  id: z.string(),
  sceneId: z.string(),
  start: z.number(),
  duration: z.number(),
  asset: AssetRef,
  /** Ordered fallbacks tried automatically if the primary asset fails. */
  alternates: z.array(AssetRef),
  trimStart: z.number(),
  layout: Layout,
  motion: z.object({ type: MotionType, intensity: z.number() }),
  treatment: z.object({ blackAndWhite: z.boolean(), grain: z.boolean() }),
  annotations: z.array(Annotation),
  transitionIn: Transition,
  role: z.enum(["primary", "meme"]),
});
export type VisualClip = z.infer<typeof VisualClip>;

export const TextClip = z.object({
  id: z.string(),
  sceneId: z.string(),
  start: z.number(),
  duration: z.number(),
  text: z.string(),
  style: TextStyle,
  position: TextPosition,
  animation: TextAnimation,
  font: z.string(),
  fontSize: z.number(),
});
export type TextClip = z.infer<typeof TextClip>;

export const SfxClip = z.object({ id: z.string(), kind: SfxKind, start: z.number(), volume: z.number() });
export type SfxClip = z.infer<typeof SfxClip>;

export const CaptionMode = z.enum(["OFF", "STANDARD", "DYNAMIC"]);
export type CaptionMode = z.infer<typeof CaptionMode>;

export const AudioMix = z.object({
  voiceVolume: z.number(), // linear gain, 1 = unchanged
  musicVolume: z.number(),
  sfxVolume: z.number(),
  ambienceVolume: z.number(),
  duckingStrength: z.number(), // 0-1
});
export type AudioMix = z.infer<typeof AudioMix>;

export const Timeline = z.object({
  version: z.literal(1),
  width: z.number(),
  height: z.number(),
  fps: z.number(),
  duration: z.number(),
  paperStyle: PaperStyle,
  visuals: z.array(VisualClip),
  texts: z.array(TextClip),
  captions: z.object({
    mode: CaptionMode,
    words: z.array(Word),
    emphasized: z.array(z.number()), // word indexes to emphasise in DYNAMIC mode
    font: z.string(),
    fontSize: z.number(),
    position: z.enum(["bottom", "middle", "top"]),
  }),
  audio: z.object({
    voice: z.string().nullable(), // local path or URL of narration
    music: z.string().nullable(),
    ambience: z.string().nullable(),
    sfx: z.array(SfxClip),
    mix: AudioMix,
  }),
  attributions: z.array(z.string()),
});
export type Timeline = z.infer<typeof Timeline>;

// ---------------------------------------------------------------------------
// Project settings & style
// ---------------------------------------------------------------------------

export const MemeFrequency = z.enum(["OFF", "LOW", "MEDIUM", "HIGH"]);
export type MemeFrequency = z.infer<typeof MemeFrequency>;

export const OutputFormat = z.enum(["landscape", "vertical", "draft"]);
export type OutputFormat = z.infer<typeof OutputFormat>;

export const ProjectSettings = z.object({
  stylePreset: z.string(),
  memeFrequency: MemeFrequency,
  captions: CaptionMode,
  paperStyle: PaperStyle,
  budgetMode: z.boolean(),
  /** Allow USER_REVIEW assets (e.g. GIPHY reactions) to be auto-placed; they stay flagged in the Rights panel. */
  allowReviewAssets: z.boolean(),
  /** Allow UNKNOWN-rights assets that the user explicitly approved. Never auto-selected. */
  allowApprovedUnknown: z.boolean(),
  enabledProviders: z.array(ProviderId),
  mix: AudioMix,
  gifRating: z.enum(["g", "pg", "pg-13"]),
  /** Built-in royalty-safe bed key, "uploaded" (project music file) or "none". */
  musicTrack: z.string(),
  /** Narration video: "replace" hides its picture; "mix" cuts back to the speaker (interview + B-roll). */
  originalFootage: z.enum(["replace", "mix"]),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export const DEFAULT_MIX: AudioMix = {
  voiceVolume: 1,
  musicVolume: 0.35,
  sfxVolume: 0.6,
  ambienceVolume: 0.2,
  duckingStrength: 0.7,
};

export const DEFAULT_SETTINGS: ProjectSettings = {
  stylePreset: "documentary",
  memeFrequency: "LOW",
  captions: "OFF",
  paperStyle: "white_paper",
  budgetMode: false,
  allowReviewAssets: true,
  allowApprovedUnknown: false,
  enabledProviders: ["pexels", "pixabay", "wikimedia", "internet_archive", "giphy"],
  mix: DEFAULT_MIX,
  gifRating: "pg",
  musicTrack: "ambient_pad",
  originalFootage: "replace",
};

export const StyleProfile = z.object({
  averageShotDuration: z.number(),
  minShotDuration: z.number(),
  maxShotDuration: z.number(),
  photoPercentage: z.number(),
  videoPercentage: z.number(),
  archivalPercentage: z.number(),
  screenshotPercentage: z.number(),
  textEmphasisFrequency: z.number(), // text overlays per scene (0-1)
  memeFrequency: z.number(), // memes per scene (0-1)
  zoomFrequency: z.number(), // share of photos with motion
  blackAndWhiteFrequency: z.number(),
  paperLayoutFrequency: z.number(),
  sfxFrequency: z.number(),
  transitionStyle: z.enum(["mostly_hard_cut", "mixed", "mostly_soft"]),
  visualDensity: z.enum(["low", "medium", "high"]),
  preferredStrategies: z.array(VisualStrategy),
});
export type StyleProfile = z.infer<typeof StyleProfile>;

export const RenderStatus = z.enum([
  "QUEUED",
  "DOWNLOADING",
  "PREPARING",
  "RENDERING",
  "FINALIZING",
  "COMPLETE",
  "FAILED",
]);
export type RenderStatus = z.infer<typeof RenderStatus>;

/** Job states in which a job can still be cancelled. */
export const ACTIVE_PIPELINE_STATUSES = ["QUEUED", "RUNNING"] as const;
export const ACTIVE_RENDER_STATUSES = ["QUEUED", "DOWNLOADING", "PREPARING", "RENDERING", "FINALIZING"] as const;
/** A cancelled job is stored as FAILED with exactly this error (no schema change needed). */
export const JOB_CANCELLED = "Cancelled by user.";

export const FORMAT_DIMENSIONS: Record<OutputFormat, { width: number; height: number; fps: number }> = {
  landscape: { width: 1920, height: 1080, fps: 30 },
  vertical: { width: 1080, height: 1920, fps: 30 },
  draft: { width: 960, height: 540, fps: 30 },
};
