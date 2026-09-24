import type { NormalizedAsset } from "@/lib/domain/types";
import { BaseProvider, orientationOf } from "./base";
import { fetchJson } from "./http";
import { assetId, type ProviderCredentials, type SearchParams, type SearchResult } from "./types";

// https://pixabay.com/api/docs/
const API = "https://pixabay.com/api";
const LICENSE = "Pixabay Content License";
const LICENSE_URL = "https://pixabay.com/service/license-summary/";

export const PIXABAY_CATEGORIES = [
  "backgrounds", "fashion", "nature", "science", "education", "feelings", "health", "people", "religion",
  "places", "animals", "industry", "computer", "food", "sports", "transportation", "travel", "buildings",
  "business", "music",
] as const;

interface PixabayImage {
  id: number;
  pageURL: string;
  tags: string;
  previewURL: string;
  webformatURL: string;
  largeImageURL: string;
  imageWidth: number;
  imageHeight: number;
  user: string;
  user_id: number;
}
interface PixabayVideoRendition {
  url: string;
  width: number;
  height: number;
  thumbnail?: string;
}
interface PixabayVideo {
  id: number;
  pageURL: string;
  tags: string;
  duration: number;
  user: string;
  user_id: number;
  videos: Partial<Record<"large" | "medium" | "small" | "tiny", PixabayVideoRendition>>;
}
interface PixabayResponse<T> {
  totalHits: number;
  hits: T[];
}

function common(user: string, userId: number, pageURL: string) {
  return {
    author: user,
    authorUrl: `https://pixabay.com/users/${encodeURIComponent(user)}-${userId}/`,
    sourceUrl: pageURL,
    license: LICENSE,
    licenseUrl: LICENSE_URL,
    attributionRequired: false,
    rightsStatus: "CLEAR" as const,
    rightsNotes: ["Pixabay Content License: free to use; source is credited in-app."],
    retrievedAt: new Date().toISOString(),
    date: null,
    archival: false,
    score: 0,
  };
}

export class PixabayProvider extends BaseProvider {
  readonly id = "pixabay" as const;
  readonly name = "Pixabay";
  readonly requiresKey = true;

  supportsImages() {
    return true;
  }
  supportsVideo() {
    return true;
  }
  isConfigured(creds: ProviderCredentials) {
    return Boolean(creds.pixabay);
  }

  private image(h: PixabayImage): NormalizedAsset {
    return {
      id: assetId("pixabay", `image-${h.id}`),
      provider: "pixabay",
      providerAssetId: `image-${h.id}`,
      type: "photo",
      title: h.tags || "Pixabay image",
      description: h.tags,
      thumbnailUrl: h.webformatURL,
      mediaUrl: h.largeImageURL,
      previewUrl: h.webformatURL,
      downloadUrl: h.largeImageURL,
      width: h.imageWidth,
      height: h.imageHeight,
      duration: null,
      attribution: `Image by ${h.user} from Pixabay`,
      categories: h.tags.split(",").map((t) => t.trim()).filter(Boolean),
      ...common(h.user, h.user_id, h.pageURL),
    };
  }

  private video(v: PixabayVideo): NormalizedAsset {
    const best = v.videos.large?.url ? v.videos.large : v.videos.medium?.url ? v.videos.medium : v.videos.small;
    const preview = v.videos.small?.url ? v.videos.small : v.videos.tiny;
    const thumb = v.videos.medium?.thumbnail ?? v.videos.large?.thumbnail ?? v.videos.small?.thumbnail ?? null;
    return {
      id: assetId("pixabay", `video-${v.id}`),
      provider: "pixabay",
      providerAssetId: `video-${v.id}`,
      type: "video",
      title: v.tags || "Pixabay video",
      description: v.tags,
      thumbnailUrl: thumb,
      mediaUrl: best?.url ?? v.pageURL,
      previewUrl: preview?.url ?? null,
      downloadUrl: best?.url ?? v.pageURL,
      width: best?.width || null,
      height: best?.height || null,
      duration: v.duration,
      attribution: `Video by ${v.user} from Pixabay`,
      categories: v.tags.split(",").map((t) => t.trim()).filter(Boolean),
      ...common(v.user, v.user_id, v.pageURL),
    };
  }

  private query(params: SearchParams, key: string) {
    const q = new URLSearchParams({
      key,
      q: params.query.slice(0, 100),
      page: String(params.page ?? 1),
      per_page: String(Math.min(Math.max(params.perPage ?? 15, 3), 200)),
      safesearch: "true",
    });
    if (params.category) q.set("category", params.category);
    if (params.minWidth) q.set("min_width", String(params.minWidth));
    return q;
  }

  async searchImages(params: SearchParams, creds: ProviderCredentials): Promise<SearchResult> {
    const q = this.query(params, this.requireKey(creds.pixabay));
    q.set("image_type", "photo");
    if (params.orientation === "landscape") q.set("orientation", "horizontal");
    if (params.orientation === "portrait") q.set("orientation", "vertical");
    const data = await fetchJson<PixabayResponse<PixabayImage>>(this.id, `${API}/?${q}`);
    const page = params.page ?? 1;
    return {
      assets: data.hits.map((h) => this.image(h)),
      page,
      hasMore: page * (params.perPage ?? 15) < data.totalHits,
    };
  }

  async searchVideos(params: SearchParams, creds: ProviderCredentials): Promise<SearchResult> {
    const q = this.query(params, this.requireKey(creds.pixabay));
    const data = await fetchJson<PixabayResponse<PixabayVideo>>(this.id, `${API}/videos/?${q}`);
    let assets = data.hits.map((h) => this.video(h));
    // The video endpoint has no orientation/duration filters; apply them locally.
    if (params.orientation) assets = assets.filter((a) => orientationOf(a.width, a.height) === params.orientation);
    if (params.minDuration) assets = assets.filter((a) => (a.duration ?? 0) >= params.minDuration!);
    if (params.maxDuration) assets = assets.filter((a) => (a.duration ?? 0) <= params.maxDuration!);
    const page = params.page ?? 1;
    return { assets, page, hasMore: page * (params.perPage ?? 15) < data.totalHits };
  }

  async getAsset(providerAssetId: string, creds: ProviderCredentials) {
    const [kind, id] = providerAssetId.split("-");
    if (!/^\d+$/.test(id ?? "")) return null;
    const q = new URLSearchParams({ key: this.requireKey(creds.pixabay), id: id! });
    if (kind === "image") {
      const data = await fetchJson<PixabayResponse<PixabayImage>>(this.id, `${API}/?${q}`);
      return data.hits[0] ? this.image(data.hits[0]) : null;
    }
    if (kind === "video") {
      const data = await fetchJson<PixabayResponse<PixabayVideo>>(this.id, `${API}/videos/?${q}`);
      return data.hits[0] ? this.video(data.hits[0]) : null;
    }
    return null;
  }
}
