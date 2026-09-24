import type { ProviderCredentials } from "@/lib/media/providers/types";

/** All server-side credentials. Never serialise this object into a response. */
export interface ResolvedCredentials extends ProviderCredentials {
  anthropic?: string;
  openai?: string;
}

export type CredentialName = keyof ResolvedCredentials;

/** Environment variable backing each credential (the fallback when no key is saved in Settings). */
export const CREDENTIAL_ENV: Record<CredentialName, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  pexels: "PEXELS_API_KEY",
  pixabay: "PIXABAY_API_KEY",
  giphy: "GIPHY_API_KEY",
  wikimediaToken: "WIKIMEDIA_ACCESS_TOKEN",
  internetArchive: "INTERNET_ARCHIVE_KEYS",
  openai: "OPENAI_API_KEY",
};

export function resolveEnvCredentials(): ResolvedCredentials {
  const out: ResolvedCredentials = {};
  for (const [name, env] of Object.entries(CREDENTIAL_ENV) as [CredentialName, string][]) {
    const v = process.env[env]?.trim();
    if (v) out[name] = v;
  }
  return out;
}

/** Last 4 characters for display, e.g. "••••a1b2". */
export function keyHint(key: string): string {
  return `••••${key.slice(-4)}`;
}
