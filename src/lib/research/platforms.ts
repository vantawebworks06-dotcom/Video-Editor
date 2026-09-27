/**
 * Recognise platform URLs and read their public oEmbed metadata (the platforms' own, documented
 * embedding endpoints). Keyless for YouTube and X; Meta requires an approved app token.
 */
import { decodeEntities, getJson } from "./http";
import { ResearchError } from "./types";

export type Platform = "youtube" | "x" | "reddit" | "facebook" | "instagram" | "tiktok" | "web";

export function platformOf(raw: string): { platform: Platform; id: string | null } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { platform: "web", id: null };
  }
  const host = u.hostname.replace(/^(www|m|mobile)\./, "");
  if (host === "youtu.be") return { platform: "youtube", id: u.pathname.slice(1).split("/")[0] || null };
  if (host === "youtube.com" || host === "music.youtube.com" || host === "youtube-nocookie.com") {
    const id = u.searchParams.get("v") ?? u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,20})/)?.[1] ?? null;
    return { platform: "youtube", id };
  }
  if (host === "x.com" || host === "twitter.com") return { platform: "x", id: u.pathname.match(/\/status(?:es)?\/(\d{5,25})/)?.[1] ?? null };
  if (host.endsWith("reddit.com") || host === "redd.it") return { platform: "reddit", id: u.pathname.match(/\/comments\/([a-z0-9]+)/i)?.[1] ?? null };
  if (host.endsWith("facebook.com") || host === "fb.watch") return { platform: "facebook", id: null };
  if (host.endsWith("instagram.com")) return { platform: "instagram", id: u.pathname.match(/\/(?:p|reel|tv)\/([\w-]+)/)?.[1] ?? null };
  if (host.endsWith("tiktok.com")) return { platform: "tiktok", id: u.pathname.match(/\/video\/(\d+)/)?.[1] ?? null };
  return { platform: "web", id: null };
}

export interface OEmbed {
  title?: string;
  author_name?: string;
  author_url?: string;
  thumbnail_url?: string;
  html?: string;
  provider_name?: string;
}

export async function youtubeOEmbed(videoId: string, signal?: AbortSignal): Promise<OEmbed> {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
  return getJson<OEmbed>("youtube", url, { signal }).catch((e: ResearchError) => {
    // oEmbed answers 401/403 for private or embedding-disabled videos, 404 for removed ones.
    if (e.code === "INVALID_CREDENTIALS" || e.code === "FORBIDDEN") throw new ResearchError("youtube", "FORBIDDEN", "This video is private or its owner has disabled embedding.");
    throw e;
  });
}

/** Public post through X's official oEmbed (keyless): author, text and date as X renders them. */
export async function xOEmbed(url: string, signal?: AbortSignal): Promise<{ author: string | null; authorUrl: string | null; text: string; date: string | null; html: string }> {
  const target = `https://publish.x.com/oembed?omit_script=1&dnt=true&url=${encodeURIComponent(url.replace("twitter.com", "x.com"))}`;
  const j = await getJson<OEmbed>("x", target, { signal }).catch((e: ResearchError) => {
    if (e.code === "NOT_FOUND" || e.code === "FORBIDDEN" || e.code === "BAD_RESPONSE") throw new ResearchError("x", "NOT_FOUND", "The post is unavailable (deleted, from a protected account, or not public).");
    throw e;
  });
  const html = j.html ?? "";
  const para = html.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
  const text = decodeEntities(para.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "")).trim();
  const date = html.match(/<a[^>]*>([A-Z][a-z]+ \d{1,2}, \d{4})<\/a>\s*<\/blockquote>/)?.[1] ?? null;
  return { author: j.author_name ?? null, authorUrl: j.author_url ?? null, text, date: date ? new Date(`${date} 12:00 UTC`).toISOString() : null, html };
}

/** Meta oEmbed Read (Facebook/Instagram) — needs an app token from an app that passed App Review. */
export async function metaOEmbed(url: string, platform: "facebook" | "instagram", token: string, signal?: AbortSignal): Promise<OEmbed> {
  const isVideo = /\/videos?\/|fb\.watch|\/reel\//.test(url);
  const endpoint = platform === "instagram" ? "instagram_oembed" : isVideo ? "oembed_video" : "oembed_post";
  const version = process.env.META_GRAPH_VERSION?.match(/^v\d+\.\d+$/)?.[0] ?? "v25.0";
  const target = `https://graph.facebook.com/${version}/${endpoint}?omitscript=true&url=${encodeURIComponent(url)}&access_token=${encodeURIComponent(token)}`;
  return getJson<OEmbed>("meta", target, { signal });
}

/** OpenGraph / Twitter-card / article metadata of an HTML page. */
export function pageMeta(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const head = html.slice(0, 400_000);
  for (const m of head.matchAll(/<meta\s+[^>]*>/gi)) {
    const tag = m[0];
    const key = tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1];
    if (key && content && !out[key]) out[key] = decodeEntities(content).trim();
  }
  const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title && !out.title) out.title = decodeEntities(title.replace(/\s+/g, " ")).trim();
  const canonical = head.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1];
  if (canonical) out.canonical = canonical;
  // JSON-LD datePublished / author (news sites).
  for (const m of head.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1]!) as Record<string, unknown> | Record<string, unknown>[];
      for (const node of (Array.isArray(j) ? j : [j, ...(((j as { "@graph"?: unknown[] })["@graph"] as Record<string, unknown>[]) ?? [])]) as Record<string, unknown>[]) {
        if (node.datePublished && !out["article:published_time"]) out["article:published_time"] = String(node.datePublished);
        const a = node.author as { name?: string } | { name?: string }[] | undefined;
        const name = Array.isArray(a) ? a[0]?.name : a?.name;
        if (name && !out.author) out.author = String(name);
      }
    } catch {
      // malformed JSON-LD is common; ignore it
    }
  }
  return out;
}
