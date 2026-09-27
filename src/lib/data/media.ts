/**
 * Project media items (server side): research results, captures, imports and uploads with their
 * status and provenance. RLS-scoped clients only — every query also filters by project.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { Embed, type MediaCategory, type MediaItem, type MediaPatch, type MediaStatus, Relevance, SegmentSuggestion } from "@/lib/domain/media";
import { BUCKET } from "@/lib/supabase/admin";

export interface MediaRow {
  id: string;
  project_id: string;
  user_id: string;
  status: MediaStatus;
  category: MediaCategory;
  provider: string;
  external_id: string | null;
  title: string;
  description: string | null;
  excerpt: string | null;
  source_url: string | null;
  platform: string | null;
  account: string | null;
  account_url: string | null;
  published_at: string | null;
  found_at: string;
  imported_at: string | null;
  duration: number | null;
  thumbnail_url: string | null;
  embed: unknown;
  segment: unknown;
  relevance: unknown;
  query: string | null;
  sentence_idx: number | null;
  scene_key: string | null;
  rights_notes: string | null;
  license: string | null;
  asset_id: string | null;
  storage_path: string | null;
  derived_from: string | null;
  metadata: Record<string, unknown> | null;
}

export function rowToItem(r: MediaRow, extra: Partial<Pick<MediaItem, "usage" | "fileUrl" | "asset" | "thumbnailUrl">> = {}): MediaItem {
  return {
    id: r.id,
    status: r.status,
    category: r.category,
    provider: r.provider,
    externalId: r.external_id,
    title: r.title,
    description: r.description,
    excerpt: r.excerpt,
    sourceUrl: r.source_url,
    platform: r.platform,
    account: r.account,
    accountUrl: r.account_url,
    publishedAt: r.published_at,
    foundAt: r.found_at,
    importedAt: r.imported_at,
    duration: r.duration === null ? null : Number(r.duration),
    thumbnailUrl: extra.thumbnailUrl !== undefined ? extra.thumbnailUrl : r.thumbnail_url,
    embed: Embed.nullable().catch(null).parse(r.embed ?? null),
    segment: SegmentSuggestion.nullable().catch(null).parse(r.segment ?? null),
    relevance: Relevance.nullable().catch(null).parse(r.relevance ?? null),
    query: r.query,
    sentenceIdx: r.sentence_idx,
    sceneKey: r.scene_key,
    rightsNotes: r.rights_notes,
    license: r.license,
    assetId: r.asset_id,
    storagePath: r.storage_path,
    derivedFrom: r.derived_from,
    metadata: r.metadata ?? {},
    usage: extra.usage ?? 0,
    fileUrl: extra.fileUrl ?? null,
    asset: extra.asset ?? null,
  };
}

export interface ListFilter {
  categories?: MediaCategory[];
  provider?: string;
  statuses?: MediaStatus[];
  sentenceIdx?: number;
  ids?: string[];
  limit?: number;
}

/** Items with usage counts, asset facts and signed URLs for storage-backed files. */
export async function listMediaItems(db: SupabaseClient, projectId: string, f: ListFilter = {}): Promise<MediaItem[]> {
  let q = db.from("media_items").select("*").eq("project_id", projectId).order("created_at", { ascending: false }).limit(f.limit ?? 500);
  if (f.categories?.length) q = q.in("category", f.categories);
  if (f.provider) q = q.eq("provider", f.provider);
  if (f.statuses?.length) q = q.in("status", f.statuses);
  if (f.sentenceIdx !== undefined) q = q.eq("sentence_idx", f.sentenceIdx);
  if (f.ids?.length) q = q.in("id", f.ids);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as MediaRow[];
  if (!rows.length) return [];

  const assetIds = [...new Set(rows.map((r) => r.asset_id).filter((x): x is string => Boolean(x)))];
  const [placements, assets] = await Promise.all([
    db.from("scene_assets").select("media_item_id, asset_id").eq("project_id", projectId),
    assetIds.length ? db.from("assets").select("id, type, width, height, rights_status, user_approved").in("id", assetIds) : Promise.resolve({ data: [] as { id: string; type: string; width: number | null; height: number | null; rights_status: string; user_approved: boolean }[] }),
  ]);
  const usage = (r: MediaRow) => (placements.data ?? []).filter((p) => p.media_item_id === r.id || (r.asset_id && p.asset_id === r.asset_id)).length;
  const assetOf = new Map((assets.data ?? []).map((a) => [a.id, a]));

  // Storage-backed files (uploads, captures): sign the file and its thumbnail for an hour.
  const paths = new Set<string>();
  for (const r of rows) {
    if (r.storage_path) paths.add(r.storage_path);
    const thumb = r.metadata?.thumbPath;
    if (typeof thumb === "string") paths.add(thumb);
  }
  const signed = new Map<string, string>();
  if (paths.size) {
    const { data: urls } = await db.storage.from(BUCKET).createSignedUrls([...paths], 3600);
    for (const u of urls ?? []) if (u.path && u.signedUrl) signed.set(u.path, u.signedUrl);
  }

  return rows.map((r) => {
    const a = r.asset_id ? assetOf.get(r.asset_id) : undefined;
    const fileUrl = r.storage_path ? (signed.get(r.storage_path) ?? null) : null;
    const thumbPath = typeof r.metadata?.thumbPath === "string" ? r.metadata.thumbPath : null;
    const isImage = r.category === "photo" || r.category === "screenshot" || a?.type === "photo" || a?.type === "gif";
    const thumbnailUrl = r.thumbnail_url ?? (thumbPath ? (signed.get(thumbPath) ?? null) : isImage ? fileUrl : null);
    const used = usage(r);
    // USED is derived (the item has clips on the timeline), so undo can never leave it stale.
    return rowToItem(used > 0 && r.status !== "REJECTED" ? { ...r, status: "USED" } : r.status === "USED" ? { ...r, status: "APPROVED" } : r, {
      usage: used,
      fileUrl,
      thumbnailUrl,
      asset: a ? { type: a.type, width: a.width, height: a.height, rightsStatus: a.rights_status, userApproved: a.user_approved } : null,
    });
  });
}

