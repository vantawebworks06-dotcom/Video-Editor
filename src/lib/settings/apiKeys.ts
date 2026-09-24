import { createClaudeClient, testClaude } from "@/lib/ai/claude/client";
import { getProvider } from "@/lib/media/providers";
import type { ConnectionStatus } from "@/lib/media/providers/types";
import { canEncrypt, decryptSecret, encryptSecret } from "@/lib/security/crypto";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";
import { CREDENTIAL_ENV, type CredentialName, keyHint, resolveEnvCredentials, type ResolvedCredentials } from "./credentials";

export const CONNECTIONS: { id: CredentialName; label: string; required: boolean; purpose: string }[] = [
  { id: "anthropic", label: "Claude", required: false, purpose: "Optional. Smarter scene planning, queries and visual ranking. Without it the built-in keyword director is used." },
  { id: "pexels", label: "Pexels", required: false, purpose: "Stock photos and video" },
  { id: "pixabay", label: "Pixabay", required: false, purpose: "Stock photos and video" },
  { id: "giphy", label: "GIPHY", required: false, purpose: "Reaction GIFs and stickers (memes)" },
  { id: "wikimediaToken", label: "Wikimedia Commons", required: false, purpose: "Archival photos/video — public API; optional OAuth token for higher limits" },
  { id: "internetArchive", label: "Internet Archive", required: false, purpose: "Archival footage — public API; optional S3 keys (access:secret)" },
  { id: "openai", label: "Transcription (OpenAI Whisper)", required: false, purpose: "Transcribe narration when no script is provided" },
];

/** Credentials for a user: keys saved in Settings override environment variables. */
export async function resolveCredentials(userId: string | null): Promise<ResolvedCredentials> {
  const creds = resolveEnvCredentials();
  if (!userId || !hasServiceRole() || !canEncrypt()) return creds;
  const { data } = await createAdminClient().from("api_settings").select("provider, encrypted_key").eq("user_id", userId);
  for (const row of data ?? []) {
    try {
      creds[row.provider as CredentialName] = decryptSecret(row.encrypted_key);
    } catch {
      // A key that no longer decrypts (rotated APP_ENCRYPTION_KEY) is ignored; Settings shows it as invalid.
    }
  }
  return creds;
}

export interface ConnectionView {
  id: CredentialName;
  label: string;
  purpose: string;
  required: boolean;
  source: "settings" | "environment" | "none";
  hint: string | null;
  status: string;
  message: string | null;
  lastTestedAt: string | null;
}

/** Safe-to-display connection summaries — never includes key material. */
export async function listConnections(userId: string): Promise<ConnectionView[]> {
  const rows = hasServiceRole()
    ? ((await createAdminClient().from("api_settings").select("provider, key_hint, status, last_error, last_tested_at").eq("user_id", userId)).data ?? [])
    : [];
  const env = resolveEnvCredentials();
  return CONNECTIONS.map((c) => {
    const row = rows.find((r) => r.provider === c.id);
    const envKey = env[c.id];
    const isPublic = c.id === "wikimediaToken" || c.id === "internetArchive";
    return {
      id: c.id,
      label: c.label,
      purpose: c.purpose,
      required: c.required,
      source: row ? "settings" : envKey ? "environment" : "none",
      hint: row?.key_hint ?? (envKey ? keyHint(envKey) : null),
      status: row?.status ?? (envKey ? "configured" : isPublic ? "public" : "not_connected"),
      message: row?.last_error ?? (isPublic && !row && !envKey ? "Public API — no key needed" : null),
      lastTestedAt: row?.last_tested_at ?? null,
    };
  });
}

export async function saveKey(userId: string, provider: CredentialName, value: string) {
  if (!CREDENTIAL_ENV[provider]) throw new Error("Unknown provider");
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 500 || /\s/.test(trimmed)) throw new Error("That does not look like a valid API key.");
  const { error } = await createAdminClient()
    .from("api_settings")
    .upsert({
      user_id: userId,
      provider,
      encrypted_key: encryptSecret(trimmed),
      key_hint: keyHint(trimmed),
      status: "untested",
      last_error: null,
      updated_at: new Date().toISOString(),
    });
  if (error) throw new Error(`Could not save key: ${error.message}`);
}

export async function deleteKey(userId: string, provider: CredentialName) {
  await createAdminClient().from("api_settings").delete().eq("user_id", userId).eq("provider", provider);
}

export async function testConnection(userId: string, provider: CredentialName): Promise<ConnectionStatus> {
  const creds = await resolveCredentials(userId);
  let status: ConnectionStatus;
  if (provider === "anthropic") status = await testClaude(creds.anthropic);
  else if (provider === "openai") status = await testOpenAi(creds.openai);
  else {
    const p = getProvider(provider === "wikimediaToken" ? "wikimedia" : provider === "internetArchive" ? "internet_archive" : provider);
    status = p ? await p.test(creds) : { state: "error", message: "Unknown provider" };
  }
  if (hasServiceRole()) {
    await createAdminClient()
      .from("api_settings")
      .update({ status: status.state, last_error: status.state === "connected" || status.state === "public" ? null : status.message, last_tested_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("provider", provider);
  }
  return status;
}

async function testOpenAi(key: string | undefined): Promise<ConnectionStatus> {
  if (!key) return { state: "not_connected", message: "No OPENAI_API_KEY configured (optional — only needed to transcribe narration without a script)." };
  const res = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!res) return { state: "error", message: "Network error" };
  if (res.status === 401) return { state: "invalid_key", message: "Key rejected." };
  if (res.status === 429) return { state: "rate_limited", message: "Rate limited." };
  return res.ok ? { state: "connected", message: "OK" } : { state: "error", message: `HTTP ${res.status}` };
}

export { createClaudeClient };
