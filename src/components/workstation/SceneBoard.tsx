"use client";

import { cx, fmtTime, Tag } from "@/components/ui";
import type { SentenceAnalysis, TranscriptAnalysis } from "@/lib/analysis/types";
import { stillThumbnail } from "@/lib/media/thumbnails";
import type { Clip } from "@/components/editor/types";
import { INTENT_LABEL } from "./highlight";

export interface SceneMediaStatus {
  discovered: number;
  approved: number;
  rejected: number;
  used: number;
}

/**
 * One card per scene: its narration, what the analysis suggests showing, where it might come
 * from, and what is actually on the timeline — so every asset's reason for existing is visible.
 */
export function SceneBoard({
  analysis,
  clips,
  mediaStatus,
  selectedSentence,
  onSelectSentence,
}: {
  analysis: TranscriptAnalysis;
  clips: Clip[];
  mediaStatus: Record<string, SceneMediaStatus>;
  selectedSentence: number | null;
  onSelectSentence: (s: SentenceAnalysis) => void;
}) {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto grid max-w-5xl gap-3">
        {analysis.scenes.map((sc) => {
          const members = analysis.sentences.slice(sc.sentences[0], sc.sentences[1] + 1);
          const lead = [...members].sort((a, b) => b.intent.importance - a.intent.importance)[0]!;
          const primary = lead.intent.suggestedAssets[0];
          const broll = members.flatMap((m) => m.intent.suggestedAssets).find((g) => (g.category === "video" || g.category === "photo") && g !== primary);
          const graphic = members.find((m) => m.intent.graphic)?.intent.graphic ?? null;
          const onTimeline = clips.filter((c) => c.start < sc.end && c.start + c.duration > sc.start);
          const st = mediaStatus[sc.key];
          const status = st?.used ? "USED" : st?.approved ? "APPROVED" : st?.discovered ? "REVIEW" : onTimeline.length ? "ON TIMELINE" : "NOT RESEARCHED";
          return (
            <article key={sc.key} className="grid grid-cols-[1fr_300px] gap-4 rounded-lg border border-line bg-panel p-3">
              <div className="min-w-0">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-xs font-black tracking-[0.18em]">SCENE {String(sc.idx + 1).padStart(2, "0")}</span>
                  <span className="text-[11px] text-muted">
                    {fmtTime(sc.start)}–{fmtTime(sc.end)}
                  </span>
                  <span className={cx("ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide", status === "USED" || status === "APPROVED" ? "bg-ok/15 text-ok" : status === "REVIEW" ? "bg-accent/15 text-accent" : "bg-panel-2 text-muted")}>{status}</span>
                </div>
                <div className="mb-2 text-[10px] font-semibold tracking-wide text-muted">NARRATION</div>
                <div className="space-y-1">
                  {members.map((m) => (
                    <button key={m.idx} onClick={() => onSelectSentence(m)} className={cx("block w-full rounded px-1.5 py-0.5 text-left text-[13px] leading-relaxed", selectedSentence === m.idx ? "bg-accent/10" : "hover:bg-panel-2")}>
                      “{m.text}” <span className="text-[10px] text-muted">· {INTENT_LABEL[m.intent.type] ?? m.intent.type}</span>
                    </button>
                  ))}
                </div>
              </div>
              <dl className="space-y-1.5 text-xs">
                <Row k="Suggested visual" v={primary ? primary.label : "Designed graphic / atmosphere"} />
                <Row k="Suggested B-roll" v={broll?.label ?? "—"} />
                <Row k="Suggested source" v={primary ? primary.providers.join(" · ") : "—"} />
                {graphic && <Row k="Graphic" v={`${graphic.text}${graphic.sub ? ` / ${graphic.sub}` : ""}`} />}
                <Row k="Research" v={st ? `${st.discovered} found · ${st.approved} approved · ${st.used} used · ${st.rejected} rejected` : "none yet"} />
                <div>
                  <dt className="text-[10px] font-semibold tracking-wide text-muted">ON TIMELINE</dt>
                  <dd className="mt-1 flex gap-1 overflow-hidden">
                    {onTimeline.length ? (
                      onTimeline.slice(0, 6).map((c) => (
                        <div key={c.rowId} title={`${c.asset.title} (${c.asset.provider})`} className="relative h-9 w-14 shrink-0 overflow-hidden rounded border border-line bg-panel-2">
                          {c.asset.thumbnailUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element -- remote provider thumbnails
                            <img src={stillThumbnail(c.asset.thumbnailUrl)} alt="" loading="lazy" className="h-full w-full object-cover" />
                          ) : (
                            <span className="flex h-full items-center justify-center px-0.5 text-center text-[8px] leading-tight text-muted">{c.asset.provider === "graphic" ? c.asset.title.slice(0, 18) : c.asset.type}</span>
                          )}
                        </div>
                      ))
                    ) : (
                      <span className="text-muted">nothing yet</span>
                    )}
                  </dd>
                </div>
              </dl>
            </article>
          );
        })}
        {!analysis.scenes.length && <Tag>No scenes</Tag>}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold tracking-wide text-muted">{k.toUpperCase()}</dt>
      <dd className="leading-snug">{v}</dd>
    </div>
  );
}
