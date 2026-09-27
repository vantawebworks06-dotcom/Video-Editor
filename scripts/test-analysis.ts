/**
 * Transcript analysis check across unrelated subjects (the engine must not be tuned to one topic).
 *   npm run test:analysis            (Wikipedia entity linking; needs network)
 *   npm run test:analysis -- --offline
 * Prints each sentence's intent, graphic opportunity and suggested searches, then asserts a few
 * expectations per genre.
 */
import { analyzeTranscript } from "@/lib/analysis/analyze";

const CASES: { name: string; topic: string; script: string; expect: [number, string][] }[] = [
  {
    name: "music",
    topic: "The Gaza vs Gully dancehall rivalry between Vybz Kartel and Mavado",
    script:
      "Vybz Kartel had a major beef with Mavado. Kartel later spoke to TMZ about the situation. Fans immediately started arguing online. Three years later, the feud was still going. The rivalry began in Kingston. His album Kingston Story sold 50,000 copies.",
    expect: [
      [0, "conflict"],
      [1, "interview_reference"],
      [2, "social_reaction"],
      [3, "time_jump"],
      [5, "statistic"],
    ],
  },
  {
    name: "history",
    topic: "The sinking of the Titanic",
    script: "The Titanic struck an iceberg on April 14, 1912. More than 1,500 people died that night. Newspapers around the world reported the disaster the next morning.",
    expect: [
      [0, "historical_context"],
      [1, "statistic"],
      [2, "news_event"],
    ],
  },
  {
    name: "business",
    topic: "How a startup became a global company",
    script: "The company announced the product in 2020. By 2005, the company had expanded to 12 countries. The CEO said in an interview that growth was never the goal.",
    expect: [
      [0, "product_announcement"],
      [1, "statistic"],
      [2, "interview_reference"],
    ],
  },
  {
    name: "crime",
    topic: "A true crime case",
    script: "Police arrested him on January 4, 2011. Court documents later showed he had been under investigation for months.",
    expect: [
      [0, "legal_event"],
      [1, "document_evidence"],
    ],
  },
];

async function main() {
  const offline = process.argv.includes("--offline");
  let failures = 0;
  for (const c of CASES) {
    const t0 = Date.now();
    const a = await analyzeTranscript({ script: c.script, projectTitle: c.name, topic: c.topic }, { offline });
    console.log(`\n=== ${c.name} (${Date.now() - t0} ms, ${a.scenes.length} scenes, entities: ${a.entities.map((e) => `${e.name}[${e.kind}]`).join(", ")})`);
    for (const w of a.warnings) console.log(`  ! ${w}`);
    for (const s of a.sentences) {
      console.log(`  [${s.idx}] ${s.intent.type.padEnd(20)} "${s.text}"`);
      if (s.intent.graphic) console.log(`       graphic: ${s.intent.graphic.kind} "${s.intent.graphic.text}"${s.intent.graphic.sub ? ` / ${s.intent.graphic.sub}` : ""}`);
      if (s.claim) console.log(`       claim: ${s.claim.kind}`);
      for (const g of s.intent.suggestedAssets.slice(0, 4)) console.log(`       → ${g.category.padEnd(9)} ${g.label}  [${g.providers.join(",")}] q="${g.query}"`);
    }
    for (const [i, type] of c.expect) {
      const got = a.sentences[i]?.intent.type;
      if (got !== type) {
        failures++;
        console.log(`  ✗ sentence ${i}: expected ${type}, got ${got}`);
      }
    }
  }
  console.log(failures ? `\n${failures} expectation(s) failed` : "\nall expectations met");
  process.exit(failures ? 1 : 0);
}

void main();
