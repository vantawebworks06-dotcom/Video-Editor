/**
 * Reddit Data API — search public posts with an app-only OAuth token.
 *
 * Since May 2026 unauthenticated .json access answers 403, and new OAuth apps need manual approval
 * under Reddit's Responsible Builder Policy. So this provider only runs with credentials of an
 * approved app ("client_id:client_secret", REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET) and a
 * descriptive User-Agent (REDDIT_USER_AGENT). https://www.reddit.com/dev/api/
 */
import { getJson } from "../http";
import { type Candidate, ResearchError, type ResearchProvider } from "../types";

const UA = () => process.env.REDDIT_USER_AGENT?.trim() || "web:docucut-research:0.1 (documentary research tool)";

let token: { value: string; expires: number; for: string } | null = null;

async function accessToken(creds: string, signal?: AbortSignal): Promise<string> {
  if (token && token.for === creds && token.expires > Date.now() + 60_000) return token.value;
  const [id, secret] = creds.split(":");
  if (!id || !secret) throw new ResearchError("reddit", "NOT_CONFIGURED", "Reddit credentials must be client_id:client_secret.");
  const r = await getJson<{ access_token?: string; expires_in?: number; error?: string }>("reddit", "https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA() },
    body: "grant_type=client_credentials",
    signal,
  }).catch((e: ResearchError) => {
    if (e.code === "INVALID_CREDENTIALS" || e.code === "FORBIDDEN") throw new ResearchError("reddit", "INVALID_CREDENTIALS", "Reddit rejected the app credentials (the app may not be approved under the Responsible Builder Policy).");
    throw e;
  });
  if (!r.access_token) throw new ResearchError("reddit", "INVALID_CREDENTIALS", `Reddit did not issue a token${r.error ? ` (${r.error})` : ""}.`);
  token = { value: r.access_token, expires: Date.now() + (r.expires_in ?? 3600) * 1000, for: creds };
  return token.value;
}

interface Listing {
  data?: { children?: { data: Post }[] };
}
interface Post {
  id: string;
  title: string;
  selftext?: string;
  author?: string;
  subreddit_name_prefixed?: string;
  permalink: string;
  url?: string;
  created_utc?: number;
  score?: number;
  num_comments?: number;
  thumbnail?: string;
  preview?: { images?: { source?: { url?: string } }[] };
  over_18?: boolean;
  removed_by_category?: string | null;
}

function toCandidate(p: Post): Candidate {
  const thumb = p.preview?.images?.[0]?.source?.url?.replace(/&amp;/g, "&") ?? (p.thumbnail && /^https?:/.test(p.thumbnail) ? p.thumbnail : null);
  return {
    provider: "reddit",
    externalId: p.id,
    category: "social",
    title: p.title,
    description: `${p.subreddit_name_prefixed ?? "Reddit"} · ${p.score ?? 0} points · ${p.num_comments ?? 0} comments`,
    excerpt: p.selftext ? p.selftext.slice(0, 1200) : null,
    sourceUrl: `https://www.reddit.com${p.permalink}`,
    platform: `Reddit ${p.subreddit_name_prefixed ?? ""}`.trim(),
    account: p.author ? `u/${p.author}` : null,
    accountUrl: p.author ? `https://www.reddit.com/user/${p.author}` : null,
    publishedAt: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null,
    duration: null,
    thumbnailUrl: thumb,
    embed: null,
    segment: null,
    license: "© the author — capture for reference; reuse per Reddit's terms",
    metrics: { likes: p.score, comments: p.num_comments },
    credibility: 0.4,
  };
}

export const reddit: ResearchProvider = {
  id: "reddit",
  name: "Reddit",
  categories: ["social"],
  capabilities: { search: true, preview: "thumbnail", capture: true, import: "none" },
  credentials: [{ key: "reddit", env: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"], label: "App credentials client_id:client_secret (approved app)", required: true }],
  docsUrl: "https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy",
  terms: "Public posts via the official OAuth API only (unauthenticated access is blocked since May 2026). New apps need Reddit's approval under the Responsible Builder Policy. Capture keeps subreddit, author and date visible.",
  limits: "Free tier ~100 queries/minute per approved OAuth client.",
  configured: (c) => Boolean(c.reddit),
  async search(q, creds, signal) {
    if (!creds.reddit) throw new ResearchError("reddit", "NOT_CONFIGURED", "Reddit needs an approved OAuth app (REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET). Unauthenticated access has been blocked since May 2026.");
    const t = await accessToken(creds.reddit, signal);
    const params = new URLSearchParams({ q: q.query, sort: "relevance", t: "all", limit: String(Math.min(25, q.limit)), type: "link", raw_json: "1" });
    const r = await getJson<Listing>("reddit", `https://oauth.reddit.com/search?${params}`, { headers: { Authorization: `Bearer ${t}`, "User-Agent": UA() }, signal });
    return (r.data?.children ?? []).map((c) => c.data).filter((p) => !p.over_18 && !p.removed_by_category).map(toCandidate);
  },
  async getMetadata(externalId, creds, signal) {
    if (!creds.reddit) return null;
    const t = await accessToken(creds.reddit, signal);
    const r = await getJson<Listing>("reddit", `https://oauth.reddit.com/by_id/t3_${encodeURIComponent(externalId)}?raw_json=1`, { headers: { Authorization: `Bearer ${t}`, "User-Agent": UA() }, signal });
    const p = r.data?.children?.[0]?.data;
    if (!p) throw new ResearchError("reddit", "NOT_FOUND", "The post was removed or is private.");
    return toCandidate(p);
  },
  getPreview: (c) => ({ kind: "thumbnail", url: c.thumbnailUrl }),
  getSource: (c) => ({ url: c.sourceUrl, label: "Open on Reddit" }),
  async test(creds) {
    if (!creds.reddit) return { state: "REQUIRES_CONFIGURATION", message: "No Reddit app credentials. Apply for API access under Reddit's Responsible Builder Policy, then set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET." };
    try {
      await accessToken(creds.reddit);
      return { state: "CONNECTED", message: "OK — app-only token issued." };
    } catch (e) {
      const err = e as ResearchError;
      return { state: err.code === "RATE_LIMITED" ? "RATE_LIMITED" : err.code === "INVALID_CREDENTIALS" ? "NOT_CONNECTED" : "UNAVAILABLE", message: err.message };
    }
  },
};
