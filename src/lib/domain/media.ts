/**
 * Project media items: every researched, captured, imported or uploaded item, with its editorial
 * status and full provenance (source, platform, account, dates, rights notes). Client-safe.
 */
import { z } from "zod";
import { MEDIA_CATEGORIES } from "@/lib/analysis/types";

export const MediaStatus = z.enum(["DISCOVERED", "REVIEW", "APPROVED", "REJECTED", "USED"]);
export type MediaStatus = z.infer<typeof MediaStatus>;

export const MediaCategory = z.enum(MEDIA_CATEGORIES);
export type MediaCategory = z.infer<typeof MediaCategory>;

/** Where a relevant section of a long video is, and how that was determined. */
export const SegmentSuggestion = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  /** "chapters" (the uploader's own description timestamps), "transcript" (speech in an imported copy), "user" (set by hand). */
  basis: z.enum(["chapters", "transcript", "user", "description"]),
  /** 0-1. Always shown as a suggestion unless basis is "user". */
  confidence: z.number().min(0).max(1),
  label: z.string().max(300).nullable(),
  reason: z.string().max(500),
});
export type SegmentSuggestion = z.infer<typeof SegmentSuggestion>;

/** Explained relevance: each factor 0-100 with a reason, and a weighted total. */
export const Relevance = z.object({
  score: z.number(),
  factors: z.record(z.string(), z.number()),
  reasons: z.array(z.string()),
});
export type Relevance = z.infer<typeof Relevance>;

/** How a reference can be previewed without copying it: an official embed or a thumbnail only. */
export const Embed = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("youtube"), videoId: z.string().regex(/^[\w-]{6,20}$/) }),
  z.object({ kind: z.literal("x"), postId: z.string().regex(/^\d{5,25}$/) }),
  z.object({ kind: z.literal("iframe"), src: z.string().url() }),
  z.object({ kind: z.literal("none") }),
]);
export type Embed = z.infer<typeof Embed>;

export interface MediaItem {
  id: string;
  status: MediaStatus;
  category: MediaCategory;
  /** Research provider or source kind: youtube, x, reddit, brave, gdelt, wikimedia, …, upload, capture, url. */
  provider: string;
  externalId: string | null;
  title: string;
  description: string | null;
  excerpt: string | null;
  sourceUrl: string | null;
  platform: string | null;
  account: string | null;
  accountUrl: string | null;
  publishedAt: string | null;
  foundAt: string;
  importedAt: string | null;
  duration: number | null;
  thumbnailUrl: string | null;
  embed: Embed | null;
  segment: SegmentSuggestion | null;
  relevance: Relevance | null;
  query: string | null;
  sentenceIdx: number | null;
  sceneKey: string | null;
  rightsNotes: string | null;
  license: string | null;
  /** Renderable asset row (null for references such as YouTube videos, which may not be downloaded). */
  assetId: string | null;
  storagePath: string | null;
  derivedFrom: string | null;
  metadata: Record<string, unknown>;
  /** Clips on the timeline that use this item. */
  usage: number;
  /** Signed URL for storage-backed files (uploads, captures), when available. */
  fileUrl?: string | null;
  /** Asset facts needed for placement/preview. */
  asset?: { type: string; width: number | null; height: number | null; rightsStatus: string; userApproved: boolean } | null;
}

/** Media Library tabs. "upload" is a provider filter, the rest are categories. */
export const LIBRARY_TABS: { id: string; label: string; categories?: MediaCategory[]; provider?: string }[] = [
  { id: "all", label: "All" },
  { id: "video", label: "Videos", categories: ["video"] },
  { id: "photo", label: "Photos", categories: ["photo"] },
  { id: "social", label: "Social posts", categories: ["social"] },
  { id: "article", label: "Articles", categories: ["article", "web"] },
  { id: "screenshot", label: "Screenshots", categories: ["screenshot"] },
  { id: "interview", label: "Interviews", categories: ["interview"] },
  { id: "audio", label: "Audio", categories: ["audio"] },
  { id: "music", label: "Music", categories: ["music"] },
  { id: "document", label: "Documents", categories: ["document"] },
  { id: "upload", label: "User uploads", provider: "upload" },
];

export const MediaPatch = z.object({
  status: MediaStatus.optional(),
  title: z.string().trim().min(1).max(500).optional(),
  rightsNotes: z.string().max(4000).nullable().optional(),
  license: z.string().max(300).nullable().optional(),
  category: MediaCategory.optional(),
  sentenceIdx: z.number().int().min(0).nullable().optional(),
  segment: SegmentSuggestion.nullable().optional(),
  /** The user states they hold the rights to use this file (uploads/captures): renders without review. */
  rightsConfirmed: z.boolean().optional(),
});
export type MediaPatch = z.infer<typeof MediaPatch>;
