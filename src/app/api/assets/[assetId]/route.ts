import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireUser, route } from "@/lib/api/server";

const Body = z.object({ isFavorite: z.boolean().optional(), userApproved: z.boolean().optional() });

/** Favourite an asset, or explicitly approve/revoke use of an UNKNOWN / needs-review asset. */
export const PATCH = route(async (req: NextRequest, ctx: RouteContext<"/api/assets/[assetId]">) => {
  const { supabase } = await requireUser();
  const { assetId } = await ctx.params;
  if (!z.uuid().safeParse(assetId).success) throw new HttpError(404, "Asset not found");
  const body = await parseBody(req, Body);
  const { data: asset } = await supabase.from("assets").select("rights_status").eq("id", assetId).maybeSingle();
  if (!asset) throw new HttpError(404, "Asset not found");
  if (body.userApproved && asset.rights_status === "RESTRICTED") throw new HttpError(400, "Restricted assets cannot be approved.");
  const update: Record<string, unknown> = {};
  if (body.isFavorite !== undefined) update.is_favorite = body.isFavorite;
  if (body.userApproved !== undefined) update.user_approved = body.userApproved;
  const { error } = await supabase.from("assets").update(update).eq("id", assetId);
  if (error) throw error;
  return NextResponse.json({ ok: true });
});
