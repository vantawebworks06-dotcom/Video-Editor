import type { AssetType, NormalizedAsset, ProviderId, RightsStatus } from "@/lib/domain/types";
import { MemorySearchCache, stableHash, type SearchCache } from "./cache";
import { giphy, getProvider, ProviderError } from "./providers";
import { orientationOf } from "./providers/base";
import type { Orientation, ProviderCredentials, SearchParams, SearchResult } from "./providers/types";
import { createLimiter } from "@/lib/limiter";
import { looksAiGenerated, RIGHTS_RANK } from "./rights";

export interface SearchRequest {
  /** Ranked queries; earlier queries are weighted higher. */
  queries: string[];
  types: AssetType[];
  providers: ProviderId[];
  orientation: Orientation;
  /** Seconds of footage the edit needs from a single video. */
  minDuration?: number;
  minWidth?: number;
  perQuery?: number;
  maxQueries?: number;
  preferArchival?: boolean;
  allowReview: boolean;
  allowUnknown: boolean;
  gifRating?: "g" | "pg" | "pg-13";
  limit?: number;
}

export interface SearchError {
  provider: ProviderId;
  query: string;
  code: string;
  message: string;
}

export interface SearchResponse {
  candidates: NormalizedAsset[];
  errors: SearchError[];
  cacheHits: number;
  providerCalls: number;
}

const defaultCache = new MemorySearchCache();

const STOPWORDS = new Set(
  "a an the of in on at to for and or but with from by as is are was were be been this that these those it its into over under about 2000s 1990s 1980s 1970s".split(
    " ",
  ),
);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

async function withConcurrency<T>(items: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await items[idx]!();
    }
  });
  await Promise.all(workers);
  return results;
}

// At most this many requests in flight per provider across the whole process, so concurrent
// searches (the generator searches several visuals at once) can't burst a provider's rate limit.
const PER_PROVIDER = 4;
const providerSlots = new Map<ProviderId, ReturnType<typeof createLimiter>>();
const slot = (p: ProviderId) => providerSlots.get(p) ?? providerSlots.set(p, createLimiter(PER_PROVIDER)).get(p)!;

// Identical searches running at the same time share one provider request.
const inFlight = new Map<string, Promise<SearchResult>>();

/** Temporary failures worth another try; bad keys and bad requests are not. */
function isTransient(err: unknown) {
  if (!(err instanceof ProviderError)) return false;
  return err.code === "RATE_LIMITED" || err.code === "TIMEOUT" || err.code === "NETWORK" || (err.code === "BAD_RESPONSE" && /HTTP 5\d\d/.test(err.message));
}

async function runWithRetry(provider: ProviderId, type: AssetType, params: SearchParams, creds: ProviderCredentials, attempts = 3): Promise<SearchResult> {
  for (let i = 0; ; i++) {
    try {
      return await slot(provider)(() => runOne(provider, type, params, creds));
    } catch (err) {
      if (i >= attempts - 1 || !isTransient(err)) throw err;
      const retryAfter = err instanceof ProviderError && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : 0;
      await new Promise((r) => setTimeout(r, Math.min(10_000, retryAfter || 800 * 2 ** i)));
    }
  }
}

async function runOne(
  provider: ProviderId,
  type: AssetType,
  params: SearchParams,
  creds: ProviderCredentials,
): Promise<SearchResult> {
  const p = getProvider(provider);
  if (!p) return { assets: [], page: 1, hasMore: false };
  if (type === "sticker") return provider === "giphy" ? giphy.searchStickers(params, creds) : { assets: [], page: 1, hasMore: false };
  if (type === "gif") return provider === "giphy" ? giphy.searchGifs(params, creds) : { assets: [], page: 1, hasMore: false };
  if (provider === "giphy") return { assets: [], page: 1, hasMore: false }; // GIPHY never serves photo/video needs
  if (type === "video") return p.supportsVideo() ? p.searchVideos(params, creds) : { assets: [], page: 1, hasMore: false };
  return p.supportsImages() ? p.searchImages(params, creds) : { assets: [], page: 1, hasMore: false };
}

const BROADCAST_SIGNALS =
  /\b(news|newscast|broadcast|tv station|television station|press conference|live report|anchor|reporter|c-span|cnn|bbc|fox news|msnbc|nbc|abc news|cbs|wowk|interview on|talk show|music video|trailer|movie clip|film clip)\b/i;

/**
 * A permissive licence tag does not make broadcast/news or film footage safe to reuse
 * (e.g. TV segments re-uploaded under CC BY). Downgrade such assets to USER_REVIEW.
 */
export function applyContentSignals(a: NormalizedAsset): NormalizedAsset {
  if (a.rightsStatus !== "CLEAR" && a.rightsStatus !== "ATTRIBUTION_REQUIRED") return a;
  const text = `${a.title} ${a.description ?? ""} ${a.categories.join(" ")}`;
  if (a.type === "video" && BROADCAST_SIGNALS.test(text)) {
    return {
      ...a,
      rightsStatus: "USER_REVIEW",
      rightsNotes: [...a.rightsNotes, "Looks like broadcast/news or film footage; third-party rights may apply despite the listed licence."],
    };
  }
  return a;
}

