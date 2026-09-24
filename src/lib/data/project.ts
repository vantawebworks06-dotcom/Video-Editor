import type { SupabaseClient } from "@supabase/supabase-js";
import { createClaudeClient } from "@/lib/ai/claude/client";
import { ClaudeService } from "@/lib/ai/claude/service";
import { MODEL_BUDGET, MODEL_DEFAULT, UsageTracker } from "@/lib/ai/claude/usage";
import { getPreset } from "@/lib/domain/presets";
import { DEFAULT_SETTINGS, ProjectSettings, StyleProfile } from "@/lib/domain/types";
import { ClaudeDirector } from "@/lib/pipeline/claudeDirector";
import type { Director } from "@/lib/pipeline/director";
import { HeuristicDirector } from "@/lib/pipeline/heuristicDirector";
import type { ResolvedCredentials } from "@/lib/settings/credentials";
import { SupabaseAiCache, usageSink } from "./store";

export function parseSettings(raw: unknown): ProjectSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(typeof raw === "object" && raw ? raw : {}) } as Record<string, unknown>;
  merged.mix = { ...DEFAULT_SETTINGS.mix, ...((merged.mix as object) ?? {}) };
  const r = ProjectSettings.safeParse(merged);
  return r.success ? r.data : DEFAULT_SETTINGS;
}

export async function resolveStyle(db: SupabaseClient, styleProfileId: string | null, settings: ProjectSettings): Promise<StyleProfile> {
  if (styleProfileId) {
    const { data } = await db.from("style_profiles").select("profile").eq("id", styleProfileId).maybeSingle();
    const parsed = data ? StyleProfile.safeParse(data.profile) : null;
    if (parsed?.success) return parsed.data;
  }
  return getPreset(settings.stylePreset).profile;
}

export function makeClaude(
  creds: ResolvedCredentials,
  settings: ProjectSettings,
  db: SupabaseClient | null,
  ids: { userId: string; projectId: string | null },
): { claude: ClaudeService | null; usage: UsageTracker } {
  const usage = new UsageTracker(db ? usageSink(db, ids.userId, ids.projectId) : undefined);
  if (!creds.anthropic) return { claude: null, usage };
  const claude = new ClaudeService(
    {
      client: createClaudeClient(creds.anthropic),
      model: settings.budgetMode ? MODEL_BUDGET : MODEL_DEFAULT,
      effort: settings.budgetMode ? "low" : "medium",
      cache: db ? new SupabaseAiCache(db) : undefined,
      usage,
    },
    settings.budgetMode,
  );
  return { claude, usage };
}

export function makeDirector(claude: ClaudeService | null, settings: ProjectSettings): Director {
  return claude ? new ClaudeDirector(claude, settings.budgetMode ? 6 : 12) : new HeuristicDirector();
}
