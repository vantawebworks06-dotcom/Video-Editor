/**
 * Wikipedia — keyless encyclopaedia search. A starting point for context (who/what/when) and for
 * finding primary sources through its references; never itself treated as proof of a claim.
 */
import { getJson } from "../http";
import type { Candidate, ResearchProvider } from "../types";

const API = "https://en.wikipedia.org/w/api.php";

interface Page {
  pageid: number;
  title: string;
  extract?: string;
  fullurl?: string;
  touched?: string;
  thumbnail?: { source: string };
  description?: string;
}

async function pages(params: Record<string, string>, signal?: AbortSignal): Promise<Page[]> {
  const q = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "extracts|pageimages|info|description",
    exintro: "1",
    explaintext: "1",
    exsentences: "3",
    piprop: "thumbnail",
    pithumbsize: "480",
    inprop: "url",
    origin: "*",
    ...params,
  });
  const j = await getJson<{ query?: { pages?: (Page & { index?: number })[] } }>("wikipedia", `${API}?${q}`, { signal });
  return (j.query?.pages ?? []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

function toCandidate(p: Page): Candidate {
  return {
    provider: "wikipedia",
    externalId: String(p.pageid),
    category: "article",
    title: p.title,
    description: p.description ?? null,
    excerpt: p.extract?.slice(0, 900) ?? null,
    sourceUrl: p.fullurl ?? `https://en.wikipedia.org/?curid=${p.pageid}`,
    platform: "Wikipedia",
    account: null,
    accountUrl: null,
    publishedAt: p.touched ?? null,
    duration: null,
    thumbnailUrl: p.thumbnail?.source ?? null,
    embed: null,
    segment: null,
    license: "Text CC BY-SA 4.0 (Wikipedia contributors); images licensed individually",
    credibility: 0.6,
  };
}

export const wikipedia: ResearchProvider = {
  id: "wikipedia",
  name: "Wikipedia",
  categories: ["article"],
  capabilities: { search: true, preview: "thumbnail", capture: true, import: "none" },
  credentials: [],
  docsUrl: "https://www.mediawiki.org/wiki/API:Main_page",
  terms: "Keyless. Text is CC BY-SA; cite it for context and follow its references to primary sources. Not treated as evidence on its own.",
  limits: "Polite use; identifying User-Agent sent.",
  configured: () => true,
  async search(q, _creds, signal) {
    return (await pages({ generator: "search", gsrsearch: q.query, gsrlimit: String(Math.min(10, q.limit)) }, signal)).map(toCandidate);
  },
  async getMetadata(externalId, _creds, signal) {
    const [p] = await pages({ pageids: externalId }, signal);
    return p ? toCandidate(p) : null;
  },
  getPreview: (c) => ({ kind: "thumbnail", url: c.thumbnailUrl }),
  getSource: (c) => ({ url: c.sourceUrl, label: "Open on Wikipedia" }),
  async test() {
    try {
      const r = await pages({ generator: "search", gsrsearch: "documentary film", gsrlimit: "2" });
      return { state: "CONNECTED", message: `OK — public API, ${r.length} test result(s). No key needed.` };
    } catch (e) {
      return { state: "UNAVAILABLE", message: (e as Error).message };
    }
  },
};
