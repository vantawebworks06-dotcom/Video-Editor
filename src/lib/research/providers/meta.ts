/**
 * Facebook & Instagram. Meta offers no public post search API (CrowdTangle closed in 2024; the
 * Meta Content Library is limited to approved researchers), so this provider cannot search. What
 * Meta does allow is oEmbed Read: embed HTML and basic metadata for a *given* public post, with an
 * app token from an app that passed App Review and business verification. The user pastes a link;
 * the post is previewed/embedded, and can be captured or uploaded as a screenshot.
 */
import { metaOEmbed, platformOf } from "../platforms";
import { type Candidate, ResearchError, type ResearchProvider } from "../types";

export const meta: ResearchProvider = {
  id: "meta",
  name: "Facebook / Instagram",
  categories: ["social"],
  capabilities: { search: false, preview: "embed", capture: true, import: "none" },
  credentials: [{ key: "metaOembed", env: ["META_OEMBED_TOKEN"], label: "App access token app-id|client-token (oEmbed Read, after App Review)", required: false }],
  docsUrl: "https://developers.facebook.com/docs/features-reference/meta-oembed-read",
  terms: "No public search exists. Paste a post link: with an approved app token it is embedded via oEmbed Read; otherwise the link is saved and you capture or upload a screenshot.",
  limits: "oEmbed Read requires App Review + business verification; standard Graph API rate limits.",
  configured: (c) => Boolean(c.metaOembed),
  async search() {
    throw new ResearchError("meta", "UNSUPPORTED", "Meta provides no public search API for Facebook/Instagram posts. Paste a post link instead.");
  },
  async getMetadata(externalId, creds, signal): Promise<Candidate | null> {
    const { platform } = platformOf(externalId);
    if (platform !== "facebook" && platform !== "instagram") return null;
    if (!creds.metaOembed) throw new ResearchError("meta", "NOT_CONFIGURED", "Previewing Facebook/Instagram posts needs META_OEMBED_TOKEN (oEmbed Read).");
    const o = await metaOEmbed(externalId, platform, creds.metaOembed, signal);
    return {
      provider: "meta",
      externalId: externalId.slice(0, 400),
      category: "social",
      title: o.title || `${platform === "facebook" ? "Facebook" : "Instagram"} post`,
      description: null,
      excerpt: null,
      sourceUrl: externalId,
      platform: platform === "facebook" ? "Facebook" : "Instagram",
      account: o.author_name ?? null,
      accountUrl: o.author_url ?? null,
      publishedAt: null,
      duration: null,
      thumbnailUrl: o.thumbnail_url ?? null,
      embed: null,
      segment: null,
      license: "© the author",
      credibility: 0.45,
    };
  },
  getPreview: (c) => ({ kind: "thumbnail", url: c.thumbnailUrl }),
  getSource: (c) => ({ url: c.sourceUrl, label: `Open on ${c.platform}` }),
  async test(creds) {
    if (!creds.metaOembed) return { state: "REQUIRES_CONFIGURATION", message: "Optional: META_OEMBED_TOKEN from a Meta app with oEmbed Read approved. Without it, Facebook/Instagram links are saved and captured/uploaded as screenshots." };
    try {
      await metaOEmbed("https://www.facebook.com/facebook/posts/10153231379946729", "facebook", creds.metaOembed);
      return { state: "CONNECTED", message: "OK — oEmbed Read answered." };
    } catch (e) {
      const err = e as ResearchError;
      return { state: err.code === "RATE_LIMITED" ? "RATE_LIMITED" : err.code === "INVALID_CREDENTIALS" || err.code === "FORBIDDEN" ? "NOT_CONNECTED" : "UNAVAILABLE", message: err.message };
    }
  },
};
