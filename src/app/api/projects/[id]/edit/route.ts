import { NextResponse, type NextRequest } from "next/server";
import { requireProject, requireUser, route } from "@/lib/api/server";
import { loadEdit } from "@/lib/data/store";
import { Transcript } from "@/lib/domain/types";
import { BUCKET } from "@/lib/supabase/admin";

/** Scenes, placed visuals (with full source/licence data) and transcript words for the editor. */
export const GET = route(async (_req: NextRequest, ctx: RouteContext<"/api/projects/[id]/edit">) => {
  const auth = await requireUser();
  const id = (await ctx.params).id;
  // Both queries are RLS-scoped, so the edit can load while the project is checked. The editor
  // never uses each clip's fallback candidates, so they stay out of the response.
  const [p, edit] = await Promise.all([requireProject(auth, id), loadEdit(auth.supabase, id, { alternates: false })]);
  const t = Transcript.safeParse(p.transcript);
  // The user's own files and captures live in private storage: sign them for the live preview.
  const stored = edit.selections.filter((c) => (c.asset.provider === "uploaded" && !c.asset.id.startsWith("uploaded:narration:")) || c.asset.provider === "capture");
  const signed = new Map<string, string>();
  if (stored.length) {
    const { data } = await auth.supabase.storage.from(BUCKET).createSignedUrls([...new Set(stored.map((c) => c.asset.providerAssetId))], 3600);
    for (const u of data ?? []) if (u.path && u.signedUrl) signed.set(u.path, u.signedUrl);
  }
  const withUrls = edit.selections.map((c) => {
    const url = signed.get(c.asset.providerAssetId);
    if (!url || !stored.includes(c)) return c;
    return { ...c, asset: { ...c.asset, mediaUrl: url, previewUrl: url, thumbnailUrl: c.asset.type === "video" ? null : url } };
  });
  return NextResponse.json({
    plans: edit.plans,
    clips: withUrls.map((clip) => ({ ...clip, alternates: undefined })), // dropped from the JSON
    words: t.success ? t.data.words : [],
    duration: t.success ? t.data.duration : Number(p.narration_duration ?? 0),
  });
});
