/**
 * Export: delivery presets and the settings a final render uses (frame rate, quality, the
 * platform's loudness target, whether captions are burned in or only delivered as a file).
 */
import { z } from "zod";

export const ExportSettings = z.object({
  fps: z.union([z.literal(24), z.literal(25), z.literal(30)]),
  /** standard: CRF 20, ≤ 8 Mbps (YouTube's 1080p recommendation); high: CRF 17, ≤ 16 Mbps, slower preset. */
  quality: z.enum(["standard", "high"]),
  /** Integrated loudness of the final mix, LUFS (true peak ≤ −1 dBTP). */
  loudness: z.number().min(-24).max(-10),
  /** Burn captions into the picture (else they are only delivered as .srt/.vtt files). */
  burnCaptions: z.boolean(),
});
export type ExportSettings = z.infer<typeof ExportSettings>;

export const DEFAULT_EXPORT: ExportSettings = { fps: 30, quality: "standard", loudness: -14, burnCaptions: true };

export const LOUDNESS_TARGETS: { value: number; label: string }[] = [
  { value: -14, label: "−14 LUFS · YouTube, Spotify, most social" },
  { value: -16, label: "−16 LUFS · Apple, podcasts, general web" },
  { value: -23, label: "−23 LUFS · EBU R128 broadcast" },
];

export interface ExportPreset {
  id: string;
  label: string;
  format: "landscape" | "hd720" | "vertical" | "draft";
  size: string;
  note: string;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: "youtube1080", label: "YouTube 1080p", format: "landscape", size: "1920×1080", note: "Full quality for YouTube and websites." },
  { id: "youtube720", label: "YouTube 720p", format: "hd720", size: "1280×720", note: "Smaller file, faster render and upload." },
  { id: "vertical", label: "Shorts / Reels / TikTok", format: "vertical", size: "1080×1920", note: "Vertical 9:16, graphics scaled up." },
  { id: "draft", label: "Draft preview", format: "draft", size: "960×540", note: "Quick check before the final export." },
];

/** YouTube accepts chapters when the first starts at 0:00, there are ≥ 3, and each lasts ≥ 10 s. */
export const MIN_CHAPTER_SECONDS = 10;
