"use client";

import { memo, useMemo, useState } from "react";
import { cx, fmtTime } from "@/components/ui";
import { stillThumbnail } from "@/lib/media/thumbnails";
import { type PlayheadStore, usePlayhead } from "./playhead";
import type { Clip, EditData } from "./types";
import { MEDIA_DRAG_TYPE } from "@/components/workstation/useMedia";
import { SOURCE_MODE_LABEL } from "@/lib/domain/sourceAudio";
import { GRAPHIC_KIND_LABEL, type GraphicKind } from "@/lib/domain/graphics";

const GRAPHIC_COLOR: Record<GraphicKind, string> = { lower_third: "#f2b441", location: "#4fb3a9", date: "#7aa2f7", time_jump: "#c099ff", statistic: "#ff9e64", quote: "#e0af68", headline: "#bb9af7", chapter: "#9ece6a" };

const ROW = "relative h-10 border-b border-line";

/** The only part of the timeline that follows playback. */
function PlayheadLine({ store, zoom }: { store: PlayheadStore; zoom: number }) {
  const t = usePlayhead(store);
  return <div className="pointer-events-none absolute top-0 bottom-0 w-px bg-danger" style={{ left: t * zoom }} />;
}

/** Narration peaks as one SVG path (was one <line> element per peak). */
const Waveform = memo(function Waveform({ peaks }: { peaks: number[] }) {
  const d = useMemo(() => peaks.map((v, i) => `M${i} ${(50 - v * 45).toFixed(1)}V${(50 + v * 45).toFixed(1)}`).join(""), [peaks]);
  return (
    <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox={`0 0 ${peaks.length} 100`} data-seek="1">
      <path d={d} stroke="#5b9bf0" strokeOpacity="0.7" data-seek="1" />
    </svg>
  );
});

/** Word blocks as one SVG path in seconds (was one element per word). */
const WordBlocks = memo(function WordBlocks({ words, duration }: { words: EditData["words"]; duration: number }) {
  const d = useMemo(() => words.map((w) => `M${w.start} 12h${Math.max(0.01, w.end - w.start)}v16h${-Math.max(0.01, w.end - w.start)}z`).join(""), [words]);
  return (
    <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox={`0 0 ${duration} 40`} data-seek="1">
      <path d={d} className="fill-info/40 stroke-info/40" strokeWidth="1" vectorEffect="non-scaling-stroke" data-seek="1" />
    </svg>
  );
});

