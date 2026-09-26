"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { api, Button, cx, fmtTime, Progress, Select, Tag } from "@/components/ui";
import { JOB_CANCELLED } from "@/lib/domain/types";
import { MUSIC_TRACKS } from "@/lib/render/libraryTracks";
import { Inspector } from "./Inspector";
import { LivePlayer } from "./LivePlayer";
import { ReplaceDialog } from "./ReplaceDialog";
import { ReviewPanel } from "./ReviewPanel";
import { RightsPanel } from "./RightsPanel";
import { SetupPanel } from "./SetupPanel";
import { createPlayhead } from "./playhead";
import { Timeline } from "./Timeline";
import type { Clip, EditData, StatusData } from "./types";
import { useWaveform } from "./useWaveform";

const ACTIVE = ["QUEUED", "RUNNING", "DOWNLOADING", "PREPARING", "RENDERING", "FINALIZING"];
const SIGNED_URL_REUSE_MS = 45 * 60_000; // the status route signs URLs for 1 h

/**
 * The status route leaves a URL null when the editor already holds one for the same file
 * (uploads/exports get unique paths). Keep the held URL: a changed URL would reload the preview
 * video and re-download + re-decode the whole narration for the waveform.
 */
function mergeStatus(prev: StatusData | null, next: StatusData): StatusData {
  if (!prev) return next;
  const pe = prev.latestExport;
  const ne = next.latestExport;
  return {
    ...next,
    narrationUrl: next.narrationUrl ?? (next.narrationPath && next.narrationPath === prev.narrationPath ? prev.narrationUrl : null),
    latestExport: ne && !ne.url && pe?.id === ne.id ? { ...ne, url: pe.url, downloadUrl: pe.downloadUrl } : ne,
  };
}

