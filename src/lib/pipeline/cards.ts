/**
 * Designed text cards: the editor's answer when no relevant media exists (section 25 of the
 * brief — a name/year/quote card is better than an unrelated clip). A card is an asset with
 * provider "graphic"; the renderer draws it (texture background + large text) and the live
 * preview shows it as styled text. No media file, no third-party rights.
 */
import type { CardSpec, NormalizedAsset, PaperStyle } from "@/lib/domain/types";
import { stableHash } from "@/lib/media/cache";

export const GRAPHIC_URL_PREFIX = "graphic:";

/** Background texture per card kind. */
export const CARD_TEXTURE: Record<CardSpec["kind"], PaperStyle> = {
  name: "dark_paper",
  year: "newspaper",
  quote: "white_paper",
  statistic: "dark_paper",
  headline: "dark_paper",
  chapter: "crumpled_paper",
};

export function isGraphic(a: Pick<NormalizedAsset, "provider">): boolean {
  return a.provider === "graphic";
}

export function cardAsset(card: CardSpec, reason: string): NormalizedAsset {
  const id = stableHash(card).slice(0, 20);
  return {
    id: `graphic:${id}`,
    provider: "graphic",
    providerAssetId: id,
    type: "photo",
    title: card.text,
    description: JSON.stringify(card),
    thumbnailUrl: null,
    mediaUrl: `${GRAPHIC_URL_PREFIX}${card.kind}`,
    previewUrl: null,
    downloadUrl: `${GRAPHIC_URL_PREFIX}${card.kind}`,
    width: 1920,
    height: 1080,
    duration: null,
    author: "DocuCut",
    authorUrl: null,
    sourceUrl: `${GRAPHIC_URL_PREFIX}${card.kind}`,
    license: "Designed by DocuCut (no third-party media)",
    licenseUrl: null,
    attribution: null,
    attributionRequired: false,
    rightsStatus: "CLEAR",
    rightsNotes: [reason],
    retrievedAt: new Date().toISOString(),
    date: null,
    categories: [card.kind],
    archival: false,
    score: 100,
  };
}

/** The card content stored on a graphic asset (tolerates older/garbled rows). */
export function cardOf(a: Pick<NormalizedAsset, "title" | "description" | "categories">): CardSpec {
  try {
    const c = JSON.parse(a.description ?? "") as CardSpec;
    if (c && typeof c.text === "string") return { kind: c.kind ?? "chapter", text: c.text, sub: c.sub ?? null };
  } catch {
    // fall through
  }
  return { kind: (a.categories[0] as CardSpec["kind"]) ?? "chapter", text: a.title, sub: null };
}
