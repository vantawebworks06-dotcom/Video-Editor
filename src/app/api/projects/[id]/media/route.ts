import { NextResponse, type NextRequest } from "next/server";
import { requireProject, requireUser, route } from "@/lib/api/server";
import { listMediaItems } from "@/lib/data/media";
import { LIBRARY_TABS, MediaStatus } from "@/lib/domain/media";

/** The project's media library: ?tab=video|photo|…|upload &status=APPROVED,USED &sentence=12 */
export const GET = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/media">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id, "id");
  const sp = req.nextUrl.searchParams;
  const tab = LIBRARY_TABS.find((t) => t.id === sp.get("tab"));
  const statuses = (sp.get("status") ?? "")
    .split(",")
    .map((s) => MediaStatus.safeParse(s.trim()).data)
    .filter((s): s is MediaStatus => Boolean(s));
  const sentence = sp.get("sentence");
  const items = await listMediaItems(auth.supabase, project.id, {
    categories: tab?.categories,
    provider: tab?.provider,
    statuses: statuses.length ? statuses : undefined,
    sentenceIdx: sentence !== null && /^\d+$/.test(sentence) ? Number(sentence) : undefined,
  });
  return NextResponse.json({ items });
});