export function Editor({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [edit, setEdit] = useState<EditData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<"scenes" | "setup">("scenes");
  const [selectedClip, setSelectedClip] = useState<string | null>(null);
  const [selectedScene, setSelectedScene] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [replacing, setReplacing] = useState<{ clip: Clip; tab: "ai" | "search" } | null>(null);
  const [centerTab, setCenterTab] = useState<"preview" | "review">("preview");
  const [showRights, setShowRights] = useState(false);
  // null = automatic: the live edit until a render exists, then the render.
  const [watchMode, setWatchMode] = useState<"live" | "render" | null>(null);
  const [format, setFormat] = useState<"landscape" | "vertical" | "draft">("draft");
  const [playhead] = useState(createPlayhead);
  const [busy, setBusy] = useState(false);
  // The mounted player (rendered video or the live preview's narration clock); seeking goes through it.
  const videoRef = useRef<HTMLMediaElement>(null);
  const lastSeen = useRef<string>("");
  const statusRef = useRef<StatusData | null>(null);
  // Signed URLs the editor holds, reported to the status route so it doesn't re-sign them.
  const held = useRef({ exportId: null as string | null, narrationPath: null as string | null, signedAt: 0 });

  const applyStatus = useCallback((s: StatusData, freshlySigned: boolean) => {
    const merged = mergeStatus(statusRef.current, s);
    if (freshlySigned) held.current.signedAt = Date.now();
    held.current.exportId = merged.latestExport?.url && !merged.latestExport.local ? merged.latestExport.id : null;
    held.current.narrationPath = merged.narrationUrl ? merged.narrationPath : null;
    // An unchanged poll must not re-render the whole editor.
    if (statusRef.current && JSON.stringify(statusRef.current) === JSON.stringify(merged)) return;
    statusRef.current = merged;
    setStatus(merged);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const h = held.current;
      const reuse = Date.now() - h.signedAt < SIGNED_URL_REUSE_MS;
      const q = new URLSearchParams();
      if (reuse && h.exportId) q.set("exportId", h.exportId);
      if (reuse && h.narrationPath) q.set("narration", h.narrationPath);
      const s = await api<StatusData>(`/api/projects/${projectId}/status${q.size ? `?${q}` : ""}`);
      applyStatus(s, !reuse);
      return s;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [projectId, applyStatus]);

  const loadEdit = useCallback(async () => {
    try {
      setEdit(await api<EditData>(`/api/projects/${projectId}/edit`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  const refresh = useCallback(async () => {
    await Promise.all([loadStatus(), loadEdit()]);
  }, [loadStatus, loadEdit]);

  useEffect(() => {
    let alive = true;
    Promise.all([api<StatusData>(`/api/projects/${projectId}/status`), api<EditData>(`/api/projects/${projectId}/edit`)])
      .then(([s, e]) => {
        if (!alive) return;
        applyStatus(s, true);
        setEdit(e);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [projectId, applyStatus]);

  // Poll: fast while a job runs, slow otherwise; reload the edit when a job finishes. The next
  // poll is scheduled only after the previous one returns (a slow response never stacks
  // requests), and polling pauses while the tab is hidden, catching up as soon as it is visible.
  const running = Boolean(status && (ACTIVE.includes(status.pipelineJob?.status ?? "") || ACTIVE.includes(status.renderJob?.status ?? "")));
  useEffect(() => {
    const every = running ? 2000 : 10000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let stopped = false;
    const tick = async () => {
      if (!document.hidden) {
        inFlight = true;
        const s = await loadStatus();
        inFlight = false;
        const key = `${s?.pipelineJob?.id}:${s?.pipelineJob?.status}:${s?.project.timelineVersion}`;
        if (s && key !== lastSeen.current) {
          if (lastSeen.current) void loadEdit();
          lastSeen.current = key;
        }
      }
      if (!stopped) timer = setTimeout(tick, every);
    };
    const onVisible = () => {
      if (document.hidden || inFlight) return;
      clearTimeout(timer);
      void tick();
    };
    timer = setTimeout(tick, every);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [running, loadStatus, loadEdit]);

  const selectClip = useCallback((c: Clip) => {
    setSelectedClip(c.clipId);
    setSelectedScene(c.sceneId);
  }, []);
  const selectScene = useCallback((id: string) => {
    setSelectedScene(id);
    setSelectedClip(null);
  }, []);
  const seek = useCallback(
    (t: number) => {
      playhead.set(t);
      if (videoRef.current) videoRef.current.currentTime = t;
    },
    [playhead],
  );

  const peaks = useWaveform(status?.narrationUrl ?? null);

  const enqueue = async (json: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${projectId}/jobs`, { method: "POST", json });
      await loadStatus();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const cancel = async (target: "pipeline" | "render") => {
    if (!confirm(target === "render" ? "Cancel this render?" : "Cancel generation? Your current edit is kept.")) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${projectId}/jobs/cancel`, { method: "POST", json: { target } });
      await loadStatus();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  if (!status) return <div className="p-8 text-sm text-muted">{error ?? "Loading project…"}</div>;
  const p = status.project;
  const clip = edit?.clips.find((c) => c.clipId === selectedClip) ?? null;
  const plan = edit?.plans.find((x) => x.sceneId === (selectedScene ?? clip?.sceneId)) ?? null;
  const pj = status.pipelineJob;
  const rj = status.renderJob;
  const music = MUSIC_TRACKS.find((t) => t.key === p.settings.musicTrack)?.name ?? (p.settings.musicTrack === "uploaded" ? "Uploaded music" : "No music");
  const hasEdit = Boolean(edit?.clips.length);
  const canLive = Boolean(hasEdit && status.narrationUrl);
  const mode = watchMode ?? (status.latestExport?.url ? "render" : "live");

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      {/* header */}
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
        <div className="mr-auto min-w-0">
          <h1 className="truncate text-base font-semibold">
            {p.name} {p.isDemo && <Tag tone="accent">Demo</Tag>}
          </h1>
          <div className="text-[11px] text-muted">
            AI usage: {status.usage.calls} calls ({status.usage.cached_calls} cached) · {Number(status.usage.input_tokens).toLocaleString()} in / {Number(status.usage.output_tokens).toLocaleString()} out · est. ${Number(status.usage.cost_usd).toFixed(3)}
          </div>
        </div>
        <Button variant="primary" disabled={busy || ACTIVE.includes(pj?.status ?? "") || !p.hasNarration} onClick={() => (!hasEdit || confirm("Regenerate the whole edit? Your manual changes will be replaced.")) && void enqueue({ type: "generate" })}>
          {hasEdit ? "Regenerate All" : "Generate"}
        </Button>
        <Select className="w-52" value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
          <option value="draft">Draft preview · 960×540</option>
          <option value="landscape">YouTube · 1920×1080</option>
          <option value="vertical">Shorts/Reels · 1080×1920</option>
        </Select>
        <Button disabled={busy || !hasEdit || ACTIVE.includes(rj?.status ?? "")} onClick={() => void enqueue({ type: "render", format })}>
          Render
        </Button>
        <Button variant="ghost" disabled={!hasEdit} onClick={() => setShowRights(true)}>
          Asset Rights
        </Button>
        {status.latestExport?.url && (
          <a href={status.latestExport.downloadUrl ?? status.latestExport.url} download className="text-sm text-accent hover:underline">
            Export MP4 ↓
          </a>
        )}
      </header>

      {/* job status */}
      {(pj && (ACTIVE.includes(pj.status) || pj.status === "FAILED")) || (rj && (ACTIVE.includes(rj.status) || rj.status === "FAILED")) || error || p.lastError ? (
        <div className="space-y-1.5 border-b border-line bg-panel px-4 py-2 text-xs">
          {error && <div className="text-danger">{error}</div>}
          {pj && ACTIVE.includes(pj.status) && (
            <div className="flex items-center gap-3">
              <span className="w-64 truncate">
                {pj.kind === "analyze_reference" ? "Reference analysis" : "Generating edit"}: {pj.current_stage ?? pj.status}
              </span>
              <Progress value={Number(pj.progress)} />
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void cancel("pipeline")}>
                Cancel
              </Button>
            </div>
          )}
          {pj?.status === "FAILED" && (pj.error === JOB_CANCELLED ? <div className="text-muted">Generation cancelled.</div> : <div className="text-danger">Last job failed: {pj.error}</div>)}
          {rj && ACTIVE.includes(rj.status) && (
            <div className="flex items-center gap-3">
              <span className="w-64 truncate">
                Render ({rj.format}) · {rj.status}: {rj.current_stage}
              </span>
              <Progress value={Number(rj.progress)} />
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void cancel("render")}>
                Cancel
              </Button>
            </div>
          )}
          {rj?.status === "FAILED" && (rj.error === JOB_CANCELLED ? <div className="text-muted">Render cancelled.</div> : <div className="text-danger">Render failed: {rj.error}</div>)}
          {pj?.status === "QUEUED" || rj?.status === "QUEUED" ? <div className="text-muted">Waiting for a worker — make sure `npm run worker` is running.</div> : null}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[300px_1fr_340px]">
        {/* LEFT: project / scenes */}
        <aside className="flex min-h-0 flex-col border-r border-line bg-panel">
          <div className="flex border-b border-line">
            {(["scenes", "setup"] as const).map((t) => (
              <button key={t} onClick={() => setLeftTab(t)} className={cx("flex-1 py-2 text-xs capitalize", leftTab === t ? "border-b-2 border-accent" : "text-muted")}>
                {t === "setup" ? "Project" : "Scenes"}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {leftTab === "setup" ? (
              <SetupPanel status={status} onChanged={() => void refresh()} onAnalyzeReference={() => void enqueue({ type: "analyze_reference", apply: true })} />
            ) : !edit?.plans.length ? (
              <div className="space-y-3 p-4 text-sm text-muted">
                <p>No edit yet.</p>
                {!p.hasNarration ? <p>Open the Project tab and upload a narration (and ideally the script), then click Generate.</p> : <p>Click Generate to analyse the narration and build the timeline.</p>}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between border-b border-line px-3 py-2 text-xs">
                  <span className="text-muted">{checked.size} selected</span>
                  <Button size="sm" disabled={!checked.size || busy || ACTIVE.includes(pj?.status ?? "")} onClick={() => void enqueue({ type: "regenerate_scenes", sceneIds: [...checked] }).then(() => setChecked(new Set()))}>
                    Regenerate selected
                  </Button>
                </div>
                <ul className="divide-y divide-line">
                  {edit.plans.map((s) => (
                    <li key={s.sceneId} className={cx("flex gap-2 px-3 py-2.5 text-xs", (selectedScene ?? clip?.sceneId) === s.sceneId && "bg-panel-2")}>
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={checked.has(s.sceneId)}
                        onChange={(e) => {
                          const n = new Set(checked);
                          if (e.target.checked) n.add(s.sceneId);
                          else n.delete(s.sceneId);
                          setChecked(n);
                        }}
                      />
                      <button
                        className="min-w-0 flex-1 text-left"
                        onClick={() => {
                          selectScene(s.sceneId);
                          seek(s.startTime);
                        }}
                      >
                        <div className="mb-0.5 flex items-center gap-1.5">
                          <span className="font-semibold">{s.sceneId.replace("scene_", "#")}</span>
                          <span className="text-muted">{fmtTime(s.startTime)}</span>
                          <Tag>{s.visualStrategy.replace(/_/g, " ")}</Tag>
                          {s.importance === "high" && <Tag tone="accent">high</Tag>}
                        </div>
                        <p className="line-clamp-3 text-muted">{s.narration}</p>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </aside>

        {/* CENTER: preview / scene review */}
        <section className="flex min-h-0 flex-col">
          <div className="flex items-center gap-1 border-b border-line bg-panel px-2">
            {(["preview", "review"] as const).map((t) => (
              <button key={t} onClick={() => setCenterTab(t)} className={cx("px-3 py-2 text-xs", centerTab === t ? "border-b-2 border-accent text-foreground" : "text-muted hover:text-foreground")}>
                {t === "preview" ? "Watch" : `Review scenes${edit?.clips.length ? ` (${edit.clips.length})` : ""}`}
              </button>
            ))}
            {centerTab === "preview" && canLive && status.latestExport?.url && (
              <div className="ml-auto flex overflow-hidden rounded border border-line text-[11px]">
                {(["live", "render"] as const).map((m) => (
                  <button key={m} onClick={() => setWatchMode(m)} className={cx("px-2.5 py-1", mode === m ? "bg-accent text-accent-ink" : "text-muted hover:text-foreground")}>
                    {m === "live" ? "Live edit" : "Last render"}
                  </button>
                ))}
              </div>
            )}
          </div>
          {centerTab === "review" && edit && hasEdit ? (
            <div className="min-h-0 flex-1 bg-background">
              <ReviewPanel
                projectId={projectId}
                data={edit}
                selectedClip={selectedClip}
                onSelect={selectClip}
                onReplace={(c, tab) => setReplacing({ clip: c, tab })}
                onRegenerateScene={(id) => void enqueue({ type: "regenerate_scenes", sceneIds: [id] })}
                onChanged={() => void refresh()}
              />
            </div>
          ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-black p-4">
          {pj && ACTIVE.includes(pj.status) && pj.kind !== "analyze_reference" ? (
            <AutoEditProgress stage={pj.current_stage ?? "Queued…"} progress={Number(pj.progress)} queued={pj.status === "QUEUED"} busy={busy} onCancel={() => void cancel("pipeline")} />
          ) : rj && ACTIVE.includes(rj.status) && !status.latestExport ? (
            <AutoEditProgress stage={rj.status === "FINALIZING" ? "Finalizing…" : `Rendering… ${rj.current_stage ?? ""}`} progress={Number(rj.progress)} queued={rj.status === "QUEUED"} busy={busy} onCancel={() => void cancel("render")} />
          ) : mode === "live" && canLive && edit ? (
            <LivePlayer data={edit} narrationUrl={status.narrationUrl!} captions={p.settings.captions !== "OFF"} playhead={playhead} mediaRef={videoRef} />
          ) : status.latestExport?.url ? (
            <>
              <video
                ref={videoRef as RefObject<HTMLVideoElement>}
                key={status.latestExport.id}
                src={status.latestExport.url}
                preload="metadata"
                controls
                className="max-h-full max-w-full"
                onTimeUpdate={(e) => playhead.set(e.currentTarget.currentTime)}
              />
              <div className="mt-2 text-[11px] text-muted">
                Last render: {status.latestExport.format} · {new Date(status.latestExport.created_at).toLocaleString()}
                {rj?.status === "COMPLETE" && (rj.warnings?.length ?? 0) > 0 && <span className="text-accent"> · {rj.warnings!.length} warning(s)</span>}
              </div>
            </>
          ) : (
            <div className="max-w-sm text-center text-sm text-muted">
              <p className="mb-2 text-foreground">No render yet</p>
              <p>{hasEdit ? "Render a Draft preview to see the edit. Only clips you change are re-rendered next time." : "Generate the edit first."}</p>
            </div>
          )}
        </div>
          )}
        </section>

        {/* RIGHT: inspector */}
        <aside className="min-h-0 border-l border-line bg-panel">
          <Inspector
            projectId={projectId}
            clip={clip}
            plan={plan}
            settings={p.settings}
            hasMusicUpload={p.hasMusic}
            onChanged={() => void refresh()}
            onReplace={(c) => setReplacing({ clip: c, tab: "ai" })}
            onRegenerateScene={(id) => void enqueue({ type: "regenerate_scenes", sceneIds: [id] })}
          />
        </aside>
      </div>

      {/* BOTTOM: timeline */}
      <div className="h-[290px] shrink-0 border-t border-line bg-panel">
        {edit && hasEdit ? (
          <Timeline
            data={edit}
            peaks={peaks}
            playhead={playhead}
            musicLabel={music}
            selectedClip={selectedClip}
            selectedScene={selectedScene}
            onSelectClip={selectClip}
            onSelectScene={selectScene}
            onSeek={seek}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted">The timeline appears after generation.</div>
        )}
      </div>

      {replacing && (
        <ReplaceDialog
          projectId={projectId}
          clip={replacing.clip}
          initialTab={replacing.tab}
          onClose={() => setReplacing(null)}
          onReplaced={() => {
            setReplacing(null);
            void refresh();
          }}
        />
      )}
      {showRights && edit && (
        <RightsPanel
          clips={edit.clips}
          allowReview={p.settings.allowReviewAssets}
          allowApprovedUnknown={p.settings.allowApprovedUnknown}
          onClose={() => setShowRights(false)}
          onSelect={(c) => {
            setShowRights(false);
            setSelectedClip(c.clipId);
            setSelectedScene(c.sceneId);
          }}
        />
      )}
    </div>
  );
}

const STEPS = [
  "Uploading",
  "Analyzing narration",
  "Transcribing",
  "Understanding scenes",
  "Searching for footage",
  "Selecting visuals",
  "Adding reactions",
  "Adding effects",
  "Building timeline",
  "Rendering",
  "Finalizing",
];

/** Step list for the automatic edit, highlighting the stage the worker reports. */
function AutoEditProgress({ stage, progress, queued, busy, onCancel }: { stage: string; progress: number; queued: boolean; busy: boolean; onCancel: () => void }) {
  const current = STEPS.findIndex((s) => stage.toLowerCase().startsWith(s.toLowerCase()));
  return (
    <div className="w-full max-w-md space-y-3 text-sm">
      <div className="text-base font-semibold text-foreground">{queued ? "Waiting for the worker…" : stage}</div>
      <Progress value={progress} />
      <ol className="space-y-1 text-xs">
        {STEPS.map((s, i) => (
          <li key={s} className={i < current ? "text-ok" : i === current ? "text-accent" : "text-muted"}>
            {i < current ? "✓" : i === current ? "●" : "○"} {s}…
          </li>
        ))}
      </ol>
      {queued && <p className="text-xs text-muted">Make sure `npm run worker` is running on your computer.</p>}
      <Button variant="danger" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
