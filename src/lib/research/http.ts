import { USER_AGENT } from "@/lib/media/providers/http";
import { ResearchError } from "./types";

/**
 * JSON over HTTPS for research providers, with a timeout and platform errors mapped to
 * ResearchError codes. Request URLs never appear in errors (some APIs take keys as parameters).
 */
export async function getJson<T>(
  provider: string,
  url: string,
  init: RequestInit & { timeoutMs?: number; signal?: AbortSignal; parse?: "json" | "text" } = {},
): Promise<T> {
  const { timeoutMs = 15000, signal, parse = "json", ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(rest.headers ?? {}) },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    const name = (err as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new ResearchError(provider, "TIMEOUT", `No answer within ${Math.round(timeoutMs / 1000)} s.`);
    throw new ResearchError(provider, "UNAVAILABLE", `Network error (${(err as Error)?.message ?? "unknown"}).`);
  }
  if (res.ok) {
    if (parse === "text") return (await res.text()) as T;
    try {
      return (await res.json()) as T;
    } catch {
      throw new ResearchError(provider, "BAD_RESPONSE", "The API answered with something other than JSON.");
    }
  }
  const body = await res.text().catch(() => "");
  const detail = extractMessage(body);
  const retry = Number(res.headers.get("retry-after"));
  switch (res.status) {
    case 401:
      throw new ResearchError(provider, "INVALID_CREDENTIALS", `Credentials rejected${detail ? `: ${detail}` : "."}`);
    case 402:
      throw new ResearchError(provider, "QUOTA_EXCEEDED", `Payment/credits required${detail ? `: ${detail}` : "."}`);
    case 403:
      if (/quota|limit|exceeded/i.test(body)) throw new ResearchError(provider, "QUOTA_EXCEEDED", `Quota exceeded${detail ? `: ${detail}` : "."}`);
      throw new ResearchError(provider, "FORBIDDEN", `Access denied${detail ? `: ${detail}` : " (the account or app may lack permission for this endpoint)."}`);
    case 404:
      throw new ResearchError(provider, "NOT_FOUND", "Not found (removed, private or never existed).");
    case 429:
      throw new ResearchError(provider, "RATE_LIMITED", `Rate limited${Number.isFinite(retry) && retry > 0 ? `; retry after ${retry} s` : ""}.`, Number.isFinite(retry) ? retry : undefined);
    default:
      if (res.status >= 500) throw new ResearchError(provider, "UNAVAILABLE", `The service is having problems (HTTP ${res.status}).`);
      throw new ResearchError(provider, "BAD_RESPONSE", `Request refused (HTTP ${res.status})${detail ? `: ${detail}` : ""}.`);
  }
}

function extractMessage(body: string): string | null {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const e = j.error as Record<string, unknown> | string | undefined;
    const m = typeof e === "string" ? e : (e?.message as string | undefined) ?? (j.detail as string | undefined) ?? (j.title as string | undefined) ?? (j.message as string | undefined);
    return m ? String(m).slice(0, 200) : null;
  } catch {
    return body && body.length < 200 && !/<html/i.test(body) ? body.trim() : null;
  }
}

/**
 * GET text with node:https. Some APIs (GDELT) take >10 s to complete the TLS handshake, longer than
 * fetch()'s fixed connect timeout; this has one overall timeout instead.
 */
export async function httpsGetText(provider: string, url: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ status: number; body: string }> {
  const { request } = await import("node:https");
  const { USER_AGENT: ua } = await import("@/lib/media/providers/http");
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", headers: { "User-Agent": ua, Accept: "application/json" }, timeout: opts.timeoutMs ?? 30_000 }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 5_000_000) req.destroy(new Error("response too large"));
        else chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    const onAbort = () => req.destroy(opts.signal?.reason ?? new Error("aborted"));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("timeout", () => req.destroy(new ResearchError(provider, "TIMEOUT", `No answer within ${Math.round((opts.timeoutMs ?? 30_000) / 1000)} s.`)));
    req.on("error", (e) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) return reject(opts.signal.reason);
      reject(e instanceof ResearchError ? e : new ResearchError(provider, "UNAVAILABLE", `Network error (${e.message}).`));
    });
    req.end();
  });
}

/** Serialise calls to an API with a minimum spacing (e.g. GDELT allows one request per 5 s). */
export function spacedQueue(minGapMs: number) {
  let last = 0;
  let chain: Promise<unknown> = Promise.resolve();
  return function run<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(async () => {
      const wait = last + minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return task();
    });
    chain = next.catch(() => undefined);
    return next;
  };
}

export const decodeEntities = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};
