/**
 * Run a research query across providers in parallel, rank the results against the narration
 * sentence, and report — per provider — what happened (results, nothing found, not configured,
 * rate limited, unavailable). Nothing is ever reported as found unless a provider returned it.
 */
import type { MediaCategory } from "@/lib/analysis/types";
import { type SearchCache, stableHash } from "@/lib/media/cache";
import { getResearchProvider } from "./index";
import { platformOf } from "./platforms";
import { rankCandidates } from "./rank";
import { type Candidate, type ProviderOutcome, type RankedCandidate, type ResearchCredentials, ResearchError, type ResearchProviderId } from "./types";

export interface ResearchRequest {
  query: string;
  category: MediaCategory;
  providers: ResearchProviderId[];
  sentence: string;
  entities: string[];
  topics: string[];
  year: number | null;
  limitPerProvider?: number;
}

/** How long each provider's results are reused (platform terms + cost). */
const TTL_MS: Partial<Record<ResearchProviderId, number>> = {
  youtube: 24 * 3600_000, // metadata must be refreshed within 30 days (YouTube policy III.E.4)
  x: 6 * 3600_000, // billed per post read: don't re-buy the same search
  brave: 24 * 3600_000,
  gdelt: 6 * 3600_000,
  wikipedia: 7 * 24 * 3600_000,
  reddit: 6 * 3600_000,
};
const TIMEOUT_MS: Partial<Record<ResearchProviderId, number>> = { gdelt: 40_000, internet_archive: 25_000 };

async function cached(cache: SearchCache | undefined, provider: ResearchProviderId, key: unknown, run: () => Promise<Candidate[]>): Promise<{ results: Candidate[]; cached: boolean }> {
  const ttl = TTL_MS[provider];
  const k = stableHash({ research: 1, provider, key });
  if (cache && ttl) {
    const hit = await cache.get(k).catch(() => null);
    if (hit && Date.now() - hit.timestamp < ttl) return { results: hit.results as unknown as Candidate[], cached: true };
  }
  const results = await run();
  if (cache && ttl && results.length) await cache.set(k, { provider: `research:${provider}`, query: JSON.stringify(key).slice(0, 300), results: results as never, timestamp: Date.now() }).catch(() => undefined);
  return { results, cached: false };
}

/** Same item found twice (a YouTube video via YouTube and via web search) is kept once. */
function dedupeKey(c: Candidate): string {
  const p = platformOf(c.sourceUrl);
  if (p.id && p.platform !== "web") return `${p.platform}:${p.id}`;
  try {
    const u = new URL(c.sourceUrl);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return `${c.provider}:${c.externalId}`;
  }
}

export async function runResearch(req: ResearchRequest, creds: ResearchCredentials, opts: { signal?: AbortSignal; cache?: SearchCache } = {}): Promise<{ candidates: RankedCandidate[]; outcomes: ProviderOutcome[] }> {
  const limit = req.limitPerProvider ?? 8;
  const outcomes: ProviderOutcome[] = [];
  const all: Candidate[] = [];

  await Promise.all(
    [...new Set(req.providers)].map(async (id) => {
      const p = getResearchProvider(id);
      const t0 = Date.now();
      if (!p) return;
      if (!p.capabilities.search) {
        outcomes.push({ provider: id, name: p.name, state: "skipped", code: "UNSUPPORTED", message: `${p.name} has no search — paste a link instead.`, count: 0, ms: 0 });
        return;
      }
      if (!p.configured(creds)) {
        outcomes.push({ provider: id, name: p.name, state: "skipped", code: "NOT_CONFIGURED", message: `Not configured — add ${p.credentials.map((c) => c.env.join(" + ")).join(" / ")} in Settings → Integrations.`, count: 0, ms: 0 });
        return;
      }
      const timeout = AbortSignal.timeout(TIMEOUT_MS[id] ?? 20_000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      try {
        const q = { query: req.query, category: req.category, limit, year: req.year, context: { sentence: req.sentence, entities: req.entities } };
        const { results, cached: fromCache } = await cached(opts.cache, id, { q: req.query, c: req.category, y: req.year, l: limit, s: id === "youtube" ? req.sentence : undefined }, () => p.search(q, creds, signal));
        all.push(...results);
        outcomes.push({ provider: id, name: p.name, state: results.length ? "ok" : "empty", message: results.length ? `${results.length} result${results.length === 1 ? "" : "s"}${fromCache ? " (cached)" : ""}` : "No results for this query.", count: results.length, ms: Date.now() - t0 });
      } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        const e = err instanceof ResearchError ? err : new ResearchError(id, timeout.aborted ? "TIMEOUT" : "UNAVAILABLE", timeout.aborted ? "Timed out." : ((err as Error)?.message ?? "Unknown error"));
        outcomes.push({ provider: id, name: p.name, state: e.code === "UNSUPPORTED" ? "skipped" : "error", code: e.code, message: e.message, count: 0, ms: Date.now() - t0 });
      }
    }),
  );

  const seen = new Map<string, Candidate>();
  for (const c of all) {
    const k = dedupeKey(c);
    const prev = seen.get(k);
    // Prefer the richer record (a platform's own API over a web-search hit about it).
    if (!prev || (prev.provider === "brave" && c.provider !== "brave")) seen.set(k, c);
  }
  // Rank against the subjects this search is for ("photograph of Mavado" → Mavado), not every name in the sentence.
  const q = ` ${req.query.toLowerCase()} `;
  const inQuery = req.entities.filter((e) => q.includes(` ${e.toLowerCase()} `) || e.toLowerCase().split(" ").some((p) => p.length >= 4 && q.includes(` ${p} `)));
  const ranked = rankCandidates([...seen.values()], { sentence: req.sentence, entities: inQuery.length ? inQuery : req.entities, topics: req.topics, year: req.year, category: req.category, query: req.query });
  const order: ResearchProviderId[] = req.providers;
  outcomes.sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider));
  return { candidates: ranked.slice(0, 40), outcomes };
}
