import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { upsertAssets } from "@/lib/data/store";
import { ProviderId } from "@/lib/domain/types";
import { getProvider } from "@/lib/media/providers";
import { looksAiGenerated } from "@/lib/media/rights";
import { applyContentSignals } from "@/lib/media/searchOrchestrator";
import { videoTrimStart } from "@/lib/pipeline/generate";
import { resolveCredentials } from "@/lib/settings/apiKeys";

const Body = z.object({
  provider: ProviderId.exclude(["uploaded", "library"]),
  providerAssetId: z.string().min(1).max(200),
  approve: z.boolean().default(false),
});

/**
 * "Use This": swap one clip's visual. The asset is re-fetched from the provider server-side —
 * the browser never supplies URLs or licence data.
 */
export const POST = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/clips/[clipKey]/replace">) => {
  const auth = await requireUser();
  const { id, clipKey } = await ctx.params;
  const project = await requireProject(auth, id);
  const body = await parseBody(req, Body);

  const { data: clip } = await auth.supabase.from("scene_assets").select("id, duration, role").eq("project_id", project.id).eq("clip_key", clipKey).maybeSingle();
  if (!clip) throw new HttpError(404, "Clip not found");

  const provider = getProvider(body.provider);
  if (!provider) throw new HttpError(400, "Unknown provider");
  const creds = await resolveCredentials(auth.userId);
  const fetched = await provider.getAsset(body.providerAssetId, creds).catch((e: Error) => {
    throw new HttpError(502, `Could not fetch asset from ${provider.name}: ${e.message}`);
  });
  if (!fetched) throw new HttpError(404, "Asset not found at the provider");
  const asset = applyContentSignals(fetched);
  if (looksAiGenerated(asset)) throw new HttpError(400, "This asset is marked as AI-generated. DocuCut only uses real footage and photography.");
  if (asset.rightsStatus === "RESTRICTED") throw new HttpError(400, "This asset's licence is restricted; it can't be used.");

  const ids = await upsertAssets(auth.supabase, auth.userId, [asset]);
  const assetRowId = ids.get(asset.id)!;
  if (body.approve) await auth.supabase.from("assets").update({ user_approved: true }).eq("id", assetRowId);

  const isStill = asset.type === "photo";
  const { error } = await auth.supabase
    .from("scene_assets")
    .update({
      asset_id: assetRowId,
      selected_by: "user",
      trim_start: asset.type === "video" ? videoTrimStart(asset.duration, Number(clip.duration), clipKey) : 0,
      motion: { type: isStill ? "slow_zoom_in" : "none", intensity: 0.08 },
      layout: asset.type === "gif" || asset.type === "sticker" ? "fullscreen" : undefined,
      reason: "Chosen by user",
    })
    .eq("id", clip.id);
  if (error) throw error;
  await auth.supabase.from("projects").update({ timeline_version: Number(project.timeline_version ?? 0) + 1 }).eq("id", project.id);

  return NextResponse.json({
    ok: true,
    rightsStatus: asset.rightsStatus,
    needsApproval: asset.rightsStatus === "UNKNOWN" && !body.approve,
  });
});
