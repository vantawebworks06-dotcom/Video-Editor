import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiResponseCache } from "@/lib/ai/claude/client";
import type { UsageRecord, UsageSink } from "@/lib/ai/claude/usage";
import {
  type NormalizedAsset,
  NormalizedAsset as NormalizedAssetSchema,
  type ScenePlan,
  ScenePlan as ScenePlanSchema,
} from "@/lib/domain/types";
import { type CachedSearch, type SearchCache, searchCacheTtlMs, stableHash } from "@/lib/media/cache";
import type { GenerateResult, SceneSelection } from "@/lib/pipeline/generate";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Caches (service role)
// ---------------------------------------------------------------------------

export class SupabaseSearchCache implements SearchCache {
  constructor(private db: SupabaseClient) {}
  async get(key: string): Promise<CachedSearch | null> {
    const { data } = await this.db.from("search_cache").select("provider, query, results, created_at").eq("cache_key", key).maybeSingle();
    if (!data) return null;
    const ts = new Date(data.created_at).getTime();
    if (Date.now() - ts > searchCacheTtlMs(data.provider)) return null;
    return { provider: data.provider, query: data.query, results: data.results as NormalizedAsset[], timestamp: ts };
  }
  async set(key: string, v: CachedSearch) {
    await this.db.from("search_cache").upsert({
      cache_key: key,
      provider: v.provider,
      query: v.query,
      results: v.results,
      created_at: new Date(v.timestamp).toISOString(),
    });
  }
}

export class SupabaseAiCache implements AiResponseCache {
  constructor(private db: SupabaseClient) {}
  async get(fn: string, key: string) {
    const { data } = await this.db.from("ai_responses").select("response").eq("fn", fn).eq("input_hash", key).maybeSingle();
    return data?.response ?? null;
  }
  async set(fn: string, key: string, value: unknown, meta: { model: string }) {
    await this.db.from("ai_responses").upsert({ fn, input_hash: key, model: meta.model, response: value });
  }
}

