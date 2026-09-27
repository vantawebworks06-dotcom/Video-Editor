"use client";

import { useEffect, useRef, useState } from "react";
import { api, Button, cx, Select, Tag } from "@/components/ui";
import type { AssetSuggestion, MediaCategory, SentenceAnalysis } from "@/lib/analysis/types";
import type { MediaItem } from "@/lib/domain/media";
import { stillThumbnail } from "@/lib/media/thumbnails";
import { relevanceLabel } from "@/lib/research/rank";
import type { ProviderOutcome } from "@/lib/research/types";
import { HighlightedSentence } from "./highlight";
import { CATEGORY_ICON, fmtDur, StatusPill } from "./MediaLibrary";
import { SegmentDialog } from "./SegmentDialog";
import type { MediaState } from "./useMedia";

export interface ProviderInfoView {
  id: string;
  name: string;
  categories: string[];
  state: "CONNECTED" | "NOT_CONNECTED" | "REQUIRES_CONFIGURATION" | "RATE_LIMITED" | "UNAVAILABLE";
  note: string;
  capabilities: { search: boolean; capture: boolean; import: string };
}

const CATEGORIES: MediaCategory[] = ["video", "interview", "photo", "social", "article", "document", "web"];

const OUTCOME_STYLE: Record<ProviderOutcome["state"], string> = {
  ok: "border-ok/40 text-ok",
  empty: "border-line text-muted",
  error: "border-danger/40 text-danger",
  skipped: "border-line text-muted opacity-70",
};

/** A pending search of one sentence; `null` query = the sentence's first suggestion. */
export interface ResearchRequestView {
  sentence: number;
  query: string | null;
  category: MediaCategory | null;
  nonce: number;
}

