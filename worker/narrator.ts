/**
 * Narrator tasks: analyse a voice profile's recordings and match an engine voice; generate
 * narration (sentences → delivery → assembly → processing) with before/after previews.
 * Everything runs locally: Kokoro on the CPU, FFmpeg for audio.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { stableHash } from "@/lib/media/cache";
import { decodeMono16k, speechStats, summarise } from "@/lib/narrator/analyze";
import { kokoroEngine, type NarratorEngine } from "@/lib/narrator/engine";
import { analysisNotes, calibrateVoice, candidateVoices, chooseMatch } from "@/lib/narrator/match";
import { planDelivery } from "@/lib/narrator/prosody";
import { isProfileSamplePath } from "@/lib/narrator/samples";
import { assemble, encodeM4a, processNarration, renderSentence } from "@/lib/narrator/render";
import { applyPronunciations, outputBasis, parseNarrator, sentenceKey } from "@/lib/narrator/state";
import { DEFAULT_VOICE_ID, KOKORO_VOICES, type NarratorOutput, type VoiceAnalysis, VoiceMatch, type VoiceSample } from "@/lib/narrator/types";
import { measureLoudness } from "@/lib/render/qc";
import type { TaskDeps, TaskJob } from "./tasks";

let engine: NarratorEngine | null = null;
const getEngine = (root: string) => (engine ??= kokoroEngine(root));

interface ProfileRow {
  id: string;
  user_id: string;
  accent: "us" | "uk";
  samples: VoiceSample[];
  match: unknown;
  pronunciations: Record<string, string> | null;
  updated_at: string;
}

async function loadProfile(d: TaskDeps, id: string, userId: string): Promise<ProfileRow> {
  const { data } = await d.db.from("voice_profiles").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!data) throw new Error("The voice profile no longer exists.");
  return data as ProfileRow;
}

/** Measure the recordings, then match an engine voice (calibrating candidate voices once). */
export async function voiceProfileTask(job: TaskJob, d: TaskDeps) {
  const profileId = typeof job.payload?.profileId === "string" ? job.payload.profileId : null;
  if (!profileId) throw new Error("voice_profile: missing profileId");
  const profile = await loadProfile(d, profileId, job.user_id);
  if (!profile.samples.length) throw new Error("Add at least one recording first.");
  // Sample paths come from a user-writable row: read only the profile's own folder or the user's projects.
  const { data: owned } = await d.db.from("projects").select("id").eq("user_id", job.user_id);
  const ownProjects = new Set((owned ?? []).map((p) => p.id as string));
  const allowed = (p: string) => isProfileSamplePath(p, profileId) || (ownProjects.has(p.split("/")[0]!) && !p.includes(".."));
  const stats = [];
  const samples: VoiceSample[] = [];
  for (const [i, s] of profile.samples.entries()) {
    if (!allowed(s.path)) throw new Error(`Recording “${s.name}” is not in this profile's storage.`);
    await d.progress(`Measuring recording ${i + 1} of ${profile.samples.length}…`, 0.05 + (i / profile.samples.length) * 0.3);
    const local = await d.downloadObject(s.path);
    const pcm = await decodeMono16k(local);
    const st = speechStats(pcm);
    stats.push(st);
    samples.push({ ...s, duration: Math.round(st.duration * 10) / 10 });
  }
  const summary = summarise(stats);
  if (summary.speechSeconds < 3 || !summary.pitchMedian) throw new Error("No speech was found in the recordings. Check that the microphone recorded your voice.");
  const analysis: VoiceAnalysis = { ...summary, notes: analysisNotes(summary), analysedAt: new Date().toISOString() };
  d.log(`voice profile ${profileId.slice(0, 8)}: ${JSON.stringify(summary)}`);

  const voices = candidateVoices(profile.accent, analysis.pitchMedian);
  const cals = [];
  const eng = getEngine(d.root);
  for (const [i, v] of voices.entries()) {
    const name = KOKORO_VOICES.find((x) => x.id === v)?.name ?? v;
    await d.progress(`Comparing with voice ${name} (${i + 1} of ${voices.length})…`, 0.4 + (i / voices.length) * 0.55);
    cals.push(await calibrateVoice(eng, v, path.join(d.root, "narrator")));
  }
  const match = chooseMatch(analysis, cals);
  const { error } = await d.db.from("voice_profiles").update({ analysis, match, samples, updated_at: new Date().toISOString() }).eq("id", profileId);
  if (error) throw new Error(error.message);
  return { profileId, voice: match.voice, pitchShift: match.pitchShift, speed: match.speed };
}

/**
 * Generate narration. mode "sentences": just the listed sentences' audio (quick previews);
 * "full": every sentence, then assembly, processing, and before/after + narration files.
 */
