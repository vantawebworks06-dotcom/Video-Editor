/**
 * A link the user pastes: read what the page itself publishes (OpenGraph/JSON-LD, or the
 * platform's official oEmbed) so it becomes a sourced reference with account, date and preview.
 * Nothing is downloaded; to use the content on screen the user captures a screenshot (where
 * permitted) or uploads a copy they are authorised to use.
 */
import { domainCredibility } from "../credibility";
import { hostOf } from "../http";
import { metaOEmbed, pageMeta, platformOf, xOEmbed, youtubeOEmbed } from "../platforms";
import { safeFetch } from "../safeFetch";
import { type Candidate, type ResearchCredentials, ResearchError, type ResearchProvider } from "../types";

function base(url: string): Candidate {
  return {
    provider: "url",
    externalId: url.slice(0, 400),
    category: "web",
    title: url,
    description: null,
    excerpt: null,
    sourceUrl: url,
    platform: hostOf(url) ?? "Web",
    account: null,
    accountUrl: null,
    publishedAt: null,
    duration: null,
    thumbnailUrl: null,
    embed: null,
    segment: null,
    license: "© the rights holder — reference only unless you have permission",
    credibility: domainCredibility(url).score,
  };
}

export async function describeUrl(raw: string, creds: ResearchCredentials, signal?: AbortSignal): Promise<Candidate> {
  const { platform, id } = platformOf(raw.trim());
  const c = base(raw.trim());
  switch (platform) {
    case "youtube": {
      if (!id) throw new ResearchError("url", "BAD_RESPONSE", "That YouTube link has no video id.");
      const o = await youtubeOEmbed(id, signal);
      return { ...c, externalId: id, provider: "url", category: "video", title: o.title ?? "YouTube video", platform: "YouTube", account: o.author_name ?? null, accountUrl: o.author_url ?? null, thumbnailUrl: o.thumbnail_url ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, sourceUrl: `https://www.youtube.com/watch?v=${id}`, embed: { kind: "youtube", videoId: id }, license: "Standard YouTube licence — may not be downloaded; preview via embed" };
    }
    case "x": {
      if (!id) throw new ResearchError("url", "BAD_RESPONSE", "That X link is not a post.");
      const o = await xOEmbed(raw, signal);
      return { ...c, externalId: id, category: "social", title: o.text ? o.text.slice(0, 180) : "Post on X", excerpt: o.text || null, platform: "X", account: o.author, accountUrl: o.authorUrl, publishedAt: o.date, embed: { kind: "x", postId: id }, license: "© the author — shown via X's embed; capture keeps attribution" };
    }
    case "facebook":
    case "instagram": {
      const name = platform === "facebook" ? "Facebook" : "Instagram";
      if (!creds.metaOembed) {
        return { ...c, category: "social", title: `${name} post`, platform: name, description: `${name} content can only be previewed through Meta's oEmbed Read (requires a Meta app that passed App Review — META_OEMBED_TOKEN). The link is saved; capture or upload a screenshot to use it.` };
      }
      const o = await metaOEmbed(raw, platform, creds.metaOembed, signal);
      return { ...c, category: "social", title: o.title || `${name} post`, platform: name, account: o.author_name ?? null, accountUrl: o.author_url ?? null, thumbnailUrl: o.thumbnail_url ?? null };
    }
    case "reddit":
    case "tiktok":
    case "web":
    default: {
      const page = await safeFetch(raw, { signal });
      if (/^image\//.test(page.contentType)) return { ...c, category: "photo", title: page.url.split("/").pop() || "Image", thumbnailUrl: page.url };
      if (/^video\//.test(page.contentType)) return { ...c, category: "video", title: page.url.split("/").pop() || "Video" };
      const m = pageMeta(page.body);
      const ogType = m["og:type"] ?? "";
      const isArticle = /article|news/.test(ogType) || Boolean(m["article:published_time"]);
      const cat = platform === "reddit" || platform === "tiktok" ? "social" : /video/.test(ogType) ? "video" : isArticle ? "article" : "web";
      const img = m["og:image"] ?? m["twitter:image"] ?? null;
      return {
        ...c,
        sourceUrl: m.canonical && /^https?:/.test(m.canonical) ? m.canonical : page.url,
        category: cat,
        title: (m["og:title"] ?? m["twitter:title"] ?? m.title ?? page.url).slice(0, 300),
        description: m["og:description"] ?? m.description ?? null,
        platform: m["og:site_name"] ?? hostOf(page.url) ?? "Web",
        account: m.author ?? m["article:author"] ?? m["og:site_name"] ?? null,
        publishedAt: m["article:published_time"] ?? m["og:updated_time"] ?? null,
        thumbnailUrl: img && /^https?:/.test(img) ? img : img ? new URL(img, page.url).toString() : null,
      };
    }
  }
}

export const urlProvider: ResearchProvider = {
  id: "url",
  name: "Link (user-provided)",
  categories: ["web", "article", "social", "video", "photo"],
  capabilities: { search: false, preview: "embed", capture: true, import: "authorised-copy" },
  credentials: [],
  docsUrl: "https://oembed.com/",
  terms: "Reads the metadata a page publishes about itself (OpenGraph/JSON-LD) or the platform's official oEmbed. Private networks are never fetched; paywalls and logins are not bypassed.",
  limits: "One fetch per link (12 s timeout, 1.5 MB cap).",
  configured: () => true,
  async search() {
    throw new ResearchError("url", "UNSUPPORTED", "Paste a link instead of searching.");
  },
  getMetadata: (externalId, creds, signal) => describeUrl(externalId, creds, signal),
  getPreview: (c) => c.embed ?? { kind: "thumbnail", url: c.thumbnailUrl },
  getSource: (c) => ({ url: c.sourceUrl, label: `Open on ${c.platform}` }),
  async test() {
    return { state: "CONNECTED", message: "Always available (no account needed)." };
  },
};
