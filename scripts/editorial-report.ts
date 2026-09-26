/**
 * Editorial quality report: runs the real generation pipeline on a project's narration
 * transcript (real provider searches, nothing written to the project) and prints every
 * placed visual next to its narration, plus summary metrics to compare before/after changes.
 *
 *   npm run report:editorial -- <projectId> <label> [--scenes=N]
 *
 * The transcript is read once from the database and kept in .cache/editorial/; searches use the
 * file search cache. Output: .cache/editorial/<label>.txt and <label>.json
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeDirector, parseSettings, resolveStyle } from "@/lib/data/project";
import { Transcript } from "@/lib/domain/types";
import { FileSearchCache } from "@/lib/media/cache";
import { generateEdit, type GenerateResult } from "@/lib/pipeline/generate";
import { resolveCredentials } from "@/lib/settings/apiKeys";
import { createAdminClient } from "@/lib/supabase/admin";

const OUT = path.join(process.cwd(), ".cache", "editorial");
const STOCK = new Set(["pexels", "pixabay"]);

async function loadProject(id: string) {
  const file = path.join(OUT, `project-${id}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    const db = createAdminClient();
    const { data, error } = await db.from("projects").select("id, name, user_id, settings, style_profile_id, transcript").eq("id", id).single();
    if (error) throw error;
    if (!data.transcript) {
      // No stored transcript: rebuild word timings from the saved scenes (each scene's words
      // spread across its span, weighted by length) — close enough for editorial testing.
      const { data: scenes } = await db.from("scenes").select("start_time, end_time, narration").eq("project_id", id).order("idx");
      const words: { word: string; start: number; end: number }[] = [];
      for (const s of scenes ?? []) {
        const ws = String(s.narration).split(/\s+/).filter(Boolean);
        const total = ws.reduce((a, w) => a + w.length + 2, 0);
        let t = Number(s.start_time);
        const span = Number(s.end_time) - t;
        for (const w of ws) {
          const d = (span * (w.length + 2)) / total;
          words.push({ word: w, start: +t.toFixed(3), end: +(t + d * 0.9).toFixed(3) });
          t += d;
        }
      }
      const duration = Number(scenes?.at(-1)?.end_time ?? 0);
      data.transcript = { text: words.map((w) => w.word).join(" "), words, duration, source: "script_alignment" };
    }
    await writeFile(file, JSON.stringify(data));
    return data;
  }
}

/** Capitalised names in the narration (skipping sentence starts) — an independent check of specificity. */
function namedTerms(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![.!?]\s)(?<!^)\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*)/g)) out.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(/\b(1[89]\d\d|20[0-2]\d)\b/g)) out.add(m[1]!);
  return [...out];
}

const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3));

function metrics(r: GenerateResult) {
  const prim = r.selections.filter((s) => s.role === "primary");
  const plans = new Map(r.plans.map((p) => [p.sceneId, p]));
  const provider: Record<string, number> = {};
  let stock = 0;
  let specific = 0;
  let specificNeeded = 0;
  let unrelated = 0;
  let run = 1;
  let maxProviderRun = 1;
  let kindRun = 1;
  let maxKindRun = 1;
  const kinds = prim.map((s) => (s.asset.provider === "graphic" ? "graphic" : s.asset.type === "video" ? "video" : s.asset.archival ? "archival" : "photo"));
  prim.forEach((s, i) => {
    provider[s.asset.provider] = (provider[s.asset.provider] ?? 0) + 1;
    if (STOCK.has(s.asset.provider)) stock++;
    const narration = plans.get(s.sceneId)?.narration ?? "";
    const hay = `${s.asset.title} ${s.asset.description ?? ""}`.toLowerCase();
    const terms = namedTerms(narration);
    if (terms.length) {
      specificNeeded++;
      if (terms.some((t) => hay.includes(t))) specific++;
    }
    const nt = tokens(narration);
    if (![...tokens(hay)].some((t) => nt.has(t))) unrelated++;
    if (i) {
      run = prim[i - 1]!.asset.provider === s.asset.provider ? run + 1 : 1;
      kindRun = kinds[i - 1] === kinds[i] ? kindRun + 1 : 1;
      maxProviderRun = Math.max(maxProviderRun, run);
      maxKindRun = Math.max(maxKindRun, kindRun);
    }
  });
  const durs = prim.map((s) => s.duration);
  const mean = durs.reduce((a, b) => a + b, 0) / Math.max(1, durs.length);
  const sd = Math.sqrt(durs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, durs.length));
  // Beats whose storyboard says "show this named person/event/thing": did they get it?
  const named = { beats: 0, exactMedia: 0, card: 0, otherMedia: 0 };
  for (const s of prim) {
    const n = Number(s.clipId.match(/_c(\d+)/)?.[1] ?? 0);
    const need = plans.get(s.sceneId)?.visualNeeds[n - 1];
    if (!need?.entities?.length || !["person_photo", "event_photo", "document"].includes(need.visualType ?? "")) continue;
    named.beats++;
    if (s.asset.provider === "graphic") named.card++;
    else if (Number(s.scores?.entityMatch ?? 0) >= 18) named.exactMedia++;
    else named.otherMedia++;
  }
  const transitions: Record<string, number> = {};
  for (const p of r.plans) transitions[p.transition] = (transitions[p.transition] ?? 0) + 1;
  return {
    clips: prim.length,
    memes: r.selections.length - prim.length,
    meanShot: +mean.toFixed(2),
    shotStdDev: +sd.toFixed(2),
    providers: provider,
    stockShare: +(stock / Math.max(1, prim.length)).toFixed(2),
    entityMatchWhereNamed: `${specific}/${specificNeeded}`,
    namedBeats: named,
    cards: prim.filter((s) => s.asset.provider === "graphic").length,
    noWordOverlapWithNarration: unrelated,
    maxSameProviderRun: maxProviderRun,
    maxSameKindRun: maxKindRun,
    transitions,
    warnings: r.warnings.length,
  };
}

