import type { NormalizedAsset, ProviderId } from "@/lib/domain/types";
import { ProviderError } from "./http";
import type {
  ConnectionStatus,
  MediaProvider,
  ProviderCredentials,
  SearchParams,
  SearchResult,
} from "./types";

export abstract class BaseProvider implements MediaProvider {
  abstract readonly id: ProviderId;
  abstract readonly name: string;
  abstract readonly requiresKey: boolean;

  abstract supportsImages(): boolean;
  abstract supportsVideo(): boolean;
  abstract isConfigured(creds: ProviderCredentials): boolean;
  abstract searchImages(params: SearchParams, creds: ProviderCredentials): Promise<SearchResult>;
  abstract searchVideos(params: SearchParams, creds: ProviderCredentials): Promise<SearchResult>;
  abstract getAsset(providerAssetId: string, creds: ProviderCredentials): Promise<NormalizedAsset | null>;

  getDownloadUrl(asset: NormalizedAsset): string {
    return asset.downloadUrl;
  }

  getAttribution(asset: NormalizedAsset): string | null {
    return asset.attribution;
  }

  getLicense(asset: NormalizedAsset) {
    return { license: asset.license, licenseUrl: asset.licenseUrl };
  }

  protected requireKey(key: string | undefined): string {
    if (!key) throw new ProviderError(this.id, "NOT_CONFIGURED", `${this.name} API key is not configured`);
    return key;
  }

  /** Default connection test: a one-result search. */
  async test(creds: ProviderCredentials): Promise<ConnectionStatus> {
    if (this.requiresKey && !this.isConfigured(creds)) {
      return { state: "not_connected", message: `No ${this.name} API key configured.` };
    }
    try {
      const params = { query: "city", perPage: 3 };
      const r = this.supportsImages()
        ? await this.searchImages(params, creds)
        : await this.searchVideos(params, creds);
      const ok = this.requiresKey ? "connected" : "public";
      return { state: ok, message: `OK — test search returned ${r.assets.length} result(s).` };
    } catch (err) {
      return errorToStatus(err);
    }
  }
}

export function errorToStatus(err: unknown): ConnectionStatus {
  if (err instanceof ProviderError) {
    switch (err.code) {
      case "NOT_CONFIGURED":
        return { state: "not_connected", message: err.message };
      case "INVALID_KEY":
        return { state: "invalid_key", message: "The API key was rejected (invalid or expired)." };
      case "RATE_LIMITED":
        return {
          state: "rate_limited",
          message: `Rate limited${err.retryAfterSeconds ? `; retry after ${err.retryAfterSeconds}s` : ""}.`,
        };
      default:
        return { state: "error", message: err.message };
    }
  }
  return { state: "error", message: (err as Error)?.message ?? "Unknown error" };
}

export function orientationOf(w: number | null, h: number | null): "landscape" | "portrait" | "square" | null {
  if (!w || !h) return null;
  const r = w / h;
  if (r > 1.1) return "landscape";
  if (r < 0.9) return "portrait";
  return "square";
}
