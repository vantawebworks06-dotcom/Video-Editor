/**
 * Research providers against the live APIs with the configured credentials.
 *   npm run test:research
 * Prints per-provider outcomes (ok / empty / not configured / error), the top ranked results with
 * their relevance reasons, link import for several platforms, and the SSRF guard.
 */
import { analyzeTranscript } from "@/lib/analysis/analyze";
import { FileSearchCache } from "@/lib/media/cache";
import { RESEARCH_PROVIDERS } from "@/lib/research";
import { runResearch } from "@/lib/research/orchestrator";
import { describeUrl } from "@/lib/research/providers/url";
import { parseChapters, segmentFromChapters, segmentFromTranscript } from "@/lib/research/segments";
import { assertPublicUrl } from "@/lib/research/safeFetch";
import { resolveEnvCredentials } from "@/lib/settings/credentials";

let failures = 0;
const check = (ok: boolean, label: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
};

async function main() {
  const creds = resolveEnvCredentials();
  console.log("configured:", RESEARCH_PROVIDERS.filter((p) => p.configured(creds)).map((p) => p.id).join(", "));

  // --- unit: chapters / transcript segments -------------------------------------------------
  const desc = "Full interview.\n0:00 Intro\n2:15 Growing up in Portmore\n6:42 The Mavado feud explained\n9:30 New album\n";
  const ch = parseChapters(desc);
  check(ch.length === 4 && ch[2]!.start === 402, `parses 4 chapters (${ch.map((c) => c.start).join(",")})`);
  const seg = segmentFromChapters(ch, 700, { query: "Vybz Kartel TMZ interview", entities: ["Mavado"], sentence: "Kartel spoke about the feud with Mavado" });
  check(seg?.start === 402 && seg.end === 570 && seg.basis === "chapters", `chapter segment 6:42–9:30 (${seg?.start}–${seg?.end})`);
  check(parseChapters("Check out 2:15 for the good part").length === 0, "ignores stray timestamps");
  const words = "welcome back today we talk music and then later my rival Mavado and that feud it was crazy honestly the feud with Mavado started in two thousand six".split(" ").map((w, i) => ({ word: w, start: i * 0.5, end: i * 0.5 + 0.4 }));
  const ts = segmentFromTranscript(words, { query: "feud", entities: ["Mavado"], sentence: "the feud with Mavado" });
  check(Boolean(ts && ts.start >= 3 && ts.basis === "transcript"), `transcript segment found (${ts?.start}–${ts?.end}, ${ts?.confidence})`);

  // --- SSRF guard ----------------------------------------------------------------------------
  for (const bad of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data", "http://localhost:3000", "file:///etc/passwd", "http://10.0.0.5/", "http://[::1]/"]) {
    const blocked = await assertPublicUrl(bad).then(() => false, () => true);
    check(blocked, `blocks ${bad}`);
  }

  // --- live research ------------------------------------------------------------------------
  const a = await analyzeTranscript({ script: "Vybz Kartel had a major beef with Mavado. Kartel later spoke to TMZ about the situation.", projectTitle: "Gaza vs Gully", topic: "The Gaza vs Gully dancehall rivalry between Vybz Kartel and Mavado" }, {});
  const cache = new FileSearchCache();
  for (const [idx, sug] of [
    [1, 0],
    [0, 0],
  ] as const) {
    const s = a.sentences[idx]!;
    const g = s.intent.suggestedAssets[sug]!;
    const providers = [...new Set([...g.providers, "wikipedia", "gdelt", "wikimedia", "pexels"])] as never[];
    console.log(`\n“${s.text}” → ${g.category} “${g.query}” via ${providers.join(",")}`);
    const t0 = Date.now();
    const r = await runResearch({ query: g.query, category: g.category, providers, sentence: s.text, entities: s.intent.entities, topics: s.intent.topics, year: s.dates.find((d) => d.year)?.year ?? null }, creds, { cache });
    console.log(`  ${Date.now() - t0} ms`);
    for (const o of r.outcomes) console.log(`  [${o.state.padEnd(7)}] ${o.name}: ${o.message}${o.code ? ` (${o.code})` : ""}`);
    for (const c of r.candidates.slice(0, 5)) console.log(`   ${String(c.relevance.score).padStart(3)} ${c.provider.padEnd(10)} ${c.category.padEnd(8)} ${c.title.slice(0, 70)}\n       ${c.relevance.reasons.join("; ")}`);
    check(r.outcomes.every((o) => o.state !== "error" || o.code === "RATE_LIMITED" || o.code === "TIMEOUT"), "no unexpected provider errors");
  }

  // --- link import --------------------------------------------------------------------------
  console.log("\nlink import:");
  for (const url of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://en.wikipedia.org/wiki/Vybz_Kartel", "https://x.com/NASA/status/1790000000000000000"]) {
    try {
      const c = await describeUrl(url, creds);
      console.log(`  ✓ ${url}\n     ${c.category} · ${c.platform} · ${c.account ?? "-"} · “${c.title.slice(0, 70)}” · ${c.publishedAt ?? "no date"} · embed=${c.embed?.kind ?? "none"}`);
    } catch (e) {
      console.log(`  • ${url}: ${(e as Error).message}`);
    }
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

void main();
