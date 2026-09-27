/**
 * Export deliverables, all derived from the rendered timeline (output time, so captions and
 * chapters stay in sync even where the narration pauses for source clips): caption files
 * (SRT/VTT), YouTube chapters, credits and a rights report. The worker stores them as one
 * manifest per render; the export route turns it into files on request.
 */
import type { ExportSettings } from "@/lib/domain/exportSettings";
import { MIN_CHAPTER_SECONDS } from "@/lib/domain/exportSettings";
import type { RightsStatus, Timeline } from "@/lib/domain/types";
import { chunkWords } from "@/lib/render/ass";
import type { QcReport } from "@/lib/render/qc";

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export interface Chapter {
  t: number;
  title: string;
}

export interface RightsRow {
  clipId: string;
  start: number;
  duration: number;
  title: string;
  provider: string;
  license: string;
  licenseUrl: string | null;
  sourceUrl: string;
  author: string | null;
  attribution: string | null;
  rightsStatus: RightsStatus;
  approvedByUser: boolean;
}

export interface ExportManifest {
  version: 1;
  jobId: string;
  projectName: string;
  format: string;
  createdAt: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  settings: ExportSettings;
  cues: Cue[];
  chapters: Chapter[];
  /** Why chapters don't meet YouTube's rules, when they don't (they're still listed). */
  chaptersNote: string | null;
  credits: string[];
  rights: RightsRow[];
  qc: QcReport;
  loudness: { gainDb: number; limited: boolean; skipped: boolean } | null;
  warnings: string[];
  thumbnailAt: number;
}

/** Caption cues from the timeline's words (output time), the same phrasing the render burns in. */
export function buildCues(t: Timeline): Cue[] {
  const words = t.captions.words;
  return chunkWords(words)
    .map((c) => ({ start: c.start, end: Math.max(c.end, c.start + 0.3), text: c.idx.map((i) => words[i]!.word).join(" ").replace(/\s+/g, " ").trim() }))
    .filter((c) => c.text && c.start < t.duration);
}

/**
 * Chapters: chapter-title graphics when the film has them, else one per scene (titled by the
 * caller). Chapters shorter than YouTube's 10 s minimum merge into the previous one; the first is
 * always at 0:00.
 */