export function isRightsAllowed(status: RightsStatus, req: Pick<SearchRequest, "allowReview" | "allowUnknown">) {
  if (status === "RESTRICTED") return false;
  if (status === "UNKNOWN") return req.allowUnknown;
  if (status === "USER_REVIEW") return req.allowReview;
  return true;
}

/** Heuristic 0-100 score used before (or instead of) AI ranking. */
export function scoreAsset(asset: NormalizedAsset, req: SearchRequest, queryIndex: number): number {
  const q = new Set(req.queries.slice(0, 3).flatMap(tokens));
  const hay = new Set(tokens(`${asset.title} ${asset.description ?? ""} ${asset.categories.join(" ")}`));
  let overlap = 0;
  for (const t of q) if (hay.has(t)) overlap++;
  const relevance = q.size ? Math.min(40, (overlap / Math.min(q.size, 4)) * 40) : 20;

  const w = asset.width ?? 0;
  const quality = asset.type === "gif" || asset.type === "sticker" ? 15 : w >= 1920 ? 20 : w >= 1280 ? 16 : w >= 800 ? 10 : w ? 4 : 8;

  const o = orientationOf(asset.width, asset.height);
  const aspect = o === null ? 5 : o === req.orientation ? 10 : 4;

  let durationFit = 10;
  if (asset.type === "video" && req.minDuration) {
    durationFit = asset.duration === null ? 5 : asset.duration >= req.minDuration ? 10 : 2;
  }

  const rights = RIGHTS_RANK[asset.rightsStatus] * 0.2;
  const rankBonus = Math.max(0, 5 - queryIndex);
  const archival = req.preferArchival && asset.archival ? 5 : 0;
  return Math.round(Math.min(100, relevance + quality + aspect + durationFit + rights + rankBonus + archival + asset.score));
}

export async function searchMedia(
  req: SearchRequest,
  ctx: { creds: ProviderCredentials; cache?: SearchCache },
): Promise<SearchResponse> {
  const cache = ctx.cache ?? defaultCache;
  const queries = req.queries.map((q) => q.trim()).filter(Boolean).slice(0, req.maxQueries ?? 4);
  const errors: SearchError[] = [];
  let cacheHits = 0;
  let providerCalls = 0;

  const jobs: (() => Promise<{ assets: NormalizedAsset[]; queryIndex: number }>)[] = [];
  queries.forEach((query, queryIndex) => {
    for (const provider of req.providers) {
      const p = getProvider(provider);
      if (!p) continue;
      if (p.requiresKey && !p.isConfigured(ctx.creds)) continue; // silently skip unconfigured keyed providers
      for (const type of req.types) {
        const params: SearchParams = {
          query,
          orientation: req.orientation,
          perPage: req.perQuery ?? 10,
          minDuration: type === "video" && req.minDuration ? Math.floor(req.minDuration) : undefined,
          minWidth: req.minWidth,
          rating: req.gifRating,
        };
        jobs.push(async () => {
          const key = stableHash({ provider, type, ...params });
          const hit = await cache.get(key).catch(() => null);
          if (hit) {
            cacheHits++;
            return { assets: hit.results, queryIndex };
          }
          try {
            let pending = inFlight.get(key);
            if (!pending) {
              providerCalls++;
              pending = runWithRetry(provider, type, params, ctx.creds).then(async (r) => {
                await cache.set(key, { provider, query, results: r.assets, timestamp: Date.now() }).catch(() => undefined);
                return r;
              });
              inFlight.set(key, pending);
              void pending.finally(() => inFlight.delete(key)).catch(() => undefined);
            } else cacheHits++;
            const r = await pending;
            return { assets: r.assets, queryIndex };
          } catch (err) {
            errors.push({
              provider,
              query,
              code: err instanceof ProviderError ? err.code : "UNKNOWN",
              message: (err as Error).message,
            });
            return { assets: [], queryIndex };
          }
        });
      }
    }
  });

  const batches = await withConcurrency(jobs, 6);

  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const candidates: NormalizedAsset[] = [];
  for (const { assets, queryIndex } of batches) {
    for (const raw of assets) {
      const a = applyContentSignals(raw);
      const url = a.mediaUrl.split("?")[0]!;
      if (seenIds.has(a.id) || seenUrls.has(url)) continue;
      seenIds.add(a.id);
      seenUrls.add(url);
      if (looksAiGenerated(a)) continue; // real media only — never AI-generated imagery
      if (!isRightsAllowed(a.rightsStatus, req)) continue;
      if (!a.mediaUrl) continue;
      // Hard filters: unusably small stills, far-too-short videos.
      if (a.type === "photo" && a.width !== null && a.width < 480) continue;
      if (a.type === "video" && req.minDuration && a.duration !== null && a.duration < req.minDuration * 0.6) continue;
      candidates.push({ ...a, score: scoreAsset(a, req, queryIndex) });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return { candidates: candidates.slice(0, req.limit ?? 30), errors, cacheHits, providerCalls };
}
