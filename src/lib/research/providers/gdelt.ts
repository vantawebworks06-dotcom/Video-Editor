/**
 * GDELT DOC 2.0 — keyless worldwide news search (articles since 2017, machine-translated from 65
 * languages). The service asks clients to send at most one request every 5 seconds, so every call
 * goes through one spaced queue per server process.
 * https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
 */
import { domainCredibility } from "../credibility";
import { decodeEntities, hostOf, httpsGetText, spacedQueue } from "../http";
import { type Candidate, ResearchError, type ResearchProvider } from "../types";

const API = "https://api.gdeltproject.org/api/v2/doc/doc";
const queue = spacedQueue(5200);

interface Article {
  url: string;
  title: string;
  seendate: string; // 20110104T120000Z
  socialimage?: string;
  domain: string;
  language?: string;
  sourcecountry?: string;
}

function isoFrom(seen: string): string | null {
  const m = seen.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

/** GDELT rejects very short words and needs multi-word names quoted. */
function gdeltQuery(q: string): string {
  const words = q
    .replace(/["“”]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, ""))
    .filter((w) => w.length >= 3);
  return words.slice(0, 8).join(" ");
}

async function call(query: string, year: number | null | undefined, limit: number, signal?: AbortSignal): Promise<Article[]> {
  const params = new URLSearchParams({ query, mode: "artlist", format: "json", maxrecords: String(Math.min(50, Math.max(5, limit))), sort: "hybridrel" });
  if (year && year >= 2017) {
    params.set("startdatetime", `${year}0101000000`);
    params.set("enddatetime", `${year}1231235959`);
  } else {
    params.set("timespan", "3months");
  }
  // node:https, not fetch: GDELT's TLS handshake regularly takes >10 s (fetch's fixed connect timeout).
  const { status, body: text } = await queue(() => httpsGetText("gdelt", `${API}?${params}`, { signal, timeoutMs: 35_000 }));
  if (status === 429 || /^Please limit requests/i.test(text)) throw new ResearchError("gdelt", "RATE_LIMITED", "GDELT asks for at most one request every 5 seconds; try again shortly.");
  if (status >= 500) throw new ResearchError("gdelt", "UNAVAILABLE", `GDELT is having problems (HTTP ${status}).`);
  if (!text.trim() || text.trim() === "{}") return [];
  let j: { articles?: Article[] };
  try {
    j = JSON.parse(text) as { articles?: Article[] };
  } catch {
    // GDELT reports query problems as plain text ("Your search contained a keyword that was too short…").
    throw new ResearchError("gdelt", "BAD_RESPONSE", text.slice(0, 160));
  }
  return j.articles ?? [];
}

function toCandidate(a: Article): Candidate {
  const cred = domainCredibility(a.url);
  return {
    provider: "gdelt",
    externalId: a.url.slice(0, 400),
    category: "article",
    title: decodeEntities(a.title).trim(),
    description: [a.domain, a.sourcecountry, a.language].filter(Boolean).join(" · "),
    excerpt: null,
    sourceUrl: a.url,
    platform: hostOf(a.url) ?? a.domain,
    account: a.domain,
    accountUrl: `https://${a.domain}`,
    publishedAt: isoFrom(a.seendate),
    duration: null,
    thumbnailUrl: a.socialimage || null,
    embed: null,
    segment: null,
    license: "© the publisher — link/screenshot for reference; reuse needs permission",
    credibility: cred.score,
  };
}

export const gdelt: ResearchProvider = {
  id: "gdelt",
  name: "GDELT News",
  categories: ["article"],
  capabilities: { search: true, preview: "thumbnail", capture: true, import: "none" },
  credentials: [],
  docsUrl: "https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/",
  terms: "Free, keyless article search (metadata + links). Articles belong to their publishers: open, cite and capture a screenshot for reference; republishing text or images needs the publisher's permission.",
  limits: "One request per 5 seconds; coverage 2017 → today (default window: last 3 months, or the sentence's year).",
  configured: () => true,
  async search(q, _creds, signal) {
    if (q.year && q.year < 2017) throw new ResearchError("gdelt", "UNSUPPORTED", `GDELT's news index starts in 2017; the sentence is about ${q.year}.`);
    const query = gdeltQuery(q.query);
    if (!query) return [];
    return (await call(query, q.year, q.limit, signal)).map(toCandidate);
  },
  async getMetadata(externalId) {
    // Articles are identified by URL; there is no per-article endpoint.
    return { ...toCandidate({ url: externalId, title: externalId, seendate: "", domain: hostOf(externalId) ?? "" }) };
  },
  getPreview: (c) => ({ kind: "thumbnail", url: c.thumbnailUrl }),
  getSource: (c) => ({ url: c.sourceUrl, label: `Open on ${c.platform}` }),
  async test() {
    try {
      const r = await call("election", null, 5);
      return { state: "CONNECTED", message: `OK — public API, ${r.length} test result(s). No key needed.` };
    } catch (e) {
      const err = e as ResearchError;
      return { state: err.code === "RATE_LIMITED" ? "RATE_LIMITED" : "UNAVAILABLE", message: err.message };
    }
  },
};
