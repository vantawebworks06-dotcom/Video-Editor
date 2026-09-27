/**
 * Screenshot capture of a public source, for use as an on-screen reference.
 *
 *  - Social posts are rendered through the platform's OFFICIAL embed (X widgets.js, Reddit's
 *    embed, Facebook's post plugin, Instagram's /embed page) — the same thing any website embeds,
 *    with the account, date and engagement the platform itself displays.
 *  - Articles/web pages are loaded like a normal browser visit (public, no login, no paywall
 *    bypass, no automation disguise). If the site blocks it, the capture fails and says so.
 *  - Every capture gets a provenance strip (platform · account · date · source URL · captured at)
 *    so the image can never lose its context. Content is never edited or fabricated here; blur
 *    and highlight are separate, visible treatments the editor applies later.
 */
import { writeFile } from "node:fs/promises";
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer-core";
import { isIP } from "node:net";
import { platformOf } from "@/lib/research/platforms";
import { assertPublicUrl, isPrivateAddress } from "@/lib/research/safeFetch";
import { findBrowser } from "./browser";

export interface CaptureSource {
  title: string;
  sourceUrl: string;
  platform: string | null;
  account: string | null;
  publishedAt: string | null;
  embed: { kind: string; postId?: string; videoId?: string } | null;
}

export interface CaptureOptions {
  theme: "light" | "dark";
  /** "auto": official embed for social posts, the page itself otherwise. */
  mode: "auto" | "page";
  signal?: AbortSignal;
  log?: (m: string) => void;
}

