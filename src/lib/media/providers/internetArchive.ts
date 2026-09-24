import type { NormalizedAsset, RightsStatus } from "@/lib/domain/types";
import { classifyLicense } from "@/lib/media/rights";
import { BaseProvider } from "./base";
import { fetchJson, ProviderError } from "./http";
import { assetId, type SearchParams, type SearchResult } from "./types";

// Internet Archive Advanced Search + Metadata APIs (public, no key needed for reads).
const SEARCH = "https://archive.org/advancedsearch.php";
const METADATA = "https://archive.org/metadata";

/** Curated collections whose items are public domain (US government works / Prelinger). */
const TRUSTED_PD_COLLECTIONS = new Set(["prelinger", "fedflix", "nasa", "usnationalarchives", "ephemera", "prelinger_library"]);
/** Collections of copyrighted broadcast material — never usable automatically. */
const RESTRICTED_COLLECTIONS = new Set(["tvnews", "tvarchive", "tv", "sports", "anime", "moviesandfilms_copyrighted"]);

interface IaDoc {
  identifier: string;
  title?: string | string[];
  description?: string | string[];
  creator?: string | string[];
  date?: string;
  year?: number | string;
  licenseurl?: string;
  rights?: string | string[];
  mediatype?: string;
  collection?: string | string[];
}
interface IaFile {
  name: string;
  format?: string;
  size?: string;
  length?: string;
  width?: string;
  height?: string;
  source?: string;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

export function iaRights(doc: IaDoc): { status: RightsStatus; attributionRequired: boolean; notes: string[] } {
  const collections = list(doc.collection).map((c) => c.toLowerCase());
  if (collections.some((c) => RESTRICTED_COLLECTIONS.has(c))) {
    return {
      status: "RESTRICTED",
      attributionRequired: true,
      notes: ["Broadcast/TV collection: footage is copyrighted by the broadcaster."],
    };
  }
  const declared = classifyLicense(first(doc.rights), doc.licenseurl);
  if (!doc.licenseurl && !doc.rights) {
    return {
      status: "UNKNOWN",
      attributionRequired: false,
      notes: ["No rights metadata. Internet Archive hosting does not imply the item is reusable."],
    };
  }
  const trusted = collections.some((c) => TRUSTED_PD_COLLECTIONS.has(c));
  if (trusted && declared.status === "CLEAR") {
    return { status: "CLEAR", attributionRequired: false, notes: ["Public domain (curated collection)."] };
  }
  if (declared.status === "RESTRICTED") return declared;
  // Uploader-declared licences are not verified by the Archive.
  return {
    status: "USER_REVIEW",
    attributionRequired: declared.attributionRequired,
    notes: [
      `Uploader-declared licence: ${doc.licenseurl ?? first(doc.rights)}. Not verified by Internet Archive — confirm before publishing.`,
      ...declared.notes,
    ],
  };
}

export class InternetArchiveProvider extends BaseProvider {
  readonly id = "internet_archive" as const;
  readonly name = "Internet Archive";
  readonly requiresKey = false;

  supportsImages() {
    return true;
  }
  supportsVideo() {
    return true;
  }
  isConfigured() {
    return true;
  }

  private docToAsset(doc: IaDoc, type: "video" | "photo"): NormalizedAsset {
    const rights = iaRights(doc);
    const creator = first(doc.creator);
    const title = first(doc.title) ?? doc.identifier;
    const year = Number(doc.year ?? doc.date?.slice(0, 4));
    const page = `https://archive.org/details/${doc.identifier}`;
    return {
      id: assetId("internet_archive", doc.identifier),
      provider: "internet_archive",
      providerAssetId: doc.identifier,
      type,
      title,
      description: first(doc.description)?.replace(/<[^>]*>/g, " ").slice(0, 500) ?? null,
      thumbnailUrl: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
      // The concrete file is resolved lazily (resolveFile) — search results only carry the item.
      mediaUrl: page,
      previewUrl: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
      downloadUrl: page,
      width: null,
      height: null,
      duration: null,
      author: creator,
      authorUrl: null,
      sourceUrl: page,
      license: doc.licenseurl ?? first(doc.rights) ?? "Unknown",
      licenseUrl: doc.licenseurl ?? null,
      attribution: `${title}${creator ? ` — ${creator}` : ""}, via Internet Archive`,
      attributionRequired: rights.attributionRequired,
      rightsStatus: rights.status,
      rightsNotes: rights.notes,
      retrievedAt: new Date().toISOString(),
      date: doc.date ?? (doc.year ? String(doc.year) : null),
      categories: list(doc.collection),
      archival: true,
      score: Number.isFinite(year) && year > 0 && year < 1990 ? 5 : 0,
    };
  }

