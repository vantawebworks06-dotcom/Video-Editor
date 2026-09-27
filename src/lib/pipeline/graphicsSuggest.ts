/**
 * Graphics suggested from the transcript analysis: names → lower thirds, places → location tags,
 * years/dates → date stamps, figures → statistics, quotes, headlines and time jumps. Restraint is
 * part of the design: each person and place is introduced once, graphics keep their distance,
 * and the most important lines win when there are too many.
 */
import type { GraphicOpportunity, TranscriptAnalysis } from "@/lib/analysis/types";
import { DEFAULT_DURATION, type Graphic, type GraphicKind } from "@/lib/domain/graphics";
import type { ScenePlan } from "@/lib/domain/types";

const KIND: Record<GraphicOpportunity["kind"], GraphicKind> = {
  name: "lower_third",
  location: "location",
  year: "date",
  date_event: "date",
  statistic: "statistic",
  quote: "quote",
  headline: "headline",
  time_jump: "time_jump",
};

/** Minimum seconds between the starts of two graphics. */
const MIN_GAP = 6;
/** At most one graphic per this many seconds of narration, on average. */
const DENSITY = 9;

export interface Suggestion {
  sceneId: string;
  graphic: Omit<Graphic, "id">;
  /** Narration time (for ordering and spacing). */
  t: number;
  importance: number;
}

export function suggestGraphics(analysis: TranscriptAnalysis, plans: ScenePlan[], opts: { keep?: { sceneId: string; graphic: Graphic }[] } = {}): Suggestion[] {
  if (!analysis.timed || !plans.length) return [];
  const described = new Map(analysis.entities.map((e) => [e.name.toLowerCase(), e.description]));
  const planAt = (t: number) => plans.find((p) => t >= p.startTime && t < p.endTime) ?? null;
  const candidates: Suggestion[] = [];
  const seenKey = new Set<string>();
  for (const s of analysis.sentences) {
    // Candidates: the line's own graphic moment (at its start), and every person or place it
    // introduces for the first time (at the moment the name is spoken, estimated from its position).
    const found: { g: GraphicOpportunity; t: number; importance: number }[] = [];
    if (s.intent.graphic) found.push({ g: s.intent.graphic, t: s.start + 0.25, importance: s.intent.importance });
    for (const m of s.mentions) {
      if (m.kind !== "person" && m.kind !== "place") continue;
      if (analysis.entities.find((e) => e.name === m.name)?.firstSentence !== s.idx) continue;
      const pos = Math.max(0, s.text.indexOf(m.text));
      const t = s.start + (s.end - s.start) * (pos / Math.max(1, s.text.length));
      // Introductions of people matter a little more than places, both less than the line's own moment.
      found.push({ g: { kind: m.kind === "person" ? "name" : "location", text: m.name, sub: m.description ?? null }, t, importance: s.intent.importance * (m.kind === "person" ? 0.95 : 0.85) });
    }
    for (const { g, t, importance } of found) {
      if (!g.text.trim()) continue;
      const kind = KIND[g.kind];
      // Each person / place / exact text is introduced once.
      const key = `${kind}:${g.text.toLowerCase()}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      const plan = planAt(t);
      if (!plan) continue;
      const at = Math.max(0, Math.round((t - plan.startTime) * 100) / 100);
      if (at >= plan.endTime - plan.startTime - 0.3) continue;
      let title = g.text.trim();
      let sub = g.sub ?? (kind === "lower_third" ? (described.get(title.toLowerCase()) ?? "") : "");
      // A statistic shows the number big and what it counts underneath ("3,000" / "people").
      const num = kind === "statistic" ? title.match(/^([$£€]?\d[\d,.]*\s?(?:%|percent|million|billion|thousand|[kKmMbB]\b)?)\s+(.+)$/) : null;
      if (num) {
        title = num[1]!.trim();
        sub = sub || num[2]!.trim().toLowerCase();
      }
      const duration = Math.min(DEFAULT_DURATION[kind], Math.max(2.2, s.end - t + 1.2));
      candidates.push({
        sceneId: plan.sceneId,
        t,
        importance,
        graphic: { kind, title: title.slice(0, 90), sub: sub.slice(0, 140), at, duration: Math.round(duration * 10) / 10, position: "auto", animation: "auto", source: "analysis" },
      });
    }
  }
  // Keep the most important within the density budget, never closer than MIN_GAP to another.
  const total = plans.at(-1)!.endTime - plans[0]!.startTime;
  const budget = Math.max(1, Math.floor(total / DENSITY));
  const taken: number[] = (opts.keep ?? []).map((k) => {
    const p = plans.find((x) => x.sceneId === k.sceneId);
    return (p?.startTime ?? 0) + k.graphic.at;
  });
  const out: Suggestion[] = [];
  for (const c of [...candidates].sort((a, b) => b.importance - a.importance || a.t - b.t)) {
    if (out.length >= budget) break;
    if (taken.some((t) => Math.abs(t - c.t) < MIN_GAP)) continue;
    taken.push(c.t);
    out.push(c);
  }
  return out.sort((a, b) => a.t - b.t);
}
