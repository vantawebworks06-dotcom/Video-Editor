"use client";

import type { ReactNode } from "react";
import type { MentionKind, SentenceAnalysis } from "@/lib/analysis/types";

/** Colour per kind of extracted item (the same legend everywhere the transcript is shown). */
export const KIND_STYLE: Record<MentionKind | "date" | "statistic", string> = {
  person: "text-[#f0c267] decoration-[#f0c267]/60",
  organization: "text-[#7fb2f5] decoration-[#7fb2f5]/60",
  place: "text-[#6fd39a] decoration-[#6fd39a]/60",
  event: "text-[#c79bf4] decoration-[#c79bf4]/60",
  date: "text-[#67d6e0] decoration-[#67d6e0]/60",
  statistic: "text-[#f08aa8] decoration-[#f08aa8]/60",
  song: "text-[#f3a15f] decoration-[#f3a15f]/60",
  album: "text-[#f3a15f] decoration-[#f3a15f]/60",
  work: "text-[#f3a15f] decoration-[#f3a15f]/60",
  platform: "text-[#b7bcc4] decoration-[#b7bcc4]/60",
  quote: "text-foreground italic",
  term: "text-foreground decoration-muted/60",
};

export const KIND_LABEL: Partial<Record<MentionKind | "date" | "statistic", string>> = {
  person: "Person",
  organization: "Organisation",
  place: "Place",
  event: "Event",
  date: "Date",
  statistic: "Figure",
  song: "Song",
  album: "Album",
  work: "Work",
  platform: "Platform",
  term: "Name (unclassified)",
};

/** The sentence with its entities, dates and figures underlined in their kind's colour. */
export function HighlightedSentence({ s }: { s: SentenceAnalysis }) {
  const spans: { at: number; len: number; kind: keyof typeof KIND_STYLE; title: string }[] = [];
  const lower = s.text.toLowerCase();
  const mark = (needle: string, kind: keyof typeof KIND_STYLE, title: string) => {
    if (!needle || needle.length < 2) return;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle.toLowerCase(), from);
      if (at < 0) return;
      from = at + needle.length;
      const before = lower[at - 1];
      const after = lower[at + needle.length];
      if ((before && /[\p{L}\p{N}]/u.test(before)) || (after && /[\p{L}\p{N}]/u.test(after))) continue;
      if (spans.some((x) => at < x.at + x.len && at + needle.length > x.at)) continue;
      spans.push({ at, len: needle.length, kind, title });
    }
  };
  for (const d of s.dates) mark(d.text, "date", `Date${d.iso ? ` · ${d.iso}` : d.year ? ` · ${d.year}` : ""}`);
  for (const st of s.statistics) mark(st.text, "statistic", "Figure");
  for (const m of s.mentions) {
    const title = `${KIND_LABEL[m.kind] ?? m.kind}${m.description ? ` · ${m.description}` : ""}`;
    mark(m.text, m.kind, title);
    // Surnames / partial references ("Kartel" for "Vybz Kartel").
    if (m.kind === "person" && m.name.includes(" ")) mark(m.name.split(" ").at(-1)!, m.kind, title);
  }
  spans.sort((a, b) => a.at - b.at);
  const out: ReactNode[] = [];
  let i = 0;
  for (const sp of spans) {
    if (sp.at > i) out.push(s.text.slice(i, sp.at));
    out.push(
      <span key={sp.at} title={sp.title} className={`underline decoration-2 underline-offset-2 ${KIND_STYLE[sp.kind]}`}>
        {s.text.slice(sp.at, sp.at + sp.len)}
      </span>,
    );
    i = sp.at + sp.len;
  }
  out.push(s.text.slice(i));
  return <>{out}</>;
}

export const INTENT_LABEL: Record<string, string> = {
  quote: "Quote",
  interview_reference: "Interview",
  social_reaction: "Social reaction",
  statistic: "Statistic",
  document_evidence: "Document",
  news_event: "News event",
  legal_event: "Legal / police",
  time_jump: "Time jump",
  performance: "Performance",
  music_reference: "Music",
  conflict: "Conflict / rivalry",
  product_announcement: "Announcement",
  location: "Location",
  person_intro: "Person",
  historical_context: "Historical context",
  event: "Event",
  science_explanation: "Science",
  sports_moment: "Sport",
  emotional: "Emotional",
  explanation: "Explanation",
};
