"use client";

import { memo, useMemo, useState } from "react";
import { cx, fmtTime } from "@/components/ui";
import { stillThumbnail } from "@/lib/media/thumbnails";
import { type PlayheadStore, usePlayhead } from "./playhead";
import type { Clip, EditData } from "./types";

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
}: {
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
          Timeline · {data.plans.length} scenes · {data.clips.length} visuals · {fmtTime(duration)}
        </span>
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
            {label("Text")}
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
            <div className={ROW}>
              {data.clips.map((c) => (
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
              <span className="absolute inset-y-2 left-0 flex items-center rounded bg-[#b56cf0]/20 px-2 text-[10px] text-[#c99af5]" style={{ width }}>
                {musicLabel} · ducked under narration
              </span>
            </div>
            <PlayheadLine store={playhead} zoom={zoom} />
          </div>
        </div>
      </div>
    </div>
  );
});
