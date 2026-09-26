import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AssetRef } from "@/lib/domain/types";
import { stableHash } from "@/lib/media/cache";
import { internetArchive } from "@/lib/media/providers";
import { USER_AGENT } from "@/lib/media/providers/http";
import { CARD_TEXTURE, GRAPHIC_URL_PREFIX } from "@/lib/pipeline/cards";
import { isAllowedMediaUrl, NETWORK_INPUT_ARGS, probe, runFfmpeg } from "./ffmpeg";
import { library } from "./library";

export interface PreparedAsset {
  path: string;
  kind: "image" | "video";
  width: number;
  height: number;
  duration: number | null;
  /** Transparent overlay (GIPHY sticker). */
  alpha: boolean;
}

export interface PrepareContext {
  cacheDir: string;
  /** Resolve uploaded/storage assets to a local file (worker downloads from Supabase Storage). */
  resolveLocal?: (ref: AssetRef) => Promise<string | null>;
  /**
   * Draft (960×540) render: prepare at draft size with a faster encode instead of up to 1920 px
   * (4× the pixels the draft uses). Cached separately from full-quality preparations.
   */
  draft?: boolean;
}

const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;
const PER_HOST_LIMIT = 2;
const hostActive = new Map<string, number>();
const hostQueue = new Map<string, (() => void)[]>();

/** Limit concurrent requests per host (media CDNs rate-limit bursts). */
async function withHostSlot<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const host = new URL(url).hostname;
  if ((hostActive.get(host) ?? 0) >= PER_HOST_LIMIT) {
    await new Promise<void>((r) => hostQueue.set(host, [...(hostQueue.get(host) ?? []), r]));
  }
  hostActive.set(host, (hostActive.get(host) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    hostActive.set(host, (hostActive.get(host) ?? 1) - 1);
    const next = hostQueue.get(host)?.shift();
    next?.();
  }
}

class RetryableError extends Error {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
  }
}

/** Retry transient failures (429/5xx/network) with backoff, honouring Retry-After. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const transient = err instanceof RetryableError || /429|HTTP 5\d\d|ECONNRESET|ETIMEDOUT|timed out|4XX Client Error/i.test((err as Error).message);
      if (!transient || i === attempts - 1) break;
      const wait = err instanceof RetryableError && err.retryAfterMs ? err.retryAfterMs : 1500 * 2 ** i;
      await new Promise((r) => setTimeout(r, Math.min(30_000, wait)));
    }
  }
  throw last;
}

async function download(url: string, dest: string): Promise<{ contentType: string }> {
  if (!isAllowedMediaUrl(url)) throw new Error(`Refusing to download from non-allow-listed host: ${new URL(url).hostname}`);
  return withRetry(() => withHostSlot(url, () => downloadOnce(url, dest)));
}

async function downloadOnce(url: string, dest: string): Promise<{ contentType: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(120_000),
    redirect: "follow",
  });
  if (res.status === 429 || res.status >= 500) {
    const ra = Number(res.headers.get("retry-after"));
    throw new RetryableError(`Download failed: HTTP ${res.status}`, Number.isFinite(ra) ? ra * 1000 : 0);
  }
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  if (res.url && !isAllowedMediaUrl(res.url)) throw new Error("Download redirected to a non-allow-listed host");
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_DOWNLOAD_BYTES) throw new Error(`File too large (${Math.round(len / 1e6)} MB)`);
  const tmp = `${dest}.part`;
  let received = 0;
  const limited = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream).on("data", (c: Buffer) => {
    received += c.length;
    if (received > MAX_DOWNLOAD_BYTES) limited.destroy(new Error("File exceeds download size limit"));
  });
  await pipeline(limited, createWriteStream(tmp));
  await rename(tmp, dest);
  return { contentType: res.headers.get("content-type") ?? "" };
}

async function resolveUrl(ref: AssetRef): Promise<string> {
  const provider = ref.assetId.split(":")[0];
  if (provider === "internet_archive" && !/\.(mp4|m4v|webm|ogv|mov|jpe?g|png|gif)$/i.test(new URL(ref.url).pathname)) {
    const id = ref.assetId.slice("internet_archive:".length);
    const full = await internetArchive.getAsset(id);
    if (!full || full.mediaUrl === ref.url) throw new Error(`No renderable file in Internet Archive item ${id}`);
    return full.mediaUrl;
  }
  return ref.url;
}

/**
 * Download and normalise one asset for rendering. Stills become ≤3840px JPEGs; video/GIF
 * becomes a trimmed H.264 clip. Results are cached by content key.
 */
