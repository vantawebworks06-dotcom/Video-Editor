"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, Button, cx, Progress } from "@/components/ui";
import type { PlayheadStore } from "@/components/editor/playhead";
import { DEFAULT_VOICE, resolveVoice, VOICE_PRESET_LABEL, type VoiceMeasurement, type VoicePreset, type VoiceProcessing } from "@/lib/domain/voice";

interface Latest {
  voice: VoiceProcessing;
  values: Omit<VoiceProcessing, "preset">;
  measurement: VoiceMeasurement;
  notes: string[];
  hash: string;
  afterUrl: string | null;
  beforeUrl: string | null;
}
interface VoiceState {
  latest: Latest | null;
  running: { id: string; status: string; progress: number | null; stage: string | null } | null;
  error: string | null;
}

type Key = keyof Omit<VoiceProcessing, "preset">;
const CONTROLS: { k: Key; label: string; min: number; max: number; step: number; fmt: (v: number) => string; help: string }[] = [
  { k: "noiseReduction", label: "Noise reduction", min: 0, max: 1, step: 0.05, fmt: pct, help: "Hiss, room tone, fans — learned from a pause in the narration" },
  { k: "gate", label: "Gap cleanup", min: 0, max: 1, step: 0.05, fmt: pct, help: "Quiets the background between phrases" },
  { k: "highpass", label: "High-pass", min: 0, max: 200, step: 5, fmt: (v) => (v ? `${v} Hz` : "off"), help: "Removes rumble and handling noise" },
  { k: "warmth", label: "Warmth", min: -6, max: 6, step: 0.5, fmt: db, help: "Body of the voice (150 Hz)" },
  { k: "mudCut", label: "Mud cut", min: 0, max: 8, step: 0.5, fmt: (v) => (v ? `−${v} dB` : "off"), help: "Boxiness around 300 Hz" },
  { k: "presence", label: "Presence", min: -6, max: 6, step: 0.5, fmt: db, help: "Clarity (3.5 kHz)" },
  { k: "air", label: "Air", min: -6, max: 6, step: 0.5, fmt: db, help: "Brightness (10 kHz)" },
  { k: "deEss", label: "De-esser", min: 0, max: 1, step: 0.05, fmt: pct, help: "Tames harsh s / sh sounds" },
  { k: "compression", label: "Compression", min: 0, max: 1, step: 0.05, fmt: pct, help: "Evens out loud and quiet words" },
  { k: "loudness", label: "Loudness target", min: -24, max: -12, step: 0.5, fmt: (v) => `${v} LUFS`, help: "−16 for online video, −14 for podcasts, −23 for broadcast" },
];

function pct(v: number) {
  return v ? `${Math.round(v * 100)}%` : "off";
}
function db(v: number) {
  return v ? `${v > 0 ? "+" : ""}${v} dB` : "0 dB";
}
// Key order is not preserved by Postgres jsonb, so compare field by field.
const same = (a: VoiceProcessing, b: VoiceProcessing) => (Object.keys(DEFAULT_VOICE) as (keyof VoiceProcessing)[]).every((k) => a[k] === b[k]);

