/**
 * Drive the real app in headless Chrome/Edge (puppeteer-core, no bundled browser) as a dedicated
 * test user, take screenshots and report console errors. Used to check UI changes end to end.
 *
 *   npm run ui -- setup                         create the test user + a demo project (worker generates it)
 *   npm run ui -- run /projects/{project} "click:Script" "wait:SCENE 01" "shot:script"
 *
 * Steps: upload:<css>|<file>[,<file>]  click:<visible text>  clicksel:<css>  wait:<text>  waitsel:<css>  type:<css>|<text>
 *        key:<Key>  sleep:<ms>  shot:<name>  eval:<js>  viewport:<w>x<h>
 * Screenshots go to .cache/ui/<name>.png. BASE_URL defaults to http://localhost:3000.
 * The test user and its projects live in .cache/uitest.json; `npm run ui -- teardown` deletes them.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import puppeteer, { type Page } from "puppeteer-core";
import { findBrowser } from "@/lib/capture/browser";
import { createAdminClient } from "@/lib/supabase/admin";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const STATE = path.join(process.cwd(), ".cache", "uitest.json");
const OUT = path.join(process.cwd(), ".cache", "ui");

interface TestState {
  email: string;
  password: string;
  userId: string;
  projectId: string | null;
}

async function loadState(): Promise<TestState | null> {
  return existsSync(STATE) ? (JSON.parse(await readFile(STATE, "utf8")) as TestState) : null;
}

async function ensureUser(): Promise<TestState> {
  const existing = await loadState();
  if (existing) return existing;
  const email = `docucut-ui-${Date.now()}@example.com`;
  const password = `Ui-${crypto.randomUUID()}`;
  const { data, error } = await createAdminClient().auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const s: TestState = { email, password, userId: data.user.id, projectId: null };
  await mkdir(path.dirname(STATE), { recursive: true });
  await writeFile(STATE, JSON.stringify(s, null, 2));
  return s;
}

async function login(page: Page, s: TestState) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  await page.type('input[type="email"]', s.email);
  await page.type('input[type="password"]', s.password);
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => undefined), page.click('button[class*="w-full"]')]);
  await page.waitForFunction("location.pathname.startsWith('/projects')", { timeout: 60_000 });
}

// In-page code is passed as a string: tsx (esbuild keepNames) would inject a __name helper that
// doesn't exist in the page.
const CLICK_TEXT = `(raw) => {
  const t = raw.toLowerCase();
  const els = [...document.querySelectorAll("button, a, [role=button], summary, label")].filter((e) => e.offsetParent !== null);
  const txt = (e) => e.innerText.trim().toLowerCase();
  const el = els.find((e) => txt(e) === t) || els.find((e) => txt(e).startsWith(t)) || els.find((e) => txt(e).includes(t));
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.click();
  return true;
}`;

async function clickText(page: Page, text: string) {
  const ok = await page.evaluate(`(${CLICK_TEXT})(${JSON.stringify(text)})`);
  if (!ok) throw new Error(`No clickable element with text "${text}"`);
}

async function run(steps: string[], s: TestState) {
  const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const errors: string[] = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 950 });
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text().slice(0, 400));
    });
    page.on("pageerror", (e) => errors.push(`pageerror: ${(e as Error).message.slice(0, 400)}`));
    await login(page, s);
    await mkdir(OUT, { recursive: true });
    for (const raw of steps) {
      const step = raw.replaceAll("{project}", s.projectId ?? "");
      const [cmd, ...rest] = step.split(":");
      const arg = rest.join(":");
      const t0 = Date.now();
      switch (cmd) {
        case "goto":
          await page.goto(`${BASE}${arg}`, { waitUntil: "networkidle2", timeout: 120_000 });
          break;
        case "click":
          await clickText(page, arg);
          break;
        case "clicksel":
          await page.click(arg);
          break;
        case "wait":
          await page.waitForFunction(`document.body.innerText.toLowerCase().includes(${JSON.stringify(arg.toLowerCase())})`, { timeout: 120_000 });
          break;
        case "waitsel":
          await page.waitForSelector(arg, { timeout: 120_000 });
          break;
        case "type": {
          const [sel, ...val] = arg.split("|");
          await page.click(sel!, { count: 3 });
          await page.type(sel!, val.join("|"));
          break;
        }
        case "upload": {
          const [sel, ...file] = arg.split("|");
          const input = await page.$(sel!);
          if (!input) throw new Error(`No file input ${sel}`);
          // One file per call (puppeteer mis-detects React's "multiple" inputs); each fires a change event.
          for (const p of file.join("|").split(",")) {
            await (input as unknown as { uploadFile: (p: string) => Promise<void> }).uploadFile(path.resolve(p));
            await new Promise((r) => setTimeout(r, 500));
          }
          break;
        }
        case "key":
          await page.keyboard.press(arg as never);
          break;
        case "sleep":
          await new Promise((r) => setTimeout(r, Number(arg)));
          break;
        case "viewport": {
          const [w, h] = arg.split("x").map(Number);
          await page.setViewport({ width: w!, height: h! });
          break;
        }
        case "eval":
          console.log("  eval →", JSON.stringify(await page.evaluate(arg)));
          break;
        case "shot": {
          const file = path.join(OUT, `${arg}.png`);
          await page.screenshot({ path: file });
          console.log(`  shot → ${file}`);
          break;
        }
        default:
          if (step.startsWith("/")) await page.goto(`${BASE}${step}`, { waitUntil: "networkidle2", timeout: 120_000 });
          else throw new Error(`Unknown step "${step}"`);
      }
      console.log(`  ✓ ${step} (${Date.now() - t0} ms)`);
    }
  } catch (err) {
    const pages = await browser.pages();
    await pages.at(-1)?.screenshot({ path: path.join(OUT, "failure.png") }).catch(() => undefined);
    console.log(`  ✗ failed — screenshot at ${path.join(OUT, "failure.png")}`);
    throw err;
  } finally {
    await browser.close();
    if (errors.length) console.log(`console errors (${errors.length}):\n  ${[...new Set(errors)].join("\n  ")}`);
    else console.log("no console errors");
  }
}

async function main() {
  const [cmd, ...steps] = process.argv.slice(2);
  if (cmd === "teardown") {
    const s = await loadState();
    if (s) await createAdminClient().auth.admin.deleteUser(s.userId);
    await rm(STATE, { force: true });
    console.log("test user deleted");
    return;
  }
  const s = await ensureUser();
  if (cmd === "setup") {
    if (!s.projectId) {
      // Create the demo project through the app's own API, authenticated as the test user.
      const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true });
      try {
        const page = await browser.newPage();
        await login(page, s);
        const r = await page.evaluate(async () => (await fetch("/api/projects/demo", { method: "POST" })).json());
        s.projectId = (r as { id: string }).id;
        await writeFile(STATE, JSON.stringify(s, null, 2));
      } finally {
        await browser.close();
      }
    }
    console.log(`test user ${s.email}, project ${s.projectId} (the worker generates the demo edit)`);
    return;
  }
  if (cmd !== "run") throw new Error("usage: ui setup | run <steps…> | teardown");
  await run(steps, s);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
