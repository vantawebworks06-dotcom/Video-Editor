"use client";

import { useState } from "react";
import { Button, cx, Label, Select } from "@/components/ui";
import type { Clip } from "@/components/editor/types";
import type { PlayheadStore } from "@/components/editor/playhead";
import { DEFAULT_SOURCE_AUDIO, SOURCE_MODE_LABEL, type SourceAudio, type SourceAudioMode } from "@/lib/domain/sourceAudio";
import { Transition } from "@/lib/domain/types";

const MODE_HELP: Record<SourceAudioMode, string> = {
  pause: "Narration stops while the source plays, then resumes (time is inserted).",
  duck: "Narration continues quietly under the source audio.",
  overlap: "The source starts while the narration finishes its line, then the narration pauses.",
  visual_only: "Source picture only — its audio is muted.",
};

/** Timing, transition and (for video) source-audio behaviour of one clip. */
export function ClipControls({ clip, playhead, busy, defaults, onAction }: { clip: Clip; playhead: PlayheadStore; busy: boolean; defaults: SourceAudio; onAction: (json: Record<string, unknown>) => Promise<void> | void }) {
  const [start, setStart] = useState(String(clip.start.toFixed(2)));
  const [dur, setDur] = useState(String(clip.duration.toFixed(2)));
  const [key, setKey] = useState(`${clip.clipId}:${clip.start}:${clip.duration}`);
  if (key !== `${clip.clipId}:${clip.start}:${clip.duration}`) {
    setKey(`${clip.clipId}:${clip.start}:${clip.duration}`);
    setStart(String(clip.start.toFixed(2)));
    setDur(String(clip.duration.toFixed(2)));
  }
  const isVideo = clip.asset.type === "video";
  const isSource = clip.role === "source";
  const changed = Number(start) !== Number(clip.start.toFixed(2)) || Number(dur) !== Number(clip.duration.toFixed(2));

  return (
    <div className="space-y-3 border-t border-line pt-3">
      <div className="flex items-center justify-between">
        <Label>Timing (narration time)</Label>
        {isSource && <span className="rounded bg-info/15 px-1.5 py-0.5 text-[10px] font-semibold text-info">SOURCE CLIP</span>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[11px] text-muted">
          Start (s)
          <input type="number" step={0.1} min={0} value={start} onChange={(e) => setStart(e.target.value)} className="mt-0.5 h-8 w-full rounded border border-line bg-background px-2 text-xs text-foreground outline-none focus:border-accent" />
        </label>
        <label className="text-[11px] text-muted">
          Duration (s)
          <input type="number" step={0.1} min={0.3} value={dur} onChange={(e) => setDur(e.target.value)} className="mt-0.5 h-8 w-full rounded border border-line bg-background px-2 text-xs text-foreground outline-none focus:border-accent" />
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" disabled={busy || !changed} onClick={() => void onAction({ action: "retime", start: Number(start), duration: Number(dur) })} title="Move/trim/extend; neighbouring picture clips give or take the time">
          Apply timing
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            const t = playhead.get();
            if (t <= clip.start + 0.3 || t >= clip.start + clip.duration - 0.3) return alert("Put the playhead inside this clip (at least 0.3 s from its ends) to split it.");
            void onAction({ action: "split", at: Math.round(t * 1000) / 1000 });
          }}
          title="Split this clip at the playhead (S)"
        >
          Split at playhead
        </Button>
      </div>
      <div>
        <Label>Transition in</Label>
        <Select value={clip.transitionIn ?? "hard_cut"} disabled={busy} onChange={(e) => void onAction({ action: "transition", transitionIn: e.target.value })}>
          {Transition.options.map((t) => (
            <option key={t} value={t}>
              {t.replace(/_/g, " ")}
            </option>
          ))}
        </Select>
      </div>
      {isVideo && (
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" className="mt-0.5" checked={isSource} disabled={busy} onChange={(e) => void onAction({ action: "role", role: e.target.checked ? "source" : "primary" })} />
          <span>
            Play this clip&apos;s own audio (interview / news / source footage)
            <span className="block text-[10px] text-muted">Off: it is B-roll under the narration. On: it becomes a source clip with the narration behaviour below.</span>
          </span>
        </label>
      )}
      {isSource && <SourceAudioEditor key={clip.clipId + JSON.stringify(clip.sourceAudio)} value={clip.sourceAudio ?? defaults} busy={busy} onSave={(a) => void onAction({ action: "audio", sourceAudio: a })} />}
    </div>
  );
}

export function SourceAudioEditor({ value, busy, onSave, title = "Narration behaviour" }: { value: SourceAudio; busy: boolean; onSave: (a: SourceAudio) => void; title?: string }) {
  const [a, setA] = useState<SourceAudio>({ ...DEFAULT_SOURCE_AUDIO, ...value });
  const dirty = JSON.stringify(a) !== JSON.stringify({ ...DEFAULT_SOURCE_AUDIO, ...value });
  const slider = (k: keyof SourceAudio, label: string, min: number, max: number, step: number, fmt: (v: number) => string, show = true) =>
    show && (
      <label key={k} className="block text-[11px] text-muted">
        <span className="flex justify-between">
          <span>{label}</span>
          <span className="tabular-nums text-foreground">{fmt(a[k] as number)}</span>
        </span>
        <input type="range" min={min} max={max} step={step} value={a[k] as number} disabled={busy} onChange={(e) => setA({ ...a, [k]: Number(e.target.value) })} className="w-full" />
      </label>
    );
  const db = (g: number) => (g <= 0.001 ? "−∞ dB" : `${(20 * Math.log10(g)).toFixed(1)} dB`);
  return (
    <div className="space-y-2 rounded-md border border-line bg-panel-2/60 p-2.5">
      <div className="text-[11px] font-semibold tracking-wide text-muted">{title.toUpperCase()}</div>
      <div className="grid grid-cols-2 gap-1">
        {(Object.keys(SOURCE_MODE_LABEL) as SourceAudioMode[]).map((m) => (
          <button key={m} disabled={busy} onClick={() => setA({ ...a, mode: m })} className={cx("rounded border px-2 py-1.5 text-left text-[11px]", a.mode === m ? "border-accent bg-accent/15 text-accent" : "border-line text-muted hover:text-foreground")}>
            {SOURCE_MODE_LABEL[m]}
          </button>
        ))}
      </div>
      <p className="text-[11px] leading-snug text-muted">{MODE_HELP[a.mode]}</p>
      {slider("sourceVolume", "Source volume", 0, 2, 0.05, db, a.mode !== "visual_only")}
      {slider("narrationVolume", "Narration while ducked", 0, 1, 0.05, db, a.mode === "duck" || a.mode === "overlap")}
      {slider("overlap", "Overlap (source starts before narration pauses)", 0, 5, 0.1, (v) => `${v.toFixed(1)} s`, a.mode === "overlap")}
      {slider("duckRamp", "Ducking duration (ramp)", 0.05, 2, 0.05, (v) => `${v.toFixed(2)} s`, a.mode === "duck" || a.mode === "overlap")}
      {slider("fadeIn", "Source fade in", 0, 3, 0.05, (v) => `${v.toFixed(2)} s`, a.mode !== "visual_only")}
      {slider("fadeOut", "Source fade out", 0, 3, 0.05, (v) => `${v.toFixed(2)} s`, a.mode !== "visual_only")}
      <Button size="sm" variant="primary" disabled={busy || !dirty} onClick={() => onSave(a)}>
        Apply
      </Button>
    </div>
  );
}
