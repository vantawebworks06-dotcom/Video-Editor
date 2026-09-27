"use client";

import { useMemo, useRef, useState } from "react";
import { Button, cx, Progress, RightsBadge, Select, Tag } from "@/components/ui";
import { uploadProjectFile } from "@/components/editor/upload";
import type { TranscriptAnalysis } from "@/lib/analysis/types";
import { LIBRARY_TABS, type MediaCategory, type MediaItem, type MediaStatus } from "@/lib/domain/media";
import type { RightsStatus } from "@/lib/domain/types";
import { stillThumbnail } from "@/lib/media/thumbnails";
import { MEDIA_DRAG_TYPE, type MediaState } from "./useMedia";

export const STATUS_STYLE: Record<MediaStatus, string> = {
  DISCOVERED: "bg-panel-2 text-muted border-line",
  REVIEW: "bg-accent/15 text-accent border-accent/30",
  APPROVED: "bg-ok/15 text-ok border-ok/30",
  REJECTED: "bg-danger/15 text-danger border-danger/30",
  USED: "bg-info/15 text-info border-info/30",
};

export const CATEGORY_ICON: Record<MediaCategory, string> = {
  video: "▶",
  photo: "▣",
  social: "💬",
  article: "📰",
  screenshot: "⧉",
  interview: "🎙",
  audio: "♪",
  music: "♫",
  document: "📄",
  web: "🌐",
};

export function StatusPill({ status }: { status: MediaStatus }) {
  return <span className={cx("inline-flex h-5 items-center rounded border px-1.5 text-[10px] font-semibold tracking-wide", STATUS_STYLE[status])}>{status}</span>;
}

const ACCEPT = ".jpg,.jpeg,.png,.webp,.gif,.mp4,.mov,.webm,.mp3,.wav,.m4a,.aac,.ogg,.flac";

