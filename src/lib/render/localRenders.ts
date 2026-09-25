import { existsSync, statSync } from "node:fs";
import path from "node:path";

/** Where the worker keeps finished renders (same machine as the web server in local setups). */
export function localRenderPath(jobId: string) {
  return path.join(process.cwd(), ".cache", "renders", `${jobId}.mp4`);
}

export function localRenderSize(jobId: string): number | null {
  const p = localRenderPath(jobId);
  return existsSync(p) ? statSync(p).size : null;
}
