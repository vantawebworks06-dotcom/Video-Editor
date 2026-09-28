"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, Button, cx, Progress } from "@/components/ui";
import { uploadProjectFile } from "@/components/editor/upload";
import { planDelivery } from "@/lib/narrator/prosody";
import { applyPronunciations, outputBasis, sentenceKey } from "@/lib/narrator/state";
import {
  DEFAULT_CONTROLS,
  DEFAULT_PROCESSING,
  DEFAULT_VOICE_ID,
  KOKORO_VOICES,
  type Narrator,
  type NarratorControls,
  type NarratorProcessing,
  type NarratorSentence,
  type NarratorStyle,
  type SentenceOverride,
  type SentencePlan,
  STYLE_LABEL,
  type VoiceProfile,
} from "@/lib/narrator/types";

type Profile = Omit<VoiceProfile, "samples"> & { samples: (VoiceProfile["samples"][number] & { url: string | null })[] };

interface NarratorData {
  narrator: Narrator;
  urls: Record<string, string>;
  usedAsNarration: boolean;
  running: { id: string; kind: string; status: string; progress: number; stage: string | null; payload: Record<string, unknown> | null } | null;
  error: { kind: string; message: string } | null;
}

const READING = `On a quiet street in the old part of town, a young engineer spent his evenings building speakers out of scrap wood. Nobody expected much from him.

But within a year, his sound system was the talk of the city. Every Saturday night, the crowds grew larger — and louder. Was it the music, or the man behind it?

Then, one night in 1979, everything changed.`;