export function ResearchPanel({
  projectId,
  sentence,
  media,
  request,
  providers,
  onUse,
}: {
  projectId: string;
  sentence: SentenceAnalysis | null;
  media: MediaState;
  request: ResearchRequestView | null;
  providers: ProviderInfoView[];
  /** Place an approved item on the timeline at this sentence (wired to the timeline builder). */
  onUse?: (item: MediaItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<MediaCategory>("photo");
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [running, setRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<ProviderOutcome[] | null>(null);
  const [resultIds, setResultIds] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [preview, setPreview] = useState<MediaItem | null>(null);
  const [showRejected, setShowRejected] = useState(false);
  const [showWeak, setShowWeak] = useState(false);
  const [capturing, setCapturing] = useState<Set<string>>(new Set());
  const capture = async (it: MediaItem) => {
    setCapturing((c) => new Set(c).add(it.id));
    setError(null);
    try {
      await api(`/api/projects/${projectId}/media/${it.id}/capture`, { method: "POST", json: { theme: "light" } });
    } catch (e) {
      setError((e as Error).message);
    }
    setTimeout(() => setCapturing((c) => {
      const n = new Set(c);
      n.delete(it.id);
      return n;
    }), 4000);
  };

  // A new sentence (or a "Research this" request) resets the form to its first suggestion.
  const sKey = `${sentence?.idx ?? -1}:${request?.nonce ?? 0}`;
  const [loadedKey, setLoadedKey] = useState("");
  if (sentence && loadedKey !== sKey) {
    setLoadedKey(sKey);
    const g = (request && request.sentence === sentence.idx && request.query ? sentence.intent.suggestedAssets.find((x) => x.query === request.query) : null) ?? sentence.intent.suggestedAssets[0];
    setQuery(request?.sentence === sentence.idx && request.query ? request.query : (g?.query ?? sentence.intent.entities.slice(0, 2).join(" ")));
    setCategory((request?.sentence === sentence.idx && request.category) || g?.category || "photo");
    setChosen(null);
    setOutcomes(null);
    setResultIds(null);
    setError(null);
  }

  const run = async (q = query, cat = category, provs = chosen) => {
    if (!sentence) return;
    setRunning(true);
    setError(null);
    setOutcomes(null);
    try {
      const r = await api<{ outcomes: ProviderOutcome[]; items: MediaItem[]; providers: string[] }>(`/api/projects/${projectId}/research`, {
        method: "POST",
        json: { sentenceIdx: sentence.idx, query: q, category: cat, providers: provs ? [...provs] : undefined },
      });
      setOutcomes(r.outcomes);
      setResultIds(r.items.map((i) => i.id));
      if (!provs) setChosen(new Set(r.providers));
      await media.reload();
    } catch (e) {
      setError((e as Error).message);
    }
    setRunning(false);
  };

  // "Research this sentence" from the Script section starts the search right away.
  const autoKey = request && sentence && request.sentence === sentence.idx ? `${request.nonce}` : null;
  const autoRan = useRef<string | null>(null);
  useEffect(() => {
    if (!autoKey || autoRan.current === autoKey || loadedKey !== sKey) return;
    autoRan.current = autoKey;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per request
  }, [autoKey, loadedKey]);

  const addLink = async () => {
    if (!link.trim()) return;
    setLinkBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${projectId}/research/url`, { method: "POST", json: { url: link.trim(), sentenceIdx: sentence?.idx ?? null } });
      setLink("");
      await media.reload();
    } catch (e) {
      setError((e as Error).message);
    }
    setLinkBusy(false);
  };

  if (!sentence) {
    return (
      <div className="space-y-2 p-4 text-sm text-muted">
        <p className="font-medium text-foreground">Visual research</p>
        <p className="text-xs">Select a sentence in the transcript. Research searches the configured sources for material that supports it and ranks what it finds against the sentence.</p>
      </div>
    );
  }

  const forSentence = media.items.filter((it) => it.sentenceIdx === sentence.idx);
  const byId = new Map(forSentence.map((i) => [i.id, i]));
  const current = resultIds ? resultIds.map((id) => byId.get(id)).filter((x): x is MediaItem => Boolean(x)) : forSentence.slice().sort((a, b) => (b.relevance?.score ?? 0) - (a.relevance?.score ?? 0));
  // Weak matches (relevance < 40) stay hidden unless asked for: they are usually noise.
  const WEAK = 40;
  const weak = current.filter((it) => it.status !== "REJECTED" && it.status !== "APPROVED" && it.status !== "USED" && (it.relevance?.score ?? 100) < WEAK);
  const visible = current.filter((it) => (showRejected || it.status !== "REJECTED") && (showWeak || !weak.includes(it)));
  const eligible = providers.filter((p) => p.capabilities.search && p.categories.includes(category));
  const active = chosen ?? new Set(eligible.filter((p) => p.state !== "REQUIRES_CONFIGURATION").map((p) => p.id));

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <div className="space-y-2.5 border-b border-line p-3">
        <div className="text-[11px] font-bold tracking-[0.18em] text-muted">VISUAL RESEARCH</div>
        <div className="rounded-md border border-line bg-panel-2 p-2 text-[13px] leading-relaxed">
          <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-muted">CURRENT TRANSCRIPT · #{sentence.idx + 1}</div>
          “<HighlightedSentence s={sentence} />”
        </div>
        {sentence.intent.suggestedAssets.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {sentence.intent.suggestedAssets.map((g: AssetSuggestion) => (
              <button
                key={`${g.category}:${g.query}`}
                title={g.why}
                onClick={() => {
                  setQuery(g.query);
                  setCategory(g.category);
                  setChosen(null);
                }}
                className={cx("rounded-full border px-2 py-0.5 text-[11px]", query === g.query && category === g.category ? "border-accent bg-accent/15 text-accent" : "border-line text-muted hover:text-foreground")}
              >
                {CATEGORY_ICON[g.category]} {g.label}
              </button>
            ))}
          </div>
        )}
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <input value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 min-w-0 flex-1 rounded border border-line bg-background px-2 text-xs outline-none focus:border-accent" placeholder="Search query" />
          <Select className="h-8 w-28 text-xs" value={category} onChange={(e) => (setCategory(e.target.value as MediaCategory), setChosen(null))}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="primary" className="h-8" disabled={running || query.trim().length < 2}>
            {running ? "Searching…" : "Search"}
          </Button>
        </form>
        <div>
          <div className="mb-1 text-[10px] font-semibold tracking-wide text-muted">{running ? "SEARCHING" : "SOURCES"}</div>
          <div className="flex flex-wrap gap-1">
            {eligible.map((p) => {
              const o = outcomes?.find((x) => x.provider === p.id);
              const on = active.has(p.id);
              const disabled = p.state === "REQUIRES_CONFIGURATION";
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={disabled}
                  title={o ? `${o.message}${o.ms ? ` · ${(o.ms / 1000).toFixed(1)} s` : ""}` : disabled ? p.note : p.note}
                  onClick={() => {
                    const n = new Set(active);
                    if (n.has(p.id)) n.delete(p.id);
                    else n.add(p.id);
                    setChosen(n);
                  }}
                  className={cx(
                    "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]",
                    o ? OUTCOME_STYLE[o.state] : on ? "border-accent/50 text-foreground" : "border-line text-muted line-through opacity-60",
                    disabled && "cursor-not-allowed no-underline opacity-40",
                  )}
                >
                  {running && on && !o && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />}
                  {p.name.split(" (")[0]}
                  {o ? (o.state === "ok" ? ` · ${o.count}` : o.state === "empty" ? " · 0" : o.state === "error" ? " · !" : " · —") : disabled ? " · setup" : ""}
                </button>
              );
            })}
          </div>
          {outcomes?.some((o) => o.state === "error") && (
            <ul className="mt-1.5 space-y-0.5 text-[11px] text-danger">
              {outcomes
                .filter((o) => o.state === "error")
                .map((o) => (
                  <li key={o.provider}>
                    {o.name}: {o.message}
                  </li>
                ))}
            </ul>
          )}
          {eligible.some((p) => p.state === "REQUIRES_CONFIGURATION") && (
            <p className="mt-1 text-[10px] text-muted">
              Greyed-out sources need credentials — <a className="text-info hover:underline" href="/settings">Settings → Integrations</a>.
            </p>
          )}
        </div>
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void addLink();
          }}
        >
          <input value={link} onChange={(e) => setLink(e.target.value)} className="h-7 min-w-0 flex-1 rounded border border-line bg-background px-2 text-[11px] outline-none focus:border-accent" placeholder="Paste a link you found (YouTube, X, Facebook, article…)" />
          <Button size="sm" disabled={linkBusy || link.trim().length < 8}>
            {linkBusy ? "Reading…" : "Add link"}
          </Button>
        </form>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
        <div className="flex items-center text-[10px] font-semibold tracking-wide text-muted">
          <span>{resultIds ? `RESULTS (${visible.length})` : `FOUND FOR THIS SENTENCE (${visible.length})`}</span>
          <label className="ml-auto flex items-center gap-1 font-normal">
            <input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} /> show rejected
          </label>
        </div>
        {running && !visible.length && <p className="text-xs text-muted">Searching {active.size} source{active.size === 1 ? "" : "s"}…</p>}
        {!running && resultIds && !visible.length && (
          <p className="rounded border border-line p-3 text-xs text-muted">{weak.length ? `No strong matches — ${weak.length} weak match${weak.length === 1 ? "" : "es"} hidden.` : "Nothing found."} Try a broader query, another category, or paste a link you found yourself.</p>
        )}
        {weak.length > 0 && (
          <button className="text-[11px] text-muted underline-offset-2 hover:text-foreground hover:underline" onClick={() => setShowWeak((v) => !v)}>
            {showWeak ? "Hide" : "Show"} {weak.length} weak match{weak.length === 1 ? "" : "es"} (relevance under {WEAK})
          </button>
        )}
        {!resultIds && !visible.length && !running && <p className="text-xs text-muted">No research for this sentence yet.</p>}
        {visible.map((it) => (
          <ResultCard
            key={it.id}
            item={it}
            onPreview={() => setPreview(it)}
            onStatus={(s) => void media.patch(it.id, { status: s })}
            onUse={onUse && it.assetId ? () => onUse(it) : undefined}
            onCapture={it.metadata.capturable ? () => void capture(it) : undefined}
            capturing={capturing.has(it.id)}
          />
        ))}
      </div>
      {preview && (
        <SegmentDialog
          item={media.items.find((x) => x.id === preview.id) ?? preview}
          onClose={() => setPreview(null)}
          onSave={async (segment, approve) => {
            await media.patch(preview.id, { segment, ...(approve ? { status: "APPROVED" as const } : {}) });
          }}
        />
      )}
    </div>
  );
}

function ResultCard({ item: it, onPreview, onStatus, onUse, onCapture, capturing }: { item: MediaItem; onPreview: () => void; onStatus: (s: "APPROVED" | "REJECTED" | "REVIEW") => void; onUse?: () => void; onCapture?: () => void; capturing?: boolean }) {
  const r = it.relevance;
  const date = it.publishedAt ? new Date(it.publishedAt) : null;
  return (
    <article className={cx("overflow-hidden rounded-lg border bg-panel", it.status === "REJECTED" ? "border-line opacity-50" : it.status === "APPROVED" || it.status === "USED" ? "border-ok/40" : "border-line")}>
      <div className="flex gap-2.5 p-2">
        <button onClick={onPreview} className="relative h-[68px] w-[120px] shrink-0 overflow-hidden rounded bg-panel-2" title="Preview">
          {it.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- remote thumbnails
            <img src={stillThumbnail(it.thumbnailUrl)} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full items-center justify-center text-2xl opacity-40">{CATEGORY_ICON[it.category]}</span>
          )}
          {it.duration ? <span className="absolute bottom-0.5 right-0.5 rounded bg-black/75 px-1 text-[9px] text-white">{fmtDur(it.duration)}</span> : null}
        </button>
        <div className="min-w-0 flex-1 space-y-0.5 text-[11px]">
          <div className="line-clamp-2 text-xs font-semibold leading-snug">{it.title}</div>
          <div className="truncate text-muted">
            Source: {it.platform ?? it.provider}
            {it.account ? ` · ${it.account}` : ""}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-muted">
            {date && <span>{date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span>}
            <StatusPill status={it.status} />
            {!it.assetId && <Tag>reference</Tag>}
          </div>
        </div>
      </div>
      {it.segment && (
        <div className="mx-2 mb-1.5 rounded bg-panel-2 px-2 py-1 text-[11px]">
          <span className="font-semibold">Relevant section: {fmtDur(it.segment.start)}–{fmtDur(it.segment.end)}</span>
          <span className="text-muted"> · {it.segment.basis === "user" ? "set by you" : `suggested (${it.segment.basis === "chapters" ? "chapter markers" : it.segment.basis}), ${Math.round(it.segment.confidence * 100)}%`}</span>
          {it.segment.label && <div className="truncate text-muted">“{it.segment.label}”</div>}
        </div>
      )}
      {r && (
        <details className="mx-2 mb-1.5 text-[11px]">
          <summary className="cursor-pointer text-muted">
            Why it matches: <span className={r.score >= 70 ? "text-ok" : r.score >= 50 ? "text-accent" : "text-danger"}>{relevanceLabel(r.score)}</span> ({r.score})
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted">
            {r.reasons.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <p className="mt-1 text-[10px] text-muted">An estimate from names, topic, dates and source — not a check of the content.</p>
        </details>
      )}
      <div className="flex flex-wrap gap-1 border-t border-line px-2 py-1.5">
        <Button size="sm" onClick={onPreview}>
          {it.embed?.kind === "youtube" ? "Preview / Use segment" : "Preview"}
        </Button>
        {it.sourceUrl && (
          <a href={it.sourceUrl} target="_blank" rel="noreferrer noopener" className="inline-flex h-7 items-center rounded-md border border-line px-2 text-xs hover:bg-panel-2">
            Open source ↗
          </a>
        )}
        {onCapture && (
          <Button size="sm" disabled={capturing} onClick={onCapture} title="Screenshot the official embed/public page, with its source, account and date kept visible">
            {capturing ? "Capture queued…" : "Capture"}
          </Button>
        )}
        {onUse && (it.status === "APPROVED" || it.status === "USED") && (
          <Button size="sm" variant="primary" onClick={onUse}>
            Add to timeline
          </Button>
        )}
        {it.status !== "APPROVED" && it.status !== "USED" && (
          <Button size="sm" variant="ghost" className="text-ok" onClick={() => onStatus("APPROVED")}>
            Approve
          </Button>
        )}
        {it.status !== "REJECTED" && it.usage === 0 && (
          <Button size="sm" variant="ghost" className="text-danger" onClick={() => onStatus("REJECTED")}>
            Reject
          </Button>
        )}
        {it.status === "REJECTED" && (
          <Button size="sm" variant="ghost" onClick={() => onStatus("REVIEW")}>
            Restore
          </Button>
        )}
      </div>
    </article>
  );
}
