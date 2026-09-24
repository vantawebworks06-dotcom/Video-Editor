import type { NormalizedAsset } from "@/lib/domain/types";
import { BaseProvider } from "./base";
import { fetchJson } from "./http";
import { assetId, type ProviderCredentials, type SearchParams, type SearchResult } from "./types";

// https://www.pexels.com/api/documentation/
const API = "https://api.pexels.com";
const LICENSE = "Pexels License";
const LICENSE_URL = "https://www.pexels.com/license/";

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  photographer_url: string;
  alt: string | null;
  src: { original: string; large2x: string; large: string; medium: string; small: string; tiny: string };
}
interface PexelsVideoFile {
  quality: string | null;
  file_type: string;
  width: number | null;
  height: number | null;
  link: string;
}
interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  url: string;
  image: string;
  duration: number;
  user: { name: string; url: string };
  video_files: PexelsVideoFile[];
}

function titleFromUrl(url: string, fallback: string) {
  // Pexels page URLs end in a slug, e.g. /photo/crowd-at-a-concert-12345/
  const slug = url.split("/").filter(Boolean).pop() ?? "";
  const words = slug.replace(/-\d+$/, "").replace(/-/g, " ").trim();
  return words || fallback;
}

export class PexelsProvider extends BaseProvider {
  readonly id = "pexels" as const;
  readonly name = "Pexels";
  readonly requiresKey = true;

  supportsImages() {
    return true;
  }
  supportsVideo() {
    return true;
  }
  isConfigured(creds: ProviderCredentials) {
    return Boolean(creds.pexels);
  }

  private headers(creds: ProviderCredentials) {
    return { Authorization: this.requireKey(creds.pexels) };
  }

  private photo(p: PexelsPhoto): NormalizedAsset {
    return {
      id: assetId("pexels", `photo-${p.id}`),
      provider: "pexels",
      providerAssetId: `photo-${p.id}`,
      type: "photo",
      title: p.alt || titleFromUrl(p.url, "Pexels photo"),
      description: p.alt,
      thumbnailUrl: p.src.medium,
      mediaUrl: p.src.large2x,
      previewUrl: p.src.large,
      downloadUrl: p.src.original,
      width: p.width,
      height: p.height,
      duration: null,
      author: p.photographer,
      authorUrl: p.photographer_url,
      sourceUrl: p.url,
      license: LICENSE,
      licenseUrl: LICENSE_URL,
      attribution: `Photo by ${p.photographer} on Pexels`,
      attributionRequired: false,
      rightsStatus: "CLEAR",
      rightsNotes: ["Pexels License: free to use; crediting the photographer and Pexels is appreciated and shown in-app."],
      retrievedAt: new Date().toISOString(),
      date: null,
      categories: [],
      archival: false,
      score: 0,
    };
  }

  private video(v: PexelsVideo): NormalizedAsset {
    // Prefer an HD MP4 no larger than 1920 wide; fall back to the largest available.
    const mp4s = v.video_files.filter((f) => f.file_type === "video/mp4" && f.width);
    const sorted = [...mp4s].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
    const best = sorted.find((f) => (f.width ?? 0) <= 1920) ?? sorted[0];
    const preview = [...mp4s].sort((a, b) => (a.width ?? 0) - (b.width ?? 0)).find((f) => (f.width ?? 0) >= 480);
    return {
      id: assetId("pexels", `video-${v.id}`),
      provider: "pexels",
      providerAssetId: `video-${v.id}`,
      type: "video",
      title: titleFromUrl(v.url, "Pexels video"),
      description: null,
      thumbnailUrl: v.image,
      mediaUrl: best?.link ?? v.url,
      previewUrl: preview?.link ?? best?.link ?? null,
      downloadUrl: best?.link ?? v.url,
      width: best?.width ?? v.width,
      height: best?.height ?? v.height,
      duration: v.duration,
      author: v.user.name,
      authorUrl: v.user.url,
      sourceUrl: v.url,
      license: LICENSE,
      licenseUrl: LICENSE_URL,
      attribution: `Video by ${v.user.name} on Pexels`,
      attributionRequired: false,
      rightsStatus: "CLEAR",
      rightsNotes: ["Pexels License: free to use; crediting the creator and Pexels is appreciated and shown in-app."],
      retrievedAt: new Date().toISOString(),
      date: null,
      categories: [],
      archival: false,
      score: 0,
    };
  }

  async searchImages(params: SearchParams, creds: ProviderCredentials): Promise<SearchResult> {
    const page = params.page ?? 1;
    const q = new URLSearchParams({ query: params.query, page: String(page), per_page: String(params.perPage ?? 15) });
    if (params.orientation) q.set("orientation", params.orientation);
    const data = await fetchJson<{ photos: PexelsPhoto[]; next_page?: string }>(
      this.id,
      `${API}/v1/search?${q}`,
      { headers: this.headers(creds) },
    );
    return { assets: (data.photos ?? []).map((p) => this.photo(p)), page, hasMore: Boolean(data.next_page) };
  }

  async searchVideos(params: SearchParams, creds: ProviderCredentials): Promise<SearchResult> {
    const page = params.page ?? 1;
    const q = new URLSearchParams({ query: params.query, page: String(page), per_page: String(params.perPage ?? 15) });
    if (params.orientation) q.set("orientation", params.orientation);
    const data = await fetchJson<{ videos: PexelsVideo[]; next_page?: string }>(
      this.id,
      `${API}/videos/search?${q}`,
      { headers: this.headers(creds) },
    );
    let assets = (data.videos ?? []).map((v) => this.video(v));
    if (params.minDuration) assets = assets.filter((a) => (a.duration ?? 0) >= params.minDuration!);
    if (params.maxDuration) assets = assets.filter((a) => (a.duration ?? 0) <= params.maxDuration!);
    return { assets, page, hasMore: Boolean(data.next_page) };
  }

  async getAsset(providerAssetId: string, creds: ProviderCredentials) {
    const [kind, id] = providerAssetId.split("-");
    if (!/^\d+$/.test(id ?? "")) return null;
    if (kind === "photo") {
      return this.photo(await fetchJson<PexelsPhoto>(this.id, `${API}/v1/photos/${id}`, { headers: this.headers(creds) }));
    }
    if (kind === "video") {
      return this.video(
        await fetchJson<PexelsVideo>(this.id, `${API}/videos/videos/${id}`, { headers: this.headers(creds) }),
      );
    }
    return null;
  }
}
