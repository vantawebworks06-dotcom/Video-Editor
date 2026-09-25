"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { uploadProjectFile } from "@/components/editor/upload";
import { api, Button, Label, Select } from "@/components/ui";
import { STYLE_PRESETS } from "@/lib/domain/presets";

const MAX_MB = 50; // Supabase free-plan upload limit (bucket file_size_limit)
const ACCEPT = ".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm";

/**
 * One-click flow: upload ONE narration video → the worker transcribes it, finds footage,
 * builds the timeline and renders a draft preview. The narration audio is the backbone.
 */
export function AutoEditPanel() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [style, setStyle] = useState("dancehall_documentary");
  const [memes, setMemes] = useState("LOW");
  const [footage, setFootage] = useState<"replace" | "mix">("replace");
  const [captions, setCaptions] = useState("OFF");
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = (f: File | undefined) => {
    setError(null);
    if (!f) return setFile(null);
    const ext = f.name.toLowerCase().split(".").pop();
    if (!["mp4", "mov", "webm"].includes(ext ?? "")) return setError("Please choose an MP4, MOV or WebM video.");
    if (f.size > MAX_MB * 1024 * 1024) {
      return setError(`This video is ${Math.round(f.size / 1024 / 1024)} MB. Uploads are limited to ${MAX_MB} MB on the current Supabase plan — export a smaller file (e.g. 720p) or upgrade the Storage limit.`);
    }
    setFile(f);
  };

  const start = async () => {
    if (!file) return;
    setError(null);
    try {
      setStep("Creating project…");
      const name = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 200) || "Auto-edit";
      const { id } = await api<{ id: string }>("/api/projects", {
        method: "POST",
        json: { name, stylePreset: style, memeFrequency: memes, captions, originalFootage: footage },
      });
      const mb = file.size / 1024 / 1024;
      setStep(`Uploading… 0% of ${mb.toFixed(1)} MB`);
      await uploadProjectFile(id, "narration", file, {
        onProgress: (f) => setStep(f >= 1 ? "Checking upload…" : `Uploading… ${Math.round(f * 100)}% of ${mb.toFixed(1)} MB`),
      });
      setStep("Starting analysis…");
      await api(`/api/projects/${id}/jobs`, { method: "POST", json: { type: "generate", autoRender: "draft" } });
      router.push(`/projects/${id}`);
    } catch (e) {
      setError((e as Error).message);
      setStep(null);
    }
  };

  return (
    <section className="rounded-xl border border-accent/40 bg-gradient-to-br from-accent/10 to-transparent p-6">
      <div className="mb-4">
        <h2 className="text-xl font-bold">Auto-Edit My Video</h2>
        <p className="text-sm text-muted">
          Upload one video with your narration. DocuCut transcribes it, finds real footage, photos, articles and reaction GIFs, builds a documentary edit around your voice and renders a preview you can review.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-[1fr_auto]">
        <label
          className="flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-line bg-panel px-4 text-center hover:border-accent"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            choose(e.dataTransfer.files?.[0]);
          }}
        >
          <input type="file" accept={ACCEPT} className="hidden" disabled={step !== null} onChange={(e) => choose(e.target.files?.[0])} />
          {file ? (
            <>
              <span className="font-medium">{file.name}</span>
              <span className="text-xs text-muted">{(file.size / 1024 / 1024).toFixed(1)} MB · click to change</span>
            </>
          ) : (
            <>
              <span className="font-medium">Drop your narration video here, or click to choose</span>
              <span className="text-xs text-muted">MP4, MOV or WebM · up to {MAX_MB} MB · talking head, blank background or existing footage</span>
            </>
          )}
        </label>
        <div className="grid w-full grid-cols-2 gap-3 md:w-80">
          <div className="col-span-2">
            <Label>Style</Label>
            <Select value={style} onChange={(e) => setStyle(e.target.value)}>
              {STYLE_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Meme frequency</Label>
            <Select value={memes} onChange={(e) => setMemes(e.target.value)}>
              {["OFF", "LOW", "MEDIUM", "HIGH"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Captions</Label>
            <Select value={captions} onChange={(e) => setCaptions(e.target.value)}>
              {["OFF", "STANDARD", "DYNAMIC"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
          </div>
          <div className="col-span-2">
            <Label>Your video&apos;s picture</Label>
            <Select value={footage} onChange={(e) => setFootage(e.target.value as "replace" | "mix")}>
              <option value="replace">Replace it with documentary visuals</option>
              <option value="mix">Mix: cut back to me between B-roll</option>
            </Select>
          </div>
        </div>
      </div>
      {error && <p className="mt-3 rounded-md border border-danger/30 bg-danger/10 p-2 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" className="h-11 px-6 text-base" disabled={!file || step !== null} onClick={() => void start()}>
          {step ?? "AUTO-EDIT MY VIDEO"}
        </Button>
        <span className="text-xs text-muted">Your narration is never cut or re-timed. You can review every scene before the final render.</span>
      </div>
    </section>
  );
}
