import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { getItemRow, listMediaItems, patchItem } from "@/lib/data/media";
import { MediaPatch } from "@/lib/domain/media";
import { BUCKET } from "@/lib/supabase/admin";

async function load(req: { params: Promise<{ id: string; itemId: string }> }) {
  const auth = await requireUser();
  const { id, itemId } = await req.params;
  const project = await requireProject(auth, id, "id");
  if (!z.uuid().safeParse(itemId).success) throw new HttpError(404, "Item not found");
  const row = await getItemRow(auth.supabase, project.id, itemId);
  if (!row) throw new HttpError(404, "Item not found");
  return { auth, project, row };
}

export const GET = route(async (_req: NextRequest, ctx: RouteContext<"/api/projects/[id]/media/[itemId]">) => {
  const { auth, project, row } = await load(ctx);
  const [item] = await listMediaItems(auth.supabase, project.id, { ids: [row.id] });
  return NextResponse.json({ item });
});

/** Approve / reject / review, edit rights notes and licence, link to a sentence, set a segment. */
export const PATCH = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/media/[itemId]">) => {
  const { auth, project, row } = await load(ctx);
  const patch = await parseBody(req, MediaPatch);
  if (patch.status === "USED") throw new HttpError(400, "An item becomes USED when it is placed on the timeline.");
  if (patch.segment && patch.segment.end <= patch.segment.start) throw new HttpError(400, "The segment must end after it starts.");
  await patchItem(auth.supabase, row, patch);
  const [item] = await listMediaItems(auth.supabase, project.id, { ids: [row.id] });
  return NextResponse.json({ item });
});

/** Remove an item from the project (and the uploaded file, if nothing uses it). */
export const DELETE = route(async (_req: NextRequest, ctx: RouteContext<"/api/projects/[id]/media/[itemId]">) => {
  const { auth, project, row } = await load(ctx);
  const [item] = await listMediaItems(auth.supabase, project.id, { ids: [row.id] });
  if (item && item.usage > 0) throw new HttpError(409, `This item is used ${item.usage}× on the timeline. Remove or replace those clips first.`);
  const { error } = await auth.supabase.from("media_items").delete().eq("id", row.id);
  if (error) throw error;
  if (row.provider === "upload" || row.provider === "capture") {
    const paths = [row.storage_path, typeof row.metadata?.thumbPath === "string" ? row.metadata.thumbPath : null].filter((p): p is string => Boolean(p));
    if (paths.length) await auth.supabase.storage.from(BUCKET).remove(paths);
    // The asset row is kept only if another project/clip still references it (FK restrict).
    if (row.asset_id) await auth.supabase.from("assets").delete().eq("id", row.asset_id).then(undefined, () => undefined);
  }
  return NextResponse.json({ ok: true });
});