export interface CaptureResult {
  pngPath: string;
  width: number;
  height: number;
  method: "x-embed" | "reddit-embed" | "facebook-plugin" | "instagram-embed" | "page";
  capturedAt: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Block requests to private networks from inside the headless page (a public page can't pull in local resources). */
async function guard(page: Page) {
  await page.setRequestInterception(true);
  page.on("request", (req: HTTPRequest) => {
    try {
      const u = new URL(req.url());
      if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return void req.continue();
      if (u.protocol !== "https:" && u.protocol !== "http:") return void req.abort("blockedbyclient");
      const host = u.hostname.replace(/^\[|\]$/g, "");
      if (/^(localhost|.*\.local|.*\.internal)$/i.test(host) || (isIP(host) && isPrivateAddress(host))) return void req.abort("blockedbyclient");
      return void req.continue();
    } catch {
      return void req.abort("blockedbyclient");
    }
  });
}

function embedPage(src: CaptureSource, theme: "light" | "dark"): { html: string; selector: string; method: CaptureResult["method"] } | null {
  const bg = theme === "dark" ? "#0b0b0c" : "#f4f5f7";
  const wrap = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:${bg};}#c{display:inline-block;padding:28px;min-width:520px}</style></head><body><div id="c">${body}</div></body></html>`;
  const p = platformOf(src.sourceUrl);
  if ((src.embed?.kind === "x" && src.embed.postId) || (p.platform === "x" && p.id)) {
    const id = src.embed?.postId ?? p.id!;
    return {
      html: wrap(`<blockquote class="twitter-tweet" data-theme="${theme}" data-dnt="true" data-conversation="none"><a href="https://twitter.com/i/status/${esc(id)}"></a></blockquote><script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>`),
      selector: "#c",
      method: "x-embed",
    };
  }
  if (p.platform === "reddit" && p.id) {
    const clean = src.sourceUrl.split("?")[0]!;
    return {
      html: wrap(`<blockquote class="reddit-embed-bq" data-embed-theme="${theme}" data-embed-height="560"><a href="${esc(clean)}"></a></blockquote><script async src="https://embed.reddit.com/widgets.js" charset="UTF-8"></script>`),
      selector: "#c",
      method: "reddit-embed",
    };
  }
  if (p.platform === "instagram" && p.id) {
    return { html: wrap(`<iframe src="https://www.instagram.com/p/${esc(p.id)}/embed/captioned/" width="540" height="760" frameborder="0" scrolling="no" style="border:0;border-radius:8px;background:#fff"></iframe>`), selector: "#c", method: "instagram-embed" };
  }
  if (p.platform === "facebook") {
    return {
      html: wrap(`<iframe src="https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(src.sourceUrl)}&show_text=true&width=520" width="520" height="680" style="border:none;overflow:hidden;background:#fff" scrolling="no" frameborder="0"></iframe>`),
      selector: "#c",
      method: "facebook-plugin",
    };
  }
  return null;
}

async function provenance(browser: Browser, shotB64: string, w: number, h: number, src: CaptureSource, capturedAt: string, theme: "light" | "dark", out: string) {
  const page = await browser.newPage();
  try {
    await guard(page);
    const dark = theme === "dark";
    const date = src.publishedAt ? new Date(src.publishedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null;
    const bits = [src.platform, src.account, date ? `posted ${date}` : null].filter(Boolean).map((x) => esc(x!));
    const width = Math.max(w, 640);
    // Viewport tall enough for the whole composite: element screenshots then stay inside it
    // (captureBeyondViewport screenshots hang on some Chrome builds).
    await page.setViewport({ width, height: h + 160, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>
        body{margin:0;background:${dark ? "#0b0b0c" : "#f4f5f7"};font:15px/1.35 system-ui,Segoe UI,Arial,sans-serif;color:${dark ? "#e8e8e8" : "#1d1f23"}}
        #wrap{width:${width}px}
        img{display:block;width:${w}px;height:${h}px;margin:0 auto}
        #meta{padding:12px 18px;border-top:1px solid ${dark ? "#2b2d31" : "#d6d8dc"};background:${dark ? "#131417" : "#ffffff"}}
        .a{font-weight:600}.u{opacity:.75;font-size:13px;word-break:break-all;margin-top:2px}.c{opacity:.6;font-size:12px;margin-top:4px}
      </style></head><body><div id="wrap"><img src="data:image/png;base64,${shotB64}"><div id="meta">
        <div class="a">${bits.join(" · ") || "Source"}</div>
        <div class="u">${esc(src.sourceUrl)}</div>
        <div class="c">Screenshot captured ${esc(new Date(capturedAt).toUTCString())} — unedited</div>
      </div></div></body></html>`,
      { waitUntil: "load" },
    );
    const el = await page.$("#wrap");
    const buf = await el!.screenshot({ type: "png", captureBeyondViewport: false });
    await writeFile(out, buf);
    const box = await el!.boundingBox();
    return { width: Math.round(box?.width ?? width), height: Math.round(box?.height ?? h) };
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function captureSource(src: CaptureSource, out: string, opts: CaptureOptions): Promise<CaptureResult> {
  await assertPublicUrl(src.sourceUrl);
  const capturedAt = new Date().toISOString();
  const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ["--disable-dev-shm-usage", "--mute-audio", "--no-first-run", "--disable-background-networking"] });
  const abort = () => void browser.close().catch(() => undefined);
  opts.signal?.addEventListener("abort", abort, { once: true });
  try {
    const page = await browser.newPage();
    await guard(page);
    const embed = opts.mode === "auto" ? embedPage(src, opts.theme) : null;
    await page.setViewport({ width: 1280, height: embed ? 1400 : 900, deviceScaleFactor: 1.5 });
    let shot: Uint8Array;
    let method: CaptureResult["method"];
    if (embed) {
      opts.log?.(`capture via ${embed.method}`);
      await page.setContent(embed.html, { waitUntil: "load", timeout: 45_000 });
      // Official embeds render inside an iframe after their script loads.
      await page.waitForSelector(`${embed.selector} iframe`, { timeout: 30_000 }).catch(() => {
        throw new Error("The platform's embed did not load — the post may be deleted, private, or not embeddable.");
      });
      // The embed script sizes its iframe once the post has loaded; wait for a real height.
      const sized = await page
        .waitForFunction(`(() => { const f = document.querySelector(${JSON.stringify(`${embed.selector} iframe`)}); return f && f.getBoundingClientRect().height > 120; })()`, { timeout: 25_000, polling: 250 })
        .then(() => true, () => false);
      if (!sized) throw new Error("The embed rendered empty — the post may be deleted, private, or not embeddable.");
      await new Promise((r) => setTimeout(r, 1500)); // images inside the embed
      const el = await page.$(embed.selector);
      shot = await el!.screenshot({ type: "png", captureBeyondViewport: false });
      method = embed.method;
    } else {
      opts.log?.("capture via page visit");
      const res = await page.goto(src.sourceUrl, { waitUntil: "networkidle2", timeout: 45_000 }).catch((e: Error) => {
        throw new Error(`The page did not finish loading (${e.message.slice(0, 120)}).`);
      });
      const status = res?.status() ?? 0;
      if (status === 401 || status === 403) throw new Error(`The site refused the visit (HTTP ${status}) — it may require login or block automated browsers. Take the screenshot yourself and upload it.`);
      if (status === 404 || status === 410) throw new Error("The page no longer exists (removed or private).");
      if (status >= 400) throw new Error(`The site answered HTTP ${status}.`);
      await new Promise((r) => setTimeout(r, 1500));
      shot = await page.screenshot({ type: "png", captureBeyondViewport: false });
      method = "page";
    }
    const dims = await page.evaluate(`({ w: ${embed ? `document.querySelector(${JSON.stringify(embed.selector)}).getBoundingClientRect().width` : 1280}, h: ${embed ? `document.querySelector(${JSON.stringify(embed.selector)}).getBoundingClientRect().height` : 900} })`);
    const { w, h } = dims as { w: number; h: number };
    const scale = 1.5;
    const size = await provenance(browser, Buffer.from(shot).toString("base64"), Math.round(w * scale), Math.round(h * scale), src, capturedAt, opts.theme, out);
    return { pngPath: out, width: size.width, height: size.height, method, capturedAt };
  } finally {
    opts.signal?.removeEventListener("abort", abort);
    await browser.close().catch(() => undefined);
  }
}