export async function narrateTask(job: TaskJob, d: TaskDeps) {
  const mode = job.payload?.mode === "sentences" ? "sentences" : "full";
  const only = Array.isArray(job.payload?.ids) ? new Set(job.payload.ids as string[]) : null;
  const { data: project } = await d.db.from("projects").select("narrator").eq("id", job.project_id).single();
  const n = parseNarrator(project?.narrator);
  if (!n.sentences.length) throw new Error("Paste a script first.");

  const profile = n.profileId ? await loadProfile(d, n.profileId, job.user_id).catch(() => null) : null;
  const parsedMatch = profile?.match ? VoiceMatch.safeParse(profile.match) : null;
  let match = parsedMatch?.success ? parsedMatch.data : null;
  const voice = n.voice ?? match?.voice ?? DEFAULT_VOICE_ID;
  // A voice chosen by hand isn't the one the pitch/speed were fitted to: keep the profile's pauses
  // and variation, drop the pitch shift and speed ratio.
  if (match && voice !== match.voice) match = { ...match, pitchShift: 0, speed: 1 };
  const pron = profile?.pronunciations ?? {};
  const plans = planDelivery({ sentences: n.sentences, style: n.style, controls: n.controls, match });
  const eng = getEngine(d.root);
  const dir = path.join(d.root, "narrator", "sentences");
  const targets = n.sentences.map((s, i) => ({ s, plan: plans[i]! })).filter(({ s }) => mode === "full" || only?.has(s.id));
  if (!targets.length) throw new Error("None of those sentences are in the script any more.");

  const t0 = Date.now();
  const audio = new Map<string, { path: string; duration: number; hash: string; key: string; file: string }>();
  for (const [i, { s, plan }] of targets.entries()) {
    const label = s.text.length > 48 ? `${s.text.slice(0, 48)}…` : s.text;
    await d.progress(`Speaking ${i + 1} of ${targets.length}: “${label}”…`, (i / targets.length) * (mode === "full" ? 0.75 : 0.95));
    const r = await renderSentence(eng, dir, voice, s, plan, pron);
    const objectPath = `${job.project_id}/audio/narrator/${r.hash}.m4a`;
    if (s.audio?.hash !== r.hash) {
      const m4a = await encodeM4a(r.file, path.join(dir, `p-${r.hash}.m4a`));
      await d.uploadFile(m4a, objectPath, "audio/mp4");
    }
    audio.set(s.id, { path: objectPath, duration: Math.round(r.duration * 100) / 100, hash: r.hash, key: sentenceKey(voice, applyPronunciations(s.text, pron), plan), file: r.file });
  }
  d.log(`narrator: ${targets.length} sentence(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  let output: NarratorOutput | null = null;
  if (mode === "full") {
    await d.progress("Joining sentences with pauses…", 0.78);
    const work = path.join(d.root, "narrator", "out", job.project_id);
    await mkdir(work, { recursive: true });
    const key = stableHash({ parts: n.sentences.map((s, i) => [audio.get(s.id)!.hash, plans[i]!.pauseAfter]), p: n.processing }).slice(0, 16);
    const raw = path.join(work, `raw-${key}.wav`);
    const asm = await assemble(n.sentences.map((s, i) => ({ id: s.id, file: audio.get(s.id)!.file, pauseAfter: plans[i]!.pauseAfter })), raw);
    await d.progress("Processing the voice…", 0.84);
    const processed = path.join(work, `processed-${key}.wav`);
    if (!existsSync(processed)) await processNarration(raw, n.processing, processed, asm.duration);
    await d.progress("Encoding before/after previews…", 0.92);
    // "Before" at the processed loudness, so the comparison is about sound, not level.
    const [rawL, procL] = await Promise.all([measureLoudness(raw), measureLoudness(processed)]);
    const matchGain = rawL.loudness !== null && procL.loudness !== null ? procL.loudness - rawL.loudness : 0;
    const before = await encodeM4a(raw, path.join(work, `before-${key}.m4a`), { gainDb: matchGain });
    const after = await encodeM4a(processed, path.join(work, `after-${key}.m4a`));
    const full = await encodeM4a(processed, path.join(work, `narration-${key}.m4a`), { bitrate: "192k" });
    const base = `${job.project_id}/audio/narrator`;
    output = {
      beforePath: `${base}/before-${key}.m4a`,
      afterPath: `${base}/after-${key}.m4a`,
      narrationPath: `${base}/narration-${key}.m4a`,
      duration: Math.round(asm.duration * 100) / 100,
      hash: key,
      timings: asm.timings,
      basis: outputBasis(n, profile?.updated_at ?? null),
      voice,
      createdAt: new Date().toISOString(),
    };
    await d.uploadFile(before, output.beforePath, "audio/mp4");
    await d.uploadFile(after, output.afterPath, "audio/mp4");
    await d.uploadFile(full, output.narrationPath, "audio/mp4");
  }

  // Merge into the latest narrator (the user may have edited while this ran): only sentences that
  // still exist with the same take get their audio; the output is stored with its basis.
  const { data: latestRow } = await d.db.from("projects").select("narrator").eq("id", job.project_id).single();
  const latest = parseNarrator(latestRow?.narrator);
  const takes = new Map(n.sentences.map((s) => [s.id, s.take]));
  latest.sentences = latest.sentences.map((s) => {
    const a = audio.get(s.id);
    return a && takes.get(s.id) === s.take ? { ...s, audio: { path: a.path, duration: a.duration, hash: a.hash, key: a.key } } : s;
  });
  if (output) latest.output = output;
  const { error } = await d.db.from("projects").update({ narrator: latest }).eq("id", job.project_id);
  if (error) throw new Error(error.message);
  return { mode, sentences: targets.length, duration: output?.duration ?? null, voice };
}
