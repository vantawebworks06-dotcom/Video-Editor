"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { fmtTime } from "@/components/ui";
import type { Word } from "@/lib/domain/types";
import { cardContent } from "./Inspector";
import type { PlayheadStore } from "./playhead";
import type { Clip, EditData } from "./types";

// Providers whose previewUrl is a smaller MP4 rendition of the same video (see timelineBuilder).
const MP4_PREVIEWS = new Set(["pexels", "pixabay"]);
const VIDEO_FILE = /\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i;
const DRIFT = 0.35; // seconds the speaker's own footage may drift from the narration before a re-seek
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;

type Source = { kind: "video"; src: string; synced: boolean } | { kind: "image"; src: string; fallback: string | null } | { kind: "card" };

/** What the browser can show for a clip without the render pipeline. */
function sourceFor(c: Clip, narrationUrl: string): Source | null {
  const a = c.asset;
  // The user's own narration video plays in sync with the narration itself.
  if (a.provider === "uploaded") return { kind: "video", src: narrationUrl, synced: true };
  if (a.provider === "graphic") return { kind: "card" };
  if (a.type === "video") {
    if (MP4_PREVIEWS.has(a.provider) && a.previewUrl) return { kind: "video", src: a.previewUrl, synced: false };
    if (VIDEO_FILE.test(a.mediaUrl)) return { kind: "video", src: a.mediaUrl, synced: false };
    // e.g. Internet Archive items resolve their file at render time: show the still.
    return a.thumbnailUrl ? { kind: "image", src: a.thumbnailUrl, fallback: null } : null;
  }
  if (a.type === "gif" && a.previewUrl && VIDEO_FILE.test(a.previewUrl)) return { kind: "video", src: a.previewUrl, synced: false };
  return { kind: "image", src: a.mediaUrl, fallback: a.thumbnailUrl };
}

/** CSS approximation of the render's Ken Burns motion, `p` = 0…1 through the clip. */
function motionTransform(c: Clip, p: number): string | undefined {
  const k = c.motionIntensity || 0.08;
  const s = `scale(${1 + k})`;
  const d = (p - 0.5) * k * 100;
  switch (c.motion) {
    case "slow_zoom_in":
      return `scale(${1 + k * p})`;
    case "slow_zoom_out":
      return `scale(${1 + k * (1 - p)})`;
    case "pan_left":
      return `${s} translateX(${d}%)`;
    case "pan_right":
      return `${s} translateX(${-d}%)`;
    case "pan_up":
      return `${s} translateY(${d}%)`;
    case "pan_down":
      return `${s} translateY(${-d}%)`;
    case "diagonal":
      return `${s} translate(${-d}%, ${-d}%)`;
    case "subtle_rotation":
      return `${s} rotate(${(p - 0.5) * 2}deg)`;
    case "punch_in":
      return `scale(${1 + k * 1.5})`;
    default:
      return undefined;
  }
}

/** Index of the clip on screen at `t`: the latest-starting clip covering it (reactions sit on top). */
function clipIndexAt(clips: Clip[], t: number): number {
  let found = -1;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!;
    if (c.start > t) break;
    if (t < c.start + c.duration && (found < 0 || c.start >= clips[found]!.start)) found = i;
  }
  return found;
}

/** Short caption phrases (≤7 words, split on long pauses) from the word timings. */
function captionChunks(words: Word[]): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) out.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, text: cur.map((w) => w.word).join(" ") });
    cur = [];
  };
  for (const w of words) {
    if (cur.length && (cur.length >= 7 || w.start - cur[cur.length - 1]!.end > 0.6)) flush();
    cur.push(w);
  }
  flush();
  return out;
}