export const Timeline = memo(function Timeline({
  data,
  peaks,
  playhead,
  musicLabel,
  selectedClip,
  selectedScene,
  onSelectClip,
  onSelectScene,
  onSeek,
  onDropMedia,
  history,
  onHistory,
}: {
  /** A media library item dropped at narration time t; asSource = dropped on the Source track. */
  onDropMedia?: (itemId: string, t: number, asSource: boolean) => void;
  history?: { undo: string | null; redo: string | null };
  onHistory?: (action: "undo" | "redo") => void;
  data: EditData;
  peaks: number[] | null;
  playhead: PlayheadStore;
  musicLabel: string;
  selectedClip: string | null;
  selectedScene: string | null;
  onSelectClip: (c: Clip) => void;
  onSelectScene: (id: string) => void;
  onSeek: (t: number) => void;
}) {
  const [zoom, setZoom] = useState(40); // px per second
  const [dropRow, setDropRow] = useState<"visual" | "source" | null>(null);
  const pictures = useMemo(() => data.clips.filter((c) => c.role !== "source"), [data.clips]);
  const sources = useMemo(() => data.clips.filter((c) => c.role === "source"), [data.clips]);
  const dropProps = (row: "visual" | "source") =>
    onDropMedia
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDropRow(row);
          },
          onDragLeave: () => setDropRow(null),
          onDrop: (e: React.DragEvent<HTMLDivElement>) => {
            const id = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
            setDropRow(null);
            if (!id) return;
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            onDropMedia(id, Math.max(0, Math.round(((e.clientX - rect.left) / zoom) * 100) / 100), row === "source");
          },
        }
      : {};
  const duration = Math.max(data.duration, data.plans.at(-1)?.endTime ?? 0, 1);
  const width = duration * zoom;
  const x = (t: number) => t * zoom;
  const ticks = Math.ceil(duration / (zoom > 30 ? 5 : 10));
  const step = zoom > 30 ? 5 : 10;

  const label = (text: string) => <div className="sticky left-0 z-10 flex h-10 w-24 shrink-0 items-center border-b border-r border-line bg-panel px-2 text-[11px] text-muted">{text}</div>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-xs text-muted">
        <span>
          Timeline · {data.plans.length} scenes · {pictures.length} visuals{sources.length ? ` · ${sources.length} source clips` : ""} · {fmtTime(duration)} narration
        </span>
        {onHistory && (
          <span className="ml-auto mr-4 flex gap-1">
            <button className="rounded border border-line px-2 py-0.5 hover:text-foreground disabled:opacity-40" disabled={!history?.undo} title={history?.undo ? `Undo: ${history.undo} (Ctrl+Z)` : "Nothing to undo"} onClick={() => onHistory("undo")}>
              ↶ Undo
            </button>
            <button className="rounded border border-line px-2 py-0.5 hover:text-foreground disabled:opacity-40" disabled={!history?.redo} title={history?.redo ? `Redo: ${history.redo} (Ctrl+Shift+Z)` : "Nothing to redo"} onClick={() => onHistory("redo")}>
              ↷ Redo
            </button>
          </span>
        )}
        <label className="flex items-center gap-2">
          Zoom
          <input type="range" min={10} max={120} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex" style={{ width: width + 96 }}>
          <div className="flex flex-col">
            <div className="sticky left-0 z-10 h-6 w-24 border-b border-r border-line bg-panel" />
            {label("Scenes")}
            {label("Narration")}
            {label("Visuals")}
            {label("Source")}
            {label("Text & graphics")}
            {label("SFX")}
            {label("Music")}
          </div>
          <div
            className="relative"
            style={{ width }}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              if ((e.target as HTMLElement).dataset.seek) onSeek((e.clientX - rect.left) / zoom);
            }}
          >
            {/* ruler */}
            <div className="relative h-6 border-b border-line" data-seek="1">
              {Array.from({ length: ticks + 1 }, (_, i) => (
                <span key={i} className="absolute top-1 text-[10px] text-muted" style={{ left: x(i * step) + 2 }}>
                  {fmtTime(i * step)}
                </span>
              ))}
            </div>
            {/* scenes */}
            <div className={ROW}>
              {data.plans.map((p) => (
                <button
                  key={p.sceneId}
                  onClick={() => onSelectScene(p.sceneId)}
                  title={p.narration}
                  className={cx(
                    "absolute top-1 bottom-1 overflow-hidden rounded border px-1.5 text-left text-[10px]",
                    selectedScene === p.sceneId ? "border-accent bg-accent/20 text-foreground" : "border-line bg-panel-2 text-muted hover:text-foreground",
                  )}
                  style={{ left: x(p.startTime), width: Math.max(4, x(p.endTime - p.startTime) - 2) }}
                >
                  {p.sceneId.replace("scene_", "#")} · {p.visualStrategy.replace(/_/g, " ")}
                </button>
              ))}
            </div>
            {/* narration waveform */}
            <div className={ROW} data-seek="1">
              {peaks ? <Waveform peaks={peaks} /> : <WordBlocks words={data.words} duration={duration} />}
            </div>
            {/* visuals */}
            <div className={cx(ROW, dropRow === "visual" && "bg-accent/10")} {...dropProps("visual")}>
              {pictures.map((c) => (
                <button
                  key={c.rowId}
                  onClick={() => onSelectClip(c)}
                  title={`${c.asset.title} (${c.asset.provider}, ${c.asset.rightsStatus})`}
                  className={cx(
                    "absolute top-0.5 bottom-0.5 overflow-hidden rounded border bg-cover bg-center",
                    selectedClip === c.clipId ? "border-accent ring-1 ring-accent" : c.role === "meme" ? "border-[#b56cf0]" : "border-line",
                  )}
                  style={{ left: x(c.start), width: Math.max(3, x(c.duration) - 1) }}
                >
                  {c.asset.thumbnailUrl && (
                    // Lazy: only thumbnails scrolled into view load; GIFs show their still frame.
                    // eslint-disable-next-line @next/next/no-img-element -- remote provider thumbnails, many hosts
                    <img src={stillThumbnail(c.asset.thumbnailUrl)} alt="" loading="lazy" decoding="async" className="pointer-events-none absolute inset-0 h-full w-full object-cover" />
                  )}
                  <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 text-left text-[9px] text-white">
                    {c.role === "meme" ? "MEME · " : ""}
                    {c.asset.type}
                  </span>
                  {(c.asset.rightsStatus === "UNKNOWN" || c.asset.rightsStatus === "USER_REVIEW") && <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-accent" />}
                </button>
              ))}
            </div>
            {/* source footage (own audio): times are narration time; pause/overlap insert time at render */}
            <div className={cx(ROW, dropRow === "source" && "bg-info/10")} {...dropProps("source")} data-seek={sources.length ? undefined : "1"}>
              {!sources.length && <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-[10px] text-muted/70">Drop interview / news footage here to play it with its audio</span>}
              {sources.map((c) => (
                <button
                  key={c.rowId}
                  onClick={() => onSelectClip(c)}
                  title={`${c.asset.title} — ${c.sourceAudio ? SOURCE_MODE_LABEL[c.sourceAudio.mode] : "source"}`}
                  className={cx("absolute top-0.5 bottom-0.5 overflow-hidden rounded border-2 bg-info/20", selectedClip === c.clipId ? "border-accent" : "border-info/70")}
                  style={{ left: x(c.start), width: Math.max(3, x(c.duration) - 1) }}
                >
                  {c.asset.thumbnailUrl && (
                    // eslint-disable-next-line @next/next/no-img-element -- remote thumbnails
                    <img src={stillThumbnail(c.asset.thumbnailUrl)} alt="" loading="lazy" className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-60" />
                  )}
                  <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-1 text-left text-[9px] text-white">
                    {c.sourceAudio ? SOURCE_MODE_LABEL[c.sourceAudio.mode] : "source"} · {c.asset.title}
                  </span>
                </button>
              ))}
            </div>
            {/* text */}
            <div className={ROW}>
              {data.plans
                .filter((p) => p.textOverlay.enabled)
                .map((p) => (
                  <button
                    key={p.sceneId}
                    onClick={() => onSelectScene(p.sceneId)}
                    className="absolute top-1.5 bottom-1.5 truncate rounded bg-[#e8b44c]/25 px-1 text-[10px] font-semibold text-accent"
                    style={{ left: x(p.startTime + p.textOverlay.at), width: Math.max(8, x(p.textOverlay.duration)) }}
                  >
                    {p.textOverlay.text}
                  </button>
                ))}
              {data.plans.flatMap((p) =>
                (p.graphics ?? []).map((g) => (
                  <button
                    key={`${p.sceneId}-${g.id}`}
                    onClick={() => onSelectScene(p.sceneId)}
                    title={`${GRAPHIC_KIND_LABEL[g.kind]}: ${g.title}${g.sub ? ` — ${g.sub}` : ""}`}
                    className="absolute top-1 bottom-1 truncate rounded border-l-2 px-1 text-left text-[10px] text-foreground"
                    style={{ left: x(p.startTime + g.at), width: Math.max(8, x(g.duration)), borderColor: GRAPHIC_COLOR[g.kind], background: `${GRAPHIC_COLOR[g.kind]}33` }}
                  >
                    {g.title}
                  </button>
                )),
              )}
            </div>
            {/* sfx */}
            <div className={ROW}>
              {data.plans.flatMap((p) =>
                p.sfx.map((s, i) => (
                  <span
                    key={`${p.sceneId}-${i}`}
                    title={`${s.kind}: ${s.reason}`}
                    className="absolute top-2 h-6 rounded bg-ok/25 px-1 text-[9px] leading-6 text-ok"
                    style={{ left: x(p.startTime + s.at) }}
                  >
                    {s.kind.replace("_", " ")}
                  </span>
                )),
              )}
            </div>
            {/* music */}
            <div className={ROW}>
              {musicLabel === "Story-driven" && data.plans.some((p) => p.storyboard) ? (
                // Story-driven music: one block per mood section, brighter where the story is more intense.
                moodSections(data.plans).map((m) => (
                  <span
                    key={m.start}
                    title={`${m.mood} · intensity ${m.intensity}/10`}
                    className="absolute inset-y-2 flex items-center overflow-hidden rounded border-l border-[#b56cf0] px-1.5 text-[10px] whitespace-nowrap text-[#e2c8fb]"
                    style={{ left: x(m.start), width: Math.max(2, x(m.end) - x(m.start)), background: `rgba(181,108,240,${0.12 + m.intensity * 0.045})` }}
                  >
                    {m.mood}
                  </span>
                ))
              ) : (
                <span className="absolute inset-y-2 left-0 flex items-center rounded bg-[#b56cf0]/20 px-2 text-[10px] text-[#c99af5]" style={{ width }}>
                  {musicLabel} · ducked under narration
                </span>
              )}
            </div>
            <PlayheadLine store={playhead} zoom={zoom} />
          </div>
        </div>
      </div>
    </div>
  );
});

/** Consecutive scenes sharing a music mood (mirrors the render's music sections closely enough to review). */
function moodSections(plans: EditData["plans"]): { start: number; end: number; mood: string; intensity: number }[] {
  const out: { start: number; end: number; mood: string; intensity: number }[] = [];
  for (const p of plans) {
    const mood = p.storyboard?.musicMood ?? "neutral";
    const I = p.storyboard?.intensity ?? 3;
    const last = out.at(-1);
    if (last && last.mood === mood) {
      last.end = p.endTime;
      last.intensity = Math.max(last.intensity, I);
    } else out.push({ start: p.startTime, end: p.endTime, mood, intensity: I });
  }
  return out;
}
