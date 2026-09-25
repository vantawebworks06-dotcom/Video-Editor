"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AutoEditPanel } from "@/components/AutoEditPanel";
import { api, Button, Input, Label, Panel, Select, Tag } from "@/components/ui";
import { STYLE_PRESETS } from "@/lib/domain/presets";

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  is_demo: boolean;
  updated_at: string;
  narration_duration: number | null;
}

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [name, setName] = useState("");
  const [preset, setPreset] = useState("documentary");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ projects: ProjectRow[] }>("/api/projects")
      .then((d) => setProjects(d.projects))
      .catch((e: Error) => setError(e.message));
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { id } = await api<{ id: string }>("/api/projects", { method: "POST", json: { name, stylePreset: preset } });
      router.push(`/projects/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const demo = async () => {
    setBusy(true);
    try {
      const { id } = await api<{ id: string }>("/api/projects/demo", { method: "POST" });
      router.push(`/projects/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-sm text-muted">Upload narration, and DocuCut researches, selects and edits the visuals.</p>
        </div>
        <Button onClick={demo} disabled={busy}>
          ▶ Try the demo project
        </Button>
      </div>

      <AutoEditPanel />

      {error && <p className="rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</p>}

      <Panel title="New project">
        <form onSubmit={create} className="grid grid-cols-[1fr_240px_auto] items-end gap-3">
          <div>
            <Label>Name</Label>
            <Input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. The Rise of Dancehall" />
          </div>
          <div>
            <Label>Style</Label>
            <Select value={preset} onChange={(e) => setPreset(e.target.value)}>
              {STYLE_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="primary" disabled={busy || !name.trim()}>
            Create
          </Button>
        </form>
      </Panel>

      <Panel title="Your projects">
        {!projects ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : !projects.length ? (
          <p className="text-sm text-muted">No projects yet. Create one above, or try the demo.</p>
        ) : (
          <ul className="divide-y divide-line">
            {projects.map((p) => (
              <li key={p.id}>
                <Link href={`/projects/${p.id}`} className="flex items-center justify-between py-3 hover:text-accent">
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    {p.is_demo && <Tag tone="accent">Demo</Tag>}
                  </span>
                  <span className="flex items-center gap-3 text-xs text-muted">
                    {p.narration_duration ? `${Math.round(Number(p.narration_duration))}s` : ""}
                    <Tag tone={p.status === "ready" ? "ok" : p.status === "error" ? "danger" : "default"}>{p.status}</Tag>
                    {new Date(p.updated_at).toLocaleString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
