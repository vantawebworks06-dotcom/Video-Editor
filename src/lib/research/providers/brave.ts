/**
 * Brave Search API — independent web index: web pages, news, images and videos.
 * (Google's Custom Search JSON API is closed to new customers and ends 1 Jan 2027; Bing's Search
 * APIs were retired in Aug 2025.) Pricing (Feb 2026): credit-based, ~$5 per 1,000 requests with
 * $5 of free credit per month; the key is sent in the X-Subscription-Token header.
 * Results are references: third-party pages and images keep their owners' rights.
 */
import type { MediaCategory } from "@/lib/analysis/types";
import { domainCredibility } from "../credibility";
import { decodeEntities, getJson, hostOf } from "../http";
import { platformOf } from "../platforms";
import { parseTimestamp } from "../segments";
import { type Candidate, ResearchError, type ResearchProvider } from "../types";

const BASE = "https://api.search.brave.com/res/v1";

interface Thumb {
  src?: string;
}
interface WebResult {
  title: string;
  url: string;
  description?: string;
  age?: string;
  page_age?: string;
  thumbnail?: Thumb;
  meta_url?: { hostname?: string };
  profile?: { name?: string };
  extra_snippets?: string[];
}
interface ImageResult {
  title: string;
  url: string;
  source?: string;
  thumbnail?: Thumb;
  properties?: { url?: string; width?: number; height?: number };
  page_fetched?: string;
}
interface VideoResult extends WebResult {
  video?: { duration?: string; creator?: string; publisher?: string };
}

type Mode = "web" | "news" | "images" | "videos";

function modeFor(c: MediaCategory): Mode {
  if (c === "article") return "news";
  if (c === "photo" || c === "screenshot") return "images";
  if (c === "video" || c === "interview") return "videos";
  return "web";
}

const clean = (s: string | undefined) => (s ? decodeEntities(s.replace(/<\/?strong>/g, "")).trim() : null);
const isoOrNull = (s: string | undefined) => (s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null);

function webCandidate(r: WebResult, category: MediaCategory): Candidate {
  const yt = platformOf(r.url);
  return {
    provider: "brave",
    externalId: r.url.slice(0, 400),
    category: yt.platform === "youtube" ? "video" : yt.platform === "x" || yt.platform === "reddit" || yt.platform === "facebook" || yt.platform === "instagram" ? "social" : category,
    title: clean(r.title) ?? r.url,
    description: clean(r.description),
    excerpt: r.extra_snippets?.length ? r.extra_snippets.map((x) => clean(x)).join(" … ").slice(0, 1200) : null,
    sourceUrl: r.url,
    platform: r.profile?.name ?? r.meta_url?.hostname ?? hostOf(r.url) ?? "Web",
    account: r.meta_url?.hostname ?? hostOf(r.url),
    accountUrl: null,
    publishedAt: isoOrNull(r.page_age),
    duration: null,
    thumbnailUrl: r.thumbnail?.src ?? null,
    embed: yt.platform === "youtube" && yt.id ? { kind: "youtube", videoId: yt.id } : yt.platform === "x" && yt.id ? { kind: "x", postId: yt.id } : null,
    segment: null,
    license: "© the publisher — reference/screenshot; reuse needs permission",
    credibility: domainCredibility(r.url).score,
  };
}

async function call<T>(mode: Mode, q: string, count: number, key: string, signal?: AbortSignal): Promise<T> {
  const params = new URLSearchParams({ q, count: String(count), safesearch: mode === "images" ? "strict" : "moderate", spellcheck: "1" });
  if (mode === "web") params.set("extra_snippets", "true");
  try {
    return await getJson<T>("brave", `${BASE}/${mode}/search?${params}`, { headers: { "X-Subscription-Token": key, "Accept-Encoding": "gzip" }, signal });
  } catch (e) {
    const err = e as ResearchError;
    if (err.code === "BAD_RESPONSE" && /subscription|token/i.test(err.message)) throw new ResearchError("brave", "INVALID_CREDENTIALS", "The Brave Search API key was rejected.");
    throw err;
  }
}

