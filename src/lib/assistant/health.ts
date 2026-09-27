/**
 * "Check my edit": problems a finishing editor would catch before export, each with the moment it
 * concerns and, where there is one, a one-click fix (an assistant action). Everything is measured
 * from the edit itself — clip rights and confidence, repetition, static holds, who is introduced
 * without a name graphic, overlapping graphics, the narration's measured noise, the mix, captions.
 */
import type { TranscriptAnalysis } from "@/lib/analysis/types";
import { DEFAULT_DURATION } from "@/lib/domain/graphics";
import type { ProjectSettings, RightsStatus, ScenePlan } from "@/lib/domain/types";
import { DEFAULT_VOICE, type VoiceMeasurement } from "@/lib/domain/voice";
import type { AssistantAction } from "./actions";

export interface HealthClip {
  clipId: string;
  sceneId: string;
  start: number;
  duration: number;
  role: string;
  userApproved: boolean;
  scores: Record<string, number> | null;
  motion: string;
  asset: { id: string; title: string; type: string; provider: string; rightsStatus: RightsStatus };
}

export interface HealthInput {
  plans: ScenePlan[];
  clips: HealthClip[];
  settings: ProjectSettings;
  analysis: TranscriptAnalysis | null;
  duration: number;
  /** Latest narration measurement (Audio tab → Measure), if any. */
  voice: VoiceMeasurement | null;
}

