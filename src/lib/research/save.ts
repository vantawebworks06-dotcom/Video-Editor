/** Research results → project media items (DISCOVERED), keeping provenance and relevance. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MediaCategory, TranscriptAnalysis } from "@/lib/analysis/types";
import type { NewItem } from "@/lib/data/media";
import type { MediaStatus } from "@/lib/domain/media";
import { saveDiscovered } from "@/lib/data/media";
import { getResearchProvider } from "./index";
import type { Candidate, RankedCandidate } from "./types";

export function candidateToItem(c: Candidate | RankedCandidate, ctx: { query: string | null; sentenceIdx: number | null; sceneKey: string | null; status?: MediaStatus }): NewItem {
  const p = getResearchProvider(c.provider);
  return {
    category: c.category,
    provider: c.provider,
    externalId: c.externalId,
    title: c.title,
    description: c.description,
    excerpt: c.excerpt,
    sourceUrl: c.sourceUrl,
    platform: c.platform,
    account: c.account,
    accountUrl: c.accountUrl,
    publishedAt: c.publishedAt && !Number.isNaN(Date.parse(c.publishedAt)) ? new Date(c.publishedAt).toISOString() : null,
    duration: c.duration,
    thumbnailUrl: c.thumbnailUrl,
    embed: c.embed,
    segment: c.segment,
    relevance: "relevance" in c ? c.relevance : null,
    query: ctx.query,
    sentenceIdx: ctx.sentenceIdx,
    sceneKey: ctx.sceneKey,
    license: c.license,
    status: ctx.status,
    metadata: {
      importable: p?.capabilities.import ?? "none",
      capturable: p?.capabilities.capture ?? false,
      credibility: c.credibility,
      ...(c.metrics ? { metrics: c.metrics } : {}),
      ...(c.chapters?.length ? { chapters: c.chapters.slice(0, 60) } : {}),
      // Stock/archive: the classified asset (re-fetched from the library again before import).
      ...(c.asset ? { asset: c.asset } : {}),
    },
  };
}

export async function saveCandidates(db: SupabaseClient, ctx: { userId: string; projectId: string }, cands: (Candidate | RankedCandidate)[], link: { query: string | null; sentenceIdx: number | null; analysis: TranscriptAnalysis | null; status?: MediaStatus }) {
  const sceneKey = link.sentenceIdx !== null && link.analysis ? (link.analysis.scenes[link.analysis.sentences[link.sentenceIdx]?.scene ?? -1]?.key ?? null) : null;
  return saveDiscovered(db, ctx, cands.map((c) => candidateToItem(c, { query: link.query, sentenceIdx: link.sentenceIdx, sceneKey, status: link.status })));
}

/** Providers worth asking for a category, when a suggestion doesn't name any. */
export const DEFAULT_PROVIDERS: Record<MediaCategory, string[]> = {
  video: ["youtube", "internet_archive", "wikimedia", "pexels", "pixabay"],
  interview: ["youtube", "brave"],
  photo: ["wikimedia", "brave", "internet_archive", "pexels", "pixabay"],
  social: ["x", "reddit"],
  article: ["gdelt", "brave", "wikipedia"],
  web: ["brave", "wikipedia"],
  document: ["internet_archive", "wikimedia", "brave"],
  screenshot: ["brave"],
  audio: ["internet_archive"],
  music: ["internet_archive"],
};
