import {
  type AssetRef,
  FORMAT_DIMENSIONS,
  type NormalizedAsset,
  type OutputFormat,
  type ProjectSettings,
  type ScenePlan,
  type SfxClip,
  type TextClip,
  Timeline,
  type Transcript,
  type VisualClip,
} from "@/lib/domain/types";
import type { SceneSelection } from "./generate";
import { NARRATION_ASSET_PREFIX } from "./originalFootage";

export const TEXT_FONT = "Anton";
export const CAPTION_FONT = "Inter";

const TEXT_SIZE: Record<TextClip["style"], number> = {
  keyword: 150,
  key_phrase: 120,
  statement: 96,
  chapter_title: 130,
  statistic: 170,
  dramatic: 130,
};

// Providers whose previewUrl is a smaller MP4 rendition of the same video (others: an image).
const VIDEO_RENDITION_PREVIEWS = new Set(["pexels", "pixabay"]);

export function toAssetRef(a: NormalizedAsset): AssetRef {
  return {
    assetId: a.id,
    type: a.type,
    url: a.mediaUrl,
    draftUrl: a.type === "video" && VIDEO_RENDITION_PREVIEWS.has(a.provider) && a.previewUrl && a.previewUrl !== a.mediaUrl ? a.previewUrl : null,
    localPath: null,
    width: a.width,
    height: a.height,
    duration: a.duration,
    rightsStatus: a.rightsStatus,
  };
}

export interface BuildTimelineInput {
  plans: ScenePlan[];
  selections: SceneSelection[];
  transcript: Transcript;
  settings: ProjectSettings;
  format: OutputFormat;
  voicePath: string | null;
  musicPath: string | null;
  ambiencePath?: string | null;
}

/**
 * Deterministically assemble the edit decision list. The result is Zod-validated, so the
 * renderer only ever receives a structurally valid timeline built from internal data.
 */
export function buildTimeline(input: BuildTimelineInput): Timeline {
  const { width, height, fps } = FORMAT_DIMENSIONS[input.format];
  const duration = round(Math.max(input.transcript.duration, input.plans.at(-1)?.endTime ?? 0) + 0.6);

  // Visuals: contiguous from 0 to duration (gaps closed by extending the previous clip).
  const sorted = [...input.selections].sort((a, b) => a.start - b.start).filter((s) => s.duration > 0.05);
  const visuals: VisualClip[] = [];
  for (const [i, s] of sorted.entries()) {
    const start = i === 0 ? 0 : visuals.at(-1)!.start + visuals.at(-1)!.duration;
    const nextStart = sorted[i + 1]?.start ?? duration;
    const end = i === sorted.length - 1 ? duration : Math.max(nextStart, start + 0.2);
    const plan = input.plans.find((p) => p.sceneId === s.sceneId);
    visuals.push({
      id: s.clipId,
      sceneId: s.sceneId,
      start: round(start),
      duration: round(end - start),
      asset: toAssetRef(s.asset),
      alternates: s.alternates.filter((a) => a.type === s.asset.type || s.role === "primary").slice(0, 3).map(toAssetRef),
      // The speaker's own footage always plays in sync with the narration.
      trimStart: s.asset.id.startsWith(NARRATION_ASSET_PREFIX) ? round(start) : s.trimStart,
      layout: s.layout,
      motion: { type: s.motion, intensity: s.motionIntensity },
      treatment: { blackAndWhite: s.blackAndWhite, grain: s.blackAndWhite },
      annotations: s.annotations,
      transitionIn: i > 0 && sorted[i - 1]!.sceneId !== s.sceneId ? (plan?.transition ?? "hard_cut") : "hard_cut",
      role: s.role,
    });
  }

  const texts: TextClip[] = input.plans
    .filter((p) => p.textOverlay.enabled && p.textOverlay.text)
    .map((p) => ({
      id: `${p.sceneId}_text`,
      sceneId: p.sceneId,
      start: round(p.startTime + p.textOverlay.at),
      duration: round(p.textOverlay.duration),
      text: p.textOverlay.text,
      style: p.textOverlay.style,
      position: p.textOverlay.position,
      animation: p.textOverlay.animation,
      font: TEXT_FONT,
      fontSize: Math.round(TEXT_SIZE[p.textOverlay.style] * (height / 1080) * (width < height ? 0.8 : 1)),
    }));

  const sfx: SfxClip[] = [];
  for (const p of input.plans) {
    for (const [i, c] of p.sfx.entries()) {
      sfx.push({ id: `${p.sceneId}_sfx${i}`, kind: c.kind, start: round(p.startTime + c.at), volume: 1 });
    }
  }
  for (const v of visuals.filter((v) => v.role === "meme")) {
    sfx.push({ id: `${v.id}_whoosh`, kind: "whoosh", start: round(Math.max(0, v.start - 0.15)), volume: 0.9 });
  }
  // Riser into high-importance scenes after the first.
  for (const p of input.plans.slice(1)) {
    if (p.importance === "high" && !p.sfx.some((c) => c.kind === "riser")) {
      sfx.push({ id: `${p.sceneId}_riser`, kind: "riser", start: round(Math.max(0, p.startTime - 1.5)), volume: 0.5 });
    }
  }

  // Dynamic captions emphasise numbers, names and words that appear in on-screen text.
  const overlayWords = new Set(texts.flatMap((t) => t.text.toLowerCase().split(/\s+/)));
  const emphasized = input.transcript.words
    .map((w, i) => ({ w: w.word.replace(/[^\p{L}\p{N}]/gu, ""), i }))
    .filter(({ w, i }) => w && (/\d/.test(w) || overlayWords.has(w.toLowerCase()) || (i > 0 && /^[A-Z]/.test(w) && w.length > 3)))
    .map(({ i }) => i);

  const attributions = [
    ...new Set(
      input.selections
        .map((s) => s.asset.attribution)
        .filter((a): a is string => Boolean(a)),
    ),
  ];

  return Timeline.parse({
    version: 1,
    width,
    height,
    fps,
    duration,
    paperStyle: input.settings.paperStyle,
    visuals,
    texts,
    captions: {
      mode: input.settings.captions,
      words: input.transcript.words,
      emphasized,
      font: CAPTION_FONT,
      fontSize: Math.round((width < height ? 64 : 54) * (height / 1080) * (width < height ? 0.6 : 1)),
      position: width < height ? "middle" : "bottom",
    },
    audio: {
      voice: input.voicePath,
      music: input.musicPath,
      ambience: input.ambiencePath ?? null,
      sfx: sfx.sort((a, b) => a.start - b.start),
      mix: input.settings.mix,
    },
    attributions,
  });
}

const round = (n: number) => Math.round(n * 1000) / 1000;
