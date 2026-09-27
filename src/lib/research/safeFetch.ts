/**
 * Fetch a URL the *user* supplied without letting it reach the server's own network (SSRF):
 * only http(s) on standard ports, every hostname resolved and checked against private, loopback,
 * link-local and reserved ranges — again after each redirect — with a size cap and timeout.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { USER_AGENT } from "@/lib/media/providers/http";
import { ResearchError } from "./types";

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  );
}

function privateV6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("::ffff:")) return privateV4(v.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v.replace(/^0+/, ""));
}

export function isPrivateAddress(ip: string): boolean {
  return isIP(ip) === 4 ? privateV4(ip) : isIP(ip) === 6 ? privateV6(ip) : true;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ResearchError("url", "BAD_RESPONSE", "That is not a valid URL.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ResearchError("url", "UNSUPPORTED", "Only http(s) links can be imported.");
  if (u.username || u.password) throw new ResearchError("url", "UNSUPPORTED", "Links with embedded credentials are not accepted.");
  if (u.port && !["80", "443"].includes(u.port)) throw new ResearchError("url", "UNSUPPORTED", "Only standard web ports are allowed.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new ResearchError("url", "FORBIDDEN", "Local network addresses are not allowed.");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => {
    throw new ResearchError("url", "NOT_FOUND", `The site ${host} could not be found.`);
  });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new ResearchError("url", "FORBIDDEN", "That address points to a private network and cannot be fetched.");
  return u;
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

/** GET a public page (HTML/JSON), following up to 4 redirects, reading at most `maxBytes`. */
export async function safeFetch(raw: string, opts: { maxBytes?: number; timeoutMs?: number; accept?: string; signal?: AbortSignal } = {}): Promise<FetchedPage> {
  const maxBytes = opts.maxBytes ?? 1_500_000;
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? 12_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  let url = raw;
  for (let hop = 0; hop < 5; hop++) {
    const u = await assertPublicUrl(url);
    let res: Response;
    try {
      res = await fetch(u, {
        redirect: "manual",
        signal,
        headers: { "User-Agent": USER_AGENT, Accept: opts.accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5", "Accept-Language": "en" },
      });
    } catch (err) {
      if ((err as Error).name === "TimeoutError" || deadline.aborted) throw new ResearchError("url", "TIMEOUT", "The page took too long to respond.");
      throw new ResearchError("url", "UNAVAILABLE", `Could not reach the page (${(err as Error).message}).`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, u).toString();
      continue;
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (res.status === 401 || res.status === 403) throw new ResearchError("url", "FORBIDDEN", `The site refused access (HTTP ${res.status}) — it may require login or block automated requests.`);
    if (res.status === 404 || res.status === 410) throw new ResearchError("url", "NOT_FOUND", "The page no longer exists (removed or private).");
    if (res.status === 429) throw new ResearchError("url", "RATE_LIMITED", "The site is rate limiting requests.");
    if (!res.ok) throw new ResearchError("url", "UNAVAILABLE", `The site answered HTTP ${res.status}.`);
    if (!/text\/html|application\/(xhtml\+xml|json)|text\/plain|application\/ld\+json/.test(contentType)) {
      await res.body?.cancel().catch(() => undefined);
      return { url: u.toString(), status: res.status, contentType, body: "" };
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        chunks.push(value);
        if (size >= maxBytes) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
    return { url: u.toString(), status: res.status, contentType, body: new TextDecoder().decode(Buffer.concat(chunks)) };
  }
  throw new ResearchError("url", "UNAVAILABLE", "Too many redirects.");
}
