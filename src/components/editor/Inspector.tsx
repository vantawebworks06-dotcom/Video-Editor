"use client";

import { useState } from "react";
import { api, Button, cx, Input, Label, RightsBadge, Select, Tag } from "@/components/ui";
import type { AnnotationKind, ProjectSettings, ScenePlan } from "@/lib/domain/types";
import { MUSIC_TRACKS } from "@/lib/render/libraryTracks";
import type { Clip } from "./types";
import { uploadProjectFile } from "./upload";

const TABS = ["Visual", "Text", "Motion", "Audio", "Source", "AI"] as const;
type Tab = (typeof TABS)[number];

const MOTIONS = ["none", "slow_zoom_in", "slow_zoom_out", "pan_left", "pan_right", "pan_up", "pan_down", "diagonal", "subtle_rotation", "punch_in"];
const LAYOUTS = ["fullscreen", "paper_card", "polaroid", "article", "picture_in_picture"];
const SFX = ["whoosh", "impact", "click", "camera_shutter", "paper", "notification", "crowd", "bass_hit", "riser"];
const ANNOTATIONS: AnnotationKind[] = ["red_circle", "underline", "highlight", "arrow", "magnifier", "cursor"];
const REGIONS: Record<string, { x: number; y: number; w: number; h: number }> = {
  "Top (headline)": { x: 0.08, y: 0.06, w: 0.84, h: 0.14 },
  Middle: { x: 0.2, y: 0.4, w: 0.6, h: 0.18 },
  Bottom: { x: 0.1, y: 0.75, w: 0.8, h: 0.14 },
  "Left half": { x: 0.05, y: 0.25, w: 0.42, h: 0.4 },
  "Right half": { x: 0.53, y: 0.25, w: 0.42, h: 0.4 },
};

