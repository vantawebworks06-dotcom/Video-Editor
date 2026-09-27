import {
  type AssetRef,
  FORMAT_DIMENSIONS,
  type NormalizedAsset,
  type OutputFormat,
  type ProjectSettings,
  type MusicCue,
  type ScenePlan,
  type SfxClip,
  type StyleProfile,
  type TextClip,
  Timeline,
  type Transcript,
  type VisualClip,
} from "@/lib/domain/types";
import { cardOf, isGraphic } from "./cards";
import type { SceneSelection } from "./generate";
import { buildMusicPlan } from "./music";
import { NARRATION_ASSET_PREFIX } from "./originalFootage";
import { applySources } from "./sourceTimeline";
import { isNeutral, type Look, lookValues } from "@/lib/domain/look";
import { DEFAULT_SOURCE_AUDIO } from "@/lib/domain/sourceAudio";

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
  /** Local file for a generated bed key (enables story-driven music); omit to use `musicPath` only. */
  resolveTrack?: (key: string) => string | null;
  /** Style profile (reference or preset): music sections/dynamics follow it. */
  style?: StyleProfile;
}

/**
 * Deterministically assemble the edit decision list. The result is Zod-validated, so the
 * renderer only ever receives a structurally valid timeline built from internal data.
 */
export function buildTimeline(input: BuildTimelineInput): Timeline {
  const { width, height, fps } = FORMAT_DIMENSIONS[input.format];
  const duration = round(Math.max(input.transcript.duration, input.plans.at(-1)?.endTime ?? 0) + 0.6);

  // Visuals: contiguous from 0 to duration (gaps closed by extending the previous clip).
  // Source footage (interviews/news with their own audio) is laid in afterwards.
  const sorted = [...input.selections].filter((s) => s.role !== "source").sort((a, b) => a.start - b.start).filter((s) => s.duration > 0.05);
  const sourceSelections = input.selections.filter((s) => s.role === "source" && s.duration > 0.2).sort((a, b) => a.start - b.start);
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
      treatment: { blackAndWhite: s.blackAndWhite, grain: s.blackAndWhite, look: clipLook(s.look, input.settings.look) },
      annotations: s.annotations,
      transitionIn: s.transitionIn ?? (i > 0 && sorted[i - 1]!.sceneId !== s.sceneId ? (plan?.transition ?? "hard_cut") : "hard_cut"),
      role: s.role,
    });
  }

  // Dip to black: the outgoing clip fades out as the next one fades in.
  for (let i = 1; i < visuals.length; i++) if (visuals[i]!.transitionIn === "dip_to_black") visuals[i - 1]!.transitionOut = "dip_to_black";

  // Source footage: pause/overlap insert time (narration pauses), duck/visual-only overlay the picture.
  const src = applySources(
    visuals,
    sourceSelections.map((s) => ({
      audio: s.sourceAudio ?? input.settings.sourceAudioDefault ?? DEFAULT_SOURCE_AUDIO,
      clip: {
        id: s.clipId,
        sceneId: s.sceneId,
        start: round(s.start),
        duration: round(s.duration),
        asset: toAssetRef(s.asset),
        alternates: [],
        trimStart: s.trimStart,
        layout: "fullscreen",
        motion: { type: "none", intensity: 0 },
        treatment: { blackAndWhite: s.blackAndWhite, grain: s.blackAndWhite, look: clipLook(s.look, input.settings.look) },
        annotations: s.annotations,
        transitionIn: s.transitionIn ?? "hard_cut",
        role: "source",
      },
    })),
    duration,
  );
  visuals.splice(0, visuals.length, ...src.visuals);
  const outT = src.map;
  const outDuration = src.duration;
  // The film ends on a fade out.
  if (visuals.length && visuals.at(-1)!.duration > 1.2) visuals.at(-1)!.transitionOut = "dip_to_black";

  // Designed cards: large text (and a smaller line under it) over the card's texture.
  const cardTexts: TextClip[] = [];
  for (const v of visuals) {
    const sel = sorted.find((x) => x.clipId === v.id);
    if (!sel || !isGraphic(sel.asset)) continue;
    const card = cardOf(sel.asset);
    const style: TextClip["style"] = card.kind === "year" || card.kind === "statistic" ? "statistic" : card.kind === "quote" ? "statement" : card.kind === "headline" ? "dramatic" : "chapter_title";
    // Cards are the hero of their shot: set large, shrinking only for long lines.
    const hero = card.kind === "year" || card.kind === "statistic" ? 1.9 : card.kind === "name" ? 1.55 : card.kind === "quote" ? 1.05 : 1.2;
    // Long lines wrap (ASS smart wrapping) rather than shrinking to a caption.
    const fit = card.text.length > 40 ? 0.7 : card.text.length > 26 ? 0.8 : card.text.length > 16 ? 0.9 : 1;
    const scale = (height / 1080) * (width < height ? 0.8 : 1) * hero * fit;
    cardTexts.push({ id: `${v.id}_card`, sceneId: v.sceneId, start: round(v.start + 0.12), duration: round(Math.max(0.4, v.duration - 0.2)), text: card.text, style, position: "center", animation: v.duration < 1.2 ? "none" : card.kind === "quote" ? "typewriter" : "pop", font: TEXT_FONT, fontSize: Math.round(TEXT_SIZE[style] * scale) });
    if (card.sub && v.duration >= 1.6) {
      cardTexts.push({ id: `${v.id}_cardsub`, sceneId: v.sceneId, start: round(v.start + 0.45), duration: round(Math.max(0.4, v.duration - 0.55)), text: card.sub.toUpperCase().slice(0, 64), style: "key_phrase", position: "bottom", animation: "fade", font: TEXT_FONT, fontSize: Math.round(46 * (height / 1080)) });
    }
  }
  const onCard = (t: number) => visuals.some((v) => isGraphic(sorted.find((x) => x.clipId === v.id)?.asset ?? { provider: "pexels" }) && t >= v.start && t < v.start + v.duration);

  const texts: TextClip[] = input.plans
    .filter((p) => p.textOverlay.enabled && p.textOverlay.text && !onCard(outT(p.startTime + p.textOverlay.at)))
    .map((p) => ({
      id: `${p.sceneId}_text`,
      sceneId: p.sceneId,
      start: round(outT(p.startTime + p.textOverlay.at)),
      duration: round(p.textOverlay.duration),
      text: p.textOverlay.text,
      style: p.textOverlay.style,
      position: p.textOverlay.position,
      animation: p.textOverlay.animation,
      font: TEXT_FONT,
      fontSize: Math.round(TEXT_SIZE[p.textOverlay.style] * (height / 1080) * (width < height ? 0.8 : 1)),
    }));
  texts.push(...cardTexts);
  texts.sort((a, b) => a.start - b.start);

  const sfx: SfxClip[] = [];
  for (const p of input.plans) {
    for (const [i, c] of p.sfx.entries()) {
      sfx.push({ id: `${p.sceneId}_sfx${i}`, kind: c.kind, start: round(outT(p.startTime + c.at)), volume: 1 });
    }
  }
  for (const v of visuals.filter((v) => v.role === "meme")) {
    sfx.push({ id: `${v.id}_whoosh`, kind: "whoosh", start: round(Math.max(0, v.start - 0.15)), volume: 0.9 });
  }
  // Riser into high-importance scenes after the first.
  for (const p of input.plans.slice(1)) {
    if (p.importance === "high" && !p.sfx.some((c) => c.kind === "riser")) {
      sfx.push({ id: `${p.sceneId}_riser`, kind: "riser", start: round(Math.max(0, outT(p.startTime) - 1.5)), volume: 0.5 });
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
    duration: outDuration,
    paperStyle: input.settings.paperStyle,
    visuals,
    texts,
    captions: {
      mode: input.settings.captions,
      words: src.inserts.length ? input.transcript.words.map((w) => ({ ...w, start: round(outT(w.start, "after")), end: round(outT(w.end, "before")) })) : input.transcript.words,
      emphasized,
      font: CAPTION_FONT,
      fontSize: Math.round((width < height ? 64 : 54) * (height / 1080) * (width < height ? 0.6 : 1)),
      position: width < height ? "middle" : "bottom",
    },
    audio: {
      voice: input.voicePath,
      voiceProcessing: input.settings.voice.preset === "off" ? undefined : input.settings.voice,
      music: input.musicPath,
      musicCues: input.resolveTrack
        ? stretchCues(buildMusicPlan({ plans: input.plans, duration, settings: input.settings, resolveTrack: input.resolveTrack, style: input.style, uploadedPath: input.settings.musicTrack === "uploaded" ? input.musicPath : null }), outT, outDuration)
        : undefined,
      ambience: input.ambiencePath ?? null,
      sfx: sfx.sort((a, b) => a.start - b.start),
      mix: input.settings.mix,
      inserts: src.inserts.length ? src.inserts : undefined,
      voiceDucks: src.voiceDucks.length ? src.voiceDucks : undefined,
    },
    attributions,
  });
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The clip's own look, else the project look; neutral looks are dropped (render and cache unchanged). */
function clipLook(own: Look | null | undefined, project: Look): Look | undefined {
  const l = own ?? project;
  return isNeutral(lookValues(l)) ? undefined : l;
}

/** Music planned in narration time, stretched over the pauses inserted for source footage. */
function stretchCues(cues: MusicCue[], outT: (t: number, side?: "before" | "after") => number, outDuration: number): MusicCue[] {
  return cues.map((c) => {
    const start = round(outT(c.start, "after"));
    const end = round(Math.min(outDuration, outT(c.end, "before")));
    const k = (end - start) / Math.max(0.001, c.end - c.start);
    if (Math.abs(k - 1) < 1e-6 && start === c.start) return c;
    return { ...c, start, end, gains: c.gains.map((g) => ({ t: round(g.t * k), g: g.g })), mutes: c.mutes?.map((m) => ({ from: round(outT(c.start + m.from) - start), to: round(outT(c.start + m.to) - start) })) };
  });
}