export function usageSink(db: SupabaseClient, userId: string, projectId: string | null): UsageSink {
  return {
    async record(r: UsageRecord) {
      await db.from("ai_usage_events").insert({
        user_id: userId,
        project_id: projectId,
        fn: r.fn,
        model: r.model,
        input_tokens: r.inputTokens,
        output_tokens: r.outputTokens,
        cache_read_tokens: r.cacheReadTokens,
        cache_write_tokens: r.cacheWriteTokens,
        cost_usd: r.costUsd,
        cached: r.cached,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export interface AssetRow {
  id: string;
  provider: string;
  provider_asset_id: string;
  type: NormalizedAsset["type"];
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  media_url: string;
  preview_url: string | null;
  download_url: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  author: string | null;
  author_url: string | null;
  source_url: string;
  license: string;
  license_url: string | null;
  attribution: string | null;
  attribution_required: boolean;
  rights_status: NormalizedAsset["rightsStatus"];
  rights_notes: string[];
  user_approved: boolean;
  is_favorite: boolean;
  archival: boolean;
  metadata: { date?: string | null; categories?: string[]; score?: number } | null;
  storage_path: string | null;
  retrieved_at: string;
}

export function assetRowToNormalized(r: AssetRow): NormalizedAsset {
  return {
    id: `${r.provider}:${r.provider_asset_id}`,
    provider: r.provider as NormalizedAsset["provider"],
    providerAssetId: r.provider_asset_id,
    type: r.type,
    title: r.title,
    description: r.description,
    thumbnailUrl: r.thumbnail_url,
    mediaUrl: r.media_url,
    previewUrl: r.preview_url,
    downloadUrl: r.download_url,
    width: r.width,
    height: r.height,
    duration: r.duration === null ? null : Number(r.duration),
    author: r.author,
    authorUrl: r.author_url,
    sourceUrl: r.source_url,
    license: r.license,
    licenseUrl: r.license_url,
    attribution: r.attribution,
    attributionRequired: r.attribution_required,
    rightsStatus: r.rights_status,
    rightsNotes: r.rights_notes ?? [],
    retrievedAt: r.retrieved_at,
    date: r.metadata?.date ?? null,
    categories: r.metadata?.categories ?? [],
    archival: r.archival,
    score: r.metadata?.score ?? 0,
  };
}

function normalizedToRow(userId: string, a: NormalizedAsset) {
  return {
    user_id: userId,
    provider: a.provider,
    provider_asset_id: a.providerAssetId,
    type: a.type,
    title: a.title.slice(0, 500),
    description: a.description?.slice(0, 2000) ?? null,
    thumbnail_url: a.thumbnailUrl,
    media_url: a.mediaUrl,
    preview_url: a.previewUrl,
    download_url: a.downloadUrl,
    width: a.width,
    height: a.height,
    duration: a.duration,
    author: a.author?.slice(0, 300) ?? null,
    author_url: a.authorUrl,
    source_url: a.sourceUrl,
    license: a.license.slice(0, 300),
    license_url: a.licenseUrl,
    attribution: a.attribution?.slice(0, 600) ?? null,
    attribution_required: a.attributionRequired,
    rights_status: a.rightsStatus,
    rights_notes: a.rightsNotes,
    archival: a.archival,
    metadata: { date: a.date, categories: a.categories.slice(0, 30), score: a.score },
    retrieved_at: a.retrievedAt,
  };
}

/** Upsert assets (licence info kept permanently) and return DB ids keyed by normalized id. */
export async function upsertAssets(db: SupabaseClient, userId: string, assets: NormalizedAsset[]): Promise<Map<string, string>> {
  const unique = [...new Map(assets.map((a) => [a.id, a])).values()];
  const ids = new Map<string, string>();
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const { data, error } = await db
      .from("assets")
      .upsert(chunk.map((a) => normalizedToRow(userId, a)), { onConflict: "user_id,provider,provider_asset_id" })
      .select("id, provider, provider_asset_id");
    if (error) throw new Error(`Saving assets failed: ${error.message}`);
    for (const r of data ?? []) ids.set(`${r.provider}:${r.provider_asset_id}`, r.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Scenes + placements
// ---------------------------------------------------------------------------

export async function saveGeneration(
  db: SupabaseClient,
  ctx: { userId: string; projectId: string },
  result: Pick<GenerateResult, "plans" | "selections">,
  onlySceneIds?: Set<string>,
) {
  const plans = onlySceneIds ? result.plans.filter((p) => onlySceneIds.has(p.sceneId)) : result.plans;
  const selections = onlySceneIds ? result.selections.filter((s) => onlySceneIds.has(s.sceneId)) : result.selections;
  // The asset library upsert doesn't depend on the scene writes, so it runs alongside them.
  const assetIdsPending = upsertAssets(db, ctx.userId, selections.map((s) => s.asset));
  assetIdsPending.catch(() => undefined); // awaited below

  if (!onlySceneIds) {
    const { error } = await db.from("scenes").delete().eq("project_id", ctx.projectId);
    if (error) throw new Error(`Clearing scenes failed: ${error.message}`);
  }

  const sceneRows = plans.map((p) => ({
    project_id: ctx.projectId,
    user_id: ctx.userId,
    idx: result.plans.indexOf(p),
    scene_key: p.sceneId,
    start_time: p.startTime,
    end_time: p.endTime,
    narration: p.narration,
    importance: p.importance,
    visual_strategy: p.visualStrategy,
    plan: p,
    content_hash: stableHash(p),
  }));
  const { data: scenes, error: sErr } = await db
    .from("scenes")
    .upsert(sceneRows, { onConflict: "project_id,scene_key" })
    .select("id, scene_key");
  if (sErr) throw new Error(`Saving scenes failed: ${sErr.message}`);
  const sceneIds = new Map((scenes ?? []).map((s) => [s.scene_key as string, s.id as string]));

  if (onlySceneIds) {
    await db.from("scene_assets").delete().in("scene_id", [...sceneIds.values()]);
  }

  const assetIds = await assetIdsPending;
  const rows = selections.map((s, i) => selectionToRow(ctx, s, sceneIds.get(s.sceneId)!, assetIds.get(s.asset.id)!, i));
  if (rows.length) {
    const { error } = await db.from("scene_assets").insert(rows);
    if (error) throw new Error(`Saving timeline placements failed: ${error.message}`);
  }
}

export function selectionToRow(ctx: { userId: string; projectId: string }, s: SceneSelection, sceneId: string, assetId: string, position: number) {
  return {
    project_id: ctx.projectId,
    scene_id: sceneId,
    asset_id: assetId,
    user_id: ctx.userId,
    clip_key: s.clipId,
    position,
    role: s.role,
    start_time: s.start,
    duration: s.duration,
    trim_start: s.trimStart,
    need_type: s.needType,
    need_description: s.needDescription,
    queries: s.queries,
    layout: s.layout,
    motion: { type: s.motion, intensity: s.motionIntensity },
    treatment: { blackAndWhite: s.blackAndWhite, grain: s.blackAndWhite },
    annotations: s.annotations,
    alternates: s.alternates,
    scores: s.scores,
    overall_score: s.overall,
    reason: s.reason,
    selected_by: s.selectedBy,
  };
}

const MotionJson = z.object({ type: z.string(), intensity: z.number() });

export interface LoadedEdit {
  plans: ScenePlan[];
  selections: (SceneSelection & { rowId: string; assetRowId: string; userApproved: boolean })[];
}

const PLACEMENT_COLUMNS =
  "id, clip_key, start_time, duration, need_type, need_description, queries, scores, overall_score, reason, role, selected_by, layout, motion, treatment, annotations, trim_start, scenes!inner(scene_key), assets!inner(*)";

/**
 * Load plans + placements from the DB, re-validating JSON before it can reach the renderer.
 * `alternates: false` skips each clip's fallback candidates (only the renderer needs them;
 * they are most of the payload), returning empty lists instead.
 */
export async function loadEdit(db: SupabaseClient, projectId: string, opts: { alternates?: boolean } = {}): Promise<LoadedEdit> {
  const withAlternates = opts.alternates ?? true;
  const [{ data: scenes, error }, { data: placed, error: pErr }] = await Promise.all([
    db.from("scenes").select("scene_key, plan").eq("project_id", projectId).order("idx"),
    db
      .from("scene_assets")
      .select(withAlternates ? `${PLACEMENT_COLUMNS}, alternates` : PLACEMENT_COLUMNS)
      .eq("project_id", projectId)
      .order("start_time"),
  ]);
  if (error) throw new Error(error.message);
  if (pErr) throw new Error(pErr.message);
  const plans = (scenes ?? []).map((s) => ScenePlanSchema.parse(s.plan));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped client; the select string is dynamic
  const selections = ((placed ?? []) as any[]).map((r) => {
    const motion = MotionJson.parse(r.motion);
    const asset = assetRowToNormalized(r.assets as AssetRow);
    return {
      rowId: r.id as string,
      assetRowId: (r.assets as AssetRow).id,
      userApproved: (r.assets as AssetRow).user_approved,
      clipId: r.clip_key as string,
      sceneId: (r.scenes as { scene_key: string }).scene_key,
      start: Number(r.start_time),
      duration: Number(r.duration),
      needType: r.need_type,
      needDescription: r.need_description ?? "",
      queries: r.queries ?? [],
      asset,
      alternates: withAlternates ? z.array(NormalizedAssetSchema).catch([]).parse(r.alternates) : [],
      scores: r.scores,
      overall: r.overall_score === null ? null : Number(r.overall_score),
      reason: r.reason ?? "",
      role: r.role,
      selectedBy: r.selected_by,
      layout: r.layout,
      motion: motion.type,
      motionIntensity: motion.intensity,
      blackAndWhite: Boolean(r.treatment?.blackAndWhite),
      annotations: r.annotations ?? [],
      trimStart: Number(r.trim_start),
    } as LoadedEdit["selections"][number];
  });
  return { plans, selections };
}