export async function prepareAsset(
  ref: AssetRef,
  window: { trimStart: number; duration: number },
  ctx: PrepareContext,
): Promise<PreparedAsset> {
  await mkdir(ctx.cacheDir, { recursive: true });
  // Designed text cards: the texture is the picture; the text is drawn with the other overlays.
  if (ref.url.startsWith(GRAPHIC_URL_PREFIX)) {
    const kind = ref.url.slice(GRAPHIC_URL_PREFIX.length) as keyof typeof CARD_TEXTURE;
    const file = library.texture(CARD_TEXTURE[kind] ?? "dark_paper");
    const info = await probe(file);
    return { path: file, kind: "image", width: info.width ?? 1920, height: info.height ?? 1080, duration: null, alpha: false };
  }
  const local = (await ctx.resolveLocal?.(ref)) ?? ref.localPath;
  const isStill = ref.type === "photo";
  const isSticker = ref.type === "sticker";
  const draft = Boolean(ctx.draft);
  const key = stableHash({ url: local ?? ref.url, trim: isStill ? 0 : window.trimStart, dur: isStill ? 0 : Math.ceil(window.duration + 1), draft: draft || undefined });
  const maxStill = draft ? 1920 : 3840; // stills keep 2× headroom for zoom/pan motion
  const maxVideo = draft ? 960 : 1920;
  const out = path.join(ctx.cacheDir, `${key}.${isStill ? "jpg" : isSticker ? "gif" : "mp4"}`);

  if (!existsSync(out)) {
    let input = local;
    let tmpDownload: string | null = null;
    if (!input) {
      const url = await resolveUrl(ref);
      if (!isAllowedMediaUrl(url)) throw new Error("Media URL host is not allow-listed");
      if (isStill || isSticker) {
        tmpDownload = path.join(ctx.cacheDir, `${key}.src`);
        const { contentType } = await download(url, tmpDownload);
        if (contentType && !/^(image\/|application\/octet-stream|binary\/)/.test(contentType)) {
          await rm(tmpDownload, { force: true });
          throw new Error(`Unexpected content type ${contentType}`);
        }
        input = tmpDownload;
      } else {
        input = url; // stream directly; FFmpeg seeks with HTTP range requests
      }
    }

    const isUrl = /^https:\/\//.test(input);
    const net = isUrl ? [...NETWORK_INPUT_ARGS, "-rw_timeout", "30000000", "-user_agent", USER_AGENT] : [];
    try {
      if (isStill) {
        await runFfmpeg(["-i", input, "-vf", `scale='min(${maxStill},iw)':-2:flags=lanczos,format=yuvj420p`, "-frames:v", "1", "-q:v", "2", `${out}.tmp.jpg`], { timeoutMs: 120_000 });
        await rename(`${out}.tmp.jpg`, out);
      } else if (isSticker) {
        await rename(input, out);
        tmpDownload = null;
      } else {
        const seek = window.trimStart > 0 ? ["-ss", window.trimStart.toFixed(3)] : [];
        const encode = (src: string) =>
          withRetry(() => withHostSlot(isUrl ? src : "https://local.invalid", () => runFfmpeg(
            [
              ...net, ...seek, "-i", src, "-t", (window.duration + 1).toFixed(3), "-an",
              "-vf", `scale='min(${maxVideo},iw)':-2:flags=bicubic,fps=30,format=yuv420p`,
              "-c:v", "libx264", "-preset", draft ? "ultrafast" : "veryfast", "-crf", draft ? "21" : "19", `${out}.tmp.mp4`,
            ],
            { timeoutMs: 5 * 60_000 },
          )));
        // Drafts stream the provider's smaller rendition of the same video (Pexels 1080p file:
        // 16 MB vs 2.5 MB), falling back to the full file if that rendition fails.
        const small = draft && isUrl && ref.draftUrl && isAllowedMediaUrl(ref.draftUrl) ? ref.draftUrl : null;
        if (small) await encode(small).catch(() => encode(input));
        else await encode(input);
        await rename(`${out}.tmp.mp4`, out);
      }
    } finally {
      if (tmpDownload) await rm(tmpDownload, { force: true });
    }
  }

  const info = await probe(out);
  if (!info.hasVideo || !info.width || !info.height) {
    await rm(out, { force: true });
    throw new Error("Prepared asset has no decodable image/video stream");
  }
  if (!isStill && (info.duration ?? 0) < 0.2) {
    await rm(out, { force: true });
    throw new Error("Prepared video is empty");
  }
  const size = (await stat(out)).size;
  if (size < 500) throw new Error("Prepared asset is suspiciously small");
  return {
    path: out,
    kind: isStill ? "image" : "video",
    width: info.width,
    height: info.height,
    duration: isStill ? null : info.duration,
    alpha: isSticker,
  };
}