export type Severity = "problem" | "warning" | "tip";
export interface HealthIssue {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  t?: number;
  fix?: AssistantAction;
  fixLabel?: string;
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(0).padStart(2, "0")}`;

export function checkEdit(x: HealthInput): HealthIssue[] {
  const out: HealthIssue[] = [];
  const clips = [...x.clips].sort((a, b) => a.start - b.start);
  const visuals = clips.filter((c) => c.asset.provider !== "graphic");

  // 1. Rights: anything not cleared must be confirmed before publishing.
  const unclear = visuals.filter((c) => (c.asset.rightsStatus === "UNKNOWN" || c.asset.rightsStatus === "USER_REVIEW") && !c.userApproved);
  if (unclear.length) {
    out.push({
      id: "rights",
      severity: "problem",
      title: `${unclear.length} visual${unclear.length === 1 ? "" : "s"} with unconfirmed rights`,
      detail: `Confirm you may use them or replace them before publishing (first at ${fmt(unclear[0]!.start)}).`,
      t: unclear[0]!.start,
      fix: { type: "openRights" },
      fixLabel: "Review rights",
    });
  }

  // 2. Low-confidence picks: the editor itself wasn't sure the visual fits the line.
  const weak = visuals.filter((c) => c.role === "primary" && c.scores && Number(c.scores.confidence ?? 1) < 0.4).slice(0, 5);
  for (const c of weak) {
    out.push({
      id: `weak-${c.clipId}`,
      severity: "warning",
      title: `Weak visual match at ${fmt(c.start)}`,
      detail: `“${c.asset.title}” scored ${Math.round(Number(c.scores!.confidence) * 100)}% confidence for its line.`,
      t: c.start,
      fix: { type: "replaceClip", clipKey: c.clipId, sceneId: c.sceneId },
      fixLabel: "Find better footage",
    });
  }

  // 3. The same shot used twice within half a minute.
  const lastUse = new Map<string, HealthClip>();
  for (const c of visuals) {
    const prev = lastUse.get(c.asset.id);
    if (prev && c.start - prev.start < 30) {
      out.push({ id: `repeat-${c.clipId}`, severity: "warning", title: `Repeated shot at ${fmt(c.start)}`, detail: `“${c.asset.title}” was already on screen at ${fmt(prev.start)}.`, t: c.start, fix: { type: "replaceClip", clipKey: c.clipId, sceneId: c.sceneId }, fixLabel: "Replace" });
    }
    lastUse.set(c.asset.id, c);
  }

  // 4. Long static holds: a still photo without motion for many seconds.
  for (const c of visuals.filter((v) => v.asset.type === "photo" && v.motion === "none" && v.duration > 7).slice(0, 4)) {
    out.push({ id: `static-${c.clipId}`, severity: "tip", title: `${c.duration.toFixed(0)} s still photo at ${fmt(c.start)}`, detail: "A long hold on a still with no movement feels frozen. Add slow motion or split it.", t: c.start, fix: { type: "selectClip", clipKey: c.clipId, sceneId: c.sceneId, t: c.start }, fixLabel: "Select clip" });
  }

  // 5. People introduced without a name graphic (viewers need to know who they are).
  if (x.analysis?.timed) {
    const named = new Set(x.plans.flatMap((p) => (p.graphics ?? []).filter((g) => g.kind === "lower_third").map((g) => g.title.toLowerCase())));
    const people = x.analysis.entities.filter((e) => e.kind === "person" && !named.has(e.name.toLowerCase())).slice(0, 4);
    for (const e of people) {
      const s = x.analysis.sentences[e.firstSentence];
      const plan = s ? x.plans.find((p) => s.start >= p.startTime && s.start < p.endTime) : null;
      if (!s || !plan) continue;
      const mention = s.mentions.find((m) => m.name === e.name);
      const pos = mention ? Math.max(0, s.text.indexOf(mention.text)) / Math.max(1, s.text.length) : 0;
      const t = s.start + (s.end - s.start) * pos;
      out.push({
        id: `name-${e.name}`,
        severity: "tip",
        title: `${e.name} is introduced without a name graphic`,
        detail: `First mentioned at ${fmt(t)}.${e.description ? ` (${e.description})` : ""}`,
        t,
        fix: { type: "addGraphic", sceneId: plan.sceneId, graphic: { kind: "lower_third", title: e.name, sub: e.description ?? "", at: Math.round((t - plan.startTime) * 100) / 100, duration: DEFAULT_DURATION.lower_third, position: "auto", animation: "auto", source: "user" } },
        fixLabel: "Add lower third",
      });
    }
  }

  // 6. Graphics on screen at the same time in the same place.
  const gs = x.plans.flatMap((p) => (p.graphics ?? []).map((g) => ({ g, t: p.startTime + g.at, sceneId: p.sceneId })));
  gs.sort((a, b) => a.t - b.t);
  for (let i = 1; i < gs.length; i++) {
    const a = gs[i - 1]!;
    const b = gs[i]!;
    const posA = a.g.position === "auto" ? a.g.kind : a.g.position;
    const posB = b.g.position === "auto" ? b.g.kind : b.g.position;
    if (b.t < a.t + a.g.duration && (posA === posB || a.g.kind === "chapter" || b.g.kind === "chapter")) {
      out.push({ id: `overlap-${b.g.id}`, severity: "warning", title: `Graphics overlap at ${fmt(b.t)}`, detail: `“${a.g.title}” and “${b.g.title}” are on screen together in the same place.`, t: b.t, fix: { type: "seek", t: b.t, label: fmt(b.t) }, fixLabel: "Go there" });
    }
  }

  // 7. Narration: measured noise with no processing, or never measured.
  if (x.settings.voice.preset === "off") {
    if (x.voice && x.voice.noiseFloor > -60) {
      out.push({ id: "voice-noise", severity: "warning", title: "Audible background noise in the narration", detail: `The noise floor measures ${x.voice.noiseFloor.toFixed(0)} dBFS and no voice processing is on.`, fix: { type: "voice", voice: { ...DEFAULT_VOICE, preset: "auto" } }, fixLabel: "Clean up the voice" });
    } else if (!x.voice) {
      out.push({ id: "voice-unmeasured", severity: "tip", title: "Narration not measured yet", detail: "Audio tab → Measure & preview checks noise, loudness and harsh s sounds." });
    }
  }
  if (x.voice && x.voice.truePeak > -0.5) out.push({ id: "voice-clip", severity: "warning", title: "The narration may be clipped", detail: `Peaks reach ${x.voice.truePeak.toFixed(1)} dBTP in the recording; distortion can't be removed afterwards.` });

  // 8. Mix balance.
  if (x.settings.musicTrack !== "none" && x.settings.mix.musicVolume > 0.6) {
    out.push({ id: "music-loud", severity: "warning", title: "Music may compete with the narration", detail: `Music volume is ${Math.round(x.settings.mix.musicVolume * 100)}%; around 35% keeps speech clear.`, fix: { type: "mix", mix: { musicVolume: 0.35 } }, fixLabel: "Set music to 35%" });
  }
  if (x.settings.mix.duckingStrength < 0.4 && x.settings.musicTrack !== "none") {
    out.push({ id: "duck-weak", severity: "tip", title: "Music barely ducks under speech", detail: `Ducking is ${Math.round(x.settings.mix.duckingStrength * 100)}%.`, fix: { type: "mix", mix: { duckingStrength: 0.7 } }, fixLabel: "Set ducking to 70%" });
  }

  // 9. Accessibility: captions.
  if (x.settings.captions === "OFF") {
    out.push({ id: "captions", severity: "tip", title: "No captions", detail: "Most social video is watched muted, and captions make the film accessible.", fix: { type: "captions", mode: "STANDARD" }, fixLabel: "Turn captions on" });
  }

  // 10. Nothing on screen names the story's facts (no graphics at all on a long film).
  if (!gs.length && x.duration > 45 && x.analysis?.timed) {
    out.push({ id: "no-graphics", severity: "tip", title: "No graphics yet", detail: "Names, places, dates and figures read better on screen.", fix: { type: "suggestGraphics" }, fixLabel: "Suggest graphics" });
  }

  const order: Record<Severity, number> = { problem: 0, warning: 1, tip: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity] || (a.t ?? 0) - (b.t ?? 0));
}