export function Inspector({
  projectId,
  clip,
  plan,
  settings,
  hasMusicUpload,
  onChanged,
  onReplace,
  onRegenerateScene,
}: {
  projectId: string;
  clip: Clip | null;
  plan: ScenePlan | null;
  settings: ProjectSettings;
  hasMusicUpload: boolean;
  onChanged: () => void;
  onReplace: (c: Clip) => void;
  onRegenerateScene: (sceneId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("Visual");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (done) setMsg(done);
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
    setBusy(false);
  };
  const clipAction = (json: unknown) => run(() => api(`/api/projects/${projectId}/clips/${clip!.clipId}`, { method: "PATCH", json }));
  const sceneAction = (json: unknown, done?: string) => run(() => api(`/api/projects/${projectId}/scenes/${plan!.sceneId}`, { method: "POST", json }), done);
  const saveSettings = (s: Partial<ProjectSettings>) => run(() => api(`/api/projects/${projectId}`, { method: "PATCH", json: { settings: s } }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex border-b border-line">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cx("flex-1 py-2 text-xs", tab === t ? "border-b-2 border-accent text-foreground" : "text-muted hover:text-foreground")}>
            {t}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3 text-sm">
        {msg && <p className="rounded border border-line bg-panel-2 p-2 text-xs">{msg}</p>}

        {tab === "Visual" &&
          (clip ? (
            <>
              <div className="aspect-video rounded bg-black bg-contain bg-center bg-no-repeat" style={{ backgroundImage: clip.asset.thumbnailUrl ? `url(${clip.asset.thumbnailUrl})` : undefined }} />
              <div className="flex items-center justify-between">
                <span className="truncate text-xs" title={clip.asset.title}>
                  {clip.asset.title}
                </span>
                <RightsBadge status={clip.asset.rightsStatus} />
              </div>
              <Button variant="primary" className="w-full" onClick={() => onReplace(clip)}>
                Replace · Find Better Footage
              </Button>
              <div>
                <Label>Layout</Label>
                <Select value={clip.layout} disabled={busy} onChange={(e) => void clipAction({ action: "update", layout: e.target.value })}>
                  {LAYOUTS.map((l) => (
                    <option key={l} value={l}>
                      {l.replace(/_/g, " ")}
                    </option>
                  ))}
                </Select>
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={clip.blackAndWhite} disabled={busy} onChange={(e) => void clipAction({ action: "update", blackAndWhite: e.target.checked })} />
                Black &amp; white + grain
              </label>
              <NumberField key={`d-${clip.clipId}-${clip.duration}`} label="Duration (s)" hint="neighbour in the scene absorbs the change" value={clip.duration} step={0.1} disabled={busy} onCommit={(v) => void clipAction({ action: "resize", duration: v })} />
              {clip.asset.type === "video" && <NumberField key={`t-${clip.clipId}-${clip.trimStart}`} label="Trim start (s)" value={clip.trimStart} step={0.5} disabled={busy} onCommit={(v) => void clipAction({ action: "update", trimStart: v })} />}
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => void clipAction({ action: "move", direction: -1 })}>
                  ← Move
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void clipAction({ action: "move", direction: 1 })}>
                  Move →
                </Button>
                <Button size="sm" variant="danger" disabled={busy} onClick={() => confirm("Delete this visual? The neighbouring clip will fill its time.") && void clipAction({ action: "delete" })}>
                  Delete
                </Button>
              </div>
            </>
          ) : (
            <p className="text-xs text-muted">Select a visual on the timeline.</p>
          ))}

        {tab === "Text" &&
          (plan ? (
            <TextEditor key={`${plan.sceneId}-${JSON.stringify(plan.textOverlay)}`} plan={plan} busy={busy} onSave={(t) => void sceneAction({ action: "text", ...t }, "Text saved")} />
          ) : (
            <p className="text-xs text-muted">Select a scene to add or edit its text emphasis.</p>
          ))}

        {tab === "Motion" &&
          (clip ? (
            <>
              <div>
                <Label hint={clip.asset.type === "photo" ? undefined : "videos support none / punch in"}>Motion</Label>
                <Select value={clip.motion} disabled={busy} onChange={(e) => void clipAction({ action: "update", motion: { type: e.target.value, intensity: clip.motionIntensity } })}>
                  {MOTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m.replace(/_/g, " ")}
                    </option>
                  ))}
                </Select>
              </div>
              <NumberField key={`i-${clip.clipId}-${clip.motionIntensity}`} label="Intensity" value={clip.motionIntensity} step={0.02} min={0} max={0.3} disabled={busy} onCommit={(v) => void clipAction({ action: "update", motion: { type: clip.motion, intensity: v } })} />
              <AnnotationEditor clip={clip} busy={busy} onSave={(annotations) => void clipAction({ action: "update", annotations })} />
            </>
          ) : (
            <p className="text-xs text-muted">Select a visual to change its motion and annotations.</p>
          ))}

        {tab === "Audio" && (
          <>
            {plan ? (
              <SfxEditor plan={plan} busy={busy} onAdd={(kind, at) => void sceneAction({ action: "addSfx", kind, at })} onRemove={(index) => void sceneAction({ action: "removeSfx", index })} />
            ) : (
              <p className="text-xs text-muted">Select a scene to add sound effects.</p>
            )}
            <div className="space-y-2 border-t border-line pt-3">
              <Label>Music</Label>
              <Select value={settings.musicTrack} disabled={busy} onChange={(e) => void saveSettings({ musicTrack: e.target.value })}>
                {MUSIC_TRACKS.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name} (royalty-safe, generated)
                  </option>
                ))}
                <option value="uploaded" disabled={!hasMusicUpload}>
                  My uploaded music{hasMusicUpload ? "" : " (upload first)"}
                </option>
                <option value="none">No music</option>
              </Select>
              <input
                type="file"
                accept=".mp3,.wav,.m4a,.aac,.ogg,.flac"
                className="text-xs"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void run(async () => {
                    await uploadProjectFile(projectId, "music", f);
                    await api(`/api/projects/${projectId}`, { method: "PATCH", json: { settings: { musicTrack: "uploaded" } } });
                  }, "Music uploaded");
                }}
              />
              {(["voiceVolume", "musicVolume", "sfxVolume", "duckingStrength"] as const).map((k) => (
                <Slider key={`${k}-${settings.mix[k]}`} label={{ voiceVolume: "Voice volume", musicVolume: "Music volume", sfxVolume: "SFX volume", duckingStrength: "Ducking strength" }[k]} value={settings.mix[k]} max={k === "duckingStrength" ? 1 : 1.5} onCommit={(v) => void saveSettings({ mix: { ...settings.mix, [k]: v } })} />
              ))}
            </div>
          </>
        )}

        {tab === "Source" &&
          (clip ? (
            <div className="space-y-2 text-xs">
              <div className="flex items-center gap-2">
                <RightsBadge status={clip.asset.rightsStatus} />
                {clip.userApproved && <Tag tone="ok">Approved by you</Tag>}
              </div>
              <Field k="Provider" v={clip.asset.provider === "giphy" ? "GIPHY — Powered By GIPHY" : clip.asset.provider} />
              <Field k="Title" v={clip.asset.title} />
              <Field k="Author" v={clip.asset.author ?? "Unknown"} />
              <Field k="Licence" v={clip.asset.license} href={clip.asset.licenseUrl} />
              <Field k="Source" v={clip.asset.sourceUrl} href={clip.asset.sourceUrl} />
              <Field k="Attribution" v={clip.asset.attribution ?? "—"} />
              <Field k="Attribution required" v={clip.asset.attributionRequired ? "Yes" : "No"} />
              <Field k="Asset ID" v={clip.asset.id} />
              <Field k="Retrieved" v={new Date(clip.asset.retrievedAt).toLocaleString()} />
              {clip.asset.rightsNotes.length > 0 && (
                <ul className="list-disc space-y-1 pl-4 text-muted">
                  {clip.asset.rightsNotes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
              {(clip.asset.rightsStatus === "UNKNOWN" || clip.asset.rightsStatus === "USER_REVIEW") && (
                <Button size="sm" disabled={busy} onClick={() => void run(() => api(`/api/assets/${clip.assetRowId}`, { method: "PATCH", json: { userApproved: !clip.userApproved } }))}>
                  {clip.userApproved ? "Revoke my approval" : "I have confirmed the rights — approve"}
                </Button>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted">Select a visual to inspect its source and licence.</p>
          ))}

        {tab === "AI" && (
          <div className="space-y-3 text-xs">
            {clip && (
              <div className="space-y-1">
                <div className="font-semibold">Why this visual</div>
                <Field k="Chosen by" v={clip.selectedBy} />
                <Field k="Need" v={`${clip.needType} — ${clip.needDescription}`} />
                <Field k="Queries" v={clip.queries.join(" · ")} />
                {clip.overall !== null && <Field k="Overall score" v={String(clip.overall)} />}
                {clip.scores && Object.entries(clip.scores).map(([k, v]) => <Field key={k} k={k} v={String(Math.round(Number(v)))} />)}
                <p className="text-muted">{clip.reason}</p>
              </div>
            )}
            {plan && (
              <div className="space-y-1 border-t border-line pt-3">
                <div className="font-semibold">Scene {plan.sceneId}</div>
                <Field k="Strategy" v={plan.visualStrategy.replace(/_/g, " ")} />
                <Field k="Importance" v={plan.importance} />
                <Field k="Info density" v={plan.intensity.informationDensity.toFixed(2)} />
                <Field k="Emotional" v={plan.intensity.emotionalIntensity.toFixed(2)} />
                <Field k="Meme moment" v={`${plan.meme.insert ? "yes" : "no"} — ${plan.meme.reason}`} />
                <div className="flex flex-wrap gap-2 pt-2">
                  <Button size="sm" disabled={busy} onClick={() => onRegenerateScene(plan.sceneId)}>
                    Regenerate Scene
                  </Button>
                  <Button size="sm" disabled={busy} onClick={() => void sceneAction({ action: "addMeme" }, "Meme added")}>
                    Add Meme
                  </Button>
                </div>
              </div>
            )}
            {!clip && !plan && <p className="text-muted">Select a scene or visual.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ k, v, href }: { k: string; v: string; href?: string | null }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-2">
      <span className="text-muted">{k}</span>
      {href ? (
        <a className="break-all text-info hover:underline" href={href} target="_blank" rel="noreferrer noopener">
          {v}
        </a>
      ) : (
        <span className="break-words">{v}</span>
      )}
    </div>
  );
}

function NumberField({ label, hint, value, step, min = 0, max = 3600, disabled, onCommit }: { label: string; hint?: string; value: number; step: number; min?: number; max?: number; disabled?: boolean; onCommit: (v: number) => void }) {
  const [v, setV] = useState(String(Number(value.toFixed(2))));
  return (
    <div>
      <Label hint={hint}>{label}</Label>
      <div className="flex gap-2">
        <Input type="number" step={step} min={min} max={max} value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} />
        <Button size="sm" disabled={disabled || Number(v) === Number(value.toFixed(2))} onClick={() => onCommit(Number(v))}>
          Apply
        </Button>
      </div>
    </div>
  );
}

function Slider({ label, value, max, onCommit }: { label: string; value: number; max: number; onCommit: (v: number) => void }) {
  const [v, setV] = useState(value);
  return (
    <label className="block text-xs text-muted">
      {label}: {v.toFixed(2)}
      <input type="range" min={0} max={max} step={0.05} value={v} className="w-full" onChange={(e) => setV(Number(e.target.value))} onMouseUp={() => onCommit(v)} onKeyUp={() => onCommit(v)} />
    </label>
  );
}

function TextEditor({ plan, busy, onSave }: { plan: ScenePlan; busy: boolean; onSave: (t: Record<string, unknown>) => void }) {
  const [t, setT] = useState(plan.textOverlay);
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">Large text is used sparingly — key phrases, statistics, chapter titles.</p>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={t.enabled} onChange={(e) => setT({ ...t, enabled: e.target.checked })} /> Show text in this scene
      </label>
      <div>
        <Label>Text</Label>
        <Input maxLength={60} value={t.text} onChange={(e) => setT({ ...t, text: e.target.value })} placeholder="THE BEEF ESCALATED" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label>Style</Label>
          <Select value={t.style} onChange={(e) => setT({ ...t, style: e.target.value as typeof t.style })}>
            {["keyword", "key_phrase", "statement", "chapter_title", "statistic", "dramatic"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Placement</Label>
          <Select value={t.position} onChange={(e) => setT({ ...t, position: e.target.value as typeof t.position })}>
            {["center", "top", "bottom", "left", "right"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Animation</Label>
          <Select value={t.animation} onChange={(e) => setT({ ...t, animation: e.target.value as typeof t.animation })}>
            {["pop", "fade", "slide_up", "typewriter", "none"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Duration (s)</Label>
          <Input type="number" step={0.1} min={0.8} max={10} value={t.duration} onChange={(e) => setT({ ...t, duration: Number(e.target.value) })} />
        </div>
      </div>
      <div>
        <Label hint="seconds after scene start">Appears at</Label>
        <Input type="number" step={0.1} min={0} value={t.at} onChange={(e) => setT({ ...t, at: Number(e.target.value) })} />
      </div>
      <p className="text-[11px] text-muted">Font: Anton (bold display) · size follows the style.</p>
      <Button variant="primary" disabled={busy} onClick={() => onSave({ ...t, enabled: t.enabled && t.text.trim().length > 0 })}>
        {plan.textOverlay.enabled ? "Save text" : "Add Text"}
      </Button>
    </div>
  );
}

function SfxEditor({ plan, busy, onAdd, onRemove }: { plan: ScenePlan; busy: boolean; onAdd: (kind: string, at: number) => void; onRemove: (i: number) => void }) {
  const [kind, setKind] = useState("whoosh");
  const [at, setAt] = useState(0);
  return (
    <div className="space-y-2">
      <Label>Sound effects in {plan.sceneId}</Label>
      {plan.sfx.length ? (
        <ul className="space-y-1">
          {plan.sfx.map((s, i) => (
            <li key={i} className="flex items-center justify-between rounded bg-panel-2 px-2 py-1 text-xs">
              <span>
                {s.kind} @ {s.at.toFixed(1)}s <span className="text-muted">— {s.reason}</span>
              </span>
              <button className="text-muted hover:text-danger" disabled={busy} onClick={() => onRemove(i)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">None.</p>
      )}
      <div className="grid grid-cols-[1fr_80px_auto] gap-2">
        <Select value={kind} onChange={(e) => setKind(e.target.value)}>
          {SFX.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </Select>
        <Input type="number" step={0.1} min={0} value={at} onChange={(e) => setAt(Number(e.target.value))} />
        <Button size="sm" disabled={busy} onClick={() => onAdd(kind, at)}>
          Add SFX
        </Button>
      </div>
    </div>
  );
}

function AnnotationEditor({ clip, busy, onSave }: { clip: Clip; busy: boolean; onSave: (a: Clip["annotations"]) => void }) {
  const [kind, setKind] = useState<AnnotationKind>("red_circle");
  const [region, setRegion] = useState(Object.keys(REGIONS)[0]!);
  const [at, setAt] = useState(0.5);
  return (
    <div className="space-y-2 border-t border-line pt-3">
      <Label hint="drawn by the renderer">Annotations</Label>
      {clip.annotations.map((a, i) => (
        <div key={i} className="flex items-center justify-between rounded bg-panel-2 px-2 py-1 text-xs">
          <span>
            {a.kind.replace("_", " ")} @ {a.appearAt.toFixed(1)}s
          </span>
          <button className="text-muted hover:text-danger" disabled={busy} onClick={() => onSave(clip.annotations.filter((_, k) => k !== i))}>
            ✕
          </button>
        </div>
      ))}
      <div className="grid grid-cols-2 gap-2">
        <Select value={kind} onChange={(e) => setKind(e.target.value as AnnotationKind)}>
          {ANNOTATIONS.map((k) => (
            <option key={k} value={k}>
              {k.replace("_", " ")}
            </option>
          ))}
        </Select>
        <Select value={region} onChange={(e) => setRegion(e.target.value)}>
          {Object.keys(REGIONS).map((r) => (
            <option key={r}>{r}</option>
          ))}
        </Select>
      </div>
      <div className="flex gap-2">
        <Input type="number" step={0.1} min={0} value={at} onChange={(e) => setAt(Number(e.target.value))} />
        <Button size="sm" disabled={busy || clip.annotations.length >= 5} onClick={() => onSave([...clip.annotations, { kind, rect: REGIONS[region]!, appearAt: at }])}>
          Add
        </Button>
      </div>
    </div>
  );
}
