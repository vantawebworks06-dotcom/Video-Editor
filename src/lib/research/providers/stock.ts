/**
 * The media libraries DocuCut already searches (Pexels, Pixabay, Wikimedia Commons, Internet
 * Archive, GIPHY) exposed as research providers. Their files may be imported: each result keeps
 * the library's licence classification (rights status), and AI-generated media is excluded.
 */
import type { MediaCategory } from "@/lib/analysis/types";
import type { NormalizedAsset, ProviderId } from "@/lib/domain/types";
import { getProvider } from "@/lib/media/providers";
import { ProviderError } from "@/lib/media/providers/http";
import type { MediaProvider } from "@/lib/media/providers/types";
import { looksAiGenerated } from "@/lib/media/rights";
import { applyContentSignals } from "@/lib/media/searchOrchestrator";
import { type Candidate, ResearchError, type ResearchProvider, type ResearchProviderId } from "../types";

interface StockSpec {
  id: ResearchProviderId & ProviderId;
  name: string;
  categories: MediaCategory[];
  credential?: { key: "pexels" | "pixabay" | "giphy" | "wikimediaToken" | "internetArchive"; env: string; label: string; required: boolean };
  credibility: number;
  docsUrl: string;
  terms: string;
  limits: string;
}

const SPECS: StockSpec[] = [
  { id: "wikimedia", name: "Wikimedia Commons", categories: ["photo", "video", "document"], credential: { key: "wikimediaToken", env: "WIKIMEDIA_ACCESS_TOKEN", label: "OAuth access token (optional, higher limits)", required: false }, credibility: 0.7, docsUrl: "https://commons.wikimedia.org/w/api.php", terms: "Freely licensed or public-domain files; licence and attribution are recorded per file.", limits: "Keyless; identifying User-Agent required." },
  { id: "internet_archive", name: "Internet Archive", categories: ["video", "photo", "document"], credential: { key: "internetArchive", env: "INTERNET_ARCHIVE_KEYS", label: "S3 keys access:secret (optional)", required: false }, credibility: 0.65, docsUrl: "https://archive.org/developers/", terms: "Rights vary per item: curated public-domain collections are clear; uploader-declared licences need review; TV news is excluded.", limits: "Keyless; ~1–3 s per search." },
  { id: "pexels", name: "Pexels", categories: ["video", "photo"], credential: { key: "pexels", env: "PEXELS_API_KEY", label: "API key", required: true }, credibility: 0.5, docsUrl: "https://www.pexels.com/api/documentation/", terms: "Free stock under the Pexels License (no attribution required, not for identifiable-person endorsements).", limits: "200 requests/hour by default." },
  { id: "pixabay", name: "Pixabay", categories: ["video", "photo"], credential: { key: "pixabay", env: "PIXABAY_API_KEY", label: "API key", required: true }, credibility: 0.5, docsUrl: "https://pixabay.com/api/docs/", terms: "Pixabay Content License; results may be cached 24 h.", limits: "100 requests/minute." },
  { id: "giphy", name: "GIPHY", categories: ["photo"], credential: { key: "giphy", env: "GIPHY_API_KEY", label: "API key", required: true }, credibility: 0.3, docsUrl: "https://developers.giphy.com/docs/api/", terms: "GIFs are user uploads: rights need review; credit “Powered By GIPHY”.", limits: "Beta keys: 100 requests/hour." },
];

function categoryOf(a: NormalizedAsset, requested: MediaCategory): MediaCategory {
  if (requested === "document" && a.type === "photo") return "document";
  return a.type === "video" ? "video" : "photo";
}

function toCandidate(a: NormalizedAsset, spec: StockSpec, requested: MediaCategory): Candidate {
  return {
    provider: spec.id,
    externalId: a.providerAssetId,
    category: categoryOf(a, requested),
    title: a.title,
    description: a.description,
    excerpt: null,
    sourceUrl: a.sourceUrl,
    platform: spec.name,
    account: a.author,
    accountUrl: a.authorUrl,
    publishedAt: a.date && /^\d{4}/.test(a.date) ? (/^\d{4}$/.test(a.date) ? `${a.date}-01-01` : a.date) : null,
    duration: a.duration,
    thumbnailUrl: a.thumbnailUrl,
    embed: null,
    segment: null,
    license: a.license,
    credibility: a.archival ? spec.credibility + 0.1 : spec.credibility,
    asset: a,
  };
}

