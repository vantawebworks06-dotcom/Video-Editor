import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { getItemRow } from "@/lib/data/media";
import { getResearchProvider } from "@/lib/research";

const Body = z.object({ theme: z.enum(["light", "dark"]).default("light"), mode: z.enum(["auto", "page"]).default("auto") });

/** Queue a screenshot capture of a public source (the worker renders it in headless Chrome). */
export const POST = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/media/[itemId]/capture">) => {
  const auth = await requireUser();
  const { id, itemId } = await ctx.params;
  const project = await requireProject(auth, id, "id");
  if (!z.uuid().safeParse(itemId).success) throw new HttpError(404, "Item not found");
  const row = await getItemRow(auth.supabase, project.id, itemId);
  if (!row) throw new HttpError(404, "Item not found");
  const body = await parseBody(req, Body);
  const provider = getResearchProvider(row.provider);
  if (!provider?.capabilities.capture || !row.source_url) {
    throw new HttpError(400, row.provider === "youtube" ? "YouTube's terms don't allow copying its video frames. Upload an authorised copy instead." : "This item can't be captured (no public source page, or the platform doesn't permit it).");
  }
  const { data: running } = await auth.supabase.from("pipeline_jobs").select("id").eq("project_id", project.id).eq("kind", "capture").in("status", ["QUEUED", "RUNNING"]).contains("payload", { itemId });
  if (running?.length) throw new HttpError(409, "A capture of this item is already running.");
  const { data, error } = await auth.supabase.from("pipeline_jobs").insert({ project_id: project.id, user_id: auth.userId, kind: "capture", payload: { itemId, theme: body.theme, mode: body.mode } }).select("id").single();
  if (error) throw error;
  return NextResponse.json({ jobId: data.id }, { status: 201 });
});
