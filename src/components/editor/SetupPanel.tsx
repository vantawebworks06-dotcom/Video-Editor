"use client";

import { useState } from "react";
import { api, Button, Label, Progress, Select, Tag } from "@/components/ui";
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
  const [uploaded, setUploaded] = useState(0);

  const upload = async (kind: UploadKind, file: File | undefined) => {
    if (!file) return;
    setBusy(kind);
    setUploaded(0);
    setMsg(null);
    try {
      await uploadProjectFile(p.id, kind, file, { onProgress: setUploaded });
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
      <TopicFields key={`${s.topic}|${s.context}`} topic={s.topic} context={s.context} disabled={busy !== null} onSave={(v) => void save(v)} />
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
      {busy && busy !== "settings" && (
        <div className="space-y-1 text-xs text-muted">
          <p>{uploaded >= 1 ? `Checking ${busy}…` : `Uploading ${busy}… ${Math.round(uploaded * 100)}%`}</p>
          <Progress value={uploaded} />
        </div>
      )}

      <div className="space-y-3 border-t border-line pt-3">
        <EditingControls s={s} disabled={busy !== null} onSave={(v) => void save(v)} hasReference={p.hasReference} />
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
        <div>
          <Label hint="when the narration is a video">Your video&apos;s picture</Label>
          <Select value={s.originalFootage} disabled={busy !== null} onChange={(e) => void save({ originalFootage: e.target.value as ProjectSettings["originalFootage"] })}>
            <option value="replace">Replace with documentary visuals</option>
            <option value="mix">Mix: cut back to the speaker</option>
          </Select>
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

/** "What is this video about?" — required global context for the whole edit. Saved on blur. */
export function TopicFields({ topic, context, disabled, onSave }: { topic: string; context: string; disabled: boolean; onSave: (v: Partial<ProjectSettings>) => void }) {
  const [t, setT] = useState(topic);
  const [c, setC] = useState(context);
  return (
    <div className="space-y-2 rounded border border-accent/40 bg-accent/5 p-2.5">
      <Label hint="required">What is this video about?</Label>
      <textarea
        value={t}
        disabled={disabled}
        rows={4}
        maxLength={2000}
        placeholder="e.g. An in-depth documentary about the Gully Gaza rivalry in Jamaican dancehall, how it developed, the artists involved, the major events that escalated it, and how it affected Jamaican culture."
        className="w-full rounded border border-line bg-background p-2 text-xs"
        onChange={(e) => setT(e.target.value)}
        onBlur={() => t !== topic && onSave({ topic: t.trim() })}
      />
      {!t.trim() && <p className="text-[11px] text-danger">Required: every search, ranking and edit decision uses this as global context.</p>}
      <Label hint="optional">Additional context</Label>
      <textarea
        value={c}
        disabled={disabled}
        rows={2}
        maxLength={4000}
        placeholder="e.g. For a YouTube documentary audience. Focus on Jamaica, dancehall, the artists involved, the timeline and the cultural impact."
        className="w-full rounded border border-line bg-background p-2 text-xs"
        onChange={(e) => setC(e.target.value)}
        onBlur={() => c !== context && onSave({ context: c.trim() })}
      />
    </div>
  );
}

/** Editing controls with intelligent defaults ("auto" follows the reference video / style). */
function EditingControls({ s, disabled, onSave, hasReference }: { s: ProjectSettings; disabled: boolean; onSave: (v: Partial<ProjectSettings>) => void; hasReference: boolean }) {
  const opt = (values: string[], labels: Record<string, string> = {}) =>
    values.map((v) => (
      <option key={v} value={v}>
        {labels[v] ?? v[0]!.toUpperCase() + v.slice(1)}
      </option>
    ));
  const auto = hasReference ? "Auto (from reference)" : "Auto";
  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <Label>Pacing</Label>
        <Select value={s.pacing} disabled={disabled} onChange={(e) => onSave({ pacing: e.target.value as ProjectSettings["pacing"] })}>
          {opt(["auto", "slow", "normal", "fast", "dynamic"], { auto })}
        </Select>
      </div>
      <div>
        <Label>Visual intensity</Label>
        <Select value={s.visualIntensity} disabled={disabled} onChange={(e) => onSave({ visualIntensity: e.target.value as ProjectSettings["visualIntensity"] })}>
          {opt(["auto", "low", "medium", "high"], { auto })}
        </Select>
      </div>
      <div>
        <Label>Music</Label>
        <Select value={s.musicIntensity} disabled={disabled} onChange={(e) => onSave({ musicIntensity: e.target.value as ProjectSettings["musicIntensity"] })}>
          {opt(["auto", "minimal", "cinematic", "dynamic", "intense"], { auto })}
        </Select>
      </div>
      <div>
        <Label>Sound effects</Label>
        <Select value={s.sfxIntensity} disabled={disabled} onChange={(e) => onSave({ sfxIntensity: e.target.value as ProjectSettings["sfxIntensity"] })}>
          {opt(["auto", "off", "low", "medium", "high"], { auto })}
        </Select>
      </div>
    </div>
  );
}