function wrapError(id: string, err: unknown): ResearchError {
  if (err instanceof ResearchError) return err;
  if (err instanceof ProviderError) {
    const map = { NOT_CONFIGURED: "NOT_CONFIGURED", INVALID_KEY: "INVALID_CREDENTIALS", RATE_LIMITED: "RATE_LIMITED", NETWORK: "UNAVAILABLE", TIMEOUT: "TIMEOUT", BAD_RESPONSE: "BAD_RESPONSE", NOT_FOUND: "NOT_FOUND" } as const;
    return new ResearchError(id, map[err.code], err.message.replace(/^\[[^\]]+\]\s*/, ""), err.retryAfterSeconds);
  }
  return new ResearchError(id, "UNAVAILABLE", (err as Error)?.message ?? "Unknown error");
}

function make(spec: StockSpec): ResearchProvider {
  const lib = (): MediaProvider => {
    const p = getProvider(spec.id);
    if (!p) throw new ResearchError(spec.id, "UNAVAILABLE", `${spec.name} is not registered.`);
    return p;
  };
  const usable = (a: NormalizedAsset) => a.rightsStatus !== "RESTRICTED" && !looksAiGenerated(a);
  return {
    id: spec.id,
    name: spec.name,
    categories: spec.categories,
    capabilities: { search: true, preview: "file", capture: false, import: "file" },
    credentials: spec.credential ? [{ key: spec.credential.key, env: [spec.credential.env], label: spec.credential.label, required: spec.credential.required }] : [],
    docsUrl: spec.docsUrl,
    terms: spec.terms,
    limits: spec.limits,
    configured: (creds) => !spec.credential?.required || Boolean(creds[spec.credential.key]),
    async search(q, creds) {
      if (spec.credential?.required && !creds[spec.credential.key]) throw new ResearchError(spec.id, "NOT_CONFIGURED", `Add a ${spec.name} API key (${spec.credential.env}) in Settings → Integrations.`);
      const p = lib();
      const wantVideo = q.category === "video" || q.category === "interview";
      const params = { query: q.query, perPage: Math.min(20, q.limit), orientation: "landscape" as const };
      try {
        const r = wantVideo && p.supportsVideo() ? await p.searchVideos(params, creds) : p.supportsImages() ? await p.searchImages(params, creds) : await p.searchVideos(params, creds);
        return r.assets.map(applyContentSignals).filter(usable).map((a) => toCandidate(a, spec, q.category));
      } catch (err) {
        throw wrapError(spec.id, err);
      }
    },
    async getMetadata(externalId, creds) {
      try {
        const a = await lib().getAsset(externalId, creds);
        return a && usable(a) ? toCandidate(applyContentSignals(a), spec, a.type === "video" ? "video" : "photo") : null;
      } catch (err) {
        throw wrapError(spec.id, err);
      }
    },
    getPreview: (c) => ({ kind: "thumbnail", url: c.thumbnailUrl }),
    getSource: (c) => ({ url: c.sourceUrl, label: `Open on ${spec.name}` }),
    async test(creds) {
      const s = await lib().test(creds);
      const state = s.state === "connected" || s.state === "public" ? "CONNECTED" : s.state === "rate_limited" ? "RATE_LIMITED" : s.state === "not_connected" ? (spec.credential?.required ? "REQUIRES_CONFIGURATION" : "NOT_CONNECTED") : s.state === "invalid_key" ? "NOT_CONNECTED" : "UNAVAILABLE";
      return { state, message: s.message };
    },
    async importMedia(c, creds) {
      // Re-fetched from the library server-side: the browser never supplies media URLs or licences.
      const a = await lib().getAsset(c.externalId, creds).catch((e: unknown) => {
        throw wrapError(spec.id, e);
      });
      return a && usable(a) ? applyContentSignals(a) : null;
    },
  };
}

export const stockProviders: ResearchProvider[] = SPECS.map(make);
