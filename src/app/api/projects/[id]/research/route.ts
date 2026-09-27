import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { TranscriptAnalysis } from "@/lib/analysis/types";
import { HttpError, parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { listMediaItems } from "@/lib/data/media";
import { SupabaseSearchCache } from "@/lib/data/store";
import { MediaCategory } from "@/lib/domain/media";
import { RESEARCH_PROVIDER_IDS } from "@/lib/research";
import { runResearch } from "@/lib/research/orchestrator";
import { DEFAULT_PROVIDERS, saveCandidates } from "@/lib/research/save";
import type { ResearchProviderId } from "@/lib/research/types";
import { resolveCredentials } from "@/lib/settings/apiKeys";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";

export const maxDuration = 60;

const Body = z.object({
  sentenceIdx: z.number().int().min(0),
  /** A suggestion's query, or the editor's own words. */
  query: z.string().trim().min(2).max(300).optional(),
  category: MediaCategory.optional(),
  providers: z.array(z.enum(RESEARCH_PROVIDER_IDS as [ResearchProviderId, ...ResearchProviderId[]])).max(15).optional(),
});

/**
 * Research one narration sentence: query the chosen providers, rank the results against the
 * sentence, save them as DISCOVERED media items linked to it, and report every provider's outcome.
 */
export const POST = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/research">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id, "id, analysis");
  const body = await parseBody(req, Body);
  const analysis = project.analysis as TranscriptAnalysis | null;
  if (!analysis?.sentences?.length) throw new HttpError(400, "Analyse the transcript first (SCRIPT section).");
  const s = analysis.sentences[body.sentenceIdx];
  if (!s) throw new HttpError(404, "Sentence not found — re-run the analysis.");

  const suggestion = s.intent.suggestedAssets.find((g) => (!body.category || g.category === body.category) && (!body.query || g.query === body.query)) ?? s.intent.suggestedAssets[0];
  const category = body.category ?? suggestion?.category ?? "photo";
  const query = body.query ?? suggestion?.query ?? s.intent.entities.slice(0, 2).join(" ");
  if (!query.trim()) throw new HttpError(400, "Nothing to search for in this sentence — type a query.");
  const providers = (body.providers?.length ? body.providers : [...new Set([...(suggestion?.category === category ? suggestion.providers : []), ...DEFAULT_PROVIDERS[category]])]) as ResearchProviderId[];

  const creds = await resolveCredentials(auth.userId);
  const cache = hasServiceRole() ? new SupabaseSearchCache(createAdminClient()) : undefined;
  const r = await runResearch(
    { query, category, providers, sentence: s.text, entities: s.intent.entities, topics: s.intent.topics, year: s.dates.find((d) => d.year)?.year ?? null },
    creds,
    { cache, signal: req.signal },
  );
  const saved = await saveCandidates(auth.supabase, { userId: auth.userId, projectId: project.id }, r.candidates, { query, sentenceIdx: s.idx, analysis });
  const ids = r.candidates.map((c) => saved.get(`${c.provider}|${c.externalId.slice(0, 400)}`)?.id).filter((x): x is string => Boolean(x));
  const items = ids.length ? await listMediaItems(auth.supabase, project.id, { ids }) : [];
  const order = new Map(ids.map((id, i) => [id, i]));
  items.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return NextResponse.json({ query, category, providers, outcomes: r.outcomes, items });
});