/** Narration processing: presets, controls, measurement and a level-matched A/B preview. */
export function VoicePanel({ projectId, saved, playhead, onSave }: { projectId: string; saved: VoiceProcessing; playhead: PlayheadStore; onSave: (v: VoiceProcessing) => Promise<void> }) {
  const [draft, setDraft] = useState<VoiceProcessing>({ ...DEFAULT_VOICE, ...saved });
  const [state, setState] = useState<VoiceState>({ latest: null, running: null, error: null });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api<VoiceState>(`/api/projects/${projectId}/audio/voice`));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [projectId]);
  useEffect(() => {
    let alive = true;
    api<VoiceState>(`/api/projects/${projectId}/audio/voice`)
      .then((s) => alive && setState(s))
      .catch((e: Error) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [projectId]);
  // Poll while the worker is processing.
  useEffect(() => {
    if (!state.running) return;
    const id = setInterval(() => void load(), 2000);
    return () => clearInterval(id);
  }, [state.running, load]);

  const measurement = state.latest?.measurement ?? null;
  // What the draft resolves to (a preset's values, or Auto from the last measurement).
  const shown = draft.preset === "custom" ? draft : { ...draft, ...resolveVoice(draft, measurement) };
  const setValue = (k: Key, v: number) => setDraft({ ...shown, preset: "custom", [k]: v });
  const previewMatches = state.latest ? same(state.latest.voice, draft) : false;

  const process = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/projects/${projectId}/audio/voice`, { method: "POST", json: { voice: draft } });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">Voice (narration)</span>
        {!same(draft, saved) ? <span className="text-[10px] text-accent">unsaved</span> : <span className="text-[10px] text-muted">used in renders</span>}
      </div>
      <div className="grid grid-cols-2 gap-1">
        {(Object.keys(VOICE_PRESET_LABEL) as VoicePreset[]).map((p) => (
          <button
            key={p}
            onClick={() => setDraft(p === "custom" ? { ...shown, preset: "custom" } : { ...DEFAULT_VOICE, preset: p })}
            className={cx("rounded border px-2 py-1.5 text-left text-[11px]", draft.preset === p ? "border-accent bg-accent/15 text-accent" : "border-line text-muted hover:text-foreground")}
          >
            {VOICE_PRESET_LABEL[p]}
          </button>
        ))}
      </div>
      {draft.preset === "auto" && !measurement && <p className="text-[11px] text-muted">Auto picks settings from a measurement of your narration — press Measure &amp; preview.</p>}

      {draft.preset !== "off" && (
        <details className="rounded border border-line bg-panel-2/50 p-2" open={draft.preset === "custom"}>
          <summary className="cursor-pointer text-[11px] text-muted">Controls {draft.preset !== "custom" && "(moving one switches to Custom)"}</summary>
          <div className="mt-2 space-y-2">
            {CONTROLS.map((c) => (
              <label key={c.k} className="block text-[11px] text-muted" title={c.help}>
                <span className="flex justify-between">
                  <span>{c.label}</span>
                  <span className="tabular-nums text-foreground">{c.fmt(shown[c.k])}</span>
                </span>
                <input type="range" min={c.min} max={c.max} step={c.step} value={shown[c.k]} onChange={(e) => setValue(c.k, Number(e.target.value))} className="w-full" />
              </label>
            ))}
          </div>
        </details>
      )}

      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" disabled={busy || Boolean(state.running)} onClick={() => void process()} title="Measure the narration and render before/after previews (runs on the worker)">
          {state.running ? "Processing…" : "Measure & preview"}
        </Button>
        <Button size="sm" variant="primary" disabled={busy || same(draft, saved)} onClick={() => void onSave(draft)}>
          Use for renders
        </Button>
      </div>
      {state.running && (
        <div className="space-y-1">
          <Progress value={state.running.progress ?? 0} />
          <p className="text-[10px] text-muted">{state.running.status === "QUEUED" ? "Waiting for the worker…" : (state.running.stage ?? "Processing…")}</p>
        </div>
      )}
      {(err || state.error) && <p className="text-[11px] text-danger">{err ?? state.error}</p>}

      {state.latest && (
        <>
          <ABPlayer key={state.latest.hash} latest={state.latest} playhead={playhead} stale={!previewMatches} />
          <Measurements m={state.latest.measurement} notes={state.latest.notes} />
        </>
      )}
    </div>
  );
}

/** Before/after at matched loudness; switching keeps the position so the difference is audible. */
function ABPlayer({ latest, playhead, stale }: { latest: Latest; playhead: PlayheadStore; stale: boolean }) {
  const a = useRef<HTMLAudioElement>(null);
  const b = useRef<HTMLAudioElement>(null);
  const [side, setSide] = useState<"before" | "after">("after");
  const [playing, setPlaying] = useState(false);
  const cur = () => (side === "after" ? b.current : a.current);
  const toggle = () => {
    const el = cur();
    if (!el) return;
    if (el.paused) {
      if (el.currentTime === 0) el.currentTime = playhead.get();
      void el.play();
      setPlaying(true);
    } else {
      el.pause();
      setPlaying(false);
    }
  };
  const switchTo = (s: "before" | "after") => {
    if (s === side) return;
    const from = cur();
    const to = s === "after" ? b.current : a.current;
    if (from && to) {
      to.currentTime = from.currentTime;
      if (!from.paused) {
        from.pause();
        void to.play();
      }
    }
    setSide(s);
  };
  if (!latest.afterUrl || !latest.beforeUrl) return null;
  return (
    <div className="space-y-1.5 rounded-md border border-line bg-panel-2/60 p-2">
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-semibold text-muted">A/B PREVIEW · {VOICE_PRESET_LABEL[latest.voice.preset]}</span>
        {stale && <span className="text-accent">older settings</span>}
      </div>
      <audio ref={a} src={latest.beforeUrl} preload="none" onEnded={() => setPlaying(false)} />
      <audio ref={b} src={latest.afterUrl} preload="none" onEnded={() => setPlaying(false)} />
      <div className="flex items-center gap-1.5">
        <Button size="sm" onClick={toggle}>
          {playing ? "❚❚ Pause" : "▶ Play"}
        </Button>
        {(["before", "after"] as const).map((s) => (
          <button key={s} onClick={() => switchTo(s)} className={cx("rounded border px-2 py-1 text-[11px]", side === s ? "border-accent bg-accent/15 text-accent" : "border-line text-muted")}>
            {s === "before" ? "A · Original" : "B · Processed"}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-muted">Both play at the same loudness, from the playhead. Switch while playing to compare.</p>
    </div>
  );
}

function Measurements({ m, notes }: { m: VoiceMeasurement; notes: string[] }) {
  const rows: [string, string, "ok" | "warn" | "bad"][] = [
    ["Background noise", `${m.noiseFloor} dBFS`, m.noiseFloor < -60 ? "ok" : m.noiseFloor < -45 ? "warn" : "bad"],
    ["Speech above noise", `${m.snr} dB`, m.snr > 45 ? "ok" : m.snr > 30 ? "warn" : "bad"],
    ["Loudness", `${m.loudness} LUFS`, "ok"],
    ["True peak", `${m.truePeak} dBTP`, m.truePeak > -0.5 ? "bad" : m.truePeak > -1.5 ? "warn" : "ok"],
    ["Loudness range", `${m.lra} LU`, m.lra > 12 ? "warn" : "ok"],
    ["Sibilance", `${m.sibilance} dB`, m.sibilance > -9 ? "bad" : m.sibilance > -13 ? "warn" : "ok"],
  ];
  return (
    <div className="space-y-1 text-[11px]">
      <div className="font-semibold text-muted">MEASURED NARRATION</div>
      {rows.map(([k, v, tone]) => (
        <div key={k} className="flex justify-between">
          <span className="text-muted">{k}</span>
          <span className={cx("tabular-nums", tone === "ok" ? "text-ok" : tone === "warn" ? "text-accent" : "text-danger")}>{v}</span>
        </div>
      ))}
      {notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 pt-1 text-muted">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
