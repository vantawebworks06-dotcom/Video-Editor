import "server-only";
import { SupabaseSearchCache } from "@/lib/data/store";
import { MemorySearchCache, type SearchCache } from "@/lib/media/cache";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";

const memory = new MemorySearchCache();

/** Shared DB-backed search cache when the service role is configured; in-memory otherwise. */
export function getSearchCache(): SearchCache {
  return hasServiceRole() ? new SupabaseSearchCache(createAdminClient()) : memory;
}

/** Admin client for AI response caching/usage, if configured. */
export function maybeAdmin() {
  return hasServiceRole() ? createAdminClient() : null;
}
