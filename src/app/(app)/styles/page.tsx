"use client";

import { useEffect, useState } from "react";
import { api, Button, Input, Label, Panel, Select, Tag } from "@/components/ui";
import type { StylePreset } from "@/lib/domain/presets";
import type { StyleProfile } from "@/lib/domain/types";

interface SavedProfile {
  id: string;
  name: string;
  description: string | null;
  source: "custom" | "reference";
  profile: StyleProfile;
  metrics: (Record<string, unknown> & { method?: string; estimated?: string[]; notes?: string }) | null;
  created_at: string;
}

const EDITABLE: { key: keyof StyleProfile; label: string; step: number; max: number }[] = [
  { key: "averageShotDuration", label: "Average shot (s)", step: 0.1, max: 12 },
  { key: "minShotDuration", label: "Min shot (s)", step: 0.1, max: 6 },
  { key: "maxShotDuration", label: "Max shot (s)", step: 0.1, max: 15 },
  { key: "photoPercentage", label: "Photos %", step: 1, max: 100 },
  { key: "videoPercentage", label: "Video %", step: 1, max: 100 },
  { key: "archivalPercentage", label: "Archival %", step: 1, max: 100 },
  { key: "textEmphasisFrequency", label: "Text per scene", step: 0.01, max: 1 },
  { key: "memeFrequency", label: "Memes per scene", step: 0.01, max: 1 },
  { key: "blackAndWhiteFrequency", label: "B&W share", step: 0.01, max: 1 },
  { key: "paperLayoutFrequency", label: "Paper layouts", step: 0.01, max: 1 },
];

function Stats({ p }: { p: StyleProfile }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] text-muted">
      <span>Avg shot {p.averageShotDuration}s</span>
      <span>
        Photo/Video {p.photoPercentage}/{p.videoPercentage}%
      </span>
      <span>Archival {p.archivalPercentage}%</span>
      <span>Text {p.textEmphasisFrequency}</span>
      <span>Memes {p.memeFrequency}</span>
      <span>{p.transitionStyle.replace(/_/g, " ")}</span>
      <span>Density {p.visualDensity}</span>
      <span>Paper {p.paperLayoutFrequency}</span>
    </div>
  );
}

export default function StylesPage() {
  const [presets, setPresets] = useState<StylePreset[]>([]);
  const [profiles, setProfiles] = useState<SavedProfile[]>([]);
  const [base, setBase] = useState("documentary");
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<StyleProfile | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () =>
    api<{ presets: StylePreset[]; profiles: SavedProfile[] }>("/api/styles").then((d) => {
      setPresets(d.presets);
      setProfiles(d.profiles);
      setDraft((cur) => cur ?? { ...(d.presets.find((x) => x.key === "documentary") ?? d.presets[0]!).profile });
    });
  useEffect(() => {
    void load();
  }, []);
  const chooseBase = (key: string) => {
    setBase(key);
    const p = presets.find((x) => x.key === key);
    if (p) setDraft({ ...p.profile });
  };

  const save = async () => {
    if (!draft) return;
    try {
      await api("/api/styles", { method: "POST", json: { name, profile: draft } });
      setMsg("Saved. Apply it to a project from the list below.");
      setName("");
      void load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-bold">Styles</h1>
        <p className="text-sm text-muted">Presets shape pacing, media mix and effects. Reference videos (upload one in a project) become measured style profiles.</p>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        {presets.map((p) => (
          <div key={p.key} className="space-y-2 rounded-lg border border-line bg-panel p-3">
            <div className="font-semibold">{p.name}</div>
            <p className="text-xs text-muted">{p.description}</p>
            <Stats p={p.profile} />
          </div>
        ))}
      </div>

      <Panel title="Custom style">
        {msg && <p className="mb-3 text-xs text-accent">{msg}</p>}
        <div className="mb-3 grid grid-cols-[240px_1fr_auto] items-end gap-3">
          <div>
            <Label>Start from</Label>
            <Select value={base} onChange={(e) => chooseBase(e.target.value)}>
              {presets.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Name</Label>
            <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="My channel style" />
          </div>
          <Button variant="primary" disabled={!name.trim() || !draft} onClick={() => void save()}>
            Save style
          </Button>
        </div>
        {draft && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {EDITABLE.map((f) => (
              <div key={f.key}>
                <Label>{f.label}</Label>
                <Input type="number" step={f.step} min={0} max={f.max} value={draft[f.key] as number} onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })} />
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Your style profiles">
        {!profiles.length ? (
          <p className="text-sm text-muted">None yet. Save a custom style, or analyse a reference video in a project.</p>
        ) : (
          <ul className="space-y-3">
            {profiles.map((p) => (
              <li key={p.id} className="rounded-lg border border-line p-3">
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  <Tag tone={p.source === "reference" ? "accent" : "default"}>{p.source}</Tag>
                  <span className="text-[11px] text-muted">{new Date(p.created_at).toLocaleString()}</span>
                </div>
                <Stats p={p.profile} />
                {p.metrics && (
                  <p className="mt-1 text-[11px] text-muted">
                    Measured: {String(p.metrics.shotCount ?? "?")} shots, {String(p.metrics.cutsPerMinute ?? "?")} cuts/min · method {p.metrics.method}
                    {p.metrics.estimated?.length ? ` · estimated: ${p.metrics.estimated.join("; ")}` : ""}
                  </p>
                )}
                <ApplyToProject profileId={p.id} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function ApplyToProject({ profileId }: { profileId: string }) {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [target, setTarget] = useState("");
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    api<{ projects: { id: string; name: string }[] }>("/api/projects").then((d) => setProjects(d.projects));
  }, []);
  return (
    <div className="mt-2 flex items-center gap-2">
      <Select className="w-64" value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">Apply to project…</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      <Button
        size="sm"
        disabled={!target}
        onClick={async () => {
          await api(`/api/projects/${target}`, { method: "PATCH", json: { styleProfileId: profileId } });
          setDone("Applied — regenerate the project to use it.");
        }}
      >
        Apply
      </Button>
      {done && <span className="text-xs text-ok">{done}</span>}
    </div>
  );
}
