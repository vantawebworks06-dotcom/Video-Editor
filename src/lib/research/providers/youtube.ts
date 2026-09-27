/**
 * YouTube Data API v3 — search and metadata only.
 *
 * Terms (YouTube API Services Developer Policies, checked Sept 2026): API clients must not
 * download, cache or store YouTube audiovisual content (III.E.1) nor separate its audio/video
 * (III.I.7); non-authorised metadata may be kept for at most 30 days (III.E.4). Captions of other
 * people's videos cannot be downloaded (captions.download needs edit rights). So: results are
 * previewed with the official embed player, a relevant section is *suggested* from the
 * uploader's chapter markers, and footage reaches the timeline only as a copy the user is
 * authorised to use (uploaded by them; the worker can transcribe that copy to find the moment).
 */
import { accountCredibility } from "../credibility";
import { decodeEntities, getJson } from "../http";
import { youtubeOEmbed } from "../platforms";
import { parseChapters, segmentFromChapters } from "../segments";
import { type Candidate, ResearchError, type ResearchProvider } from "../types";

const API = "https://www.googleapis.com/youtube/v3";

interface SearchItem {
  id: { videoId?: string };
}
interface Video {
  id: string;
  snippet: { title: string; description: string; channelTitle: string; channelId: string; publishedAt: string; thumbnails?: Record<string, { url: string }> };
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  status?: { embeddable?: boolean; privacyStatus?: string };
}

/** ISO 8601 duration (PT1H2M3S) → seconds. */
export function isoDuration(d: string | undefined): number | null {
  const m = d?.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

async function call<T>(path: string, params: Record<string, string>, key: string, signal?: AbortSignal): Promise<T> {
  try {
    return await getJson<T>("youtube", `${API}/${path}?${new URLSearchParams({ ...params, key })}`, { signal });
  } catch (e) {
    const err = e as ResearchError;
    if (err.code === "BAD_RESPONSE" && /api key not valid|keyInvalid/i.test(err.message)) throw new ResearchError("youtube", "INVALID_CREDENTIALS", "The YouTube API key is not valid.");
    if (err.code === "FORBIDDEN" && /has not been used|disabled|accessNotConfigured/i.test(err.message)) throw new ResearchError("youtube", "FORBIDDEN", "YouTube Data API v3 is not enabled for this key's Google Cloud project.");
    throw err;
  }
}

function toCandidate(v: Video, want?: { query: string; entities: string[]; sentence: string }): Candidate {
  const s = v.snippet;
  const duration = isoDuration(v.contentDetails?.duration);
  const chapters = parseChapters(s.description);
  const segment = want && chapters.length ? segmentFromChapters(chapters, duration, want) : null;
  const t = s.thumbnails ?? {};
  const embeddable = v.status?.embeddable !== false;
  return {
    provider: "youtube",
    externalId: v.id,
    category: /\b(interview|sits? down|podcast|speaks|talks|q ?& ?a|conversation)\b/i.test(s.title) ? "interview" : "video",
    title: decodeEntities(s.title),
    description: s.description ? s.description.slice(0, 2000) : null,
    excerpt: null,
    sourceUrl: `https://www.youtube.com/watch?v=${v.id}`,
    platform: "YouTube",
    account: s.channelTitle,
    accountUrl: `https://www.youtube.com/channel/${s.channelId}`,
    publishedAt: s.publishedAt,
    duration,
    thumbnailUrl: (t.maxres ?? t.high ?? t.medium ?? t.default)?.url ?? `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    embed: embeddable ? { kind: "youtube", videoId: v.id } : { kind: "none" },
    segment,
    license: `Standard YouTube licence${embeddable ? "" : " — embedding disabled by the owner"}. Not downloadable; use needs the rights holder's permission.`,
    metrics: { views: Number(v.statistics?.viewCount ?? NaN) || undefined, likes: Number(v.statistics?.likeCount ?? NaN) || undefined, comments: Number(v.statistics?.commentCount ?? NaN) || undefined },
    credibility: accountCredibility(s.channelTitle, []).score,
    chapters,
  };
}

async function videos(ids: string[], key: string, signal?: AbortSignal): Promise<Video[]> {
  if (!ids.length) return [];
  const r = await call<{ items?: Video[] }>("videos", { part: "snippet,contentDetails,statistics,status", id: ids.join(","), maxResults: "50" }, key, signal);
  return r.items ?? [];
}

export const youtube: ResearchProvider = {
  id: "youtube",
  name: "YouTube",
  categories: ["video", "interview"],
  capabilities: { search: true, preview: "embed", capture: false, import: "authorised-copy" },
  credentials: [{ key: "youtube", env: ["YOUTUBE_API_KEY"], label: "YouTube Data API v3 key (Google Cloud)", required: true }],
  docsUrl: "https://developers.google.com/youtube/v3/docs/search/list",
  terms: "Search + metadata + the official embed player only. YouTube's API policies forbid downloading/storing its video or audio and separating them; metadata is refreshed within 30 days. To use footage, upload a copy you are authorised to use.",
  limits: "search.list draws on the Search Queries quota bucket; videos.list costs 1 unit of the 10,000/day default quota.",
  configured: (c) => Boolean(c.youtube),
  async search(q, creds, signal) {
    const key = creds.youtube;
    const want = { query: q.query, entities: q.context?.entities ?? [], sentence: q.context?.sentence ?? q.query };
    if (!key) throw new ResearchError("youtube", "NOT_CONFIGURED", "Add a YouTube Data API key (YOUTUBE_API_KEY) in Settings → Integrations.");
    const r = await call<{ items?: SearchItem[] }>("search", { part: "snippet", type: "video", q: q.query, maxResults: String(Math.min(15, q.limit)), safeSearch: "none", relevanceLanguage: "en" }, key, signal);
    const ids = (r.items ?? []).map((i) => i.id.videoId).filter((x): x is string => Boolean(x));
    // Private/removed videos simply don't come back from videos.list.
    return (await videos(ids, key, signal)).filter((v) => v.status?.privacyStatus !== "private").map((v) => toCandidate(v, want));
  },
  async getMetadata(externalId, creds, signal) {
    if (!creds.youtube) {
      // Without a key: the public oEmbed still gives title/channel/thumbnail (no date/duration).
      const o = await youtubeOEmbed(externalId, signal);
      return toCandidate({ id: externalId, snippet: { title: o.title ?? "YouTube video", description: "", channelTitle: o.author_name ?? "", channelId: "", publishedAt: "" } });
    }
    const [v] = await videos([externalId], creds.youtube, signal);
    if (!v) throw new ResearchError("youtube", "NOT_FOUND", "The video was removed or made private.");
    return toCandidate(v);
  },
  getPreview: (c) => c.embed ?? { kind: "thumbnail", url: c.thumbnailUrl },
  getSource: (c) => ({ url: c.sourceUrl, label: "Open on YouTube" }),
  async test(creds) {
    if (!creds.youtube) return { state: "REQUIRES_CONFIGURATION", message: "No YOUTUBE_API_KEY. Create one in Google Cloud Console → APIs & Services (enable YouTube Data API v3)." };
    try {
      await videos(["dQw4w9WgXcQ"], creds.youtube);
      return { state: "CONNECTED", message: "OK — videos.list answered (1 quota unit)." };
    } catch (e) {
      const err = e as ResearchError;
      return { state: err.code === "QUOTA_EXCEEDED" || err.code === "RATE_LIMITED" ? "RATE_LIMITED" : err.code === "INVALID_CREDENTIALS" || err.code === "FORBIDDEN" ? "NOT_CONNECTED" : "UNAVAILABLE", message: err.message };
    }
  },
};