export const brave: ResearchProvider = {
  id: "brave",
  name: "Brave Search (web · news · images · videos)",
  categories: ["web", "article", "photo", "video", "interview", "document", "social"],
  capabilities: { search: true, preview: "thumbnail", capture: true, import: "authorised-copy" },
  credentials: [{ key: "brave", env: ["BRAVE_SEARCH_API_KEY"], label: "Brave Search API key", required: true }],
  docsUrl: "https://api-dashboard.search.brave.com/app/documentation",
  terms: "Web search results with links, snippets and thumbnails. Pages and images belong to their publishers: open, cite and capture for reference; reuse needs the owner's permission.",
  limits: "Credit-based: about $5 per 1,000 requests; $5 free credit each month; 50 requests/s.",
  configured: (c) => Boolean(c.brave),
  async search(q, creds, signal) {
    const key = creds.brave;
    if (!key) throw new ResearchError("brave", "NOT_CONFIGURED", "Add a Brave Search API key (BRAVE_SEARCH_API_KEY) in Settings → Integrations.");
    const mode = modeFor(q.category);
    const count = Math.min(mode === "images" ? 30 : 20, q.limit);
    if (mode === "images") {
      const r = await call<{ results?: ImageResult[] }>("images", q.query, count, key, signal);
      return (r.results ?? []).map((x) => ({
        provider: "brave" as const,
        externalId: (x.properties?.url ?? x.url).slice(0, 400),
        category: q.category === "screenshot" ? "screenshot" : ("photo" as MediaCategory),
        title: clean(x.title) ?? x.url,
        description: x.properties?.width ? `${x.properties.width}×${x.properties.height} · ${x.source ?? hostOf(x.url) ?? ""}` : (x.source ?? null),
        excerpt: null,
        sourceUrl: x.url,
        platform: x.source ?? hostOf(x.url) ?? "Web",
        account: hostOf(x.url),
        accountUrl: null,
        publishedAt: isoOrNull(x.page_fetched),
        duration: null,
        thumbnailUrl: x.thumbnail?.src ?? null,
        embed: null,
        segment: null,
        license: "© the image owner — rights unknown; ask the owner or use a licensed copy",
        credibility: domainCredibility(x.url).score,
      }));
    }
    if (mode === "videos") {
      const r = await call<{ results?: VideoResult[] }>("videos", q.query, count, key, signal);
      return (r.results ?? []).map((x) => {
        const c = webCandidate(x, q.category === "interview" ? "interview" : "video");
        const d = x.video?.duration ? parseTimestamp(x.video.duration) : null;
        return { ...c, category: q.category === "interview" ? "interview" : "video", duration: d, account: x.video?.creator ?? x.video?.publisher ?? c.account };
      });
    }
    const r = await call<{ results?: WebResult[]; web?: { results?: WebResult[] } }>(mode, q.query, count, key, signal);
    const list = mode === "news" ? (r.results ?? []) : (r.web?.results ?? []);
    return list.map((x) => webCandidate(x, mode === "news" ? "article" : q.category));
  },
  async getMetadata() {
    // Search results are identified by URL; refresh them through the link importer.
    return null;
  },
  getPreview: (c) => c.embed ?? { kind: "thumbnail", url: c.thumbnailUrl },
  getSource: (c) => ({ url: c.sourceUrl, label: `Open on ${c.platform}` }),
  async test(creds) {
    if (!creds.brave) return { state: "REQUIRES_CONFIGURATION", message: "No BRAVE_SEARCH_API_KEY. Get one at api-dashboard.search.brave.com (credit card required; $5 free credit/month)." };
    try {
      const r = await call<{ web?: { results?: unknown[] } }>("web", "documentary", 1, creds.brave);
      return { state: "CONNECTED", message: `OK — ${r.web?.results?.length ?? 0} test result(s) (1 request of credit used).` };
    } catch (e) {
      const err = e as ResearchError;
      return { state: err.code === "RATE_LIMITED" || err.code === "QUOTA_EXCEEDED" ? "RATE_LIMITED" : err.code === "INVALID_CREDENTIALS" ? "NOT_CONNECTED" : "UNAVAILABLE", message: err.message };
    }
  },
};
