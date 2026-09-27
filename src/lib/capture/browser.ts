import { existsSync } from "node:fs";

/**
 * A Chromium-based browser already installed on the machine (used headless by puppeteer-core for
 * source screenshots; nothing is downloaded). CAPTURE_BROWSER_PATH overrides detection.
 */
const CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
];

export function findBrowser(): string {
  const configured = process.env.CAPTURE_BROWSER_PATH?.trim();
  if (configured) {
    if (!existsSync(configured)) throw new Error(`CAPTURE_BROWSER_PATH points to a missing file: ${configured}`);
    return configured;
  }
  const found = CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error("No Chrome/Edge/Chromium found for screenshot capture. Install one or set CAPTURE_BROWSER_PATH.");
  return found;
}

export function browserAvailable(): boolean {
  try {
    findBrowser();
    return true;
  } catch {
    return false;
  }
}
