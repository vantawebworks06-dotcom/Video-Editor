import { NextResponse, type NextRequest } from "next/server";
import { HttpError, requireProject, requireUser, route } from "@/lib/api/server";
import { getSearchCache, maybeAdmin } from "@/lib/api/media";
import { makeClaude, makeDirector, parseSettings, resolveStyle } from "@/lib/data/project";
import { loadEdit } from "@/lib/data/store";
import type { VisualNeed } from "@/lib/domain/types";
import { searchMedia } from "@/lib/media/searchOrchestrator";
import { assetTypesForNeed, kindOf } from "@/lib/pipeline/engines";
import { resolveCredentials } from "@/lib/settings/apiKeys";

/** "Find Better Footage": AI-generated alternative queries + ranked candidates for one clip. */
export const POST = route(async (_req: NextRequest, ctx: RouteContext<"/api/projects/[id]/clips/[clipKey]/recommend">) => {
  const auth = await requireUser();
  const { id, clipKey } = await ctx.params;
  const project = await requireProject(auth, id);
  const edit = await loadEdit(auth.supabase, project.id);
  const clip = edit.selections.find((s) => s.clipId === clipKey);
  if (!clip) throw new HttpError(404, "Clip not found");
  const plan = edit.plans.find((p) => p.sceneId === clip.sceneId);

  const settings = parseSettings(project.settings);
  const creds = await resolveCredentials(auth.userId);
  const admin = maybeAdmin();
  const { claude, usage } = makeClaude(creds, settings, admin, { userId: auth.userId, projectId: project.id });
  const director = makeDirector(claude, settings);

  let queries = clip.queries;
  if (claude) {
    const q = await claude.generateSearchQueries(plan?.narration ?? "", `${clip.needType}: ${clip.needDescription}`, clip.queries);
    queries = [...new Set([...q.ranked, ...q.literal, ...q.conceptual])];
  }
  const need: VisualNeed = { type: clip.needType, queries, duration: clip.duration, description: clip.needDescription };
  const search = await searchMedia(
    {
      queries,
      types: clip.role === "meme" ? ["gif"] : [...new Set([...assetTypesForNeed(clip.needType), clip.needType === "video" ? "photo" as const : "video" as const])],
      providers: settings.enabledProviders,
      orientation: "landscape",
      minDuration: clip.needType === "video" ? clip.duration : undefined,
      allowReview: true,
      allowUnknown: false,
      gifRating: settings.gifRating,
      maxQueries: settings.budgetMode ? 2 : 4,
      limit: settings.budgetMode ? 8 : 16,
    },
    { creds, cache: getSearchCache() },
  );
  const recent = edit.selections.filter((s) => s.start < clip.start).slice(-5).map((s) => kindOf(s.asset, s.needType));
  const ranked = await director.rankCandidates(
    {
      narration: plan?.narration ?? "",
      strategy: plan?.visualStrategy ?? "documentary",
      need,
      candidates: search.candidates.filter((c) => c.id !== clip.asset.id),
      recentKinds: recent,
      usedAssetIds: new Set(edit.selections.map((s) => s.asset.id)),
    },
    { style: await resolveStyle(auth.supabase, (project.style_profile_id as string) ?? null, settings), settings, projectTitle: project.name, orientation: "landscape" },
  );

  return NextResponse.json({
    director: director.label,
    queries,
    candidates: ranked.slice(0, 12).map((r) => ({ ...r.asset, overall: r.overall, scores: r.scores, reason: r.reason })),
    errors: search.errors.map((e) => `${e.provider}: ${e.message}`),
    ai: usage.totals,
  });
});
