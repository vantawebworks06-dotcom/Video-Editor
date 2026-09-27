/**
 * Explained relevance ranking of research results against the narration sentence they are for.
 * Every factor is 0-100 with a human reason, so the editor can see *why* something ranked where it
 * did. It estimates relevance from text; it never claims the content is what it says.
 */
import type { MediaCategory } from "@/lib/analysis/types";
import { accountCredibility, domainCredibility } from "./credibility";
import type { Candidate, RankedCandidate } from "./types";

export interface RankContext {
  sentence: string;
  /** Named subjects of the sentence, most important first. */
  entities: string[];
  topics: string[];
  year: number | null;
  category: MediaCategory;
  query: string;
}

const WEIGHTS = { entity: 0.3, topic: 0.12, context: 0.15, title: 0.13, date: 0.1, credibility: 0.12, type: 0.08 };

const norm = (s: string) => ` ${s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;
const STOP = new Set("the a an and or of to in on at by for with from as is are was were be been this that these those it its his her their our your into about after before over than then there here what which who when where why how not no".split(" "));
const tokens = (s: string) => norm(s).trim().split(" ").filter((w) => w.length >= 3 && !STOP.has(w));

const COMPATIBLE: Partial<Record<MediaCategory, MediaCategory[]>> = {
  interview: ["video"],
  video: ["interview"],
  article: ["web", "document"],
  web: ["article"],
  document: ["article", "photo", "web"],
  photo: ["screenshot", "document"],
  screenshot: ["photo", "social"],
  social: ["screenshot"],
};

function yearsIn(c: Candidate): number[] {
  const out: number[] = [];
  if (c.publishedAt) {
    const y = new Date(c.publishedAt).getUTCFullYear();
    if (Number.isFinite(y)) out.push(y);
  }
  for (const m of `${c.title} ${c.description ?? ""}`.matchAll(/\b(1[89]\d\d|20\d\d)\b/g)) out.push(Number(m[1]));
  return out;
}

export function rankCandidates(cands: Candidate[], ctx: RankContext): RankedCandidate[] {
  const sentTokens = [...new Set(tokens(ctx.sentence))];
  const queryTokens = [...new Set(tokens(ctx.query))];
  const topicTokens = ctx.topics.map((t) => t.toLowerCase());
  const ranked = cands.map((c) => {
    const titleN = norm(c.title);
    const hay = norm(`${c.title} ${c.description ?? ""} ${c.excerpt ?? ""} ${c.account ?? ""}`);
    const reasons: string[] = [];

    // Entities: full name, or surname/distinctive part ("Kartel" for "Vybz Kartel").
    let entity = 50;
    const matched: string[] = [];
    const missing: string[] = [];
    const ents = ctx.entities.slice(0, 3);
    if (ents.length) {
      let sum = 0;
      for (const e of ents) {
        const full = norm(e);
        const parts = full.trim().split(" ").filter((p) => p.length >= 4);
        const s = hay.includes(full) ? 1 : parts.some((p) => hay.includes(` ${p} `)) ? 0.7 : 0;
        sum += s;
        (s ? matched : missing).push(e);
      }
      entity = Math.round((sum / ents.length) * 100);
      if (matched.length) reasons.push(`mentions ${matched.join(" and ")}${titleN.includes(norm(matched[0]!)) || matched.some((m) => titleN.includes(` ${norm(m).trim().split(" ").at(-1)} `)) ? " in the title" : ""}`);
      if (missing.length) reasons.push(`does not mention ${missing.join(" or ")}`);
    }

    const topicHits = topicTokens.filter((t) => hay.includes(` ${t} `) || hay.includes(` ${t.replace(/s$/, "")} `));
    const topic = topicTokens.length ? Math.round((topicHits.length / topicTokens.length) * 100) : 50;
    if (topicHits.length) reasons.push(`matches the topic (${topicHits.slice(0, 3).join(", ")})`);

    const ctxHits = sentTokens.filter((t) => hay.includes(` ${t} `));
    const context = sentTokens.length ? Math.min(100, Math.round((ctxHits.length / Math.min(8, sentTokens.length)) * 100)) : 50;

    const qHits = queryTokens.filter((t) => titleN.includes(` ${t} `));
    const title = queryTokens.length ? Math.round((qHits.length / queryTokens.length) * 100) : 50;

    let date = 50;
    if (ctx.year) {
      const ys = yearsIn(c);
      if (ys.length) {
        const d = Math.min(...ys.map((y) => Math.abs(y - ctx.year!)));
        date = d === 0 ? 100 : d <= 1 ? 85 : d <= 3 ? 65 : d <= 10 ? 40 : 15;
        reasons.push(d === 0 ? `dated ${ctx.year}, the year the sentence is about` : `dated ${d} year${d === 1 ? "" : "s"} from ${ctx.year}`);
      }
    }

    const cred = c.provider === "youtube" || c.provider === "x" || c.provider === "reddit" || c.provider === "meta" ? accountCredibility(c.account, ctx.entities) : c.category === "article" || c.category === "web" ? domainCredibility(c.sourceUrl) : { score: c.credibility, label: c.platform };
    const credibility = Math.round(Math.max(cred.score, c.provider === "youtube" || c.provider === "x" ? 0 : c.credibility) * 100);
    reasons.push(`source: ${cred.label}`);

    const type = c.category === ctx.category ? 100 : COMPATIBLE[ctx.category]?.includes(c.category) ? 75 : 40;
    if (type < 100) reasons.push(`is ${c.category === "article" ? "an" : "a"} ${c.category}, not the ${ctx.category} asked for`);

    let score = entity * WEIGHTS.entity + topic * WEIGHTS.topic + context * WEIGHTS.context + title * WEIGHTS.title + date * WEIGHTS.date + credibility * WEIGHTS.credibility + type * WEIGHTS.type;
    // A result about none of the people/things the sentence names is rarely right, however well it matches otherwise.
    if (ents.length && entity === 0) score = Math.min(score, 38);
    if (c.segment) reasons.push(`suggested section ${fmt(c.segment.start)}–${fmt(c.segment.end)} (${c.segment.basis === "chapters" ? "from the uploader's chapter markers" : c.segment.basis})`);
    return { ...c, relevance: { score: Math.round(score), factors: { entity, topic, context, title, date, credibility, type }, reasons: reasons.slice(0, 6) } };
  });
  return ranked.sort((a, b) => b.relevance.score - a.relevance.score);
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** "High / Medium / Low" wording for the UI — relevance is an estimate, never presented as fact. */
export function relevanceLabel(score: number): string {
  return score >= 70 ? "High contextual relevance" : score >= 50 ? "Moderate relevance" : "Weak match — check before using";
}
