/**
 * Tests every media provider (and Claude, if configured) with real API calls.
 * Usage: npm run test:providers
 */
import { resolveEnvCredentials } from "@/lib/settings/credentials";
import { PROVIDERS } from "@/lib/media/providers";
import { searchMedia } from "@/lib/media/searchOrchestrator";
import { testClaude } from "@/lib/ai/claude/client";
import { internetArchive } from "@/lib/media/providers";

async function main() {
  const creds = resolveEnvCredentials();
  console.log("== Connection tests");
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const s = await p!.test(creds);
    console.log(`${id.padEnd(17)} ${s.state.padEnd(14)} ${s.message}`);
  }
  const c = await testClaude(creds.anthropic);
  console.log(`${"claude".padEnd(17)} ${c.state.padEnd(14)} ${c.message}`);

  console.log("\n== Orchestrated search: 'Kingston Jamaica street' (photo+video)");
  const r = await searchMedia(
    {
      queries: ["Kingston Jamaica street", "Jamaica crowd"],
      types: ["photo", "video"],
      providers: ["pexels", "pixabay", "wikimedia", "internet_archive"],
      orientation: "landscape",
      minDuration: 3,
      allowReview: true,
      allowUnknown: false,
      limit: 12,
    },
    { creds },
  );
  console.log(`providerCalls=${r.providerCalls} cacheHits=${r.cacheHits} errors=${r.errors.length}`);
  for (const e of r.errors) console.log(`  ! ${e.provider} ${e.code}: ${e.message}`);
  for (const a of r.candidates) {
    console.log(
      `  ${String(a.score).padStart(3)} ${a.provider.padEnd(16)} ${a.type.padEnd(5)} ${a.rightsStatus.padEnd(20)} ${a.width ?? "?"}x${a.height ?? "?"} ${a.duration ? a.duration.toFixed(1) + "s " : ""}${a.title.slice(0, 60)}`,
    );
  }

  const ia = r.candidates.find((a) => a.provider === "internet_archive");
  if (ia) {
    const resolved = await internetArchive.resolveFile(ia).catch((e: Error) => e);
    console.log(`\n== Internet Archive file resolution for ${ia.providerAssetId}:`, resolved instanceof Error ? resolved.message : resolved.mediaUrl);
  }

  if (creds.giphy) {
    const g = await searchMedia(
      { queries: ["shocked reaction"], types: ["gif"], providers: ["giphy"], orientation: "landscape", allowReview: true, allowUnknown: false, limit: 3 },
      { creds },
    );
    console.log("\n== GIPHY reactions:", g.candidates.map((a) => `${a.title} [${a.rightsStatus}]`).join(" | ") || g.errors.map((e) => e.message).join("; "));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
