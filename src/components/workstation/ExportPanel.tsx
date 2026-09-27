"use client";

import { useCallback, useEffect, useState } from "react";
import { api, Button, cx, Progress } from "@/components/ui";
import type { EditData, JobInfo } from "@/components/editor/types";
import { checkEdit, type HealthIssue } from "@/lib/assistant/health";
import type { TranscriptAnalysis } from "@/lib/analysis/types";
import { EXPORT_PRESETS, type ExportSettings, LOUDNESS_TARGETS } from "@/lib/domain/exportSettings";
import type { ProjectSettings } from "@/lib/domain/types";
import type { VoiceMeasurement } from "@/lib/domain/voice";
import type { QcReport } from "@/lib/render/qc";

interface ExportItem {
  id: string;
  format: string;
  createdAt: string;
  warnings: string[];
  videoUrl: string | null;
  downloadUrl: string | null;
  thumbnailUrl: string | null;
  manifest: {
    duration: number;
    width: number;
    height: number;
    fps: number;
    settings: ExportSettings;
    qc: QcReport;
    loudness: { gainDb: number; limited: boolean; skipped: boolean } | null;
    cues: number;
    chapters: { t: number; title: string }[];
    chaptersNote: string | null;
    credits: number;
    rights: { total: number; unconfirmed: number };
  } | null;
}

const ACTIVE = ["QUEUED", "DOWNLOADING", "PREPARING", "RENDERING", "FINALIZING"];
const FILES: [string, string][] = [
  ["captions.srt", "Captions (.srt)"],
  ["captions.vtt", "Captions (.vtt)"],
  ["chapters.txt", "YouTube chapters"],
  ["credits.txt", "Credits"],
  ["rights.csv", "Rights report (.csv)"],
  ["report.json", "Quality report"],
];

const fmtT = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const mb = (b: number) => `${(b / 1e6).toFixed(b > 1e8 ? 0 : 1)} MB`;

