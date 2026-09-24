"use client";

import { useState } from "react";
import { api, Button, Label, Select, Tag } from "@/components/ui";
import { STYLE_PRESETS } from "@/lib/domain/presets";
import type { ProjectSettings, ProviderId } from "@/lib/domain/types";
import type { StatusData } from "./types";
import { type UploadKind, uploadProjectFile } from "./upload";

const PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: "pexels", label: "Pexels" },
  { id: "pixabay", label: "Pixabay" },
  { id: "wikimedia", label: "Wikimedia" },
  { id: "internet_archive", label: "Internet Archive" },
  { id: "giphy", label: "GIPHY" },
];

function FileRow({ kind, label, accept, has, disabled, onFile }: { kind: UploadKind; label: string; accept: string; has: boolean; disabled: boolean; onFile: (k: UploadKind, f: File | undefined) => void }) {
  return (
    <div>
      <Label>
        {label} {has ? <Tag tone="ok">uploaded</Tag> : null}
      </Label>
      <input type="file" accept={accept} disabled={disabled} className="w-full text-xs text-muted file:mr-2 file:rounded file:border-0 file:bg-panel-2 file:px-2 file:py-1 file:text-foreground" onChange={(e) => onFile(kind, e.target.files?.[0])} />
    </div>
  );
}

export function SetupPanel({ status, onChanged, onAnalyzeReference }: { status: StatusData; onChanged: () => void; onAnalyzeReference: () => void }) {
  const p = status.project;
  const s = p.settings;
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const upload = async (kind: UploadKind, file: File | undefined) => {
    if (!file) return;
    setBusy(kind);
    setMsg(null);
    try {
      await uploadProjectFile(p.id, kind, file);
      setMsg(`${kind} uploaded`);
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
    setBusy(null);
  };
  const save = async (settings: Partial<ProjectSettings>) => {
    setBusy("settings");
    try {
      await api(`/api/projects/${p.id}`, { method: "PATCH", json: { settings } });
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
    setBusy(null);
  };

  return (
    <div className="space-y-4 p-3 text-sm">
      {msg && <p className="rounded border border-line bg-panel-2 p-2 text-xs">{msg}</p>}
      {p.isDemo ? (
        <p className="rounded border border-accent/30 bg-accent/10 p-2 text-xs text-accent">Demo project: narration is the worker&apos;s generated TTS voice reading a fictional script.</p>
      ) : (
        <>
          <FileRow disabled={busy !== null} onFile={upload} kind="narration" label="Narration (audio or video)" accept=".mp3,.wav,.m4a,.aac,.ogg,.flac,.mp4,.mov,.webm" has={p.hasNarration} />
          <FileRow disabled={busy !== null} onFile={upload} kind="script" label="Script / transcript (.txt, optional)" accept=".txt" has={p.hasScript} />
          {!p.hasScript && <p className="text-[11px] text-muted">Without a script, transcription needs an OpenAI key (Settings).</p>}
        </>
      )}
      <FileRow disabled={busy !== null} onFile={upload} kind="reference" label="Reference video (optional)" accept=".mp4,.mov,.webm" has={p.hasReference} />
      {p.hasReference && (
        <Button size="sm" disabled={busy !== null} onClick={onAnalyzeReference}>
          Analyse reference style
        </Button>
      )}
      {busy && busy !== "settings" && <p className="text-xs text-muted">Uploading {busy}…</p>}

      <div className="space-y-3 border-t border-line pt-3">
        <div>
          <Label>Style preset</Label>
          <Select value={s.stylePreset} disabled={busy !== null} onChange={(e) => void save({ stylePreset: e.target.value })}>
            {STYLE_PRESETS.map((x) => (
              <option key={x.key} value={x.key}>
                {x.name}
              </option>
            ))}
          </Select>
          {p.styleProfileId && <p className="mt-1 text-[11px] text-accent">A custom/reference style profile is applied (see Styles).</p>}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>Memes</Label>
            <Select value={s.memeFrequency} onChange={(e) => void save({ memeFrequency: e.target.value as ProjectSettings["memeFrequency"] })}>
              {["OFF", "LOW", "MEDIUM", "HIGH"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Captions</Label>
            <Select value={s.captions} onChange={(e) => void save({ captions: e.target.value as ProjectSettings["captions"] })}>
              {["OFF", "STANDARD", "DYNAMIC"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Paper</Label>
            <Select value={s.paperStyle} onChange={(e) => void save({ paperStyle: e.target.value as ProjectSettings["paperStyle"] })}>
              {["white_paper", "crumpled_paper", "newspaper", "dark_paper", "corkboard", "document"].map((x) => (
                <option key={x} value={x}>
                  {x.replace("_", " ")}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>GIF rating</Label>
            <Select value={s.gifRating} onChange={(e) => void save({ gifRating: e.target.value as ProjectSettings["gifRating"] })}>
              {["g", "pg", "pg-13"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </Select>
          </div>
        </div>
        <div>
          <Label>Media providers</Label>
          <div className="flex flex-wrap gap-1.5">
            {PROVIDERS.map((x) => {
              const on = s.enabledProviders.includes(x.id);
              return (
                <button
                  key={x.id}
                  className={`h-6 rounded-full border px-2 text-[11px] ${on ? "border-accent bg-accent/15 text-accent" : "border-line text-muted"}`}
                  onClick={() => void save({ enabledProviders: on ? s.enabledProviders.filter((v) => v !== x.id) : [...s.enabledProviders, x.id] })}
                >
                  {x.label}
                </button>
              );
            })}
          </div>
        </div>
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" checked={s.budgetMode} onChange={(e) => void save({ budgetMode: e.target.checked })} />
          <span>
            Budget Mode <span className="text-muted">— fewer candidates and AI calls, text-only ranking, cheaper model</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" checked={s.allowReviewAssets} onChange={(e) => void save({ allowReviewAssets: e.target.checked })} />
          <span>
            Allow needs-review assets (e.g. GIPHY reactions) in auto edits <span className="text-muted">— they stay flagged in Asset Rights</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" checked={s.allowApprovedUnknown} onChange={(e) => void save({ allowApprovedUnknown: e.target.checked })} />
          <span>
            Render unknown-rights assets I have explicitly approved <span className="text-muted">— never auto-selected</span>
          </span>
        </label>
      </div>
    </div>
  );
}
