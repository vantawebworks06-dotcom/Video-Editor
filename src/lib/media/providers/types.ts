import type { NormalizedAsset, ProviderId } from "@/lib/domain/types";

export type Orientation = "landscape" | "portrait" | "square";

export interface SearchParams {
  query: string;
  orientation?: Orientation;
  page?: number;
  perPage?: number;
  minDuration?: number;
  maxDuration?: number;
  minWidth?: number;
  category?: string;
  /** GIPHY content rating filter. */
  rating?: "g" | "pg" | "pg-13" | "r";
}

export interface SearchResult {
  assets: NormalizedAsset[];
  page: number;
  hasMore: boolean;
}

/** Credentials resolved server-side. Never sent to the browser. */
export interface ProviderCredentials {
  pexels?: string;
  pixabay?: string;
  giphy?: string;
  /** Optional Wikimedia OAuth 2 access token for higher rate limits. */
  wikimediaToken?: string;
  /** Optional Internet Archive S3-style "access:secret" for authenticated calls. */
  internetArchive?: string;
}

export type ConnectionState = "connected" | "not_connected" | "invalid_key" | "rate_limited" | "error" | "public";

export interface ConnectionStatus {
  state: ConnectionState;
  message: string;
}

export interface MediaProvider {
  readonly id: ProviderId;
  readonly name: string;
  readonly requiresKey: boolean;
  supportsImages(): boolean;
  supportsVideo(): boolean;
  isConfigured(creds: ProviderCredentials): boolean;
  searchImages(params: SearchParams, creds: ProviderCredentials): Promise<SearchResult>;
  searchVideos(params: SearchParams, creds: ProviderCredentials): Promise<SearchResult>;
  getAsset(providerAssetId: string, creds: ProviderCredentials): Promise<NormalizedAsset | null>;
  getDownloadUrl(asset: NormalizedAsset): string;
  getAttribution(asset: NormalizedAsset): string | null;
  getLicense(asset: NormalizedAsset): { license: string; licenseUrl: string | null };
  test(creds: ProviderCredentials): Promise<ConnectionStatus>;
}

export const EMPTY_RESULT: SearchResult = { assets: [], page: 1, hasMore: false };

export function assetId(provider: ProviderId, providerAssetId: string | number): string {
  return `${provider}:${providerAssetId}`;
}
