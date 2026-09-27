/**
 * Editor operations on the timeline (scene_assets rows, narration time). Picture placements cut
 * into the contiguous visual track; source clips (footage with its own audio) sit on top of it
 * and change the narration at render time (see pipeline/sourceTimeline.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { upsertAssets } from "@/lib/data/store";
import { getItemRow } from "@/lib/data/media";
import { DEFAULT_SOURCE_AUDIO, SourceAudio } from "@/lib/domain/sourceAudio";
import type { NormalizedAsset } from "@/lib/domain/types";
import { getResearchProvider } from "@/lib/research";
import { resolveCredentials } from "@/lib/settings/apiKeys";

export class OpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Row {
  id: string;
  scene_id: string;
  asset_id: string;
  clip_key: string;
  position: number;
  role: "primary" | "meme" | "source";
  start_time: number;
  duration: number;
  trim_start: number;
  treatment: Record<string, unknown> | null;
  audio: unknown;
  [k: string]: unknown;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
export const newClipKey = (prefix = "usr") => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

export async function loadRows(db: SupabaseClient, projectId: string): Promise<Row[]> {
  const { data, error } = await db.from("scene_assets").select("*").eq("project_id", projectId).order("start_time");
  if (error) throw new Error(error.message);
  return ((data ?? []) as Row[]).map((r) => ({ ...r, start_time: Number(r.start_time), duration: Number(r.duration), trim_start: Number(r.trim_start) }));
}

export async function sceneAt(db: SupabaseClient, projectId: string, t: number): Promise<{ id: string; key: string; start: number; end: number }> {
  const { data } = await db.from("scenes").select("id, scene_key, start_time, end_time").eq("project_id", projectId).order("start_time");
  const scenes = (data ?? []).map((s) => ({ id: s.id as string, key: s.scene_key as string, start: Number(s.start_time), end: Number(s.end_time) }));
  if (!scenes.length) throw new OpError(400, "Generate the edit first — the narration timeline (scenes) must exist before placing media on it.");
  return scenes.find((s) => t >= s.start && t < s.end) ?? (t < scenes[0]!.start ? scenes[0]! : scenes.at(-1)!);
}

/** Make room for [x, y) in the picture track: trim, split or remove the base clips there. */
export async function cutBase(db: SupabaseClient, rows: Row[], x: number, y: number) {
  for (const r of rows.filter((r) => r.role !== "source")) {
    const a = r.start_time;
    const b = a + r.duration;
    if (b <= x + 1e-6 || a >= y - 1e-6) continue;
    const isVideo = r.need_type === "video" || r.need_type === "archival" || r.need_type === "reaction";
    if (a >= x - 1e-6 && b <= y + 1e-6) {
      const { error } = await db.from("scene_assets").delete().eq("id", r.id);
      if (error) throw new Error(error.message);
      continue;
    }
    if (a < x && b > y) {
      // Spans the whole range: keep the left part, add the right part after the new clip.
      await db.from("scene_assets").update({ duration: round(x - a) }).eq("id", r.id);
      const { id: _id, created_at: _c, updated_at: _u, ...copy } = r;
      void _id;
      void _c;
      void _u;
      const { error } = await db.from("scene_assets").insert({ ...copy, clip_key: newClipKey(r.clip_key.split("_")[0]), start_time: round(y), duration: round(b - y), trim_start: isVideo ? round(r.trim_start + (y - a)) : r.trim_start, treatment: { ...(r.treatment ?? {}), transitionIn: "hard_cut" } });
      if (error) throw new Error(error.message);
      continue;
    }
    if (a < x) await db.from("scene_assets").update({ duration: round(x - a) }).eq("id", r.id);
    else await db.from("scene_assets").update({ start_time: round(y), duration: round(b - y), trim_start: isVideo ? round(r.trim_start + (y - a)) : r.trim_start }).eq("id", r.id);
  }
}