export interface NewItem {
  category: MediaCategory;
  provider: string;
  externalId: string | null;
  title: string;
  description?: string | null;
  excerpt?: string | null;
  sourceUrl?: string | null;
  platform?: string | null;
  account?: string | null;
  accountUrl?: string | null;
  publishedAt?: string | null;
  duration?: number | null;
  thumbnailUrl?: string | null;
  embed?: Embed | null;
  segment?: SegmentSuggestion | null;
  relevance?: Relevance | null;
  query?: string | null;
  sentenceIdx?: number | null;
  sceneKey?: string | null;
  license?: string | null;
  rightsNotes?: string | null;
  assetId?: string | null;
  storagePath?: string | null;
  derivedFrom?: string | null;
  metadata?: Record<string, unknown>;
  status?: MediaStatus;
  importedAt?: string | null;
}

const clip = (s: string | null | undefined, n: number) => (s == null ? null : s.slice(0, n));

function itemToRow(ctx: { userId: string; projectId: string }, it: NewItem) {
  return {
    project_id: ctx.projectId,
    user_id: ctx.userId,
    category: it.category,
    provider: it.provider,
    external_id: clip(it.externalId, 400),
    title: clip(it.title.trim() || "Untitled", 500)!,
    description: clip(it.description, 5000),
    excerpt: clip(it.excerpt, 5000),
    source_url: clip(it.sourceUrl, 2000),
    platform: clip(it.platform, 120),
    account: clip(it.account, 300),
    account_url: clip(it.accountUrl, 2000),
    published_at: it.publishedAt ?? null,
    duration: it.duration ?? null,
    thumbnail_url: clip(it.thumbnailUrl, 2000),
    embed: it.embed ?? null,
    segment: it.segment ?? null,
    relevance: it.relevance ?? null,
    query: clip(it.query, 500),
    sentence_idx: it.sentenceIdx ?? null,
    scene_key: it.sceneKey ?? null,
    license: clip(it.license, 300),
    rights_notes: clip(it.rightsNotes, 4000),
    asset_id: it.assetId ?? null,
    storage_path: it.storagePath ?? null,
    derived_from: it.derivedFrom ?? null,
    metadata: it.metadata ?? {},
    imported_at: it.importedAt ?? null,
    ...(it.status ? { status: it.status } : {}),
  };
}

/**
 * Save research results. Items already in the project (same provider + id) keep their status —
 * a rejected result stays rejected when the same search runs again — but get fresh metadata.
 */
