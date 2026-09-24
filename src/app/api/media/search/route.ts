import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, requireUser, route } from "@/lib/api/server";
import { getSearchCache } from "@/lib/api/media";
import { AssetType, ProviderId, RightsStatus } from "@/lib/domain/types";
import { searchMedia } from "@/lib/media/searchOrchestrator";
import { resolveCredentials } from "@/lib/settings/apiKeys";

const Body = z.object({
  query: z.string().trim().min(1).max(120),
  types: z.array(AssetType).min(1).default(["photo", "video"]),
  providers: z.array(ProviderId).min(1).default(["pexels", "pixabay", "wikimedia", "internet_archive", "giphy"]),
  rights: z.array(RightsStatus).default(["CLEAR", "ATTRIBUTION_REQUIRED", "USER_REVIEW"]),
  orientation: z.enum(["landscape", "portrait", "square"]).default("landscape"),
  gifRating: z.enum(["g", "pg", "pg-13"]).default("pg"),
});

export const POST = route(async (req: Request) => {
  const { userId } = await requireUser();
  const body = await parseBody(req, Body);
  const creds = await resolveCredentials(userId);
  const r = await searchMedia(
    {
      queries: [body.query],
      types: body.types,
      providers: body.providers,
      orientation: body.orientation,
      allowReview: body.rights.includes("USER_REVIEW"),
      allowUnknown: body.rights.includes("UNKNOWN"),
      gifRating: body.gifRating,
      perQuery: 15,
      maxQueries: 1,
      limit: 40,
    },
    { creds, cache: getSearchCache() },
  );
  const allowed = new Set(body.rights);
  return NextResponse.json({
    candidates: r.candidates.filter((c) => allowed.has(c.rightsStatus)),
    errors: r.errors.map((e) => ({ provider: e.provider, code: e.code, message: e.message })),
    cacheHits: r.cacheHits,
  });
});
