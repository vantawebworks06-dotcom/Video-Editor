import type { NormalizedAsset, ScenePlan } from "@/lib/domain/types";
import { seeded } from "./engines";
import type { SceneSelection } from "./generate";

/** Asset id prefix marking the user's own narration video (always rendered in sync). */
export const NARRATION_ASSET_PREFIX = "uploaded:narration:";

export function narrationFootageAsset(storagePath: string, info: { width: number | null; height: number | null; duration: number }): NormalizedAsset {
  return {
    id: `${NARRATION_ASSET_PREFIX}${storagePath}`,
    provider: "uploaded",
    providerAssetId: `narration:${storagePath}`,
    type: "video",
    title: "Your narration video (original footage)",
    description: "The speaker's own footage, kept in sync with the narration.",
    thumbnailUrl: null,
    mediaUrl: "uploaded",
    previewUrl: null,
    downloadUrl: "uploaded",
    width: info.width,
    height: info.height,
    duration: info.duration,
    author: "You",
    authorUrl: null,
    sourceUrl: "uploaded",
    license: "Your own upload",
    licenseUrl: null,
    attribution: null,
    attributionRequired: false,
    rightsStatus: "CLEAR",
    rightsNotes: ["Your own footage."],
    retrievedAt: new Date().toISOString(),
    date: null,
    categories: [],
    archival: false,
    score: 100,
  };
}

/**
 * "Mix" mode (interviews intercut with B-roll): cut back to the speaker at the opening and on
 * interview-style scenes, plus roughly every third scene. The speaker's picture always plays in
 * sync with the narration (trim = timeline position), so lips match the voice.
 */
export function applyOriginalFootage(selections: SceneSelection[], plans: ScenePlan[], footage: NormalizedAsset, onlySceneIds?: Set<string>) {
  const firstClipOf = new Map<string, SceneSelection>();
  for (const s of [...selections].sort((a, b) => a.start - b.start)) {
    if (s.role === "primary" && !firstClipOf.has(s.sceneId)) firstClipOf.set(s.sceneId, s);
  }
  plans.forEach((p, i) => {
    if (onlySceneIds && !onlySceneIds.has(p.sceneId)) return;
    const clip = firstClipOf.get(p.sceneId);
    if (!clip || clip.duration < 1.5) return;
    const pick = i === 0 || p.visualStrategy === "interview" || (i % 3 === 0 && seeded(p.sceneId)() < 0.8);
    if (!pick) return;
    Object.assign(clip, {
      asset: footage,
      alternates: [clip.asset, ...clip.alternates].slice(0, 4),
      needDescription: "Speaker (your original footage)",
      reason: "Cut back to the speaker (interview mixed with B-roll)",
      layout: "fullscreen",
      motion: "none",
      blackAndWhite: false,
      annotations: [],
      trimStart: clip.start,
      selectedBy: "heuristic",
    } satisfies Partial<SceneSelection>);
  });
}
