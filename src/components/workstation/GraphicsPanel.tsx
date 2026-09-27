"use client";

import { useState } from "react";
import { api, Button, cx, Select } from "@/components/ui";
import type { PlayheadStore } from "@/components/editor/playhead";
import { DEFAULT_DURATION, GRAPHIC_FIELDS, GRAPHIC_KIND_LABEL, GraphicAnimation, type Graphic, type GraphicKind, GraphicPosition, type GraphicsStyle, GraphicTheme, THEMES } from "@/lib/domain/graphics";
import type { ScenePlan } from "@/lib/domain/types";

type Draft = Omit<Graphic, "id">;

/** Designed graphics: project style, suggestions from the script, and the scene's graphics. */
export function GraphicsPanel({
  projectId,
  plan,
  style,
  playhead,
  busy,
  run,
}: {
  projectId: string;
  plan: ScenePlan | null;
  style: GraphicsStyle;
  playhead: PlayheadStore;
  busy: boolean;
  /** Runs an API call with the Inspector's busy/refresh handling. */
  run: (fn: () => Promise<unknown>, done?: string) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [suggested, setSuggested] = useState<string | null>(null);
  const sceneAction = (json: Record<string, unknown>, done: string) => run(() => api(`/api/projects/${projectId}/scenes/${plan!.sceneId}`, { method: "POST", json }), done);
  const saveStyle = (s: Partial<GraphicsStyle>) => run(() => api(`/api/projects/${projectId}`, { method: "PATCH", json: { settings: { graphics: { ...style, ...s } } } }), "Graphics style saved");

  const startNew = (kind: GraphicKind) => {
    if (!plan) return;
    const rel = playhead.get() - plan.startTime;
    const at = rel >= 0 && rel < plan.endTime - plan.startTime - 0.5 ? Math.round(rel * 10) / 10 : 0.5;
    setEditing({ id: null, draft: { kind, title: "", sub: "", at, duration: DEFAULT_DURATION[kind], position: "auto", animation: "auto", source: "user" } });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-md border border-line bg-panel-2/50 p-2.5">
        <div className="text-[11px] font-semibold tracking-wide text-muted">GRAPHICS STYLE (WHOLE FILM)</div>
        <div className="grid grid-cols-[1fr_auto] items-center gap-2">
          <Select value={style.theme} disabled={busy} onChange={(e) => void saveStyle({ theme: e.target.value as GraphicsStyle["theme"] })}>
            {GraphicTheme.options.map((t) => (
              <option key={t} value={t}>
                {THEMES[t].label}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-1 text-[11px] text-muted" title="Accent colour (bars, numbers, lines)">
            <input type="color" value={style.accent ?? THEMES[style.theme].accent} disabled={busy} onChange={(e) => void saveStyle({ accent: e.target.value })} className="h-7 w-9 cursor-pointer rounded border border-line bg-transparent" />
            {style.accent && (
              <button className="text-muted hover:text-foreground" title="Use the theme's accent" onClick={() => void saveStyle({ accent: null })}>
                ↺
              </button>
            )}
          </label>
        </div>
        <label className="block text-[11px] text-muted">
          <span className="flex justify-between">
            <span>Size</span>
            <span className="text-foreground">{Math.round(style.scale * 100)}%</span>
          </span>
          <input type="range" min={0.6} max={1.5} step={0.05} defaultValue={style.scale} disabled={busy} onMouseUp={(e) => void saveStyle({ scale: Number(e.currentTarget.value) })} onKeyUp={(e) => void saveStyle({ scale: Number(e.currentTarget.value) })} className="w-full" />
        </label>
        <Button
          size="sm"
          disabled={busy}
          title="Names → lower thirds, places → location tags, years → date stamps, figures, quotes, headlines. Each person/place once; replaces earlier suggestions, keeps yours."
          onClick={() =>
            void run(async () => {
              const r = await api<{ added: number }>(`/api/projects/${projectId}/graphics/suggest`, { method: "POST", json: { replace: true } });
              setSuggested(r.added ? `${r.added} graphics suggested from the script (undo to remove).` : "No new graphic moments found in the script.");
            })
          }
        >
          Suggest graphics from script
        </Button>
        {suggested && <p className="text-[10px] text-muted">{suggested}</p>}
      </div>

      {!plan ? (
        <p className="text-xs text-muted">Select a scene to add or edit its graphics.</p>
      ) : (
        <>
          <div className="text-[11px] font-semibold tracking-wide text-muted">GRAPHICS IN {plan.sceneId.replace("scene_", "SCENE ")}</div>
          {(plan.graphics ?? []).length === 0 && !editing && <p className="text-[11px] text-muted">None yet.</p>}
          <ul className="space-y-1">
            {(plan.graphics ?? []).map((g) => (
              <li key={g.id} className={cx("flex items-center gap-2 rounded bg-panel-2 px-2 py-1 text-[11px]", editing?.id === g.id && "ring-1 ring-accent")}>
                <button className="min-w-0 flex-1 truncate text-left" onClick={() => setEditing({ id: g.id, draft: { ...g } })} title="Edit">
                  <span className="text-muted">{GRAPHIC_KIND_LABEL[g.kind].split(" (")[0]} · </span>
                  {g.title}
                  {g.source === "analysis" && <span className="ml-1 text-[9px] text-info">suggested</span>}
                </button>
                <span className="shrink-0 tabular-nums text-muted">{(plan.startTime + g.at).toFixed(1)}s</span>
                <button className="text-muted hover:text-danger" disabled={busy} title="Remove" onClick={() => void sceneAction({ action: "removeGraphic", id: g.id }, "Graphic removed")}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
          {editing ? (
            <GraphicForm
              key={editing.id ?? "new"}
              draft={editing.draft}
              isNew={!editing.id}
              busy={busy}
              sceneLength={plan.endTime - plan.startTime}
              onCancel={() => setEditing(null)}
              onSave={async (d) => {
                await (editing.id ? sceneAction({ action: "updateGraphic", id: editing.id, graphic: d }, "Graphic saved") : sceneAction({ action: "addGraphic", graphic: d }, "Graphic added"));
                setEditing(null);
              }}
            />
          ) : (
            <div>
              <div className="mb-1 text-[11px] text-muted">Add at the playhead</div>
              <div className="grid grid-cols-2 gap-1">
                {(Object.keys(GRAPHIC_KIND_LABEL) as GraphicKind[]).map((k) => (
                  <button key={k} disabled={busy} onClick={() => startNew(k)} className="rounded border border-line px-2 py-1.5 text-left text-[11px] text-muted hover:border-muted hover:text-foreground">
                    {GRAPHIC_KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GraphicForm({ draft, isNew, busy, sceneLength, onSave, onCancel }: { draft: Draft; isNew: boolean; busy: boolean; sceneLength: number; onSave: (d: Draft) => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(draft);
  const f = GRAPHIC_FIELDS[d.kind];
  const input = "h-8 w-full rounded border border-line bg-background px-2 text-xs outline-none focus:border-accent";
  const valid = d.title.trim().length > 0 && d.at < sceneLength;
  return (
    <div className="space-y-2 rounded-md border border-accent/40 bg-panel-2/60 p-2.5 text-[11px]">
      <div className="font-semibold">{isNew ? "New" : "Edit"} {GRAPHIC_KIND_LABEL[d.kind].toLowerCase()}</div>
      <label className="block text-muted">
        {f.title}
        <input className={input} maxLength={90} value={d.title} placeholder={f.example[0]} onChange={(e) => setD({ ...d, title: e.target.value })} autoFocus />
      </label>
      {f.sub && (
        <label className="block text-muted">
          {f.sub}
          <input className={input} maxLength={140} value={d.sub} placeholder={f.example[1]} onChange={(e) => setD({ ...d, sub: e.target.value })} />
        </label>
      )}
      <div className="grid grid-cols-2 gap-2">
        <label className="text-muted">
          Starts (s into scene)
          <input className={input} type="number" step={0.1} min={0} max={sceneLength} value={d.at} onChange={(e) => setD({ ...d, at: Number(e.target.value) })} />
        </label>
        <label className="text-muted">
          Duration (s)
          <input className={input} type="number" step={0.1} min={0.5} max={30} value={d.duration} onChange={(e) => setD({ ...d, duration: Number(e.target.value) })} />
        </label>
        <label className="text-muted">
          Position
          <Select value={d.position} onChange={(e) => setD({ ...d, position: e.target.value as Draft["position"] })}>
            {GraphicPosition.options.map((p) => (
              <option key={p} value={p}>
                {p === "auto" ? "auto (template)" : p.replace("_", " ")}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-muted">
          Animation
          <Select value={d.animation} onChange={(e) => setD({ ...d, animation: e.target.value as Draft["animation"] })}>
            {GraphicAnimation.options.map((a) => (
              <option key={a} value={a}>
                {a === "auto" ? "auto (template)" : a}
              </option>
            ))}
          </Select>
        </label>
        <label className="col-span-2 text-muted">
          Theme
          <Select value={d.theme ?? ""} onChange={(e) => setD({ ...d, theme: (e.target.value || undefined) as Draft["theme"] })}>
            <option value="">Film style</option>
            {GraphicTheme.options.map((t) => (
              <option key={t} value={t}>
                {THEMES[t].label}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {d.at >= sceneLength && <p className="text-danger">Must start inside the scene ({sceneLength.toFixed(1)} s long).</p>}
      <div className="flex gap-1.5">
        <Button size="sm" variant="primary" disabled={busy || !valid} onClick={() => onSave({ ...d, title: d.title.trim(), sub: d.sub.trim(), source: "user" })}>
          {isNew ? "Add graphic" : "Save"}
        </Button>
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
