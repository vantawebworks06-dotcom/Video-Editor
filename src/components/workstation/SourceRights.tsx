"use client";

import { useRef, useState } from "react";
import { api, Button, Label, Progress, RightsBadge, Select, Tag } from "@/components/ui";
import { uploadProjectFile } from "@/components/editor/upload";
import type { TranscriptAnalysis } from "@/lib/analysis/types";
import type { MediaItem, MediaStatus } from "@/lib/domain/media";
import type { RightsStatus } from "@/lib/domain/types";
import { fmtDur, StatusPill } from "./MediaLibrary";
import type { MediaState } from "./useMedia";

const PLATFORM_NOTE: Record<string, string> = {
  youtube: "YouTube's API terms forbid downloading or storing its video/audio. Preview it here via the official embed; to use footage, upload a copy you are authorised to use (e.g. licensed from the rights holder).",
  x: "Shown through X's official embed. A screenshot capture keeps the account, date and context visible.",
  reddit: "Public Reddit content via the official API. Capture a screenshot to use it on screen.",
  meta: "Facebook/Instagram content can only be embedded (oEmbed). Capture or upload a screenshot to use it.",
  brave: "A web result. Open the page to check its publisher and date; capture a screenshot to show it.",
  gdelt: "A news article indexed by GDELT. Open it to verify; capture a screenshot of the headline to show it.",
  wikipedia: "Wikipedia article — a starting point for research, not a primary source.",
};

