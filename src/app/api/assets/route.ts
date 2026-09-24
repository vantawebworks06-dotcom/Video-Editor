import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireUser, route } from "@/lib/api/server";
import { assetRowToNormalized, type AssetRow, upsertAssets } from "@/lib/data/store";
import { ProviderId } from "@/lib/domain/types";
import { getProvider } from "@/lib/media/providers";
import { looksAiGenerated } from "@/lib/media/rights";
import { applyContentSignals } from "@/lib/media/searchOrchestrator";
import { resolveCredentials } from "@/lib/settings/apiKeys";

/** Media library: every asset the user has used or saved, with full source/licence data. */
export const GET = route(async (req: NextRequest) => {
  const { supabase } = await requireUser();
  const sp = req.nextUrl.searchParams;
  let q = supabase.from("assets").select("*").order("created_at", { ascending: false }).limit(200);
  const type = sp.get("type");
  const provider = sp.get("provider");
  const rights = sp.get("rights");
  const text = sp.get("q");
  if (type === "archive") q = q.eq("archival", true);
  else if (type === "meme") q = q.in("type", ["gif", "sticker"]);
  else if (type && ["video", "photo", "gif"].includes(type)) q = q.eq("type", type);
  if (provider && ProviderId.safeParse(provider).success) q = q.eq("provider", provider);
  if (rights) q = q.eq("rights_status", rights);
  if (sp.get("favorites") === "1") q = q.eq("is_favorite", true);
  if (text) q = q.ilike("title", `%${text.replace(/[%_\\]/g, "").slice(0, 80)}%`);
  const { data, error } = await q;
  if (error) throw error;
  return NextResponse.json({
    assets: (data as AssetRow[]).map((r) => ({ ...assetRowToNormalized(r), rowId: r.id, isFavorite: r.is_favorite, userApproved: r.user_approved })),
  });
});

const SaveBody = z.object({ provider: ProviderId.exclude(["uploaded", "library"]), providerAssetId: z.string().min(1).max(200) });

/** Save a search result to the library as a favourite (re-fetched server-side). */
export const POST = route(async (req: NextRequest) => {
  const { supabase, userId } = await requireUser();
  const body = await parseBody(req, SaveBody);
  const p = getProvider(body.provider);
  if (!p) throw new HttpError(400, "Unknown provider");
  const asset = await p.getAsset(body.providerAssetId, await resolveCredentials(userId));
  if (!asset) throw new HttpError(404, "Asset not found at the provider");
  if (looksAiGenerated(asset)) throw new HttpError(400, "This asset is marked as AI-generated. DocuCut only uses real footage and photography.");
  const ids = await upsertAssets(supabase, userId, [applyContentSignals(asset)]);
  const rowId = ids.get(asset.id)!;
  await supabase.from("assets").update({ is_favorite: true }).eq("id", rowId);
  return NextResponse.json({ ok: true, id: rowId });
});
