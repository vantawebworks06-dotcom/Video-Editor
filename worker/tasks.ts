/**
 * Short background tasks run by the worker between generation/render jobs: measuring imported
 * media (dimensions, duration, thumbnail), capturing sources, processing narration audio.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { probe, runFfmpeg } from "@/lib/render/ffmpeg";

export interface TaskDeps {
  db: SupabaseClient;
  root: string;
  downloadObject: (objectPath: string) => Promise<string>;
  uploadFile: (local: string, objectPath: string, contentType: string) => Promise<void>;
  progress: (stage: string, p: number) => Promise<void>;
  log: (m: string) => void;
  signal: AbortSignal;
}

export interface TaskJob {
  id: string;
  project_id: string;
  user_id: string;
  kind?: string;
  payload?: Record<string, unknown>;
}

/** Probe an uploaded file and record what it is; videos get a thumbnail. */
export async function importMedia(job: TaskJob, d: TaskDeps) {
  const itemId = typeof job.payload?.itemId === "string" ? job.payload.itemId : null;
  if (!itemId) throw new Error("import_media: missing itemId");
  const { data: item } = await d.db.from("media_items").select("id, project_id, storage_path, asset_id, metadata, category").eq("id", itemId).eq("project_id", job.project_id).maybeSingle();
  if (!item?.storage_path) throw new Error("The imported file no longer exists.");
  await d.progress("Measuring imported file…", 0.1);
  const local = await d.downloadObject(item.storage_path);
  const info = await probe(local).catch(() => null);
  if (!info || (!info.hasVideo && !info.hasAudio)) {
    await d.db.from("media_items").update({ status: "REJECTED", metadata: { ...(item.metadata ?? {}), importError: "The file could not be decoded (corrupt or unsupported codec)." } }).eq("id", item.id);
    throw new Error("The imported file could not be decoded — it may be corrupt or use an unsupported codec.");
  }
  const meta: Record<string, unknown> = { ...(item.metadata ?? {}), width: info.width, height: info.height, hasAudio: info.hasAudio, hasVideo: info.hasVideo };
  const isVideo = info.hasVideo && (info.duration ?? 0) > 0.5 && item.category !== "photo" && item.category !== "screenshot";

  if (isVideo) {
    await d.progress("Making thumbnail…", 0.5);
    const dir = path.join(d.root, "thumbs");
    await mkdir(dir, { recursive: true });
    const thumb = path.join(dir, `${item.id}.jpg`);
    if (!existsSync(thumb)) {
      const at = Math.min(2, (info.duration ?? 1) / 3);
      await runFfmpeg(["-ss", at.toFixed(2), "-i", local, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", thumb]);
    }
    const thumbPath = `${job.project_id}/thumbnails/${item.id}.jpg`;
    await d.uploadFile(thumb, thumbPath, "image/jpeg");
    meta.thumbPath = thumbPath;
  }
  await d.db.from("media_items").update({ duration: isVideo || !info.hasVideo ? info.duration : null, metadata: meta }).eq("id", item.id);
  if (item.asset_id) {
    await d.db.from("assets").update({ width: info.width, height: info.height, duration: isVideo ? info.duration : null }).eq("id", item.asset_id);
  }
  d.log(`imported ${item.storage_path}: ${info.width}x${info.height} ${info.duration?.toFixed(1)}s audio=${info.hasAudio}`);
  return { itemId: item.id, width: info.width, height: info.height, duration: info.duration, hasAudio: info.hasAudio };
}

const CAPTURABLE = new Set(["x", "reddit", "meta", "brave", "gdelt", "wikipedia", "url"]);

/** Screenshot a public source (official embed for posts, page visit for articles) into the library. */
export async function captureTask(job: TaskJob, d: TaskDeps) {
  const itemId = typeof job.payload?.itemId === "string" ? job.payload.itemId : null;
  const theme = job.payload?.theme === "dark" ? "dark" : "light";
  const mode = job.payload?.mode === "page" ? "page" : "auto";
  if (!itemId) throw new Error("capture: missing itemId");
  const { data: item } = await d.db.from("media_items").select("*").eq("id", itemId).eq("project_id", job.project_id).maybeSingle();
  if (!item) throw new Error("The source to capture no longer exists.");
  if (!item.source_url) throw new Error("This item has no source URL to capture.");
  if (!CAPTURABLE.has(item.provider)) throw new Error(`Capturing ${item.platform ?? item.provider} content is not offered (its terms don't allow copying it). Upload an authorised copy instead.`);
  await d.progress("Opening the source in a headless browser…", 0.15);
  const { captureSource } = await import("@/lib/capture/capture");
  const dir = path.join(d.root, "captures");
  await mkdir(dir, { recursive: true });
  const out = path.join(dir, `${job.id}.png`);
  const r = await captureSource(
    { title: item.title, sourceUrl: item.source_url, platform: item.platform, account: item.account, publishedAt: item.published_at, embed: item.embed },
    out,
    { theme, mode, signal: d.signal, log: d.log },
  );
  await d.progress("Saving the screenshot…", 0.8);
  const objectPath = `${job.project_id}/assets/capture-${crypto.randomUUID()}.png`;
  await d.uploadFile(out, objectPath, "image/png");
  const license = `Screenshot of a public ${item.platform ?? "web"} page — © the author/publisher. Reference/commentary use; review before publishing.`;
  const { data: asset, error: aErr } = await d.db
    .from("assets")
    .insert({
      user_id: job.user_id,
      provider: "capture",
      provider_asset_id: objectPath,
      type: "photo",
      title: `Screenshot: ${item.title}`.slice(0, 500),
      description: item.excerpt ?? item.description,
      media_url: `storage:${objectPath}`,
      download_url: `storage:${objectPath}`,
      width: r.width,
      height: r.height,
      author: item.account,
      author_url: item.account_url,
      source_url: item.source_url,
      license,
      rights_status: "USER_REVIEW",
      rights_notes: ["Captured screenshot of a third-party post/page"],
      retrieved_at: r.capturedAt,
      metadata: { categories: ["capture", r.method], date: item.published_at },
    })
    .select("id")
    .single();
  if (aErr) throw new Error(aErr.message);
  const { data: created, error: mErr } = await d.db
    .from("media_items")
    .insert({
      project_id: job.project_id,
      user_id: job.user_id,
      status: "REVIEW",
      category: "screenshot",
      provider: "capture",
      external_id: objectPath,
      title: `Screenshot: ${item.title}`.slice(0, 500),
      description: item.description,
      excerpt: item.excerpt,
      source_url: item.source_url,
      platform: item.platform,
      account: item.account,
      account_url: item.account_url,
      published_at: item.published_at,
      imported_at: r.capturedAt,
      sentence_idx: item.sentence_idx,
      scene_key: item.scene_key,
      license,
      asset_id: asset.id,
      storage_path: objectPath,
      derived_from: item.id,
      metadata: { capturedAt: r.capturedAt, method: r.method, theme, width: r.width, height: r.height },
    })
    .select("id")
    .single();
  if (mErr) throw new Error(mErr.message);
  d.log(`captured ${item.source_url} via ${r.method} → ${objectPath} (${r.width}x${r.height})`);
  return { itemId: created.id, method: r.method, width: r.width, height: r.height };
}
