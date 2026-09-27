"use client";

import { useEffect, useState } from "react";
import { api, Button, cx } from "@/components/ui";
import type { Clip } from "@/components/editor/types";
import { stillThumbnail } from "@/lib/media/thumbnails";
import { DEFAULT_LOOK, isNeutral, type Look, LOOK_PRESET_LABEL, LOOK_PRESETS, type LookPreset, lookCss, lookValues, type LookValues } from "@/lib/domain/look";

type Key = keyof LookValues;
const CONTROLS: { k: Key; label: string; min: number; max: number; step: number; fmt: (v: number) => string }[] = [
  { k: "exposure", label: "Exposure", min: -1, max: 1, step: 0.05, fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)} EV` },
  { k: "contrast", label: "Contrast", min: 0.5, max: 1.6, step: 0.02, fmt: (v) => `${Math.round(v * 100)}%` },
  { k: "saturation", label: "Saturation", min: 0, max: 2, step: 0.05, fmt: (v) => (v === 0 ? "B&W" : `${Math.round(v * 100)}%`) },
  { k: "temperature", label: "Temperature", min: -1, max: 1, step: 0.05, fmt: (v) => (v === 0 ? "neutral" : v > 0 ? `warm ${Math.round(v * 100)}` : `cool ${Math.round(-v * 100)}`) },
  { k: "tint", label: "Tint", min: -1, max: 1, step: 0.05, fmt: (v) => (v === 0 ? "neutral" : v > 0 ? `magenta ${Math.round(v * 100)}` : `green ${Math.round(-v * 100)}`) },
  { k: "split", label: "Split toning", min: -1, max: 1, step: 0.05, fmt: (v) => (v === 0 ? "off" : v > 0 ? `teal/orange ${Math.round(v * 100)}` : `orange/teal ${Math.round(-v * 100)}`) },
  { k: "fade", label: "Fade (lifted blacks)", min: 0, max: 1, step: 0.05, fmt: pct },
  { k: "vignette", label: "Vignette", min: 0, max: 1, step: 0.05, fmt: pct },
  { k: "grain", label: "Film grain", min: 0, max: 1, step: 0.05, fmt: pct },
  { k: "sharpen", label: "Sharpen", min: 0, max: 1, step: 0.05, fmt: pct },
];
function pct(v: number) {
  return v ? `${Math.round(v * 100)}%` : "off";
}

interface SavedPreset {
  id: string;
  name: string;
  data: Look;
}

/** Colour grade + finishing for one clip or the whole project, with saved looks. */
export function LookPanel({ clip, projectLook, busy, onClip, onProject }: { clip: Clip | null; projectLook: Look; busy: boolean; onClip: (look: Look | null) => Promise<void> | void; onProject: (look: Look, clearOverrides: boolean) => Promise<void> | void }) {
  const [scope, setScope] = useState<"clip" | "project">(clip ? "clip" : "project");
  const current = scope === "clip" && clip ? (clip.look ?? projectLook) : projectLook;
  const [draft, setDraft] = useState<Look>(current);
  const [key, setKey] = useState(`${scope}:${clip?.clipId}:${JSON.stringify(current)}`);
  const k = `${scope}:${clip?.clipId}:${JSON.stringify(current)}`;
  if (k !== key) {
    setKey(k);
    setDraft(current);
  }
  const effScope = clip ? scope : "project";
  const [clearOverrides, setClearOverrides] = useState(false);
  const [presets, setPresets] = useState<SavedPreset[]>([]);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ presets: SavedPreset[] }>("/api/presets?kind=image")
      .then((r) => alive && setPresets(r.presets))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const values = lookValues(draft);
  const set = (kk: Key, v: number) => setDraft({ ...values, preset: "custom", [kk]: v });
  const thumb = clip?.asset.thumbnailUrl ? stillThumbnail(clip.asset.thumbnailUrl) : null;
  const changed = JSON.stringify(draft) !== JSON.stringify(current);
  const following = effScope === "clip" && clip && !clip.look;

  const savePreset = async () => {
    setErr(null);
    try {
      const r = await api<{ preset: SavedPreset }>("/api/presets", { method: "POST", json: { kind: "image", name, data: { ...values, preset: "custom" } } });
      setPresets((p) => [...p.filter((x) => x.name !== r.preset.name), r.preset].sort((a, b) => a.name.localeCompare(b.name)));
      setName("");
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="space-y-3 border-t border-line pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">Look</span>
        {clip && (
          <div className="flex overflow-hidden rounded border border-line text-[10px]">
            {(["clip", "project"] as const).map((s) => (
              <button key={s} onClick={() => setScope(s)} className={cx("px-2 py-0.5", scope === s ? "bg-accent/20 text-accent" : "text-muted")}>
                {s === "clip" ? "This clip" : "Whole project"}
              </button>
            ))}
          </div>
        )}
      </div>
      {following && <p className="text-[10px] text-muted">This clip follows the project look ({LOOK_PRESET_LABEL[projectLook.preset]}). Applying here gives it its own.</p>}

      {/* Preset swatches: the selected clip's thumbnail with each look (CSS approximation). */}
      <div className="grid grid-cols-3 gap-1.5">
        {(Object.keys(LOOK_PRESETS) as Exclude<LookPreset, "custom">[]).map((p) => {
          const c = lookCss(LOOK_PRESETS[p]);
          return (
            <button key={p} onClick={() => setDraft({ ...DEFAULT_LOOK, preset: p })} className={cx("overflow-hidden rounded border text-left", draft.preset === p ? "border-accent ring-1 ring-accent" : "border-line hover:border-muted")}>
              <div className="relative aspect-video bg-[linear-gradient(135deg,#6b8fb3,#d9a066_60%,#3b3b3b)]">
                {thumb && (
                  // eslint-disable-next-line @next/next/no-img-element -- remote thumbnails
                  <img src={thumb} alt="" className="absolute inset-0 h-full w-full object-cover" style={{ filter: c.filter }} />
                )}
                {!thumb && <div className="absolute inset-0" style={{ backdropFilter: c.filter }} />}
                {c.fade > 0 && <div className="absolute inset-0 mix-blend-lighten" style={{ background: `rgba(40,40,40,${Math.min(1, c.fade * 1.2)})` }} />}
                {c.vignette > 0 && <div className="absolute inset-0" style={{ background: `radial-gradient(ellipse at center, transparent ${Math.round(70 - c.vignette * 30)}%, rgba(0,0,0,${(c.vignette * 0.75).toFixed(2)}) 100%)` }} />}
              </div>
              <div className="truncate px-1 py-0.5 text-[10px]">{LOOK_PRESET_LABEL[p]}</div>
            </button>
          );
        })}
      </div>

      <details className="rounded border border-line bg-panel-2/50 p-2" open={draft.preset === "custom"}>
        <summary className="cursor-pointer text-[11px] text-muted">Adjust {draft.preset !== "custom" && "(moving one switches to Custom)"}</summary>
        <div className="mt-2 space-y-2">
          {CONTROLS.map((c) => (
            <label key={c.k} className="block text-[11px] text-muted">
              <span className="flex justify-between">
                <span>{c.label}</span>
                <span className="tabular-nums text-foreground">{c.fmt(values[c.k])}</span>
              </span>
              <input type="range" min={c.min} max={c.max} step={c.step} value={values[c.k]} onChange={(e) => set(c.k, Number(e.target.value))} className="w-full" />
            </label>
          ))}
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-1.5">
        {effScope === "clip" ? (
          <>
            <Button size="sm" variant="primary" disabled={busy || (!changed && !following)} onClick={() => void onClip(isNeutral(values) ? { ...DEFAULT_LOOK } : draft)}>
              Apply to clip
            </Button>
            {clip?.look && (
              <Button size="sm" disabled={busy} onClick={() => void onClip(null)}>
                Use project look
              </Button>
            )}
          </>
        ) : (
          <>
            <Button size="sm" variant="primary" disabled={busy || (!changed && !clearOverrides)} onClick={() => void onProject(draft, clearOverrides)}>
              Apply to project
            </Button>
            <label className="flex items-center gap-1 text-[10px] text-muted">
              <input type="checkbox" checked={clearOverrides} onChange={(e) => setClearOverrides(e.target.checked)} /> also replace clip looks
            </label>
          </>
        )}
      </div>
      <p className="text-[10px] text-muted">Thumbnails and the live player approximate the look; renders apply it exactly.</p>

      <div className="space-y-1.5">
        <div className="text-[11px] font-semibold text-muted">MY LOOKS</div>
        {presets.length === 0 && <p className="text-[10px] text-muted">Save the current settings to reuse them in any project.</p>}
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => (
            <span key={p.id} className="flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px]">
              <button onClick={() => setDraft({ ...p.data, preset: "custom" })} className="hover:text-accent">
                {p.name}
              </button>
              <button
                title="Delete"
                className="text-muted hover:text-danger"
                onClick={() => void api(`/api/presets?id=${p.id}`, { method: "DELETE" }).then(() => setPresets((x) => x.filter((y) => y.id !== p.id)))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-1">
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Name this look" className="h-7 min-w-0 flex-1 rounded border border-line bg-background px-2 text-[11px] outline-none focus:border-accent" />
          <Button size="sm" disabled={!name.trim()} onClick={() => void savePreset()}>
            Save
          </Button>
        </div>
        {err && <p className="text-[10px] text-danger">{err}</p>}
      </div>
    </div>
  );
}