/** The media item's renderable asset, importing stock/archive files (re-fetched server-side) on first use. */
async function assetFor(db: SupabaseClient, ctx: { userId: string; projectId: string }, itemId: string) {
  const item = await getItemRow(db, ctx.projectId, itemId);
  if (!item) throw new OpError(404, "Media item not found.");
  if (item.status === "REJECTED") throw new OpError(400, "This item was rejected. Restore it first.");
  if (item.asset_id) {
    const { data: a } = await db.from("assets").select("id, type, duration, width, height, title").eq("id", item.asset_id).single();
    return { item, asset: a as { id: string; type: string; duration: number | null; width: number | null; height: number | null; title: string } };
  }
  const provider = getResearchProvider(item.provider);
  if (provider?.capabilities.import !== "file" || !provider.importMedia) {
    throw new OpError(400, `${item.platform ?? item.provider} content can't be downloaded (${provider?.capabilities.import === "authorised-copy" ? "the platform forbids it" : "reference only"}). ${item.provider === "youtube" ? "Upload a copy you are authorised to use" : "Capture a screenshot or upload an authorised copy"} and place that instead.`);
  }
  const stored = item.metadata?.asset as NormalizedAsset | undefined;
  const fresh = await provider.importMedia({ provider: provider.id, externalId: item.external_id ?? stored?.providerAssetId ?? "", category: item.category, title: item.title, description: null, excerpt: null, sourceUrl: item.source_url ?? "", platform: item.platform ?? "", account: null, accountUrl: null, publishedAt: null, duration: null, thumbnailUrl: null, embed: null, segment: null, license: null, credibility: 0.5 }, await resolveCredentials(ctx.userId));
  if (!fresh) throw new OpError(404, "The file is no longer available from the library (removed or restricted).");
  const ids = await upsertAssets(db, ctx.userId, [fresh]);
  const assetId = ids.get(fresh.id)!;
  await db.from("media_items").update({ asset_id: assetId, imported_at: new Date().toISOString() }).eq("id", item.id);
  return { item: { ...item, asset_id: assetId }, asset: { id: assetId, type: fresh.type, duration: fresh.duration, width: fresh.width, height: fresh.height, title: fresh.title } };
}

export interface PlaceInput {
  itemId: string;
  /** Narration time the placement starts at. */
  at: number;
  duration?: number;
  /** Seconds into the source video to start from (defaults to the item's segment start). */
  trimStart?: number;
  /** Play the item's own audio (interview/news footage) instead of laying it in as picture only. */
  asSource?: boolean;
  sourceAudio?: Partial<SourceAudio>;
  narrationDuration: number;
  defaultSourceAudio?: SourceAudio;
  reason?: string;
}

export async function placeItem(db: SupabaseClient, ctx: { userId: string; projectId: string }, p: PlaceInput) {
  const { item, asset } = await assetFor(db, ctx, p.itemId);
  const isVideo = asset.type === "video" || asset.type === "gif";
  const seg = item.segment as { start: number; end: number } | null;
  const trim = Math.max(0, p.trimStart ?? (isVideo && seg ? seg.start : 0));
  const available = isVideo && asset.duration ? Math.max(0.5, Number(asset.duration) - trim) : Infinity;
  const wanted = p.duration ?? (isVideo ? (seg ? seg.end - seg.start : Math.min(8, available)) : 4);
  const duration = round(Math.max(0.5, Math.min(wanted, available, 600)));
  const at = round(Math.max(0, Math.min(p.at, p.narrationDuration - 0.2)));
  const asSource = Boolean(p.asSource && isVideo);
  const scene = await sceneAt(db, ctx.projectId, at);
  const rows = await loadRows(db, ctx.projectId);

  let end = at + duration;
  if (asSource) {
    const clash = rows.find((r) => r.role === "source" && r.start_time < end - 1e-6 && r.start_time + r.duration > at + 1e-6);
    if (clash) throw new OpError(409, `Another source clip already plays at ${clash.start_time.toFixed(1)} s. Move it or place this one elsewhere.`);
  } else {
    // A picture placement never runs past the narration.
    end = Math.min(end, p.narrationDuration);
    await cutBase(db, rows, at, end);
  }
  const audio = asSource ? SourceAudio.parse({ ...(p.defaultSourceAudio ?? DEFAULT_SOURCE_AUDIO), ...(p.sourceAudio ?? {}) }) : null;
  const row = {
    project_id: ctx.projectId,
    scene_id: scene.id,
    asset_id: asset.id,
    user_id: ctx.userId,
    clip_key: newClipKey(asSource ? "src" : "usr"),
    position: 0,
    role: asSource ? "source" : "primary",
    start_time: at,
    duration: round(end - at),
    trim_start: isVideo ? trim : 0,
    need_type: isVideo ? "video" : "photo",
    need_description: `Placed from the media library: ${item.title}`.slice(0, 500),
    queries: item.query ? [item.query] : [],
    layout: "fullscreen",
    motion: { type: isVideo || asSource ? "none" : "slow_zoom_in", intensity: 0.08 },
    treatment: { blackAndWhite: false, grain: false, transitionIn: "hard_cut" },
    annotations: [],
    alternates: [],
    reason: p.reason ?? "Placed by the editor",
    selected_by: "user",
    audio,
    media_item_id: item.id,
  };
  const { data, error } = await db.from("scene_assets").insert(row).select("clip_key").single();
  if (error) throw new Error(error.message);
  // Placing is an editorial decision: the item and its file count as approved.
  if (item.status === "DISCOVERED" || item.status === "REVIEW") await db.from("media_items").update({ status: "APPROVED" }).eq("id", item.id);
  await db.from("assets").update({ user_approved: true }).eq("id", asset.id);
  return { clipKey: data.clip_key as string, role: row.role, start: at, duration: row.duration, sceneKey: scene.key };
}
