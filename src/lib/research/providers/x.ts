/**
 * X (Twitter) API v2 — recent search of public posts.
 *
 * Since 2026 the X API is pay-per-use for new developers (about $0.005 per post read; recent
 * search returns at least 10 posts per call) and recent search only covers the last 7 days. Older
 * posts are added by pasting their link: the official oEmbed endpoint (keyless) gives author, text
 * and date, and the capture keeps them visible. Posts are never fabricated or edited.
 * https://docs.x.com/x-api/posts/search-recent-posts
 */
import { getJson } from "../http";
import { xOEmbed } from "../platforms";
import { type Candidate, ResearchError, type ResearchProvider } from "../types";

const API = "https://api.x.com/2";

interface Post {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  public_metrics?: { retweet_count?: number; reply_count?: number; like_count?: number; quote_count?: number; impression_count?: number };
  attachments?: { media_keys?: string[] };
}
interface User {
  id: string;
  name: string;
  username: string;
  verified?: boolean;
  profile_image_url?: string;
}
interface Media {
  media_key: string;
  type: string;
  url?: string;
  preview_image_url?: string;
}

/** X query syntax: keep words/phrases, drop punctuation that would change the operator meaning. */
function xQuery(q: string): string {
  const words = q.replace(/[()"“”:]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !/^(OR|AND)$/i.test(w));
  return `${words.slice(0, 10).join(" ")} -is:retweet lang:en`;
}

function toCandidate(p: Post, users: Map<string, User>, media: Map<string, Media>): Candidate {
  const u = p.author_id ? users.get(p.author_id) : undefined;
  const m = p.attachments?.media_keys?.map((k) => media.get(k)).find(Boolean);
  const pm = p.public_metrics ?? {};
  return {
    provider: "x",
    externalId: p.id,
    category: "social",
    title: p.text.replace(/\s+/g, " ").slice(0, 180),
    description: u ? `${u.name} (@${u.username})${u.verified ? " · verified" : ""}` : null,
    excerpt: p.text,
    sourceUrl: `https://x.com/${u?.username ?? "i/web"}/status/${p.id}`,
    platform: "X",
    account: u ? `@${u.username}` : null,
    accountUrl: u ? `https://x.com/${u.username}` : null,
    publishedAt: p.created_at ?? null,
    duration: null,
    thumbnailUrl: m?.url ?? m?.preview_image_url ?? u?.profile_image_url ?? null,
    embed: { kind: "x", postId: p.id },
    segment: null,
    license: "© the author — shown via X's embed or a context-preserving capture",
    metrics: { likes: pm.like_count, comments: pm.reply_count, shares: (pm.retweet_count ?? 0) + (pm.quote_count ?? 0), views: pm.impression_count },
    credibility: u?.verified ? 0.6 : 0.45,
  };
}

async function search(query: string, max: number, token: string, signal?: AbortSignal) {
  const params = new URLSearchParams({
    query,
    max_results: String(Math.min(100, Math.max(10, max))),
    sort_order: "relevancy",
    "tweet.fields": "created_at,public_metrics,author_id,attachments",
    expansions: "author_id,attachments.media_keys",
    "user.fields": "name,username,verified,profile_image_url",
    "media.fields": "type,url,preview_image_url",
  });
  return getJson<{ data?: Post[]; includes?: { users?: User[]; media?: Media[] }; meta?: { result_count?: number } }>("x", `${API}/tweets/search/recent?${params}`, { headers: { Authorization: `Bearer ${token}` }, signal });
}

export const x: ResearchProvider = {
  id: "x",
  name: "X (Twitter)",
  categories: ["social"],
  capabilities: { search: true, preview: "embed", capture: true, import: "none" },
  credentials: [{ key: "xBearer", env: ["X_BEARER_TOKEN"], label: "App bearer token (X developer console)", required: true }],
  docsUrl: "https://docs.x.com/x-api/posts/search-recent-posts",
  terms: "Public posts via the official API and embed. Recent search covers the last 7 days only; older posts: paste the link (keyless oEmbed). Capture a screenshot of the embed to show a post — never edited or fabricated.",
  limits: "Pay-per-use: ~$0.005 per post read; each search reads 10+ posts (≈ $0.05). Capped at 3M reads/month.",
  configured: (c) => Boolean(c.xBearer),
  async search(q, creds, signal) {
    if (!creds.xBearer) throw new ResearchError("x", "NOT_CONFIGURED", "Add an X bearer token (X_BEARER_TOKEN) in Settings → Integrations. X search is billed per post read.");
    const r = await search(xQuery(q.query), q.limit, creds.xBearer, signal).catch((e: ResearchError) => {
      if (e.code === "QUOTA_EXCEEDED") throw new ResearchError("x", "QUOTA_EXCEEDED", "X API credits exhausted or the monthly cap was reached.");
      throw e;
    });
    const users = new Map((r.includes?.users ?? []).map((u) => [u.id, u]));
    const media = new Map((r.includes?.media ?? []).map((m) => [m.media_key, m]));
    return (r.data ?? []).map((p) => toCandidate(p, users, media));
  },
  async getMetadata(externalId, _creds, signal) {
    // Keyless and free: the official oEmbed of the post.
    const o = await xOEmbed(`https://x.com/i/status/${externalId}`, signal);
    return {
      provider: "x",
      externalId,
      category: "social",
      title: o.text.slice(0, 180) || "Post on X",
      description: null,
      excerpt: o.text || null,
      sourceUrl: o.authorUrl ? `${o.authorUrl}/status/${externalId}` : `https://x.com/i/status/${externalId}`,
      platform: "X",
      account: o.author,
      accountUrl: o.authorUrl,
      publishedAt: o.date,
      duration: null,
      thumbnailUrl: null,
      embed: { kind: "x", postId: externalId },
      segment: null,
      license: "© the author",
      credibility: 0.45,
    };
  },
  getPreview: (c) => c.embed ?? { kind: "thumbnail", url: c.thumbnailUrl },
  getSource: (c) => ({ url: c.sourceUrl, label: "Open on X" }),
  async test(creds) {
    if (!creds.xBearer) return { state: "REQUIRES_CONFIGURATION", message: "No X_BEARER_TOKEN. Create an app in the X developer console (pay-per-use billing)." };
    try {
      // The cheapest authenticated call that proves the token: a 10-post search (~$0.05).
      const r = await search("news -is:retweet", 10, creds.xBearer);
      return { state: "CONNECTED", message: `OK — ${r.meta?.result_count ?? 0} post(s) read (billed per post).` };
    } catch (e) {
      const err = e as ResearchError;
      return { state: err.code === "RATE_LIMITED" || err.code === "QUOTA_EXCEEDED" ? "RATE_LIMITED" : err.code === "INVALID_CREDENTIALS" || err.code === "FORBIDDEN" ? "NOT_CONNECTED" : "UNAVAILABLE", message: err.message };
    }
  },
};