/** Everything known about where an item came from, its rights, and the editor's decision. */
export function SourceRights({ projectId, item, media, analysis, onPreviewSegment }: { projectId: string; item: MediaItem | null; media: MediaState; analysis: TranscriptAnalysis | null; onPreviewSegment?: (it: MediaItem) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [notes, setNotes] = useState<{ id: string; rights: string; license: string } | null>(null);
  const [copyProgress, setCopyProgress] = useState<number | null>(null);
  const copyRef = useRef<HTMLInputElement>(null);

  if (!item) {
    return (
      <div className="space-y-2 p-4 text-sm text-muted">
        <p className="font-medium text-foreground">Source &amp; Rights</p>
        <p className="text-xs">Select an item to see its source, platform, account, dates, licence and your rights notes.</p>
      </div>
    );
  }
  const draft = notes?.id === item.id ? notes : { id: item.id, rights: item.rightsNotes ?? "", license: item.license ?? "" };
  const setStatus = async (status: MediaStatus) => {
    setBusy(true);
    await media.patch(item.id, { status });
    setBusy(false);
  };
  const saveNotes = async () => {
    setBusy(true);
    const r = await media.patch(item.id, { rightsNotes: draft.rights.trim() || null, license: draft.license.trim() || null });
    setMsg(r ? "Saved." : null);
    setBusy(false);
  };
  const uploadCopy = async (file: File | undefined) => {
    if (!file) return;
    setCopyProgress(0);
    setMsg(null);
    try {
      await uploadProjectFile(projectId, "media", file, {
        onProgress: setCopyProgress,
        meta: { title: `${item.title} (authorised copy)`, category: item.category === "social" || item.category === "article" ? "screenshot" : item.category, sentenceIdx: item.sentenceIdx, derivedFrom: item.id, rightsNotes: draft.rights || null },
      });
      setMsg("Copy uploaded. It appears in the library (USER UPLOADS) linked to this source; the worker is measuring it.");
      await media.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
    setCopyProgress(null);
  };
  const sentence = item.sentenceIdx !== null ? analysis?.sentences[item.sentenceIdx] : null;
  const derived = media.items.filter((x) => x.derivedFrom === item.id);
  const parent = item.derivedFrom ? media.items.find((x) => x.id === item.derivedFrom) : null;
  const isFile = item.provider === "upload" || item.provider === "capture";

  return (
    <div className="space-y-4 p-3 text-sm">
      <Preview item={item} />
      <div>
        <div className="mb-1 flex items-center gap-2">
          <StatusPill status={item.status} />
          <Tag>{item.category}</Tag>
          {item.asset ? <RightsBadge status={item.asset.rightsStatus as RightsStatus} /> : <Tag>reference only</Tag>}
          {item.usage > 0 && <Tag tone="ok">used {item.usage}×</Tag>}
        </div>
        <h3 className="font-semibold leading-snug">{item.title}</h3>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {item.status !== "APPROVED" && item.status !== "USED" && (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void setStatus("APPROVED")}>
            Approve
          </Button>
        )}
        {item.status !== "REVIEW" && item.status !== "USED" && (
          <Button size="sm" disabled={busy} onClick={() => void setStatus("REVIEW")}>
            Mark for review
          </Button>
        )}
        {item.status !== "REJECTED" && item.usage === 0 && (
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void setStatus("REJECTED")}>
            Reject
          </Button>
        )}
        {item.sourceUrl && (
          <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener" className="inline-flex h-7 items-center rounded-md border border-line px-2.5 text-xs hover:bg-panel-2">
            Open source ↗
          </a>
        )}
        {Boolean(item.metadata.capturable) && (
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/api/projects/${projectId}/media/${item.id}/capture`, { method: "POST", json: { theme: "light" } });
                setMsg("Capture queued — the screenshot appears in the library (SCREENSHOTS) when the worker finishes.");
              } catch (e) {
                setMsg((e as Error).message);
              }
              setBusy(false);
            }}
          >
            Capture screenshot
          </Button>
        )}
        {item.segment && onPreviewSegment && (
          <Button size="sm" onClick={() => onPreviewSegment(item)}>
            Preview segment
          </Button>
        )}
      </div>
      {msg && <p className="rounded border border-line bg-panel-2 p-2 text-xs">{msg}</p>}
      {PLATFORM_NOTE[item.provider] && <p className="rounded border border-line bg-panel-2 p-2 text-[11px] leading-snug text-muted">{PLATFORM_NOTE[item.provider]}</p>}

      <section>
        <h4 className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted">SOURCE</h4>
        <dl className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-1 text-xs">
          <Field k="Platform" v={item.platform ?? item.provider} />
          <Field k="Account / channel" v={item.account} href={item.accountUrl} />
          <Field k="Source URL" v={item.sourceUrl} href={item.sourceUrl} mono />
          <Field k="Published" v={item.publishedAt ? new Date(item.publishedAt).toLocaleString() : null} />
          <Field k="Found" v={new Date(item.foundAt).toLocaleString()} />
          <Field k="Imported" v={item.importedAt ? new Date(item.importedAt).toLocaleString() : null} />
          <Field k="Duration" v={item.duration ? fmtDur(item.duration) : null} />
          <Field k="Search query" v={item.query} />
          <Field k="Licence" v={item.license} />
          {parent && <Field k="Copy of" v={parent.title} />}
        </dl>
        {item.excerpt && (
          <blockquote className="mt-2 border-l-2 border-line pl-2 text-xs leading-relaxed text-muted">
            {item.excerpt}
          </blockquote>
        )}
      </section>

      <section>
        <h4 className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted">LINKED NARRATION</h4>
        <Select
          value={item.sentenceIdx ?? ""}
          onChange={(e) => void media.patch(item.id, { sentenceIdx: e.target.value === "" ? null : Number(e.target.value) })}
          className="text-xs"
        >
          <option value="">Not linked to a sentence</option>
          {analysis?.sentences.map((s) => (
            <option key={s.idx} value={s.idx}>
              #{s.idx + 1} · {s.text.slice(0, 70)}
            </option>
          ))}
        </Select>
        {sentence && <p className="mt-1 text-xs italic text-muted">“{sentence.text}”</p>}
      </section>

      {item.relevance && (
        <section>
          <h4 className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted">WHY IT WAS SUGGESTED</h4>
          <p className="mb-1 text-[11px] text-muted">Relevance {Math.round(item.relevance.score)}/100 — an estimate from matching names, topic, dates and source; not a verification of the content.</p>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted">
            {item.relevance.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h4 className="text-[11px] font-semibold tracking-wide text-muted">RIGHTS</h4>
        {isFile && (
          <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" className="mt-0.5" checked={Boolean(item.metadata.rightsConfirmed)} onChange={(e) => void media.patch(item.id, { rightsConfirmed: e.target.checked, rightsNotes: draft.rights || null })} />
            <span>I own this file or have permission/a licence to use it. (Unticked, it stays “needs review” and only renders when review assets are allowed.)</span>
          </label>
        )}
        <div>
          <Label>Licence</Label>
          <input value={draft.license} onChange={(e) => setNotes({ ...draft, license: e.target.value })} placeholder="e.g. Licensed from …, CC BY 4.0, Fair use (commentary)" className="h-8 w-full rounded border border-line bg-background px-2 text-xs outline-none focus:border-accent" />
        </div>
        <div>
          <Label>Rights notes</Label>
          <textarea value={draft.rights} onChange={(e) => setNotes({ ...draft, rights: e.target.value })} rows={3} placeholder="Who granted permission, when, conditions, credit line…" className="w-full rounded border border-line bg-background p-2 text-xs outline-none focus:border-accent" />
        </div>
        <Button size="sm" disabled={busy || (draft.rights === (item.rightsNotes ?? "") && draft.license === (item.license ?? ""))} onClick={() => void saveNotes()}>
          Save rights notes
        </Button>
      </section>

      {!item.assetId && (item.category === "video" || item.category === "interview" || item.category === "social" || item.category === "article" || item.category === "web" || item.category === "document") && (
        <section className="space-y-2 rounded-md border border-line p-2.5">
          <h4 className="text-[11px] font-semibold tracking-wide text-muted">USE ON THE TIMELINE</h4>
          <p className="text-xs text-muted">This is a reference: DocuCut does not download it from {item.platform ?? "the platform"}. Upload a copy you are authorised to use (the file, or a screenshot) and it is linked back to this source.</p>
          <Button size="sm" onClick={() => copyRef.current?.click()} disabled={copyProgress !== null}>
            Upload authorised copy / screenshot
          </Button>
          <input ref={copyRef} type="file" className="hidden" accept=".mp4,.mov,.webm,.jpg,.jpeg,.png,.webp,.gif,.mp3,.wav,.m4a" onChange={(e) => void uploadCopy(e.target.files?.[0])} />
          {copyProgress !== null && <Progress value={copyProgress} />}
          {derived.length > 0 && <p className="text-xs text-ok">{derived.length} authorised cop{derived.length === 1 ? "y" : "ies"} in the library.</p>}
        </section>
      )}

      {item.usage === 0 && (
        <button
          className="text-xs text-danger hover:underline"
          onClick={() => {
            if (confirm(`Remove “${item.title}” from this project?${isFile ? " The uploaded file is deleted." : ""}`)) void media.remove(item.id);
          }}
        >
          Remove from project
        </button>
      )}
    </div>
  );
}

function Field({ k, v, href, mono }: { k: string; v: string | null | undefined; href?: string | null; mono?: boolean }) {
  if (!v) return null;
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className={mono ? "break-all font-mono text-[10px]" : "break-words"}>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer noopener" className="text-info hover:underline">
            {v}
          </a>
        ) : (
          v
        )}
      </dd>
    </>
  );
}

/** Official embeds for references, the file itself for uploads/captures, else the thumbnail. */
export function Preview({ item, start }: { item: MediaItem; start?: number }) {
  const e = item.embed;
  if (e?.kind === "youtube") {
    const s = Math.floor(start ?? item.segment?.start ?? 0);
    return (
      <div className="aspect-video w-full overflow-hidden rounded-md border border-line bg-black">
        <iframe
          key={`${e.videoId}:${s}`}
          src={`https://www.youtube-nocookie.com/embed/${e.videoId}?start=${s}&rel=0`}
          title={item.title}
          className="h-full w-full"
          allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    );
  }
  if (e?.kind === "x") {
    return (
      <div className="h-[420px] w-full overflow-hidden rounded-md border border-line bg-white">
        <iframe src={`https://platform.twitter.com/embed/Tweet.html?id=${e.postId}&dnt=true`} title={item.title} className="h-full w-full" sandbox="allow-scripts allow-same-origin allow-popups" />
      </div>
    );
  }
  if (e?.kind === "iframe") {
    return (
      <div className="aspect-video w-full overflow-hidden rounded-md border border-line bg-black">
        <iframe src={e.src} title={item.title} className="h-full w-full" sandbox="allow-scripts allow-same-origin allow-popups" />
      </div>
    );
  }
  if (item.fileUrl && item.asset?.type === "video") {
    return <video src={item.fileUrl} controls preload="metadata" className="aspect-video w-full rounded-md border border-line bg-black" />;
  }
  if (item.fileUrl && (item.category === "audio" || item.category === "music")) {
    return <audio src={item.fileUrl} controls className="w-full" />;
  }
  const img = item.fileUrl && (item.asset?.type === "photo" || item.asset?.type === "gif") ? item.fileUrl : item.thumbnailUrl;
  if (!img) return null;
  // eslint-disable-next-line @next/next/no-img-element -- remote/storage thumbnails
  return <img src={img} alt="" className="max-h-72 w-full rounded-md border border-line bg-black object-contain" />;
}