const r1 = (v: number, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toString();

function Slider({ label, value, min, max, step, fmt, onChange, disabled }: { label: string; value: number; min: number; max: number; step: number; fmt?: (v: number) => string; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <label className="block text-[11px] text-muted">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="tabular-nums text-foreground">{fmt ? fmt(value) : r1(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className="w-full" />
    </label>
  );
}

/** Narrator: a synthetic narrator matched to the user's voice (local Kokoro TTS). */
export function NarratorWorkspace({ projectId, onUsedAsNarration }: { projectId: string; onUsedAsNarration: () => void }) {
  const [data, setData] = useState<NarratorData | null>(null);
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [n, p] = await Promise.all([api<NarratorData>(`/api/projects/${projectId}/narrator`), api<{ profiles: Profile[] }>(`/api/voice-profiles`)]);
    setData(n);
    setProfiles(p.profiles);
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    Promise.all([api<NarratorData>(`/api/projects/${projectId}/narrator`), api<{ profiles: Profile[] }>(`/api/voice-profiles`)])
      .then(([n, p]) => {
        if (!alive) return;
        setData(n);
        setProfiles(p.profiles);
      })
      .catch((e: Error) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [projectId]);

  // Poll while the worker is busy with this project's narrator.
  const running = data?.running ?? null;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load().catch(() => undefined), 2000);
    return () => clearInterval(t);
  }, [running, load]);

  const n = data?.narrator ?? null;
  const profile = profiles?.find((p) => p.id === n?.profileId) ?? null;

  const save = async (patch: Partial<{ profileId: string | null; voice: string | null; style: NarratorStyle; controls: NarratorControls; script: string; processing: NarratorProcessing; overrides: Record<string, SentenceOverride | null> }>) => {
    setErr(null);
    try {
      const r = await api<{ narrator: Narrator }>(`/api/projects/${projectId}/narrator`, { method: "PUT", json: patch });
      setData((d) => (d ? { ...d, narrator: r.narrator } : d));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const generate = async (body: { mode: "full" | "sentences"; ids?: string[]; regenerate?: boolean }) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/projects/${projectId}/narrator/generate`, { method: "POST", json: body });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };

  // The delivery plan, computed here exactly as the worker will.
  const voice = n?.voice ?? profile?.match?.voice ?? DEFAULT_VOICE_ID;
  const match = useMemo(() => {
    const m = profile?.match ?? null;
    return m && voice !== m.voice ? { ...m, pitchShift: 0, speed: 1 } : m;
  }, [profile, voice]);
  const plans = useMemo(() => (n ? planDelivery({ sentences: n.sentences, style: n.style, controls: n.controls, match }) : []), [n, match]);
  const pron = profile?.pronunciations ?? {};
  const stateOf = (s: NarratorSentence, plan: SentencePlan) => (!s.audio ? "missing" : s.audio.key !== sentenceKey(voice, applyPronunciations(s.text, pron), plan) ? "stale" : "ready");
  const outputStale = Boolean(n?.output && n.output.basis !== outputBasis(n, profile?.updated_at ?? null));

  if (!data || !n || !profiles) return <div className="p-6 text-sm text-muted">{err ?? "Loading narrator…"}</div>;
  const narrating = running?.kind === "narrate";

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)_360px]">
      <aside className="min-h-0 overflow-auto border-r border-line bg-panel">
        <VoicePanel projectId={projectId} profiles={profiles} narrator={n} running={running} onReload={load} onSave={save} onError={setErr} />
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col bg-background">
        <ScriptEditor
          key={n.script === "" ? "empty" : "script"}
          script={n.script}
          onSave={(script) => save({ script })}
        />
        <div className="flex items-center gap-2 border-b border-line bg-panel px-4 py-2 text-xs">
          <span className="text-muted">
            {n.sentences.length} sentence{n.sentences.length === 1 ? "" : "s"} · {n.sentences.filter((s, i) => stateOf(s, plans[i]!) === "ready").length} ready
          </span>
          <span className="flex-1" />
          <Button size="sm" disabled={busy || narrating || !n.sentences.length} onClick={() => void generate({ mode: "sentences", ids: n.sentences.filter((s, i) => stateOf(s, plans[i]!) !== "ready").map((s) => s.id) })} title="Generate only sentences without current audio, to listen before building the full narration">
            Preview missing sentences
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {n.sentences.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted">Paste your script above. It is split into sentences, and each one can be adjusted and regenerated on its own.</p>
          ) : (
            <ol className="space-y-1.5">
              {n.sentences.map((s, i) => (
                <SentenceRow
                  key={s.id}
                  index={i}
                  s={s}
                  plan={plans[i]!}
                  newParagraph={i > 0 && n.sentences[i - 1]!.paragraph !== s.paragraph}
                  state={stateOf(s, plans[i]!)}
                  url={s.audio ? (data.urls[s.audio.path] ?? null) : null}
                  working={narrating && (running?.payload?.mode === "full" || ((running?.payload?.ids as string[] | null) ?? []).includes(s.id))}
                  disabled={busy}
                  onGenerate={(regenerate) => void generate({ mode: "sentences", ids: [s.id], regenerate })}
                  onOverride={(o) => void save({ overrides: { [s.id]: o } })}
                />
              ))}
            </ol>
          )}
        </div>
      </section>

      <aside className="min-h-0 overflow-auto border-l border-line bg-panel">
        <DeliveryPanel narrator={n} disabled={busy} onSave={save} />
        <div className="space-y-2 border-t border-line p-4">
          {running ? (
            <div className="space-y-1">
              <Progress value={Number(running.progress)} />
              <div className="text-[11px] text-muted">{running.status === "QUEUED" ? "Waiting for the worker (npm run worker)…" : (running.stage ?? "Working…")}</div>
            </div>
          ) : (
            <Button variant="primary" className="w-full" disabled={busy || !n.sentences.length} onClick={() => void generate({ mode: "full" })}>
              {n.output ? "Update narration" : "Generate narration"}
            </Button>
          )}
          {data.error && <p className="text-xs text-danger">{data.error.kind === "voice_profile" ? "Voice analysis" : "Generation"} failed: {data.error.message}</p>}
          {err && <p className="text-xs text-danger">{err}</p>}
          <p className="text-[10px] text-muted">Runs on this computer with Kokoro-82M (free, open source). Sentences already generated are reused, so updates after small changes are quick.</p>
        </div>
        <ProcessingPanel processing={n.processing} disabled={busy} onSave={(processing) => save({ processing })} />
        {n.output && (
          <OutputPanel
            projectId={projectId}
            output={n.output}
            stale={outputStale}
            before={data.urls[n.output.beforePath] ?? null}
            after={data.urls[n.output.afterPath] ?? null}
            used={data.usedAsNarration}
            onUsed={() => {
              void load();
              onUsedAsNarration();
            }}
          />
        )}
      </aside>
    </div>
  );
}

function ScriptEditor({ script, onSave }: { script: string; onSave: (s: string) => Promise<void> }) {
  const [draft, setDraft] = useState(script);
  const [open, setOpen] = useState(script.trim() === "");
  const [saving, setSaving] = useState(false);
  const dirty = draft !== script;
  return (
    <div className="border-b border-line bg-panel">
      <div className="flex items-center gap-2 px-4 py-2">
        <button className="text-xs font-semibold" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} Script
        </button>
        {!open && <span className="min-w-0 flex-1 truncate text-xs text-muted">{script.slice(0, 160) || "No script yet"}</span>}
        <span className="flex-1" />
        {open && (
          <Button
            size="sm"
            variant={dirty ? "primary" : "secondary"}
            disabled={!dirty || saving}
            onClick={() => {
              setSaving(true);
              void onSave(draft).finally(() => setSaving(false));
            }}
          >
            {saving ? "Saving…" : "Save script"}
          </Button>
        )}
      </div>
      {open && (
        <div className="px-4 pb-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            placeholder="Paste the narration script. Separate paragraphs with a blank line — paragraph breaks get longer pauses."
            className="w-full resize-y rounded border border-line bg-background p-2 text-sm leading-relaxed"
          />
          <p className="text-[10px] text-muted">Unchanged sentences keep their audio when you edit the script.</p>
        </div>
      )}
    </div>
  );
}

function SentenceRow({
  index,
  s,
  plan,
  newParagraph,
  state,
  url,
  working,
  disabled,
  onGenerate,
  onOverride,
}: {
  index: number;
  s: NarratorSentence;
  plan: SentencePlan;
  newParagraph: boolean;
  state: "missing" | "stale" | "ready";
  url: string | null;
  working: boolean;
  disabled: boolean;
  onGenerate: (regenerate: boolean) => void;
  onOverride: (o: SentenceOverride | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  return (
    <li className={cx("rounded-md border bg-panel p-2.5", newParagraph && "mt-4", state === "ready" ? "border-line" : "border-line/60")}>
      <div className="flex items-start gap-2">
        <span className="w-6 shrink-0 pt-0.5 text-right text-[10px] tabular-nums text-muted">{index + 1}</span>
        <button
          className={cx("mt-0.5 h-6 w-6 shrink-0 rounded-full text-[10px]", url ? "bg-accent/20 text-accent hover:bg-accent/30" : "bg-panel-2 text-muted")}
          disabled={!url}
          title={url ? (state === "stale" ? "Play (made with earlier settings)" : "Play") : "Not generated yet"}
          onClick={() => {
            const a = audioRef.current;
            if (!a) return;
            if (a.paused) void a.play();
            else a.pause();
          }}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        {url && <audio ref={audioRef} src={url} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />}
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug">
            {s.text.split(/(\s+)/).map((w, i) => {
              const bare = w.replace(/[^\p{L}\p{N}'’-]/gu, "").replace(/[’']s$/, "");
              return plan.emphasis.some((e) => e.toLowerCase() === bare.toLowerCase()) ? (
                <strong key={i} className="text-accent" title="Stressed">
                  {w}
                </strong>
              ) : (
                <span key={i}>{w}</span>
              );
            })}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted" title={plan.reasons.join("\n") || "Style defaults"}>
            <span>speed ×{plan.speed.toFixed(2)}</span>
            <span>
              pitch {plan.pitch >= 0 ? "+" : ""}
              {plan.pitch.toFixed(1)} st
            </span>
            <span>
              level {plan.gainDb >= 0 ? "+" : ""}
              {plan.gainDb.toFixed(1)} dB
            </span>
            <span>pause {plan.pauseAfter.toFixed(2)} s</span>
            {plan.beat && <span>beat before stress</span>}
            {plan.reasons.length > 0 && <span className="text-info">{plan.reasons.filter((r) => r !== "manual override").map((r) => r.split(":")[0]).join(" · ")}</span>}
            {s.override && <span className="text-accent">adjusted</span>}
            {s.take > 0 && <span>take {s.take + 1}</span>}
            {working ? <span className="text-accent">generating…</span> : state === "missing" ? <span>not generated</span> : state === "stale" ? <span className="text-accent">settings changed</span> : <span className="text-ok">{s.audio!.duration.toFixed(1)} s</span>}
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <Button size="sm" disabled={disabled || working} onClick={() => onGenerate(state === "ready")} title={state === "ready" ? "Generate a different take of this sentence (new variation of pace, pitch, level and pause)" : "Generate this sentence"}>
            {state === "ready" ? "New take" : "Generate"}
          </Button>
          <Button size="sm" onClick={() => setOpen(!open)}>
            {open ? "Close" : "Adjust"}
          </Button>
        </div>
      </div>
      {open && <OverrideEditor key={JSON.stringify(s.override)} s={s} plan={plan} onSave={onOverride} />}
    </li>
  );
}

function OverrideEditor({ s, plan, onSave }: { s: NarratorSentence; plan: SentencePlan; onSave: (o: SentenceOverride | null) => void }) {
  const o = s.override ?? {};
  const [speed, setSpeed] = useState(o.speed ?? 1);
  const [pitch, setPitch] = useState(o.pitch ?? 0);
  const [pause, setPause] = useState(o.pauseAfter ?? plan.pauseAfter);
  const [intensity, setIntensity] = useState(o.intensity ?? 0.5);
  const [words, setWords] = useState((o.emphasis ?? plan.emphasis).join(", "));
  const [use, setUse] = useState<Record<string, boolean>>({ speed: o.speed !== undefined, pitch: o.pitch !== undefined, pause: o.pauseAfter !== undefined, intensity: o.intensity !== undefined, emphasis: o.emphasis !== undefined });
  const row = (k: string, el: React.ReactNode) => (
    <div className="flex items-end gap-2">
      <input type="checkbox" className="mb-1.5" checked={use[k]} onChange={(e) => setUse({ ...use, [k]: e.target.checked })} title="Override the automatic value" />
      <div className={cx("flex-1", !use[k] && "opacity-50")}>{el}</div>
    </div>
  );
  return (
    <div className="mt-2 space-y-2 rounded border border-line bg-background p-2.5">
      <p className="text-[10px] text-muted">Tick a control to override the automatic delivery for this sentence. Speed and pitch are relative to your matched voice.</p>
      {row("speed", <Slider label="Speed" value={speed} min={0.6} max={1.5} step={0.01} fmt={(v) => `×${v.toFixed(2)}`} onChange={setSpeed} />)}
      {row("pitch", <Slider label="Pitch" value={pitch} min={-5} max={5} step={0.1} fmt={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} st`} onChange={setPitch} />)}
      {row("pause", <Slider label="Pause after" value={pause} min={0} max={5} step={0.05} fmt={(v) => `${v.toFixed(2)} s`} onChange={setPause} />)}
      {row("intensity", <Slider label="Intensity" value={intensity} min={0} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={setIntensity} />)}
      {row(
        "emphasis",
        <label className="block text-[11px] text-muted">
          Stressed words (comma-separated; empty = none)
          <input value={words} onChange={(e) => setWords(e.target.value)} className="mt-1 h-7 w-full rounded border border-line bg-panel px-2 text-xs text-foreground" />
        </label>,
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            const next: SentenceOverride = {};
            if (use.speed) next.speed = speed;
            if (use.pitch) next.pitch = pitch;
            if (use.pause) next.pauseAfter = pause;
            if (use.intensity) next.intensity = intensity;
            if (use.emphasis)
              next.emphasis = words
                .split(",")
                .map((w) => w.trim())
                .filter(Boolean)
                .slice(0, 8);
            onSave(Object.keys(next).length ? next : null);
          }}
        >
          Apply
        </Button>
        {s.override && (
          <Button size="sm" onClick={() => onSave(null)}>
            Back to automatic
          </Button>
        )}
      </div>
    </div>
  );
}

