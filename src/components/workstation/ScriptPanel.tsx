"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Button, cx, fmtTime, Tag } from "@/components/ui";
import type { SentenceAnalysis } from "@/lib/analysis/types";
import type { PlayheadStore } from "@/components/editor/playhead";
import { HighlightedSentence, INTENT_LABEL, KIND_LABEL, KIND_STYLE } from "./highlight";
import type { AnalysisState } from "./useAnalysis";

/** Per-sentence research counts shown as small status badges. */
export type SentenceStatus = Record<number, { discovered: number; approved: number; used: number }>;

/** Index of the sentence being spoken; re-renders only when it changes (not every playhead tick). */
function useActiveSentence(store: PlayheadStore, sentences: SentenceAnalysis[]): number {
  const [active, setActive] = useState(-1);
  useEffect(() => {
    const update = () => {
      const t = store.get();
      const i = sentences.findIndex((s) => t >= s.start && t < s.end + 0.25);
      setActive((prev) => (prev === i ? prev : i));
    };
    update();
    return store.subscribe(update);
  }, [store, sentences]);
  return active;
}

export const ScriptPanel = memo(function ScriptPanel({
  state,
  playhead,
  selected,
  status,
  onSelect,
}: {
  state: AnalysisState;
  playhead: PlayheadStore;
  selected: number | null;
  status?: SentenceStatus;
  onSelect: (s: SentenceAnalysis) => void;
}) {
  const a = state.analysis;
  const sentences = a?.sentences ?? [];
  const active = useActiveSentence(playhead, sentences);
  const [filter, setFilter] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the spoken sentence in view while playing (only when it isn't already visible).
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-sentence="${active}"]`);
    const box = listRef.current?.getBoundingClientRect();
    if (!el || !box) return;
    const r = el.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) el.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (state.loading) return <div className="p-4 text-xs text-muted">Loading transcript analysis…</div>;
  if (!a) {
    return (
      <div className="space-y-3 p-4 text-sm">
        <p className="font-medium">Transcript analysis</p>
        <p className="text-xs text-muted">
          Breaks the narration into sentences and scenes, finds the people, places, organisations, dates, figures, quotes, claims and media references in each line, and works out what supporting material would strengthen it.
        </p>
        {state.canAnalyze ? (
          <Button variant="primary" disabled={state.running} onClick={() => void state.run()}>
            {state.running ? "Analysing… (linking names on Wikipedia)" : "Analyse transcript"}
          </Button>
        ) : (
          <p className="rounded border border-line bg-panel-2 p-2 text-xs text-muted">Upload the narration (and generate once for a timed transcript) or paste the script in the PROJECT section first.</p>
        )}
        {state.error && <p className="text-xs text-danger">{state.error}</p>}
      </div>
    );
  }

  const q = filter.trim().toLowerCase();
  const visible = (s: SentenceAnalysis) => !q || s.text.toLowerCase().includes(q) || s.intent.type.includes(q) || s.intent.entities.some((e) => e.toLowerCase().includes(q));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-line p-2.5">
        <div className="flex items-center gap-2 text-[11px] text-muted">
          <span className="min-w-0 flex-1 truncate" title={a.basis === "rules" ? "Rule-based analysis (no AI key); names linked via Wikipedia" : "Analysis by Claude"}>
            {a.sentences.length} sentences · {a.scenes.length} scenes · {a.entities.length} names · {a.basis === "rules" ? "rules" : "Claude"}
          </span>
          <Button size="sm" variant={state.stale ? "primary" : "ghost"} disabled={state.running} onClick={() => void state.run()} title={state.stale ? "The transcript, script or topic changed since this analysis" : "Re-run the analysis"}>
            {state.running ? "Analysing…" : state.stale ? "Re-analyse (outdated)" : "Re-analyse"}
          </Button>
        </div>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter: text, name or intent (e.g. interview)" className="h-7 w-full rounded border border-line bg-background px-2 text-xs outline-none focus:border-accent" />
        {a.warnings.map((w) => (
          <p key={w} className="text-[10px] leading-snug text-accent">
            {w}
          </p>
        ))}
        {state.error && <p className="text-[11px] text-danger">{state.error}</p>}
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
        {a.scenes.map((sc) => {
          const members = a.sentences.slice(sc.sentences[0], sc.sentences[1] + 1).filter(visible);
          if (!members.length) return null;
          return (
            <section key={sc.key}>
              <header className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-line bg-panel/95 px-3 py-1.5 backdrop-blur">
                <span className="text-[11px] font-bold tracking-wider text-muted">SCENE {String(sc.idx + 1).padStart(2, "0")}</span>
                <span className="truncate text-[11px] text-foreground/80">{sc.title}</span>
                <span className="ml-auto shrink-0 text-[10px] text-muted">{fmtTime(sc.start)}</span>
              </header>
              {members.map((s) => {
                const st = status?.[s.idx];
                return (
                  <button
                    key={s.idx}
                    data-sentence={s.idx}
                    onClick={() => onSelect(s)}
                    className={cx(
                      "block w-full border-b border-line/60 px-3 py-2 text-left text-[13px] leading-relaxed transition-colors",
                      selected === s.idx ? "bg-accent/10" : active === s.idx ? "bg-panel-2" : "hover:bg-panel-2/60",
                    )}
                  >
                    <div className="mb-1 flex items-center gap-1.5 text-[10px]">
                      <span className={cx("tabular-nums", active === s.idx ? "text-accent" : "text-muted")}>{fmtTime(s.start)}</span>
                      <Tag>{INTENT_LABEL[s.intent.type] ?? s.intent.type}</Tag>
                      {s.claim && <Tag tone="accent">claim</Tag>}
                      {s.intent.graphic && <Tag>graphic</Tag>}
                      {st && (st.used > 0 ? <Tag tone="ok">{st.used} used</Tag> : st.approved > 0 ? <Tag tone="ok">{st.approved} approved</Tag> : st.discovered > 0 ? <Tag>{st.discovered} found</Tag> : null)}
                    </div>
                    <HighlightedSentence s={s} />
                  </button>
                );
              })}
            </section>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-2.5 gap-y-1 border-t border-line px-3 py-1.5 text-[10px]">
        {(["person", "organization", "place", "event", "date", "statistic", "work"] as const).map((k) => (
          <span key={k} className={KIND_STYLE[k].split(" ")[0]}>
            ■ {KIND_LABEL[k]}
          </span>
        ))}
      </div>
    </div>
  );
});
