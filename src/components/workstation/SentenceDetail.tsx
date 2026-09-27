"use client";

import { Button, fmtTime, Tag } from "@/components/ui";
import type { AssetSuggestion, SentenceAnalysis, TranscriptAnalysis } from "@/lib/analysis/types";
import { HighlightedSentence, INTENT_LABEL, KIND_LABEL, KIND_STYLE } from "./highlight";

const CATEGORY_LABEL: Record<string, string> = {
  video: "Video",
  photo: "Photo",
  social: "Social post",
  article: "Article",
  screenshot: "Screenshot",
  interview: "Interview",
  audio: "Audio",
  music: "Music",
  document: "Document",
  web: "Web page",
};

/** Everything the analysis found in one sentence, and what it suggests looking for. */
export function SentenceDetail({ analysis, s, onResearch }: { analysis: TranscriptAnalysis; s: SentenceAnalysis | null; onResearch: (s: SentenceAnalysis, suggestion: AssetSuggestion | null) => void }) {
  if (!s) {
    return (
      <div className="space-y-2 p-4 text-sm text-muted">
        <p className="font-medium text-foreground">Select a sentence</p>
        <p className="text-xs">Click any line of the transcript to see what it talks about, the visual intent the analysis assigned to it, and where supporting material might be found.</p>
      </div>
    );
  }
  const scene = analysis.scenes[s.scene];
  const i = s.intent;
  return (
    <div className="space-y-4 p-3 text-sm">
      <div>
        <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
          <span>
            SCENE {String((scene?.idx ?? 0) + 1).padStart(2, "0")} · {fmtTime(s.start)}–{fmtTime(s.end)}
          </span>
          {!analysis.timed && <Tag>times estimated</Tag>}
        </div>
        <p className="leading-relaxed">
          <HighlightedSentence s={s} />
        </p>
      </div>

      <section className="rounded-md border border-line bg-panel-2 p-2.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[11px] font-semibold tracking-wide text-muted">VISUAL INTENT</span>
          <Tag tone="accent">{INTENT_LABEL[i.type] ?? i.type}</Tag>
          <span className="ml-auto text-[10px] text-muted" title="How sure the rules are about the kind of sentence — not whether its content is true.">
            {i.basis === "rules" ? "rules" : "Claude"} · classification {Math.round(i.confidence * 100)}%
          </span>
        </div>
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted">
          {i.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
          <Tag>tone: {i.tone}</Tag>
          <Tag>importance {Math.round(i.importance * 100)}</Tag>
          {i.era && <Tag>era: {i.era}</Tag>}
          {i.topics.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
        </div>
      </section>

      {(s.mentions.length > 0 || s.dates.length > 0 || s.statistics.length > 0 || s.quotes.length > 0) && (
        <section>
          <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-muted">FOUND IN THIS SENTENCE</h3>
          <ul className="space-y-1 text-xs">
            {s.mentions.map((m) => (
              <li key={`${m.kind}:${m.name}`} className="flex gap-2">
                <span className={`w-24 shrink-0 ${KIND_STYLE[m.kind].split(" ")[0]}`}>{KIND_LABEL[m.kind] ?? m.kind}</span>
                <span>
                  {m.name}
                  {m.description && <span className="text-muted"> — {m.description}</span>}
                  {m.wikiTitle && (
                    <a className="ml-1 text-info hover:underline" href={`https://en.wikipedia.org/wiki/${encodeURIComponent(m.wikiTitle.replace(/ /g, "_"))}`} target="_blank" rel="noreferrer">
                      Wikipedia ↗
                    </a>
                  )}
                </span>
              </li>
            ))}
            {s.dates.map((d) => (
              <li key={d.text} className="flex gap-2">
                <span className={`w-24 shrink-0 ${KIND_STYLE.date.split(" ")[0]}`}>Date</span>
                <span>
                  {d.text} <span className="text-muted">({d.kind}{d.iso ? `, ${d.iso}` : d.year ? `, ${d.year}` : ""})</span>
                </span>
              </li>
            ))}
            {s.statistics.map((st) => (
              <li key={st.text} className="flex gap-2">
                <span className={`w-24 shrink-0 ${KIND_STYLE.statistic.split(" ")[0]}`}>Figure</span>
                <span>{st.text}</span>
              </li>
            ))}
            {s.quotes.map((q) => (
              <li key={q} className="flex gap-2">
                <span className="w-24 shrink-0 text-muted">Quote</span>
                <span className="italic">“{q}”</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {s.claim && (
        <section className="rounded-md border border-accent/30 bg-accent/5 p-2.5 text-xs">
          <div className="mb-1 font-semibold text-accent">Claim needs a source ({s.claim.kind})</div>
          <p className="text-muted">This is a factual statement. Attach a source in RESEARCH so it appears in the SOURCES evidence panel. The analysis flags claims; it does not check whether they are true.</p>
        </section>
      )}

      {i.graphic && (
        <section className="text-xs">
          <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-muted">GRAPHIC OPPORTUNITY</h3>
          <div className="rounded-md border border-line bg-black/60 p-3 text-center">
            <div className="text-lg font-black tracking-wide">{i.graphic.text}</div>
            {i.graphic.sub && <div className="mt-0.5 text-[10px] tracking-[0.2em] text-muted">{i.graphic.sub}</div>}
          </div>
          <p className="mt-1 text-muted">{i.graphic.kind.replace("_", " ")} graphic — designed in EFFECTS → Text &amp; Graphics.</p>
        </section>
      )}

      <section>
        <div className="mb-1 flex items-center">
          <h3 className="text-[11px] font-semibold tracking-wide text-muted">SUGGESTED MATERIAL</h3>
          <Button size="sm" variant="primary" className="ml-auto" onClick={() => onResearch(s, null)}>
            Research this sentence
          </Button>
        </div>
        {!i.suggestedAssets.length ? (
          <p className="text-xs text-muted">No specific material suggested — a designed text graphic or atmosphere shot may suit this line.</p>
        ) : (
          <ul className="space-y-1.5">
            {i.suggestedAssets.map((g) => (
              <li key={`${g.category}:${g.query}`} className="rounded-md border border-line p-2 text-xs">
                <div className="flex items-start gap-2">
                  <Tag>{CATEGORY_LABEL[g.category] ?? g.category}</Tag>
                  <span className="flex-1 font-medium">{g.label}</span>
                  <Button size="sm" onClick={() => onResearch(s, g)}>
                    Search
                  </Button>
                </div>
                <p className="mt-1 text-muted">{g.why}</p>
                <p className="mt-0.5 text-[10px] text-muted">
                  query “{g.query}” · {g.providers.join(", ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