function ClipVisual({ clip, source, t, active, visible, playing }: { clip: Clip; source: Source; t: number; active: boolean; visible: boolean; playing: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [broken, setBroken] = useState(false);
  const placed = useRef<"on" | "off" | null>(null);
  const local = Math.max(0, t - clip.start);

  const synced = source.kind === "video" && source.synced;
  // Keep the clip's video on the narration clock; the next clip waits paused at its first frame.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (active && playing) {
      if (v.paused) void v.play().catch(() => {});
    } else if (!v.paused) v.pause();
    // Never seek a video that is still loading or seeking: re-seeking a remote file every frame
    // keeps it from ever playing. The `#t=` fragment on its src already starts it at trimStart.
    if (v.seeking || v.readyState < HAVE_CURRENT_DATA) return;
    if (synced) {
      // The speaker's own footage must stay lip-synced with the narration.
      if (Math.abs(v.currentTime - t) > (playing ? DRIFT : 0.1)) v.currentTime = t;
      return;
    }
    // Stock footage is seeked once when it goes on screen, then plays freely. Some CDNs (Pixabay)
    // answer range requests with 200, so Chrome can't seek them; correcting drift every frame
    // would then snap the video back to 0 forever and freeze the picture.
    const phase = active ? "on" : "off";
    if (placed.current === phase) return;
    placed.current = phase;
    const len = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : clip.asset.duration;
    let want = clip.trimStart + (active ? local : 0);
    if (len) want %= len;
    if (Math.abs(v.currentTime - want) > 0.1) v.currentTime = want;
  }, [t, local, active, playing, clip, synced]);

  const fit = clip.role === "meme" || clip.layout !== "fullscreen" ? "object-contain" : "object-cover";
  const style = {
    transform: active ? motionTransform(clip, Math.min(1, local / Math.max(clip.duration, 0.01))) : undefined,
    filter: clip.blackAndWhite ? "grayscale(1)" : undefined,
  };
  const cls = `absolute inset-0 h-full w-full ${fit}`;

  // Editorial transitions, approximated in CSS (the render uses FFmpeg; see render/segments.ts).
  const tr = active && clip.transitionIn && clip.transitionIn !== "hard_cut" ? clip.transitionIn : null;
  return (
    <div className={`absolute inset-0 overflow-hidden ${visible ? "" : "invisible"}`}>
      <div className={`absolute inset-0 ${tr ? `tr-in-${tr}` : ""}`}>
      {source.kind === "card" ? (
        <CardView asset={clip.asset} style={style} />
      ) : source.kind === "video" ? (
        <video ref={ref} src={synced ? source.src : `${source.src}#t=${clip.trimStart}`} poster={clip.asset.thumbnailUrl ?? undefined} muted playsInline loop={!synced} preload="auto" className={cls} style={style} />
      ) : broken && !source.fallback ? null : (
        // eslint-disable-next-line @next/next/no-img-element -- remote provider media, many hosts
        <img src={broken ? source.fallback! : source.src} alt="" decoding="async" className={cls} style={style} onError={() => setBroken(true)} />
      )}
      </div>
      {tr && <div className={`pointer-events-none absolute inset-0 tr-ov-${tr}`} />}
    </div>
  );
}

/** Designed text card (name / year / quote / headline), as the render draws it. */
function CardView({ asset, style }: { asset: Clip["asset"]; style: React.CSSProperties }) {
  const c = cardContent(asset);
  const light = c.kind === "quote" || c.kind === "year" || c.kind === "chapter";
  const big = c.kind === "year" || c.kind === "statistic" ? "text-[9cqw]" : c.text.length > 26 ? "text-[4cqw]" : "text-[6cqw]";
  return (
    <div className={`absolute inset-0 flex flex-col items-center justify-center px-[8%] text-center [container-type:size] ${light ? "bg-[#e9e2d3] text-[#1d1a14]" : "bg-[radial-gradient(circle_at_50%_40%,#2a2c31,#101113)] text-white"}`} style={style}>
      <div className={`font-[Anton,Impact,sans-serif] leading-tight tracking-wide ${big}`}>{c.text}</div>
      {c.sub && <div className="mt-[2%] text-[1.8cqw] uppercase tracking-widest opacity-75">{c.sub}</div>}
    </div>
  );
}

/**
 * Plays the current edit in the browser without rendering: the narration is the clock and each
 * clip's footage is shown in step with it. Music, transitions and layouts appear only in a render.
 */
