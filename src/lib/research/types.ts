/**
 * Research providers: one interface for every source the editor can research — video platforms,
 * social networks, news, web search, encyclopaedias, stock/archive libraries and user-provided
 * URLs. Each provider declares what its platform's terms permit (search, embed preview, capture,
 * import) and the app never offers more than that.
 */
import type { MediaCategory } from "@/lib/analysis/types";
import type { Embed, Relevance, SegmentSuggestion } from "@/lib/domain/media";
import type { NormalizedAsset } from "@/lib/domain/types";

export type ResearchProviderId =
  | "youtube"
  | "x"
  | "reddit"
  | "meta"
  | "brave"
  | "gdelt"
  | "wikipedia"
  | "wikimedia"
  | "internet_archive"
  | "pexels"
  | "pixabay"
  | "giphy"
  | "url";

/** What the UI shows for each integration. */
export type ProviderState = "CONNECTED" | "NOT_CONNECTED" | "REQUIRES_CONFIGURATION" | "RATE_LIMITED" | "UNAVAILABLE";

export interface ResearchCredentials {
  youtube?: string;
  xBearer?: string;
  /** Meta app access token "app-id|client-token" (oEmbed Read, after App Review). */
  metaOembed?: string;
  /** "client_id:client_secret" of a Reddit app approved under the Responsible Builder Policy. */
  reddit?: string;
  brave?: string;
  pexels?: string;
  pixabay?: string;
  giphy?: string;
  wikimediaToken?: string;
  internetArchive?: string;
}

export interface Capabilities {
  search: boolean;
  /** How a result can be previewed: the platform's official embed, a thumbnail, or the file itself. */
  preview: "embed" | "thumbnail" | "file";
  /** A screenshot of the public page/official embed may be captured (context preserved). */
  capture: boolean;
  /**
   * "file": the media may be downloaded and used (licensed stock/archive/Commons files).
   * "authorised-copy": the platform forbids downloading — the user uploads a copy they may use.
   * "none": reference only.
   */
  import: "file" | "authorised-copy" | "none";
}

export interface ProviderInfo {
  id: ResearchProviderId;
  name: string;
  categories: MediaCategory[];
  capabilities: Capabilities;
  /** Environment variables / Settings keys that configure it (empty = keyless). */
  credentials: { key: keyof ResearchCredentials; env: string[]; label: string; required: boolean }[];
  docsUrl: string;
  /** What the platform's current terms allow, shown in Settings → Integrations. */
  terms: string;
  /** Cost/limit notes (quota units, pay-per-use prices). */
  limits: string;
}

/** A normalised search result, before ranking. */
export interface Candidate {
  provider: ResearchProviderId;
  externalId: string;
  category: MediaCategory;
  title: string;
  description: string | null;
  excerpt: string | null;
  sourceUrl: string;
  platform: string;
  account: string | null;
  accountUrl: string | null;
  publishedAt: string | null;
  duration: number | null;
  thumbnailUrl: string | null;
  embed: Embed | null;
  segment: SegmentSuggestion | null;
  license: string | null;
  metrics?: { views?: number; likes?: number; comments?: number; shares?: number };
  /** 0-1 prior on the source (an official channel, a wire service, an encyclopaedia…). */
  credibility: number;
  /** Stock/archive providers: the importable media asset (rights already classified). */
  asset?: NormalizedAsset;
  /** Captions/chapters text useful for locating a segment (never the platform's media). */
  chapters?: { start: number; title: string }[];
}

export interface RankedCandidate extends Candidate {
  relevance: Relevance;
}

export interface ResearchQuery {
  query: string;
  category: MediaCategory;
  limit: number;
  /** Year the sentence is about (narrows news/date filters where supported). */
  year?: number | null;
  /** The narration the search is for (used e.g. to pick the matching chapter of a long video). */
  context?: { sentence: string; entities: string[] };
}

export type ResearchErrorCode = "NOT_CONFIGURED" | "INVALID_CREDENTIALS" | "RATE_LIMITED" | "QUOTA_EXCEEDED" | "FORBIDDEN" | "UNAVAILABLE" | "TIMEOUT" | "NOT_FOUND" | "UNSUPPORTED" | "BAD_RESPONSE";

export class ResearchError extends Error {
  constructor(
    readonly provider: string,
    readonly code: ResearchErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ResearchError";
  }
}

export interface ResearchProvider extends ProviderInfo {
  /** Configured (credentials present)? Keyless providers are always configured. */
  configured(creds: ResearchCredentials): boolean;
  search(q: ResearchQuery, creds: ResearchCredentials, signal?: AbortSignal): Promise<Candidate[]>;
  /** Fresh metadata for one item (e.g. before saving or when it may have been removed). */
  getMetadata(externalId: string, creds: ResearchCredentials, signal?: AbortSignal): Promise<Candidate | null>;
  getPreview(c: Candidate): Embed | { kind: "thumbnail"; url: string | null };
  getSource(c: Candidate): { url: string; label: string };
  /** A real, cheap request that proves the credentials work (Settings → Test). */
  test(creds: ResearchCredentials): Promise<{ state: ProviderState; message: string }>;
  /** Importable media for a result, only where the licence and terms permit. */
  importMedia?(c: Candidate, creds: ResearchCredentials): Promise<NormalizedAsset | null>;
}

export interface ProviderOutcome {
  provider: ResearchProviderId;
  name: string;
  state: "ok" | "empty" | "error" | "skipped";
  code?: ResearchErrorCode;
  message: string;
  count: number;
  ms: number;
}

export function errorState(code: ResearchErrorCode): ProviderState {
  switch (code) {
    case "NOT_CONFIGURED":
      return "REQUIRES_CONFIGURATION";
    case "INVALID_CREDENTIALS":
    case "FORBIDDEN":
      return "NOT_CONNECTED";
    case "RATE_LIMITED":
    case "QUOTA_EXCEEDED":
      return "RATE_LIMITED";
    default:
      return "UNAVAILABLE";
  }
}
