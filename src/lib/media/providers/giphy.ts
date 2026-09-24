import type { NormalizedAsset } from "@/lib/domain/types";
import { BaseProvider } from "./base";
import { fetchJson } from "./http";
import { assetId, type ProviderCredentials, type SearchParams, type SearchResult } from "./types";

// https://developers.giphy.com/docs/api/ — GIFs and stickers only.
// GIPHY Clips (video with sound) needs separate approval and is intentionally not used.
const API = "https://api.giphy.com/v1";
export const GIPHY_ATTRIBUTION = "Powered By GIPHY";

interface GiphyRendition {
  url?: string;
  width?: string;
  height?: string;
  mp4?: string;
  webp?: string;
  frames?: string;
}
interface GiphyItem {
  id: string;
  url: string;
  title: string;
  username?: string;
  user?: { display_name?: string; profile_url?: string };
  rating?: string;
  import_datetime?: string;
  images: Record<string, GiphyRendition | undefined>;
}
interface GiphyResponse {
  data: GiphyItem[];
  pagination?: { total_count: number; count: number; offset: number };
}

/** Starter vocabulary for reaction searches. */
export const REACTION_QUERIES = [
  "shocked reaction", "confused reaction", "disbelief", "facepalm", "laughing reaction", "serious reaction",
  "awkward reaction", "surprised", "dramatic reaction", "this is fine", "mind blown", "slow clap",
] as const;

export class GiphyProvider extends BaseProvider {
  readonly id = "giphy" as const;
  readonly name = "GIPHY";
  readonly requiresKey = true;

  supportsImages() {
    return true; // animated GIFs + stickers
  }
  supportsVideo() {
    return false;
  }
  isConfigured(creds: ProviderCredentials) {
    return Boolean(creds.giphy);
  }

  toAsset(g: GiphyItem, kind: "gif" | "sticker"): NormalizedAsset {
    const original = g.images.original ?? {};
    const small = g.images.fixed_width ?? g.images.downsized ?? original;
    // GIFs: use the MP4 rendition for FFmpeg. Stickers keep transparency, so use the GIF/WebP.
    const media = kind === "gif" ? (original.mp4 ?? original.url ?? "") : (original.url ?? original.webp ?? "");
    const author = g.user?.display_name || g.username || null;
    return {
      id: assetId("giphy", `${kind}-${g.id}`),
      provider: "giphy",
      providerAssetId: `${kind}-${g.id}`,
      type: kind,
      title: g.title || "GIPHY reaction",
      description: null,
      thumbnailUrl: small.url ?? null,
      mediaUrl: media,
      previewUrl: small.mp4 ?? small.url ?? null,
      downloadUrl: media,
      width: original.width ? Number(original.width) : null,
      height: original.height ? Number(original.height) : null,
      duration: null,
      author,
      authorUrl: g.user?.profile_url ?? null,
      sourceUrl: g.url,
      license: "GIPHY Terms of Service",
      licenseUrl: "https://support.giphy.com/hc/en-us/articles/360020027752-GIPHY-Terms-of-Service",
      attribution: `${GIPHY_ATTRIBUTION}${author ? ` · ${author}` : ""}`,
      attributionRequired: true,
      rightsStatus: "USER_REVIEW",
      rightsNotes: [
        `Show "${GIPHY_ATTRIBUTION}" wherever GIPHY content is displayed.`,
        "Reaction GIFs often contain clips from films, TV or music videos owned by third parties. Confirm your use (e.g. commentary) is permitted before publishing.",
      ],
      retrievedAt: new Date().toISOString(),
      date: g.import_datetime ?? null,
      categories: g.rating ? [`rating:${g.rating}`] : [],
      archival: false,
      score: 0,
    };
  }

  private async list(endpoint: string, params: SearchParams, creds: ProviderCredentials, kind: "gif" | "sticker") {
    const perPage = Math.min(params.perPage ?? 15, 50);
    const page = params.page ?? 1;
    const q = new URLSearchParams({
      api_key: this.requireKey(creds.giphy),
      limit: String(perPage),
      offset: String((page - 1) * perPage),
      rating: params.rating ?? "pg",
      lang: "en",
    });
    if (params.query) q.set("q", params.query.slice(0, 50));
    const data = await fetchJson<GiphyResponse>(this.id, `${API}/${endpoint}?${q}`);
    const total = data.pagination?.total_count ?? 0;
    return {
      assets: data.data.map((g) => this.toAsset(g, kind)).filter((a) => a.mediaUrl),
      page,
      hasMore: page * perPage < total,
    };
  }

  /** Animated reaction GIFs (the image interface returns GIFs for this provider). */
  searchImages(params: SearchParams, creds: ProviderCredentials): Promise<SearchResult> {
    return this.searchGifs(params, creds);
  }

  searchVideos(): Promise<SearchResult> {
    return Promise.resolve({ assets: [], page: 1, hasMore: false });
  }

  searchGifs(params: SearchParams, creds: ProviderCredentials) {
    return this.list("gifs/search", params, creds, "gif");
  }

  searchStickers(params: SearchParams, creds: ProviderCredentials) {
    return this.list("stickers/search", params, creds, "sticker");
  }

  trending(params: Omit<SearchParams, "query">, creds: ProviderCredentials) {
    return this.list("gifs/trending", { ...params, query: "" }, creds, "gif");
  }

  async getAsset(providerAssetId: string, creds: ProviderCredentials) {
    const [kind, id] = providerAssetId.split(/-(.+)/);
    if (!id || !/^[A-Za-z0-9]+$/.test(id)) return null;
    const q = new URLSearchParams({ api_key: this.requireKey(creds.giphy) });
    const data = await fetchJson<{ data: GiphyItem }>(this.id, `${API}/gifs/${id}?${q}`);
    return data.data ? this.toAsset(data.data, kind === "sticker" ? "sticker" : "gif") : null;
  }
}
