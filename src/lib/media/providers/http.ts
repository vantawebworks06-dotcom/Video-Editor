export type ProviderErrorCode =
  | "NOT_CONFIGURED"
  | "INVALID_KEY"
  | "RATE_LIMITED"
  | "NETWORK"
  | "TIMEOUT"
  | "BAD_RESPONSE"
  | "NOT_FOUND";

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`[${provider}] ${message}`);
    this.name = "ProviderError";
  }
}

// Wikimedia's API policy requires an identifying User-Agent.
export const USER_AGENT =
  process.env.MEDIA_USER_AGENT ||
  "DocuCutAI/0.1 (documentary editor; https://github.com/vantawebworks06-dotcom/video-editor)";

/**
 * fetch + JSON with a timeout and provider-specific error mapping.
 * Never include the request URL in errors: some providers take keys as query params.
 */
export async function fetchJson<T>(
  provider: string,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 15000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(rest.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ProviderError(provider, "TIMEOUT", `request timed out after ${timeoutMs}ms`);
    }
    throw new ProviderError(provider, "NETWORK", `network error: ${(err as Error)?.message ?? "unknown"}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new ProviderError(provider, "INVALID_KEY", `authentication failed (HTTP ${res.status})`);
  }
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after"));
    throw new ProviderError(provider, "RATE_LIMITED", "rate limited", Number.isFinite(retry) ? retry : undefined);
  }
  if (res.status === 400) {
    // Pixabay (and some others) answer a bad key with 400 + a message rather than 401.
    const text = await res.text().catch(() => "");
    if (/api key/i.test(text)) throw new ProviderError(provider, "INVALID_KEY", "API key rejected (invalid or missing)");
    throw new ProviderError(provider, "BAD_RESPONSE", "request rejected (HTTP 400)");
  }
  if (res.status === 404) throw new ProviderError(provider, "NOT_FOUND", "not found");
  if (!res.ok) throw new ProviderError(provider, "BAD_RESPONSE", `unexpected HTTP ${res.status}`);

  try {
    return (await res.json()) as T;
  } catch {
    throw new ProviderError(provider, "BAD_RESPONSE", "response was not valid JSON");
  }
}

export function stripHtml(input: string | null | undefined): string | null {
  if (!input) return null;
  const text = input
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}
