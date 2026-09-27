import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { historyState, step } from "@/lib/data/history";

/** What undo/redo would do next (labels), for the toolbar. */
export const GET = route(async (_req: NextRequest, ctx: RouteContext<"/api/projects/[id]/history">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id, "id");
  return NextResponse.json(await historyState(auth.supabase, project.id));
});

export const POST = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/history">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id, "id");
  const { action } = await parseBody(req, z.object({ action: z.enum(["undo", "redo"]) }));
  const label = await step(auth.supabase, { userId: auth.userId, projectId: project.id }, action);
  if (!label) throw new HttpError(409, action === "undo" ? "Nothing to undo." : "Nothing to redo.");
  return NextResponse.json({ ok: true, label, ...(await historyState(auth.supabase, project.id)) });
});
