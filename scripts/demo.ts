/**
 * Demo Mode (CLI): runs the full pipeline on the fictional demo script without a database.
 *   npm run demo            → 1920x1080 render to output/demo.mp4
 *   npm run demo -- --draft → fast 960x540 preview render
 *   npm run demo -- --vertical
 * Uses Claude when ANTHROPIC_API_KEY is set, otherwise the heuristic director.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileAiCache, createClaudeClient } from "@/lib/ai/claude/client";
import { ClaudeService } from "@/lib/ai/claude/service";
import { MODEL_BUDGET, MODEL_DEFAULT, UsageTracker } from "@/lib/ai/claude/usage";
import { DEMO_SCRIPT, DEMO_TITLE } from "@/lib/demo/script";
import { getPreset } from "@/lib/domain/presets";
import { DEFAULT_SETTINGS, type OutputFormat, type ProjectSettings } from "@/lib/domain/types";
import { FileSearchCache } from "@/lib/media/cache";
import { ClaudeDirector } from "@/lib/pipeline/claudeDirector";
import type { Director } from "@/lib/pipeline/director";
import { generateEdit } from "@/lib/pipeline/generate";
import { HeuristicDirector } from "@/lib/pipeline/heuristicDirector";
import { buildTimeline } from "@/lib/pipeline/timelineBuilder";
import { alignScriptToAudio } from "@/lib/pipeline/transcript";
import { detectSilences, probe } from "@/lib/render/ffmpeg";
import { library, libraryReady } from "@/lib/render/library";
import { renderTimeline } from "@/lib/render/render";
import { resolveEnvCredentials } from "@/lib/settings/credentials";

async function main() {
  const draft = process.argv.includes("--draft");
  const vertical = process.argv.includes("--vertical");
  const budget = process.argv.includes("--budget");
  const format: OutputFormat = vertical ? "vertical" : draft ? "draft" : "landscape";
  if (!libraryReady()) throw new Error("Run `npm run assets:generate` first.");

  const creds = resolveEnvCredentials();
  const preset = getPreset("dancehall_documentary");
  const settings: ProjectSettings = {
    ...DEFAULT_SETTINGS,
    stylePreset: preset.key,
    memeFrequency: "MEDIUM",
    captions: "DYNAMIC",
    paperStyle: preset.defaultPaper,
    budgetMode: budget,
  };

  const narration = library.demoNarration;
  const info = await probe(narration);
  const pauses = await detectSilences(narration);
  const transcript = alignScriptToAudio(DEMO_SCRIPT, info.duration ?? 60, pauses);
  console.log(`Narration ${info.duration?.toFixed(1)}s, ${transcript.words.length} words, ${pauses.length} pauses (script alignment)`);

  const usage = new UsageTracker();
  let director: Director;
  if (creds.anthropic) {
    const claude = new ClaudeService(
      { client: createClaudeClient(creds.anthropic), model: budget ? MODEL_BUDGET : MODEL_DEFAULT, effort: budget ? "low" : "medium", cache: new FileAiCache(), usage },
      budget,
    );
    director = new ClaudeDirector(claude, budget ? 6 : 12);
  } else {
    director = new HeuristicDirector();
  }
  console.log(`Director: ${director.label}`);
  const configured = Object.entries({ pexels: creds.pexels, pixabay: creds.pixabay, giphy: creds.giphy })
    .map(([k, v]) => `${k}:${v ? "yes" : "no key"}`)
    .join(" ");
  console.log(`Providers: wikimedia:public internet_archive:public ${configured}`);

  const t0 = Date.now();
  const result = await generateEdit(
    { projectTitle: DEMO_TITLE, transcript, settings, style: preset.profile, orientation: vertical ? "portrait" : "landscape" },
    {
      director,
      creds,
      searchCache: new FileSearchCache(),
      onProgress: (s, p) => void process.stdout.write(`\r  ${Math.round(p * 100)}% ${s.padEnd(50)}`),
    },
  );
  console.log(`\nPlanned ${result.plans.length} scenes, ${result.selections.length} clips in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const p of result.plans) {
    console.log(`  ${p.sceneId} ${p.startTime.toFixed(1)}-${p.endTime.toFixed(1)}s ${p.visualStrategy}${p.textOverlay.enabled ? ` text="${p.textOverlay.text}"` : ""}${p.meme.insert ? " meme-candidate" : ""}`);
  }
  for (const s of result.selections) {
    console.log(`    ${s.clipId.padEnd(18)} ${s.duration.toFixed(1)}s ${s.needType.padEnd(8)} ${s.layout.padEnd(10)} ${s.motion.padEnd(15)} ${s.asset.provider.padEnd(16)} ${s.asset.rightsStatus.padEnd(20)} ${s.asset.title.slice(0, 50)}`);
  }
  for (const w of result.warnings) console.log(`  ! ${w}`);
  const errs = new Map<string, number>();
  for (const e of result.searchErrors) errs.set(`${e.provider} ${e.code}`, (errs.get(`${e.provider} ${e.code}`) ?? 0) + 1);
  for (const [k, v] of errs) console.log(`  ! search errors: ${k} ×${v}`);

  const timeline = buildTimeline({
    plans: result.plans,
    selections: result.selections,
    transcript,
    settings,
    format,
    voicePath: narration,
    musicPath: library.music("ambient_pad"),
  });
  const outDir = path.join(process.cwd(), "output");
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "demo.timeline.json"), JSON.stringify(timeline, null, 2));

  const t1 = Date.now();
  const out = path.join(outDir, `demo${vertical ? "-vertical" : draft ? "-draft" : ""}.mp4`);
  const r = await renderTimeline(timeline, {
    workDir: path.join(process.cwd(), ".cache", "render", "demo"),
    outPath: out,
    draft,
    log: (m) => {
      if (/^\[(RENDERING|FINALIZING|DOWNLOADING)\]/.test(m)) process.stdout.write(`\r  ${m.padEnd(70)}`);
      else console.log(`  ${m}`);
    },
  });
  console.log(`\nRendered ${out} (${r.duration.toFixed(1)}s) in ${((Date.now() - t1) / 1000).toFixed(0)}s — ${r.segmentsRendered} new segments, ${r.segmentsCached} cached`);
  for (const w of r.warnings) console.log(`  ! ${w}`);
  if (usage.records.length) {
    const t = usage.totals;
    console.log(`Claude usage: ${t.calls} calls (${t.cachedCalls} cached), ${t.inputTokens} in / ${t.outputTokens} out tokens, est. $${t.costUsd.toFixed(4)}`);
  }
  console.log(`Attributions:\n  ${timeline.attributions.join("\n  ")}`);
}

main().catch((e) => {
  console.error("\nDemo failed:", e);
  process.exit(1);
});