function DeliveryPanel({ narrator, disabled, onSave }: { narrator: Narrator; disabled: boolean; onSave: (p: { style?: NarratorStyle; controls?: NarratorControls }) => Promise<void> }) {
  const [c, setC] = useState(narrator.controls);
  const [synced, setSynced] = useState(narrator.controls);
  // Adopt saved values when they change elsewhere (e.g. the assistant or another tab).
  if (synced !== narrator.controls) {
    setSynced(narrator.controls);
    setC(narrator.controls);
  }
  const changed = JSON.stringify(c) !== JSON.stringify(narrator.controls);
  return (
    <div className="space-y-3 p-4">
      <div className="text-xs font-semibold">Delivery</div>
      <div className="grid grid-cols-3 gap-1">
        {(Object.keys(STYLE_LABEL) as NarratorStyle[]).map((s) => (
          <button key={s} disabled={disabled} onClick={() => void onSave({ style: s })} className={cx("rounded border px-1.5 py-1 text-[11px]", narrator.style === s ? "border-accent bg-accent/10" : "border-line hover:border-muted")}>
            {STYLE_LABEL[s]}
          </button>
        ))}
      </div>
      <Slider label="Speed" value={c.speed} min={0.7} max={1.35} step={0.01} fmt={(v) => `×${v.toFixed(2)}`} onChange={(v) => setC({ ...c, speed: v })} />
      <Slider label="Pitch" value={c.pitch} min={-4} max={4} step={0.1} fmt={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} st`} onChange={(v) => setC({ ...c, pitch: v })} />
      <Slider label="Pause length" value={c.pauseScale} min={0.4} max={2.5} step={0.05} fmt={(v) => `×${v.toFixed(2)}`} onChange={(v) => setC({ ...c, pauseScale: v })} />
      <Slider label="Emphasis" value={c.emphasis} min={0} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setC({ ...c, emphasis: v })} />
      <Slider label="Intensity" value={c.intensity} min={0} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setC({ ...c, intensity: v })} />
      <Slider label="Variation between sentences" value={c.variation} min={0} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setC({ ...c, variation: v })} />
      <div className="flex gap-2">
        <Button size="sm" variant={changed ? "primary" : "secondary"} disabled={!changed || disabled} onClick={() => void onSave({ controls: c })}>
          Apply delivery
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => void onSave({ controls: DEFAULT_CONTROLS })}>
          Reset
        </Button>
      </div>
    </div>
  );
}

function ProcessingPanel({ processing, disabled, onSave }: { processing: NarratorProcessing; disabled: boolean; onSave: (p: NarratorProcessing) => Promise<void> }) {
  const [p, setP] = useState(processing);
  const [synced, setSynced] = useState(processing);
  if (synced !== processing) {
    setSynced(processing);
    setP(processing);
  }
  const changed = JSON.stringify(p) !== JSON.stringify(processing);
  const set = (k: keyof NarratorProcessing) => (v: number) => setP({ ...p, [k]: v });
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const dB = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
  return (
    <div className="space-y-2.5 border-t border-line p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">Audio processing</span>
        <span className="text-[10px] text-muted">applied on the next update</span>
      </div>
      <Slider label="Noise reduction" value={p.noiseReduction} min={0} max={1} step={0.05} fmt={pct} onChange={set("noiseReduction")} />
      <Slider label="Clarity (presence 3.5 kHz)" value={p.presence} min={-6} max={6} step={0.5} fmt={dB} onChange={set("presence")} />
      <details className="text-[11px]">
        <summary className="cursor-pointer text-muted">EQ</summary>
        <div className="mt-2 space-y-2">
          <Slider label="Warmth (150 Hz)" value={p.warmth} min={-6} max={6} step={0.5} fmt={dB} onChange={set("warmth")} />
          <Slider label="Mud cut (320 Hz)" value={p.mudCut} min={0} max={8} step={0.5} fmt={(v) => `−${v.toFixed(1)} dB`} onChange={set("mudCut")} />
          <Slider label="Air (10 kHz)" value={p.air} min={-6} max={6} step={0.5} fmt={dB} onChange={set("air")} />
          <Slider label="High-pass" value={p.highpass} min={0} max={200} step={5} fmt={(v) => (v ? `${v} Hz` : "off")} onChange={set("highpass")} />
        </div>
      </details>
      <Slider label="Bass (100 Hz)" value={p.bass} min={-10} max={10} step={0.5} fmt={dB} onChange={set("bass")} />
      <Slider label="Treble (5 kHz)" value={p.treble} min={-10} max={10} step={0.5} fmt={dB} onChange={set("treble")} />
      <Slider label="Compression" value={p.compression} min={0} max={1} step={0.05} fmt={pct} onChange={set("compression")} />
      <Slider label="De-esser" value={p.deEss} min={0} max={1} step={0.05} fmt={pct} onChange={set("deEss")} />
      <Slider label="Reverb" value={p.reverb} min={0} max={1} step={0.05} fmt={pct} onChange={set("reverb")} />
      {p.reverb > 0 && <Slider label="Room size" value={p.reverbSize} min={0} max={1} step={0.05} fmt={(v) => `${(0.3 + v * 1.9).toFixed(1)} s decay`} onChange={set("reverbSize")} />}
      <Slider label="Echo" value={p.echo} min={0} max={1} step={0.05} fmt={pct} onChange={set("echo")} />
      {p.echo > 0 && <Slider label="Echo delay" value={p.echoDelay} min={60} max={1000} step={10} fmt={(v) => `${v} ms`} onChange={set("echoDelay")} />}
      <Slider label="Room tone (under silence)" value={p.roomTone} min={-90} max={-45} step={1} fmt={(v) => (v <= -90 ? "off" : `${v} dBFS`)} onChange={set("roomTone")} />
      <label className="block text-[11px] text-muted">
        Loudness normalisation
        <select value={p.loudness} onChange={(e) => setP({ ...p, loudness: Number(e.target.value) })} className="mt-1 h-7 w-full rounded border border-line bg-background px-2 text-foreground">
          <option value={-14}>−14 LUFS (YouTube, social)</option>
          <option value={-16}>−16 LUFS (podcast, web — under music)</option>
          <option value={-19}>−19 LUFS (quieter, leaves room for music)</option>
          <option value={-23}>−23 LUFS (broadcast)</option>
        </select>
      </label>
      <Slider label="Volume (after normalisation)" value={p.volume} min={0} max={2} step={0.05} fmt={(v) => (v === 0 ? "mute" : `${(20 * Math.log10(v)).toFixed(1)} dB`)} onChange={set("volume")} />
      <div className="flex gap-2">
        <Button size="sm" variant={changed ? "primary" : "secondary"} disabled={!changed || disabled} onClick={() => void onSave(p)}>
          Apply processing
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => void onSave(DEFAULT_PROCESSING)}>
          Reset
        </Button>
      </div>
    </div>
  );
}

function OutputPanel({ projectId, output, stale, before, after, used, onUsed }: { projectId: string; output: NonNullable<Narrator["output"]>; stale: boolean; before: string | null; after: string | null; used: boolean; onUsed: () => void }) {
  const [side, setSide] = useState<"after" | "before">("after");
  const ref = useRef<HTMLAudioElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // A/B: switch sources at the same position, keep playing if it was.
  const flip = (to: "after" | "before") => {
    const a = ref.current;
    if (!a || to === side) return;
    const t = a.currentTime;
    const wasPlaying = !a.paused;
    setSide(to);
    requestAnimationFrame(() => {
      const b = ref.current;
      if (!b) return;
      const go = () => {
        b.currentTime = t;
        if (wasPlaying) void b.play();
      };
      if (b.readyState >= 1) go();
      else b.addEventListener("loadedmetadata", go, { once: true });
    });
  };
  const voiceName = KOKORO_VOICES.find((v) => v.id === output.voice)?.name ?? output.voice;
  return (
    <div className="space-y-2 border-t border-line p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">Narration</span>
        <span className="text-[10px] text-muted">
          {Math.floor(output.duration / 60)}:{String(Math.round(output.duration % 60)).padStart(2, "0")} · {voiceName}
        </span>
      </div>
      {stale && <p className="text-[11px] text-accent">Settings changed since this was generated — update it to hear them.</p>}
      <div className="flex rounded border border-line text-[11px]">
        {(["before", "after"] as const).map((s) => (
          <button key={s} className={cx("flex-1 py-1", side === s ? "bg-accent/15 text-accent" : "text-muted")} onClick={() => flip(s)}>
            {s === "before" ? "Before processing" : "After processing"}
          </button>
        ))}
      </div>
      <audio ref={ref} key={side} src={(side === "after" ? after : before) ?? undefined} controls className="w-full" />
      <p className="text-[10px] text-muted">Both play at the same loudness, so you hear the processing, not a volume change.</p>
      <Button
        size="sm"
        variant={used ? "secondary" : "primary"}
        className="w-full"
        disabled={busy}
        onClick={() => {
          if (!confirm("Use this as the project's narration? It replaces the current narration audio and script, and the edit will need to be generated again to follow it.")) return;
          setBusy(true);
          setMsg(null);
          api<{ duration: number }>(`/api/projects/${projectId}/narrator/use`, { method: "POST" })
            .then(() => {
              setMsg("This is now the project narration. Generate the edit to build the film around it.");
              onUsed();
            })
            .catch((e: Error) => setMsg(e.message))
            .finally(() => setBusy(false));
        }}
      >
        {used ? "In use as the project narration ✓ (use again)" : "Use as project narration"}
      </Button>
      {msg && <p className="text-[11px] text-muted">{msg}</p>}
    </div>
  );
}

function VoicePanel({
  projectId,
  profiles,
  narrator,
  running,
  onReload,
  onSave,
  onError,
}: {
  projectId: string;
  profiles: Profile[];
  narrator: Narrator;
  running: NarratorData["running"];
  onReload: () => Promise<void>;
  onSave: (p: { profileId?: string | null; voice?: string | null }) => Promise<void>;
  onError: (m: string | null) => void;
}) {
  const profile = profiles.find((p) => p.id === narrator.profileId) ?? null;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("My voice");
  const [accent, setAccent] = useState<"us" | "uk">("us");
  const analysing = running?.kind === "voice_profile";

  const create = async () => {
    try {
      const r = await api<{ profile: Profile }>(`/api/voice-profiles`, { method: "POST", json: { name, accent } });
      setCreating(false);
      await onSave({ profileId: r.profile.id });
      await onReload();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const patch = async (body: Record<string, unknown>) => {
    try {
      await api(`/api/voice-profiles/${profile!.id}`, { method: "PATCH", json: body });
      await onReload();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const analyse = async () => {
    try {
      await api(`/api/voice-profiles/${profile!.id}/analyze`, { method: "POST", json: { projectId } });
      await onReload();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <div>
        <div className="mb-1.5 text-xs font-semibold">Your voice</div>
        <div className="flex gap-2">
          <select value={narrator.profileId ?? ""} onChange={(e) => void onSave({ profileId: e.target.value || null })} className="h-8 min-w-0 flex-1 rounded border border-line bg-background px-2 text-sm">
            <option value="">No profile (stock voice)</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={() => setCreating(!creating)}>
            New
          </Button>
        </div>
        {creating && (
          <div className="mt-2 space-y-2 rounded border border-line bg-background p-2.5">
            <input value={name} onChange={(e) => setName(e.target.value)} className="h-7 w-full rounded border border-line bg-panel px-2 text-sm" placeholder="Profile name" />
            <label className="block text-[11px] text-muted">
              Accent of the voice engine
              <select value={accent} onChange={(e) => setAccent(e.target.value as "us" | "uk")} className="mt-1 h-7 w-full rounded border border-line bg-panel px-2 text-foreground">
                <option value="us">American English</option>
                <option value="uk">British English</option>
              </select>
            </label>
            <p className="text-[10px] text-muted">The free engine offers American and British English only; pick the closer one to your accent.</p>
            <Button size="sm" variant="primary" disabled={!name.trim()} onClick={() => void create()}>
              Create profile
            </Button>
          </div>
        )}
      </div>

      {profile && (
        <>
          <Recorder projectId={projectId} profileId={profile.id} count={profile.samples.length} onDone={onReload} onError={onError} />
          <div>
            <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
              <span>Recordings ({profile.samples.length})</span>
              <span>{profile.samples.reduce((a, s) => a + (s.duration ?? 0), 0).toFixed(0)} s measured</span>
            </div>
            <ul className="space-y-1">
              {profile.samples.map((s) => (
                <li key={s.path} className="flex items-center gap-2 text-xs">
                  {s.url ? <audio src={s.url} controls preload="none" className="h-7 min-w-0 flex-1" /> : <span className="flex-1 truncate">{s.name}</span>}
                  <button className="text-muted hover:text-danger" title={`Remove ${s.name}`} onClick={() => confirm(`Remove “${s.name}”?`) && void patch({ removeSample: s.path })}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {analysing ? (
            <div className="space-y-1">
              <Progress value={Number(running!.progress)} />
              <div className="text-[11px] text-muted">{running!.status === "QUEUED" ? "Waiting for the worker (npm run worker)…" : (running!.stage ?? "Analysing…")}</div>
            </div>
          ) : (
            <Button size="sm" variant={profile.analysis ? "secondary" : "primary"} className="w-full" disabled={!profile.samples.length} onClick={() => void analyse()}>
              {profile.analysis ? "Analyse again" : "Analyse my voice"}
            </Button>
          )}
          {profile.analysis && <AnalysisView profile={profile} />}
          <label className="block text-[11px] text-muted">
            Engine accent
            <select value={profile.accent} onChange={(e) => confirm("Changing the accent needs a new analysis. Continue?") && void patch({ accent: e.target.value })} className="mt-1 h-7 w-full rounded border border-line bg-background px-2 text-foreground">
              <option value="us">American English</option>
              <option value="uk">British English</option>
            </select>
          </label>
          <Pronunciations value={profile.pronunciations} onSave={(pronunciations) => void patch({ pronunciations })} />
        </>
      )}

      <label className="block text-[11px] text-muted">
        Voice used
        <select value={narrator.voice ?? ""} onChange={(e) => void onSave({ voice: e.target.value || null })} className="mt-1 h-7 w-full rounded border border-line bg-background px-2 text-foreground">
          <option value="">{profile?.match ? `Matched to your voice (${KOKORO_VOICES.find((v) => v.id === profile.match!.voice)?.name})` : `Default (${KOKORO_VOICES.find((v) => v.id === DEFAULT_VOICE_ID)?.name})`}</option>
          {KOKORO_VOICES.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} — {v.accent === "us" ? "American" : "British"} {v.gender}, quality {v.grade}
            </option>
          ))}
        </select>
      </label>
      <p className="text-[10px] leading-relaxed text-muted">
        Voices come from Kokoro-82M (Apache 2.0), which runs on this computer. It does not clone voices: your recordings choose the closest voice and set its pitch, pace and pauses to yours.
      </p>
    </div>
  );
}

function AnalysisView({ profile }: { profile: Profile }) {
  const a = profile.analysis!;
  const m = profile.match;
  const stat = (label: string, value: string) => (
    <div className="rounded bg-background px-2 py-1">
      <div className="text-[9px] uppercase tracking-wide text-muted">{label}</div>
      <div className="text-xs tabular-nums">{value}</div>
    </div>
  );
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1">
        {stat("Pitch", `${a.pitchMedian.toFixed(0)} Hz (${a.pitchLow.toFixed(0)}–${a.pitchHigh.toFixed(0)})`)}
        {stat("Pitch range", `${a.pitchRange.toFixed(1)} semitones`)}
        {stat("Pace", `${a.wordsPerMinute} words/min`)}
        {stat("Articulation", `${a.articulationRate.toFixed(1)} syll/s`)}
        {stat("Pauses", `${a.pauseMedian.toFixed(2)} s typical`)}
        {stat("Pauses/min", a.pausesPerMinute.toFixed(0))}
        {stat("Energy variation", `${a.energyVariation.toFixed(1)} dB`)}
        {stat("Speech measured", `${a.speechSeconds.toFixed(0)} s`)}
      </div>
      {a.notes.map((n, i) => (
        <p key={i} className="text-[11px] text-accent">
          {n}
        </p>
      ))}
      {m && (
        <div className="rounded border border-line bg-background p-2 text-[11px]">
          {m.notes.map((n, i) => (
            <p key={i} className={i === 0 ? "text-foreground" : "text-muted"}>
              {n}
            </p>
          ))}
          <details className="mt-1">
            <summary className="cursor-pointer text-muted">Voices compared ({m.candidates.length})</summary>
            <ul className="mt-1 space-y-0.5 text-muted">
              {m.candidates.map((c) => (
                <li key={c.voice}>
                  {KOKORO_VOICES.find((v) => v.id === c.voice)?.name ?? c.voice}: {c.pitch.toFixed(0)} Hz, {c.rate.toFixed(1)} syll/s, quality {c.grade} (score {c.score})
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}

function Pronunciations({ value, onSave }: { value: Record<string, string>; onSave: (v: Record<string, string>) => void }) {
  const [rows, setRows] = useState(Object.entries(value));
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setRows(Object.entries(value));
  }
  return (
    <details className="text-[11px]">
      <summary className="cursor-pointer text-muted">Pronunciations ({Object.keys(value).length})</summary>
      <div className="mt-2 space-y-1">
        <p className="text-[10px] text-muted">Spell words the way they should sound, e.g. “Delroy” → “Del-roy”, “Kingston” → “King-stun”.</p>
        {rows.map(([w, say], i) => (
          <div key={i} className="flex gap-1">
            <input value={w} placeholder="Word" onChange={(e) => setRows(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} className="h-7 w-1/2 rounded border border-line bg-background px-2" />
            <input value={say} placeholder="Say it as" onChange={(e) => setRows(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} className="h-7 w-1/2 rounded border border-line bg-background px-2" />
            <button className="px-1 text-muted hover:text-danger" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setRows([...rows, ["", ""]])}>
            Add
          </Button>
          <Button size="sm" variant="primary" onClick={() => onSave(Object.fromEntries(rows.filter(([w, s]) => w.trim() && s.trim()).map(([w, s]) => [w.trim(), s.trim()])))}>
            Save
          </Button>
        </div>
      </div>
    </details>
  );
}

/** Record in the browser (raw microphone: no echo cancellation or noise suppression, which would change the voice) or upload files. */
function Recorder({ projectId, profileId, count, onDone, onError }: { projectId: string; profileId: string; count: number; onDone: () => Promise<void>; onError: (m: string | null) => void }) {
  const [rec, setRec] = useState<{ stream: MediaStream; ctx: AudioContext; started: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [uploading, setUploading] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    if (!rec) return;
    const an = rec.ctx.createAnalyser();
    rec.ctx.createMediaStreamSource(rec.stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    let raf = 0;
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      setLevel(Math.min(1, Math.sqrt(s / buf.length) * 4));
      setElapsed((Date.now() - rec.started) / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rec]);

  const upload = async (file: File, title: string) => {
    setUploading(0);
    try {
      await uploadProjectFile(projectId, "voice", file, { onProgress: setUploading, meta: { profileId, title } });
      await onDone();
    } catch (e) {
      onError((e as Error).message);
    }
    setUploading(null);
  };

  const start = async () => {
    onError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
      const type = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const mr = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 128_000 });
      const ctx = new AudioContext();
      const started = Date.now();
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
        if ((Date.now() - started) / 1000 < 3) return onError("That recording was too short — read at least a few sentences.");
        const title = `Recording ${count + 1}`;
        void upload(new File([new Blob(chunks, { type: "audio/webm" })], `${title}.webm`, { type: "audio/webm" }), title);
      };
      mr.start(1000);
      recorder.current = mr;
      setRec({ stream, ctx, started });
    } catch (e) {
      onError(`Microphone unavailable: ${(e as Error).message}`);
    }
  };
  const stop = () => {
    recorder.current?.stop();
    recorder.current = null;
    setRec(null);
  };

  return (
    <div className="space-y-2 rounded border border-line bg-background p-2.5">
      {rec ? (
        <>
          <p className="whitespace-pre-line text-[11px] leading-relaxed">{READING}</p>
          <div className="flex items-center gap-2">
            <span className="h-2 flex-1 overflow-hidden rounded bg-panel-2">
              <span className={cx("block h-full", level > 0.9 ? "bg-danger" : "bg-ok")} style={{ width: `${Math.round(level * 100)}%` }} />
            </span>
            <span className="w-10 text-right text-[11px] tabular-nums">
              {Math.floor(elapsed / 60)}:{String(Math.floor(elapsed % 60)).padStart(2, "0")}
            </span>
          </div>
          <Button size="sm" variant="danger" className="w-full" onClick={stop}>
            Stop and save
          </Button>
        </>
      ) : (
        <>
          <p className="text-[11px] text-muted">Record 1–3 minutes of yourself reading as you would narrate (a reading passage appears when you start), or upload recordings.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" className="flex-1" disabled={uploading !== null} onClick={() => void start()}>
              ● Record
            </Button>
            <Button size="sm" className="flex-1" disabled={uploading !== null} onClick={() => fileRef.current?.click()}>
              Upload…
            </Button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.webm"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              void (async () => {
                for (const f of files) await upload(f, f.name.replace(/\.[^.]+$/, ""));
              })();
            }}
          />
          {uploading !== null && <Progress value={uploading} />}
        </>
      )}
    </div>
  );
}
