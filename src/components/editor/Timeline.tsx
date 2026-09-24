"use client";

import { useState } from "react";
import { cx, fmtTime } from "@/components/ui";
import type { Clip, EditData } from "./types";

const ROW = "relative h-10 border-b border-line";

export function Timeline({
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
  playhead: number;
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
              {peaks ? (
                <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox={`0 0 ${peaks.length} 100`} data-seek="1">
                  {peaks.map((v, i) => (
                    <line key={i} x1={i} x2={i} y1={50 - v * 45} y2={50 + v * 45} stroke="#5b9bf0" strokeOpacity="0.7" data-seek="1" />
                  ))}
                </svg>
              ) : (
                data.words.map((w, i) => (
                  <span key={i} className="absolute top-3 h-4 rounded-sm bg-info/40" style={{ left: x(w.start), width: Math.max(1, x(w.end - w.start)) }} data-seek="1" />
                ))
              )}
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
                  style={{ left: x(c.start), width: Math.max(3, x(c.duration) - 1), backgroundImage: c.asset.thumbnailUrl ? `url(${c.asset.thumbnailUrl})` : undefined }}
                >
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
            {/* playhead */}
            <div className="pointer-events-none absolute top-0 bottom-0 w-px bg-danger" style={{ left: x(playhead) }} />
          </div>
        </div>
      </div>
    </div>
  );
}
