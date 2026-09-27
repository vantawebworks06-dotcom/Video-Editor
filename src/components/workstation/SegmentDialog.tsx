"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Tag } from "@/components/ui";
import type { MediaItem, SegmentSuggestion } from "@/lib/domain/media";
import { fmtDur } from "./MediaLibrary";
import { Preview } from "./SourceRights";

interface YTPlayer {
  getCurrentTime(): number;
  seekTo(s: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  destroy(): void;
}
declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: Record<string, unknown>) => YTPlayer };
    onYouTubeIframeAPIReady?: () => void;
  }
}

/** Load the official YouTube IFrame Player API once (it reports the playback time for in/out points). */
function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.onerror = () => reject(new Error("YouTube player failed to load"));
      document.head.appendChild(s);
    }
    setTimeout(() => (window.YT?.Player ? resolve() : reject(new Error("YouTube player timed out"))), 12000);
  });
}

const parseTime = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const parts = t.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  return parts.reduce((a, p) => a * 60 + p, 0);
};

/** Preview a source and choose (or confirm) the section of it that belongs to the sentence. */
export function SegmentDialog({ item, onClose, onSave }: { item: MediaItem; onClose: () => void; onSave: (segment: SegmentSuggestion, approve: boolean) => Promise<void> }) {
  const [inText, setInText] = useState(item.segment ? fmtDur(item.segment.start) : "");
  const [outText, setOutText] = useState(item.segment ? fmtDur(item.segment.end) : "");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const ytHost = useRef<HTMLDivElement>(null);
  const yt = useRef<YTPlayer | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const isYouTube = item.embed?.kind === "youtube";
  // The YouTube player API or the local <video> can report the playback time.
  const canReadTime = isYouTube ? !playerError : item.asset?.type === "video";
  const chapters = (item.metadata.chapters as { start: number; title: string }[] | undefined) ?? [];

  useEffect(() => {
    if (item.embed?.kind !== "youtube" || !ytHost.current) return;
    let cancelled = false;
    const videoId = item.embed.videoId;
    loadYouTubeApi()
      .then(() => {
        if (cancelled || !ytHost.current || !window.YT) return;
        yt.current = new window.YT.Player(ytHost.current, {
          videoId,
          host: "https://www.youtube-nocookie.com",
          playerVars: { start: Math.floor(item.segment?.start ?? 0), rel: 0, modestbranding: 1 },
          width: "100%",
          height: "100%",
        });
      })
      .catch((e: Error) => setPlayerError(e.message));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKey);
      yt.current?.destroy();
      yt.current = null;
    };
  }, [item.embed, item.segment?.start, onClose]);

  const now = (): number | null => {
    if (yt.current) return Math.round(yt.current.getCurrentTime() * 10) / 10;
    if (video.current) return Math.round(video.current.currentTime * 10) / 10;
    return null;
  };
  const seek = (s: number) => {
    if (yt.current) {
      yt.current.seekTo(s, true);
      yt.current.playVideo();
    } else if (video.current) {
      video.current.currentTime = s;
      void video.current.play();
    }
  };

  const save = async (approve: boolean) => {
    const start = parseTime(inText);
    const end = parseTime(outText);
    if (start === null || end === null) return setMsg("Enter in and out times as m:ss (e.g. 6:42).");
    if (end <= start) return setMsg("The out point must be after the in point.");
    if (item.duration && end > item.duration + 1) return setMsg(`The video is only ${fmtDur(item.duration)} long.`);
    setBusy(true);
    await onSave({ start, end, basis: "user", confidence: 1, label: item.segment?.label ?? null, reason: "Chosen by you in the preview." }, approve);
    setBusy(false);
    setMsg(approve ? "Segment saved and item approved." : "Segment saved.");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{item.title}</h2>
          <Tag>{item.platform ?? item.provider}</Tag>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close (Esc)
          </Button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-[1fr_260px] overflow-auto">
          <div className="space-y-2 p-4">
            {isYouTube ? (
              <div className="aspect-video w-full overflow-hidden rounded-md border border-line bg-black">
                {playerError ? <Preview item={item} /> : <div ref={ytHost} className="h-full w-full" />}
              </div>
            ) : item.fileUrl && item.asset?.type === "video" ? (
              <video ref={video} src={item.fileUrl} controls className="aspect-video w-full rounded-md border border-line bg-black" />
            ) : (
              <Preview item={item} />
            )}
            {playerError && <p className="text-[11px] text-muted">{playerError} — showing the basic embed; type in/out times by hand.</p>}
            {item.description && <p className="line-clamp-4 whitespace-pre-line text-[11px] text-muted">{item.description}</p>}
          </div>
          <aside className="space-y-3 border-l border-line p-3 text-xs">
            {(isYouTube || item.asset?.type === "video") && (
              <section className="space-y-2">
                <h3 className="text-[11px] font-semibold tracking-wide text-muted">SEGMENT</h3>
                {item.segment && item.segment.basis !== "user" && (
                  <p className="rounded bg-panel-2 p-2 text-[11px] leading-snug text-muted">
                    Suggested {fmtDur(item.segment.start)}–{fmtDur(item.segment.end)} ({Math.round(item.segment.confidence * 100)}%): {item.segment.reason}
                  </p>
                )}
                {!item.segment && <p className="text-[11px] text-muted">No reliable timestamp information — play the video and set the in/out points yourself.</p>}
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="space-y-0.5">
                    <span className="text-muted">In</span>
                    <input value={inText} onChange={(e) => setInText(e.target.value)} placeholder="6:42" className="h-7 w-full rounded border border-line bg-background px-2 outline-none focus:border-accent" />
                  </label>
                  <label className="space-y-0.5">
                    <span className="text-muted">Out</span>
                    <input value={outText} onChange={(e) => setOutText(e.target.value)} placeholder="7:18" className="h-7 w-full rounded border border-line bg-background px-2 outline-none focus:border-accent" />
                  </label>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" onClick={() => now() !== null && setInText(fmtDur(now()!))} disabled={!canReadTime}>
                    Set in ◀ player
                  </Button>
                  <Button size="sm" onClick={() => now() !== null && setOutText(fmtDur(now()!))} disabled={!canReadTime}>
                    Set out ◀ player
                  </Button>
                  {parseTime(inText) !== null && (
                    <Button size="sm" variant="ghost" onClick={() => seek(parseTime(inText)!)}>
                      Play from in
                    </Button>
                  )}
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void save(true)}>
                    Use segment
                  </Button>
                  <Button size="sm" disabled={busy} onClick={() => void save(false)}>
                    Save only
                  </Button>
                </div>
                {msg && <p className="text-[11px] text-accent">{msg}</p>}
                {isYouTube && <p className="text-[10px] leading-snug text-muted">YouTube footage is never downloaded. The segment is recorded with the source; upload a copy you are authorised to use to put it on the timeline.</p>}
              </section>
            )}
            {chapters.length > 0 && (
              <section>
                <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-muted">CHAPTERS (from the uploader)</h3>
                <ul className="max-h-60 space-y-0.5 overflow-auto">
                  {chapters.map((c, i) => (
                    <li key={`${c.start}-${i}`}>
                      <button
                        className="w-full truncate rounded px-1 py-0.5 text-left hover:bg-panel-2"
                        onClick={() => {
                          setInText(fmtDur(c.start));
                          setOutText(fmtDur(chapters[i + 1]?.start ?? item.duration ?? c.start + 60));
                          seek(c.start);
                        }}
                      >
                        <span className="tabular-nums text-muted">{fmtDur(c.start)}</span> {c.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {item.sourceUrl && (
              <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener" className="inline-block text-info hover:underline">
                Open source ↗
              </a>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
