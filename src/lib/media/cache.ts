import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NormalizedAsset } from "@/lib/domain/types";

export interface CachedSearch {
  provider: string;
  query: string;
  results: NormalizedAsset[];
  timestamp: number;
}

/** Search-result cache. Implementations: in-memory, file (CLI/worker), Supabase table (app). */
export interface SearchCache {
  get(key: string): Promise<CachedSearch | null>;
  set(key: string, value: CachedSearch): Promise<void>;
}

export const SEARCH_CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_TTL_HOURS ?? 24) * 3600_000;
/**
 * Archive search results (Wikimedia Commons, Internet Archive) change rarely, and Internet
 * Archive is the slowest provider by far (~1–3 s per search), so they are kept for 7 days — the
 * worker's cleanup window. Stock providers keep 24 h (Pixabay's API terms cap caching at 24 h).
 */
const ARCHIVE_CACHE_TTL_MS = 7 * 24 * 3600_000;

export function searchCacheTtlMs(provider: string): number {
  return provider === "wikimedia" || provider === "internet_archive" || provider === "wikipedia" ? Math.max(ARCHIVE_CACHE_TTL_MS, SEARCH_CACHE_TTL_MS) : SEARCH_CACHE_TTL_MS;
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** JSON.stringify with sorted keys so equal inputs always hash the same. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export class MemorySearchCache implements SearchCache {
  private map = new Map<string, CachedSearch>();
  async get(key: string) {
    const hit = this.map.get(key);
    return hit && Date.now() - hit.timestamp < searchCacheTtlMs(hit.provider) ? hit : null;
  }
  async set(key: string, value: CachedSearch) {
    this.map.set(key, value);
  }
}

export class FileSearchCache implements SearchCache {
  constructor(private dir = path.join(process.cwd(), ".cache", "search")) {}
  private file(key: string) {
    return path.join(this.dir, `${key}.json`);
  }
  async get(key: string) {
    try {
      const hit = JSON.parse(await readFile(this.file(key), "utf8")) as CachedSearch;
      return Date.now() - hit.timestamp < searchCacheTtlMs(hit.provider) ? hit : null;
    } catch {
      return null;
    }
  }
  async set(key: string, value: CachedSearch) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(key), JSON.stringify(value));
  }
}