async function main() {
  const [id, label = "run", ...rest] = process.argv.slice(2);
  if (!id) throw new Error("usage: editorial-report <projectId> <label> [--scenes=N]");
  const sceneLimit = Number(rest.find((a) => a.startsWith("--scenes="))?.split("=")[1] ?? 0);
  await mkdir(OUT, { recursive: true });
  const project = await loadProject(id);
  let transcript = Transcript.parse(project.transcript);
  if (sceneLimit) {
    // Roughly the first N scenes' worth of narration (≈8 s each) for quicker iterations.
    const cut = sceneLimit * 8.5;
    const words = transcript.words.filter((w) => w.end <= cut);
    transcript = { ...transcript, words, duration: words.at(-1)?.end ?? cut, text: words.map((w) => w.word).join(" ") };
  }
  const settings = parseSettings(project.settings);
  const db = createAdminClient();
  const style = await resolveStyle(db, project.style_profile_id, settings);
  const creds = await resolveCredentials(project.user_id);
  const director = makeDirector(null, settings);
  const t0 = Date.now();
  const result = await generateEdit(
    { projectTitle: project.name, transcript, settings, style, orientation: "landscape" },
    { director, creds, searchCache: new FileSearchCache(), onProgress: () => undefined },
  );
  const secs = (Date.now() - t0) / 1000;

  const lines: string[] = [];
  for (const p of result.plans) {
    const sb = p.storyboard;
    lines.push(`\n=== ${p.sceneId} ${p.startTime.toFixed(1)}–${p.endTime.toFixed(1)}s · ${p.visualStrategy} · ${p.transition}${sb ? ` · intent=${sb.intent} feel=${sb.feel} intensity=${sb.intensity} music=${sb.musicMood} pacing=${sb.pacing}` : ""}`);
    lines.push(`   "${p.narration}"`);
    if (sb) lines.push(`   entities: ${JSON.stringify(sb.entities)}`);
    for (const s of result.selections.filter((x) => x.sceneId === p.sceneId)) {
      const conf = s.scores && "confidence" in s.scores ? ` conf=${Number(s.scores.confidence).toFixed(2)}` : "";
      lines.push(`   ${s.start.toFixed(1).padStart(6)}s +${s.duration.toFixed(1)}s ${s.role === "meme" ? "MEME " : ""}[${s.needType}] ${s.asset.provider}/${s.asset.type}: ${s.asset.title.slice(0, 80)}  (score ${s.overall}${conf})`);
      lines.push(`            q=${JSON.stringify(s.queries.slice(0, 3))} · ${s.reason}`);
    }
  }
  const m = metrics(result);
  const summary = `Project ${project.name} (${id}) · label=${label} · ${result.plans.length} scenes · ${secs.toFixed(0)}s\n${JSON.stringify(m, null, 1)}`;
  const reviewLines = (result.review ?? []).map((r) => `${r.clipId ?? r.sceneId} ${r.problem} → ${r.action}: ${r.reason}`);
  const text = `${summary}\n${lines.join("\n")}\n\nREVIEW (pass 2):\n${reviewLines.join("\n")}\n\nWARNINGS:\n${result.warnings.join("\n")}\n`;
  await writeFile(path.join(OUT, `${label}.txt`), text);
  await writeFile(path.join(OUT, `${label}.json`), JSON.stringify({ metrics: m, plans: result.plans, selections: result.selections, review: result.review }, null, 1));
  console.log(summary);
  console.log(`→ ${path.join(OUT, `${label}.txt`)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