export function buildChapters(t: Timeline, sceneTitles: Record<string, string>): { chapters: Chapter[]; note: string | null } {
  const fromGraphics = (t.graphics ?? []).filter((g) => g.kind === "chapter").map((g) => ({ t: g.start, title: g.title }));
  let raw: Chapter[];
  if (fromGraphics.length >= 2) raw = fromGraphics;
  else {
    const firstBy = new Map<string, number>();
    for (const v of t.visuals) if (!firstBy.has(v.sceneId) || v.start < firstBy.get(v.sceneId)!) firstBy.set(v.sceneId, v.start);
    raw = [...firstBy.entries()].map(([sceneId, start], i) => ({ t: start, title: sceneTitles[sceneId] || `Part ${i + 1}` }));
  }
  raw.sort((a, b) => a.t - b.t);
  if (!raw.length || raw[0]!.t > 0) raw.unshift({ t: 0, title: raw[0]?.t === 0 ? raw[0].title : "Introduction" });
  raw[0]!.t = 0;
  const out: Chapter[] = [];
  for (const c of raw) {
    const prev = out.at(-1);
    if (prev && c.t - prev.t < MIN_CHAPTER_SECONDS) continue;
    out.push({ t: Math.round(c.t), title: c.title.replace(/\s+/g, " ").trim().slice(0, 90) });
  }
  // The last chapter must also last ≥ 10 s.
  while (out.length > 1 && t.duration - out.at(-1)!.t < MIN_CHAPTER_SECONDS) out.pop();
  const note = out.length < 3 ? `YouTube needs at least 3 chapters of ≥ ${MIN_CHAPTER_SECONDS} s; this film has ${out.length}.` : null;
  return { chapters: out, note };
}

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, "0");
function clock(s: number, sep: "," | ".") {
  const ms = Math.round((s % 1) * 1000);
  return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}${sep}${pad(ms, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${clock(c.start, ",")} --> ${clock(c.end, ",")}\n${c.text}\n`).join("\n");
}

export function toVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${clock(c.start, ".")} --> ${clock(c.end, ".")}\n${c.text}\n`).join("\n")}`;
}

/** "0:00 Title" lines, ready to paste into a YouTube description. */
export function chaptersText(chapters: Chapter[]): string {
  return chapters.map((c) => `${c.t >= 3600 ? `${Math.floor(c.t / 3600)}:${pad((c.t % 3600) / 60)}` : Math.floor(c.t / 60)}:${pad(c.t % 60)} ${c.title}`).join("\n");
}

export function creditsText(m: Pick<ExportManifest, "projectName" | "credits">): string {
  return [`${m.projectName}`, "", "Credits", ...m.credits.map((c) => `• ${c}`), "", "Edited with DocuCut."].join("\n");
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Quote every cell; neutralise spreadsheet formulas.
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

export function rightsCsv(rows: RightsRow[]): string {
  const head = ["Time", "Duration (s)", "Title", "Provider", "Licence", "Licence URL", "Source URL", "Author", "Attribution", "Rights status", "Approved by you"];
  const body = rows.map((r) => [clock(r.start, ".").slice(0, 8), r.duration.toFixed(1), r.title, r.provider, r.license, r.licenseUrl, r.sourceUrl, r.author, r.attribution, r.rightsStatus, r.approvedByUser ? "yes" : "no"].map(csvCell).join(","));
  return `﻿${[head.map(csvCell).join(","), ...body].join("\r\n")}\r\n`;
}

/** Everything the worker knows after a render → the stored manifest. */
export function buildManifest(x: {
  jobId: string;
  projectName: string;
  format: string;
  timeline: Timeline;
  /** Clip id → the chosen asset's metadata (title, licence, source…). */
  assets: Map<string, { title: string; provider: string; license: string; licenseUrl: string | null; sourceUrl: string; author: string | null; attribution: string | null; rightsStatus: RightsStatus; userApproved?: boolean }>;
  settings: ExportSettings;
  sceneTitles: Record<string, string>;
  qc: QcReport;
  loudness: ExportManifest["loudness"];
  warnings: string[];
}): ExportManifest {
  const t = x.timeline;
  const { chapters, note } = buildChapters(t, x.sceneTitles);
  const rights: RightsRow[] = t.visuals
    .filter((v) => !v.asset.assetId.startsWith("graphic:") && !v.asset.assetId.startsWith("uploaded:narration:"))
    .map((v) => {
      const a = x.assets.get(v.id.split("~")[0]!);
      return {
        clipId: v.id,
        start: Math.round(v.start * 100) / 100,
        duration: Math.round(v.duration * 100) / 100,
        title: a?.title ?? v.asset.assetId,
        provider: a?.provider ?? "unknown",
        license: a?.license ?? "unknown",
        licenseUrl: a?.licenseUrl ?? null,
        sourceUrl: a?.sourceUrl ?? "",
        author: a?.author ?? null,
        attribution: a?.attribution ?? null,
        rightsStatus: a?.rightsStatus ?? v.asset.rightsStatus,
        approvedByUser: Boolean(a?.userApproved),
      };
    });
  // A thumbnail from a meaningful moment: the first chapter/lower-third graphic, else 20% in —
  // never inside a black stretch.
  const g = (t.graphics ?? []).find((x) => x.kind === "chapter" || x.kind === "lower_third" || x.kind === "statistic");
  let thumbnailAt = g ? g.start + Math.min(1.5, g.duration / 2) : t.duration * 0.2;
  if (x.qc.black.some((b) => thumbnailAt >= b.start && thumbnailAt <= b.end)) thumbnailAt = Math.min(t.duration - 0.5, (x.qc.black.find((b) => thumbnailAt >= b.start)?.end ?? thumbnailAt) + 1);
  return {
    version: 1,
    jobId: x.jobId,
    projectName: x.projectName,
    format: x.format,
    createdAt: new Date().toISOString(),
    duration: x.qc.duration ?? t.duration,
    width: t.width,
    height: t.height,
    fps: t.fps,
    settings: x.settings,
    cues: buildCues(t),
    chapters,
    chaptersNote: note,
    credits: [...new Set(t.attributions)],
    rights,
    qc: x.qc,
    loudness: x.loudness,
    warnings: x.warnings,
    thumbnailAt: Math.round(thumbnailAt * 100) / 100,
  };
}