export async function saveDiscovered(db: SupabaseClient, ctx: { userId: string; projectId: string }, items: NewItem[]): Promise<Map<string, MediaRow>> {
  const out = new Map<string, MediaRow>();
  const keyed = items.filter((i) => i.externalId);
  if (!keyed.length) return out;
  const { data: existing } = await db
    .from("media_items")
    .select("*")
    .eq("project_id", ctx.projectId)
    .in("external_id", keyed.map((i) => i.externalId!.slice(0, 400)));
  const have = new Map(((existing ?? []) as MediaRow[]).map((r) => [`${r.provider}|${r.external_id}`, r]));
  const fresh = keyed.filter((i) => !have.has(`${i.provider}|${i.externalId!.slice(0, 400)}`));
  if (fresh.length) {
    const { data, error } = await db.from("media_items").insert(fresh.map((i) => itemToRow(ctx, { ...i, status: i.status ?? "DISCOVERED" }))).select("*");
    if (error) throw new Error(`Saving research results failed: ${error.message}`);
    for (const r of (data ?? []) as MediaRow[]) out.set(`${r.provider}|${r.external_id}`, r);
  }
  for (const i of keyed) {
    const key = `${i.provider}|${i.externalId!.slice(0, 400)}`;
    const row = have.get(key);
    if (!row) continue;
    // Refresh what the platform reports (title, counts, thumbnail); keep the editor's decisions.
    const { status: _s, project_id: _p, user_id: _u, sentence_idx, ...meta } = itemToRow(ctx, i);
    void _s;
    void _p;
    void _u;
    const patch = { ...meta, sentence_idx: row.sentence_idx ?? sentence_idx, rights_notes: row.rights_notes, segment: row.segment ?? meta.segment, asset_id: row.asset_id ?? meta.asset_id, storage_path: row.storage_path ?? meta.storage_path };
    const { data } = await db.from("media_items").update(patch).eq("id", row.id).select("*").single();
    out.set(key, (data as MediaRow | null) ?? row);
  }
  return out;
}

export async function createItem(db: SupabaseClient, ctx: { userId: string; projectId: string }, it: NewItem): Promise<MediaRow> {
  const { data, error } = await db.from("media_items").insert(itemToRow(ctx, it)).select("*").single();
  if (error) throw new Error(`Saving media item failed: ${error.message}`);
  return data as MediaRow;
}

export async function getItemRow(db: SupabaseClient, projectId: string, id: string): Promise<MediaRow | null> {
  const { data } = await db.from("media_items").select("*").eq("project_id", projectId).eq("id", id).maybeSingle();
  return (data as MediaRow | null) ?? null;
}

export async function patchItem(db: SupabaseClient, row: MediaRow, p: MediaPatch): Promise<void> {
  const update: Record<string, unknown> = {};
  if (p.status) update.status = p.status;
  if (p.title !== undefined) update.title = p.title;
  if (p.rightsNotes !== undefined) update.rights_notes = p.rightsNotes;
  if (p.license !== undefined) update.license = p.license;
  if (p.category) update.category = p.category;
  if (p.sentenceIdx !== undefined) update.sentence_idx = p.sentenceIdx;
  if (p.segment !== undefined) update.segment = p.segment;
  if (p.rightsConfirmed !== undefined) update.metadata = { ...(row.metadata ?? {}), rightsConfirmed: p.rightsConfirmed, rightsConfirmedAt: p.rightsConfirmed ? new Date().toISOString() : null };
  if (Object.keys(update).length) {
    const { error } = await db.from("media_items").update(update).eq("id", row.id);
    if (error) throw new Error(error.message);
  }
  if (!row.asset_id) return;
  // Approval and the user's rights statement follow through to the renderable asset (render gate).
  const assetUpdate: Record<string, unknown> = {};
  if (p.status === "APPROVED" || p.status === "USED") assetUpdate.user_approved = true;
  if (p.status === "REJECTED") assetUpdate.user_approved = false;
  if (p.rightsConfirmed !== undefined && (row.provider === "upload" || row.provider === "capture")) {
    assetUpdate.rights_status = p.rightsConfirmed ? "CLEAR" : "USER_REVIEW";
    assetUpdate.license = p.rightsConfirmed ? "Rights confirmed by the project owner" : "User-provided — rights not confirmed";
    assetUpdate.rights_notes = p.rightsNotes ? [p.rightsNotes] : [];
  }
  if (Object.keys(assetUpdate).length) await db.from("assets").update(assetUpdate).eq("id", row.asset_id);
}