export function LivePlayer({
  data,
  narrationUrl,
  captions,
  playhead,
  mediaRef,
}: {
  data: EditData;
  narrationUrl: string;
  captions: boolean;
  playhead: PlayheadStore;
  /** The editor seeks through this (timeline and scene-list clicks). */
  mediaRef: RefObject<HTMLMediaElement | null>;
}) {
  const [t, setT] = useState(() => playhead.get());
  const [playing, setPlaying] = useState(false);
  // Play was pressed but the narration has not buffered enough to start/continue.
  const [buffering, setBuffering] = useState(false);
  const [duration, setDuration] = useState(data.duration);
  const clips = useMemo(() => [...data.clips].sort((a, b) => a.start - b.start), [data.clips]);
  const sources = useMemo(() => new Map(clips.map((c) => [c.rowId, sourceFor(c, narrationUrl)])), [clips, narrationUrl]);
  const chunks = useMemo(() => (captions ? captionChunks(data.words) : []), [captions, data.words]);

  const lastPush = useRef(0);
  const sync = useCallback(() => {
    const a = mediaRef.current;
    if (!a) return;
    setT(a.currentTime);
    setBuffering(!a.paused && a.readyState < HAVE_FUTURE_DATA);
    const now = performance.now();
    if (now - lastPush.current > 100) {
      lastPush.current = now;
      playhead.set(a.currentTime);
    }
  }, [mediaRef, playhead]);

  // Smooth clock while playing; `timeupdate` alone fires only ~4×/s.
  useEffect(() => {
    if (!playing) return;
    let id = requestAnimationFrame(function frame() {
      sync();
      id = requestAnimationFrame(frame);
    });
    return () => cancelAnimationFrame(id);
  }, [playing, sync]);

  useEffect(() => {
    const a = mediaRef.current;
    if (a && Math.abs(a.currentTime - playhead.get()) > 0.05) a.currentTime = playhead.get();
    // Only on mount: pick up where the playhead was.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const idx = clipIndexAt(clips, t);
  // The clip on screen plus the next one (hidden, so its media is loaded before the cut).
  const nextIdx = idx < 0 ? clips.findIndex((c) => c.start > t) : idx + 1;
  const mounted = [idx, nextIdx].filter((i) => i >= 0 && i < clips.length).map((i) => clips[i]!);
  // In a gap before a clip (e.g. the very start), show the upcoming clip's first frame, not black.
  const shown = clips[idx >= 0 ? idx : nextIdx];
  const caption = chunks.find((c) => t >= c.start && t <= c.end + 0.3)?.text;

  const toggle = () => {
    const a = mediaRef.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => {});
    else a.pause();
  };
  const seekTo = (v: number) => {
    if (mediaRef.current) mediaRef.current.currentTime = v;
    playhead.set(v);
    setT(v);
  };

  return (
    <div className="flex h-full w-full max-w-5xl flex-col items-center justify-center gap-2">
      <div className="relative aspect-video max-h-[calc(100%-3.5rem)] w-full cursor-pointer overflow-hidden rounded bg-black" onClick={toggle}>
        {mounted.map((c) => {
          const s = sources.get(c.rowId);
          return s ? <ClipVisual key={c.rowId} clip={c} source={s} t={t} active={c === clips[idx]} visible={c === shown} playing={playing} /> : null;
        })}
        {idx >= 0 && !sources.get(clips[idx]!.rowId) && <div className="absolute inset-0 flex items-center justify-center text-xs text-muted">No preview for this clip</div>}
        {caption && (
          <div className="pointer-events-none absolute inset-x-0 bottom-[8%] flex justify-center px-6">
            <span className="rounded bg-black/70 px-3 py-1 text-center text-lg font-semibold text-white">{caption}</span>
          </div>
        )}
        {playing && buffering && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/40 text-sm text-white">
            <span className="h-10 w-10 animate-spin rounded-full border-4 border-white/30 border-t-white" />
            Loading…
          </div>
        )}
        {!playing && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-black/60 pl-1 text-3xl text-white">▶</span>
          </div>
        )}
      </div>
      <div className="flex w-full items-center gap-3 text-xs text-muted">
        <button onClick={toggle} className="w-8 text-lg text-foreground" aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="w-24 tabular-nums">
          {fmtTime(t)} / {fmtTime(duration)}
        </span>
        <input type="range" min={0} max={duration || 0} step={0.05} value={Math.min(t, duration)} onChange={(e) => seekTo(Number(e.target.value))} className="flex-1 accent-[var(--color-accent)]" />
        <span className="whitespace-nowrap">Live preview · music & transitions appear in the render</span>
      </div>
      <audio
        ref={mediaRef as RefObject<HTMLAudioElement>}
        src={narrationUrl}
        preload="auto"
        onPlay={() => {
          setPlaying(true);
          sync();
        }}
        onPause={() => {
          setPlaying(false);
          sync();
        }}
        onEnded={() => setPlaying(false)}
        onSeeked={sync}
        onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(Math.max(e.currentTarget.duration, data.duration))}
      />
    </div>
  );
}
