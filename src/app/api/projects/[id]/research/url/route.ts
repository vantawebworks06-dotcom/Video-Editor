import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { TranscriptAnalysis } from "@/lib/analysis/types";
import { HttpError, parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { listMediaItems } from "@/lib/data/media";
import { platformOf } from "@/lib/research/platforms";
import { meta } from "@/lib/research/providers/meta";
import { describeUrl } from "@/lib/research/providers/url";
import { x } from "@/lib/research/providers/x";
import { youtube } from "@/lib/research/providers/youtube";
import { rankCandidates } from "@/lib/research/rank";
import { saveCandidates } from "@/lib/research/save";
import { type Candidate, ResearchError } from "@/lib/research/types";
import { resolveCredentials } from "@/lib/settings/apiKeys";

export const maxDuration = 30;

const Body = z.object({ url: z.string().trim().min(8).max(2000), sentenceIdx: z.number().int().min(0).nullable().optional() });

/**
 * Add a link the editor found themselves (any site, a YouTube video, an X/Facebook/Instagram post):
 * its public metadata becomes a sourced reference in the project, status REVIEW.
 */
export const POST = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/research/url">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id, "id, analysis");
  const body = await parseBody(req, Body);
  const creds = await resolveCredentials(auth.userId);
  const { platform, id } = platformOf(body.url);
  let c: Candidate | null;
  try {
    if (platform === "youtube" && id) c = await youtube.getMetadata(id, creds, req.signal);
    else if (platform === "x" && id) c = await x.getMetadata(id, creds, req.signal);
    else if ((platform === "facebook" || platform === "instagram") && creds.metaOembed) c = await meta.getMetadata(body.url, creds, req.signal);
    else c = await describeUrl(body.url, creds, req.signal);
  } catch (e) {
    if (e instanceof ResearchError) throw new HttpError(e.code === "NOT_FOUND" ? 404 : e.code === "FORBIDDEN" ? 403 : e.code === "RATE_LIMITED" ? 429 : 400, e.message);
    throw e;
  }
  if (!c) throw new HttpError(404, "Nothing could be read from that link.");
  if (platform === "youtube" && id && c.provider !== "youtube") c = { ...c, provider: "youtube", externalId: id };
  if (platform === "x" && id) c = { ...c, provider: "x", externalId: id };

  const analysis = project.analysis as TranscriptAnalysis | null;
  const s = body.sentenceIdx != null ? analysis?.sentences[body.sentenceIdx] : undefined;
  const ranked = s ? rankCandidates([c], { sentence: s.text, entities: s.intent.entities, topics: s.intent.topics, year: s.dates.find((d) => d.year)?.year ?? null, category: c.category, query: s.intent.entities.join(" ") })[0]! : c;
  const saved = await saveCandidates(auth.supabase, { userId: auth.userId, projectId: project.id }, [ranked], { query: null, sentenceIdx: s ? s.idx : null, analysis, status: "REVIEW" });
  const row = [...saved.values()][0];
  const [item] = row ? await listMediaItems(auth.supabase, project.id, { ids: [row.id] }) : [];
  return NextResponse.json({ item });
});