  private async search(params: SearchParams, mediatype: "movies" | "image"): Promise<SearchResult> {
    const perPage = Math.min(params.perPage ?? 15, 50);
    const page = params.page ?? 1;
    const q = new URLSearchParams({
      q: `(${params.query}) AND mediatype:(${mediatype}) AND -collection:(tvnews OR tvarchive)`,
      rows: String(perPage),
      page: String(page),
      output: "json",
      "sort[]": "downloads desc",
    });
    for (const f of ["identifier", "title", "description", "creator", "date", "year", "licenseurl", "rights", "mediatype", "collection"]) {
      q.append("fl[]", f);
    }
    const data = await fetchJson<{ response: { numFound: number; docs: IaDoc[] } }>(this.id, `${SEARCH}?${q}`);
    const type = mediatype === "movies" ? "video" : "photo";
    return {
      assets: data.response.docs.map((d) => this.docToAsset(d, type)),
      page,
      hasMore: page * perPage < data.response.numFound,
    };
  }

  searchImages(params: SearchParams): Promise<SearchResult> {
    return this.search(params, "image");
  }

  searchVideos(params: SearchParams): Promise<SearchResult> {
    return this.search(params, "movies");
  }

  async getAsset(identifier: string): Promise<NormalizedAsset | null> {
    if (!/^[A-Za-z0-9._-]+$/.test(identifier)) return null;
    const data = await fetchJson<{ metadata?: IaDoc & { mediatype?: string }; files?: IaFile[] }>(
      this.id,
      `${METADATA}/${identifier}`,
    );
    if (!data.metadata) return null;
    const type = data.metadata.mediatype === "image" ? "photo" : "video";
    const asset = this.docToAsset({ ...data.metadata, identifier }, type);
    const file = pickFile(data.files ?? [], type);
    if (!file) return { ...asset, rightsNotes: [...asset.rightsNotes, "No renderable file found in this item."] };
    const url = `https://archive.org/download/${encodeURIComponent(identifier)}/${file.name.split("/").map(encodeURIComponent).join("/")}`;
    return {
      ...asset,
      mediaUrl: url,
      downloadUrl: url,
      width: file.width ? Number(file.width) : null,
      height: file.height ? Number(file.height) : null,
      duration: file.length ? parseLength(file.length) : null,
    };
  }

  /** Resolve an item-level asset from search into a concrete downloadable file. */
  async resolveFile(asset: NormalizedAsset): Promise<NormalizedAsset> {
    if (/\.(mp4|m4v|webm|ogv|mov|jpe?g|png|gif)$/i.test(asset.mediaUrl)) return asset;
    const resolved = await this.getAsset(asset.providerAssetId);
    if (!resolved || resolved.mediaUrl === asset.mediaUrl) {
      throw new ProviderError(this.id, "NOT_FOUND", `no renderable file in item ${asset.providerAssetId}`);
    }
    return { ...resolved, rightsStatus: asset.rightsStatus, rightsNotes: asset.rightsNotes };
  }
}

function parseLength(len: string): number | null {
  if (/^\d+(\.\d+)?$/.test(len)) return Number(len);
  const parts = len.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function pickFile(files: IaFile[], type: "video" | "photo"): IaFile | undefined {
  if (type === "video") {
    const mp4 = files.filter((f) => /\.mp4$/i.test(f.name) && !/\.thumbs\//.test(f.name));
    // Prefer an h.264 derivative under ~400 MB; ffmpeg seeks with HTTP range requests so size matters less.
    const byPref = (f: IaFile) => (/h\.264/i.test(f.format ?? "") ? 0 : /512kb/i.test(f.format ?? "") ? 1 : 2);
    return mp4
      .filter((f) => Number(f.size ?? 0) < 400_000_000)
      .sort((a, b) => byPref(a) - byPref(b) || Number(b.width ?? 0) - Number(a.width ?? 0))[0];
  }
  const images = files.filter(
    (f) => /\.(jpe?g|png)$/i.test(f.name) && !/thumb|__ia_thumb/i.test(f.name) && f.format !== "Thumbnail",
  );
  return images.sort((a, b) => Number(b.size ?? 0) - Number(a.size ?? 0))[0];
}