/** Final export: preset + delivery settings, a pre-export check, progress, and every export's files. */
export function ExportPanel({
  projectId,
  settings,
  edit,
  analysis,
  renderJob,
  onClose,
  onStarted,
}: {
  projectId: string;
  settings: ProjectSettings;
  edit: EditData | null;
  analysis: TranscriptAnalysis | null;
  renderJob: JobInfo | null;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [preset, setPreset] = useState(EXPORT_PRESETS[0]!.id);
  const [opts, setOpts] = useState<ExportSettings>(settings.export);
  const [issues, setIssues] = useState<HealthIssue[] | null>(null);
  const [acceptRisk, setAcceptRisk] = useState(false);
  const [items, setItems] = useState<ExportItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const running = Boolean(renderJob && ACTIVE.includes(renderJob.status));

  const loadHistory = useCallback(() => api<{ exports: ExportItem[] }>(`/api/projects/${projectId}/exports`).then((r) => setItems(r.exports)), [projectId]);

  // Pre-export check on the saved edit, and the export history.
  useEffect(() => {
    let alive = true;
    Promise.all([
      api<EditData>(`/api/projects/${projectId}/edit`),
      api<{ latest: { measurement: VoiceMeasurement } | null }>(`/api/projects/${projectId}/audio/voice`).then((r) => r.latest?.measurement ?? null).catch(() => null),
    ])
      .then(([e, voice]) => {
        if (!alive) return;
        setIssues(checkEdit({ plans: e.plans, clips: e.clips.map((c) => ({ ...c, asset: { id: c.asset.id, title: c.asset.title, type: c.asset.type, provider: c.asset.provider, rightsStatus: c.asset.rightsStatus } })), settings, analysis, duration: e.duration, voice }));
      })
      .catch((e: Error) => alive && setErr(e.message));
    api<{ exports: ExportItem[] }>(`/api/projects/${projectId}/exports`)
      .then((r) => alive && setItems(r.exports))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [projectId, settings, analysis]);

  // Refresh the history when a render finishes.
  const [lastRun, setLastRun] = useState(running);
  if (lastRun !== running) {
    setLastRun(running);
    if (!running) void loadHistory();
  }

  const problems = (issues ?? []).filter((i) => i.severity === "problem");
  const p = EXPORT_PRESETS.find((x) => x.id === preset)!;
  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/projects/${projectId}`, { method: "PATCH", json: { settings: { export: opts } } });
      await api(`/api/projects/${projectId}/jobs`, { method: "POST", json: { type: "render", format: p.format } });
      onStarted();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/60 p-6" onClick={onClose}>
      <div className="w-full max-w-4xl rounded-lg border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Export">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="text-base font-semibold">Export</div>
          <button className="text-muted hover:text-foreground" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="grid gap-5 p-5 md:grid-cols-[1fr_1fr]">
          {/* Settings */}
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              {EXPORT_PRESETS.map((x) => (
                <button key={x.id} onClick={() => setPreset(x.id)} className={cx("rounded-md border p-2.5 text-left", preset === x.id ? "border-accent bg-accent/10" : "border-line hover:border-muted")}>
                  <div className="text-sm font-medium">{x.label}</div>
                  <div className="text-[11px] text-muted">
                    {x.size} · {x.note}
                  </div>
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <label className="text-muted">
                Frame rate
                <select value={opts.fps} disabled={p.format === "draft"} onChange={(e) => setOpts({ ...opts, fps: Number(e.target.value) as ExportSettings["fps"] })} className="mt-1 h-8 w-full rounded border border-line bg-background px-2 text-foreground">
                  <option value={24}>24 fps (film)</option>
                  <option value={25}>25 fps (PAL / Europe)</option>
                  <option value={30}>30 fps (web)</option>
                </select>
              </label>
              <label className="text-muted">
                Quality
                <select value={opts.quality} disabled={p.format === "draft"} onChange={(e) => setOpts({ ...opts, quality: e.target.value as ExportSettings["quality"] })} className="mt-1 h-8 w-full rounded border border-line bg-background px-2 text-foreground">
                  <option value="standard">Standard (≤ 8 Mbps)</option>
                  <option value="high">High (≤ 16 Mbps, slower)</option>
                </select>
              </label>
              <label className="col-span-2 text-muted">
                Loudness
                <select value={opts.loudness} disabled={p.format === "draft"} onChange={(e) => setOpts({ ...opts, loudness: Number(e.target.value) })} className="mt-1 h-8 w-full rounded border border-line bg-background px-2 text-foreground">
                  {LOUDNESS_TARGETS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="col-span-2 flex items-start gap-2 text-muted">
                <input type="checkbox" className="mt-0.5" checked={opts.burnCaptions} onChange={(e) => setOpts({ ...opts, burnCaptions: e.target.checked })} />
                <span>
                  Burn captions into the picture
                  <span className="block text-[10px]">{settings.captions === "OFF" ? "Captions are off in the project, so nothing is burned in; .srt/.vtt files are delivered either way." : "Untick to deliver captions only as .srt/.vtt files (upload them to YouTube as subtitles)."}</span>
                </span>
              </label>
            </div>
            {p.format === "draft" && <p className="text-[11px] text-muted">Drafts skip the loudness pass and use fast settings.</p>}

            {/* Pre-export check */}
            <div className="rounded-md border border-line bg-panel-2/50 p-3 text-xs">
              <div className="mb-1 font-semibold">Before you export</div>
              {!issues ? (
                <div className="text-muted">Checking the edit…</div>
              ) : issues.length === 0 ? (
                <div className="text-ok">No problems found.</div>
              ) : (
                <>
                  <div className="text-muted">
                    {problems.length} problem{problems.length === 1 ? "" : "s"}, {issues.length - problems.length} other note{issues.length - problems.length === 1 ? "" : "s"} (open the Assistant → Check edit to fix them).
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {issues.slice(0, 5).map((i) => (
                      <li key={i.id} className={i.severity === "problem" ? "text-danger" : i.severity === "warning" ? "text-accent" : "text-muted"}>
                        • {i.title}
                      </li>
                    ))}
                  </ul>
                  {problems.length > 0 && p.format !== "draft" && (
                    <label className="mt-2 flex items-center gap-2">
                      <input type="checkbox" checked={acceptRisk} onChange={(e) => setAcceptRisk(e.target.checked)} /> Export anyway — I&apos;ll resolve these before publishing
                    </label>
                  )}
                </>
              )}
            </div>
            {running ? (
              <div className="space-y-1">
                <Progress value={renderJob!.progress ?? 0} />
                <div className="text-[11px] text-muted">{renderJob!.status === "QUEUED" ? "Waiting for the worker (npm run worker)…" : (renderJob!.current_stage ?? renderJob!.status)}</div>
              </div>
            ) : (
              <Button variant="primary" className="w-full" disabled={busy || !edit?.clips.length || (problems.length > 0 && p.format !== "draft" && !acceptRisk)} onClick={() => void start()}>
                Export {p.label}
              </Button>
            )}
            {err && <p className="text-xs text-danger">{err}</p>}
          </div>

          {/* History */}
          <div className="min-w-0 space-y-2">
            <div className="text-xs font-semibold text-muted">EXPORTS</div>
            {!items ? <div className="text-xs text-muted">Loading…</div> : items.length === 0 ? <div className="text-xs text-muted">Nothing exported yet.</div> : items.map((x) => <ExportCard key={x.id} projectId={projectId} x={x} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

function ExportCard({ projectId, x }: { projectId: string; x: ExportItem }) {
  const m = x.manifest;
  const q = m?.qc;
  const preset = EXPORT_PRESETS.find((p) => p.format === x.format);
  const loudOk = q && q.loudness !== null && q.loudnessTarget !== null ? Math.abs(q.loudness - q.loudnessTarget) <= 1 : null;
  const peakOk = q && q.truePeak !== null ? q.truePeak <= -0.9 : null;
  const [copied, setCopied] = useState(false);
  const chapterText = m?.chapters.map((c) => `${fmtT(c.t)} ${c.title}`).join("\n") ?? "";
  return (
    <div className="rounded-md border border-line bg-panel-2/40 p-2.5 text-xs">
      <div className="flex gap-2.5">
        {x.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed storage URL
          <img src={x.thumbnailUrl} alt="" className="h-16 w-28 shrink-0 rounded object-cover" />
        ) : (
          <div className="h-16 w-28 shrink-0 rounded bg-background" />
        )}
        <div className="min-w-0 flex-1">
          <div className="font-medium">{preset?.label ?? x.format}</div>
          <div className="text-[11px] text-muted">
            {new Date(x.createdAt).toLocaleString()} {m && `· ${fmtT(m.duration)} · ${m.width}×${m.height} ${m.fps} fps`} {q && `· ${mb(q.sizeBytes)}`}
          </div>
          {q && (
            <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
              {q.loudness !== null && <span className={cx("rounded px-1.5 py-0.5", loudOk === false ? "bg-danger/15 text-danger" : "bg-ok/15 text-ok")}>{q.loudness.toFixed(1)} LUFS{q.loudnessTarget !== null ? ` (target ${q.loudnessTarget})` : ""}</span>}
              {q.truePeak !== null && <span className={cx("rounded px-1.5 py-0.5", peakOk ? "bg-ok/15 text-ok" : "bg-danger/15 text-danger")}>peak {q.truePeak.toFixed(1)} dBTP</span>}
              {q.black.length > 0 && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-accent">{q.black.length} black stretch{q.black.length === 1 ? "" : "es"}</span>}
              {q.silence.length > 0 && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-accent">{q.silence.length} silent gap{q.silence.length === 1 ? "" : "s"}</span>}
              {m.rights.unconfirmed > 0 && <span className="rounded bg-danger/15 px-1.5 py-0.5 text-danger">{m.rights.unconfirmed} unconfirmed rights</span>}
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {x.downloadUrl && (
          <a className="font-medium text-accent hover:underline" href={x.downloadUrl}>
            MP4 ↓
          </a>
        )}
        {m ? (
          FILES.map(([f, label]) => (
            <a key={f} className="text-info hover:underline" href={`/api/projects/${projectId}/exports/${x.id}/${f}`}>
              {label}
            </a>
          ))
        ) : (
          <span className="text-muted">Older render — export again for captions, chapters and reports.</span>
        )}
      </div>
      {m && m.chapters.length > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11px] text-muted">Chapters ({m.chapters.length}){m.chaptersNote ? " — not enough for YouTube" : ""}</summary>
          <pre className="mt-1 whitespace-pre-wrap rounded bg-background p-2 text-[11px]">{chapterText}</pre>
          <button
            className="text-[11px] text-info hover:underline"
            onClick={() =>
              void navigator.clipboard.writeText(chapterText).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? "Copied" : "Copy for the YouTube description"}
          </button>
          {m.chaptersNote && <p className="text-[10px] text-muted">{m.chaptersNote}</p>}
        </details>
      )}
      {x.warnings.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-accent">{x.warnings.length} warning{x.warnings.length === 1 ? "" : "s"}</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-muted">
            {x.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