/** Project media library: every discovered, captured, imported and uploaded item. */
export function MediaLibrary({
  projectId,
  media,
  analysis,
  selected,
  onSelect,
  uploadSentence,
}: {
  projectId: string;
  media: MediaState;
  analysis: TranscriptAnalysis | null;
  selected: string | null;
  onSelect: (item: MediaItem) => void;
  /** Sentence new uploads are linked to (the one selected in the transcript), if any. */
  uploadSentence: number | null;
}) {
  const [tab, setTab] = useState("all");
  const [statuses, setStatuses] = useState<Set<MediaStatus>>(new Set(["DISCOVERED", "REVIEW", "APPROVED", "USED"]));
  const [q, setQ] = useState("");
  const [uploads, setUploads] = useState<{ id: string; name: string; progress: number; error?: string }[]>([]);
  const [category, setCategory] = useState<"auto" | MediaCategory>("auto");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const t = LIBRARY_TABS.find((x) => x.id === tab)!;
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const x of LIBRARY_TABS) c[x.id] = media.items.filter((it) => (x.categories ? x.categories.includes(it.category) : x.provider ? it.provider === x.provider : true)).length;
    return c;
  }, [media.items]);
  const shown = media.items.filter(
    (it) =>
      (t.categories ? t.categories.includes(it.category) : t.provider ? it.provider === t.provider : true) &&
      statuses.has(it.status) &&
      (!q.trim() || `${it.title} ${it.account ?? ""} ${it.platform ?? ""} ${it.description ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())),
  );

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    const queued = list.map((file) => ({ id: crypto.randomUUID(), name: file.name, progress: 0 }));
    setUploads((u) => [...u, ...queued]);
    for (const [k, file] of list.entries()) {
      const id = queued[k]!.id;
      try {
        await uploadProjectFile(projectId, "media", file, {
          onProgress: (p) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: p } : x))),
          meta: { category: category === "auto" ? undefined : category, sentenceIdx: uploadSentence, rightsConfirmed },
        });
        setUploads((u) => u.filter((x) => x.id !== id));
        await media.reload();
      } catch (e) {
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, error: (e as Error).message } : x)));
      }
    }
  };

  return (
    <div
      className={cx("flex h-full min-h-0 flex-col", dragOver && "ring-2 ring-inset ring-accent")}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragOver(false);
        void upload(e.dataTransfer.files);
      }}
    >
      <div className="flex flex-wrap items-center gap-1 border-b border-line bg-panel px-2 py-1.5">
        {LIBRARY_TABS.map((x) => (
          <button key={x.id} onClick={() => setTab(x.id)} className={cx("rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide", tab === x.id ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground")}>
            {x.label} <span className="font-normal opacity-70">{counts[x.id] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs">
        {(["DISCOVERED", "REVIEW", "APPROVED", "USED", "REJECTED"] as MediaStatus[]).map((s) => (
          <label key={s} className="flex cursor-pointer items-center gap-1">
            <input
              type="checkbox"
              checked={statuses.has(s)}
              onChange={(e) => {
                const n = new Set(statuses);
                if (e.target.checked) n.add(s);
                else n.delete(s);
                setStatuses(n);
              }}
            />
            <StatusPill status={s} />
          </label>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, account, platform…" className="ml-auto h-7 w-56 rounded border border-line bg-background px-2 outline-none focus:border-accent" />
      </div>
      <div className="flex items-center gap-2 border-b border-line bg-panel-2/40 px-3 py-2 text-xs">
        <Button size="sm" variant="primary" onClick={() => fileRef.current?.click()}>
          Upload media
        </Button>
        <input ref={fileRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => e.target.files && void upload(e.target.files)} />
        <span className="text-muted">or drop files here · as</span>
        <Select className="h-7 w-32 text-xs" value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
          <option value="auto">auto type</option>
          {(["video", "photo", "interview", "screenshot", "document", "audio", "music", "social", "article"] as MediaCategory[]).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-1" title="Tick only if you own the file or have a licence/permission to use it. Otherwise it is marked for rights review.">
          <input type="checkbox" checked={rightsConfirmed} onChange={(e) => setRightsConfirmed(e.target.checked)} />I hold the rights
        </label>
        {uploadSentence !== null && <Tag>linked to sentence {uploadSentence + 1}</Tag>}
      </div>
      {uploads.length > 0 && (
        <div className="space-y-1 border-b border-line px-3 py-2 text-xs">
          {uploads.map((u) => (
            <div key={u.id} className="flex items-center gap-2">
              <span className="w-48 truncate">{u.name}</span>
              {u.error ? (
                <>
                  <span className="flex-1 text-danger">{u.error}</span>
                  <button className="text-muted hover:text-foreground" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}>
                    dismiss
                  </button>
                </>
              ) : (
                <>
                  <Progress value={u.progress} />
                  <span className="w-20 shrink-0 text-muted">{u.progress >= 1 ? "checking…" : `${Math.round(u.progress * 100)}%`}</span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {media.error && <p className="border-b border-line px-3 py-1.5 text-xs text-danger">{media.error}</p>}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {media.loading ? (
          <p className="text-sm text-muted">Loading media…</p>
        ) : !shown.length ? (
          <div className="mx-auto mt-10 max-w-md space-y-2 text-center text-sm text-muted">
            <p className="text-foreground">{media.items.length ? "Nothing matches these filters." : "The media library is empty."}</p>
            <p>Research a sentence (RESEARCH section) to discover material, or upload your own photos, footage, screenshots, audio and music.</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
            {shown.map((it) => (
              <MediaCard key={it.id} item={it} analysis={analysis} selected={selected === it.id} onSelect={() => onSelect(it)} onStatus={(s) => void media.patch(it.id, { status: s })} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MediaCard({ item: it, analysis, selected, onSelect, onStatus }: { item: MediaItem; analysis: TranscriptAnalysis | null; selected: boolean; onSelect: () => void; onStatus: (s: MediaStatus) => void }) {
  const sentence = it.sentenceIdx !== null ? analysis?.sentences[it.sentenceIdx] : null;
  // Stock/archive files are downloaded from the library on first placement.
  const placeable = Boolean(it.assetId) || it.metadata.importable === "file";
  const date = it.publishedAt ?? it.importedAt ?? it.foundAt;
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={placeable}
      onDragStart={(e) => {
        e.dataTransfer.setData(MEDIA_DRAG_TYPE, it.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
      title={placeable ? "Drag onto the timeline to place it" : "Reference only — preview/embed; provide an authorised copy to use it on the timeline"}
      className={cx("group overflow-hidden rounded-lg border bg-panel text-left transition-colors", selected ? "border-accent ring-1 ring-accent" : "border-line hover:border-muted", it.status === "REJECTED" && "opacity-50")}
    >
      <div className="relative aspect-video bg-panel-2">
        {it.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- remote thumbnails from many hosts
          <img src={stillThumbnail(it.thumbnailUrl)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-3xl opacity-40">{CATEGORY_ICON[it.category]}</span>
        )}
        <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">{it.category}</span>
        <span className="absolute right-1.5 top-1.5 rounded bg-black/80">
          <StatusPill status={it.status} />
        </span>
        {it.duration ? <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1 text-[10px] text-white">{fmtDur(it.duration)}</span> : null}
        {!placeable && <span className="absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1 text-[9px] text-white/80">reference only</span>}
      </div>
      <div className="space-y-1 p-2 text-[11px]">
        <div className="line-clamp-2 text-xs font-medium leading-snug">{it.title}</div>
        <div className="truncate text-muted">
          {it.platform ?? it.provider}
          {it.account ? ` · ${it.account}` : ""}
        </div>
        <div className="flex items-center gap-1.5 text-muted">
          <span>{date ? new Date(date).toLocaleDateString() : ""}</span>
          {it.usage > 0 && <Tag tone="ok">used {it.usage}×</Tag>}
          {it.asset && (
            <span className="flex items-center gap-1" title="Licence status of the file (separate from your approval)">
              rights <RightsBadge status={it.asset.rightsStatus as RightsStatus} />
            </span>
          )}
        </div>
        {sentence && <div className="line-clamp-1 text-muted">↳ #{sentence.idx + 1} “{sentence.text}”</div>}
        <div className="flex gap-1 pt-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {it.status !== "APPROVED" && it.status !== "USED" && (
            <Button size="sm" onClick={(e) => (e.stopPropagation(), onStatus("APPROVED"))}>
              Approve
            </Button>
          )}
          {it.status !== "REJECTED" && it.usage === 0 && (
            <Button size="sm" variant="ghost" onClick={(e) => (e.stopPropagation(), onStatus("REJECTED"))}>
              Reject
            </Button>
          )}
          {it.status === "REJECTED" && (
            <Button size="sm" variant="ghost" onClick={(e) => (e.stopPropagation(), onStatus("REVIEW"))}>
              Restore
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function fmtDur(s: number) {
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m % 60).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
