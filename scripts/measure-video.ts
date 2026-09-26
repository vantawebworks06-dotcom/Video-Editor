/**
 * Measure a video's editing language (the reference analyser) and print the result.
 *   npm run measure:video -- <file.mp4> [maxSeconds]
 */
import path from "node:path";
import { measureReference } from "@/lib/reference/measure";

async function main() {
  const [file, max] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!file) throw new Error("usage: measure:video <file> [maxSeconds]");
  const t0 = Date.now();
  const { measurements, shots } = await measureReference(path.resolve(file), { workDir: path.join(process.cwd(), ".cache", "measure"), maxSeconds: max ? Number(max) : undefined });
  console.log(JSON.stringify(measurements, null, 1));
  console.log(`${shots.length} shots in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (process.argv.includes("--shots")) for (const s of shots) console.log(`${s.start.toFixed(1).padStart(7)}–${s.end.toFixed(1).padEnd(7)} ${s.transitionIn.padEnd(12)} ${s.kind}${s.bw ? " bw" : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
