/**
 * Delivery planning: how each sentence is spoken, from what it says.
 *
 * The rules follow common narration practice and prosody research: paragraph-initial pitch reset
 * and final lowering, slower delivery for figures and names, a beat before a turn ("But…"),
 * short lines given weight, sombre content slower and softer, action faster and brighter, and
 * small seeded differences so no two neighbouring sentences are delivered identically.
 */
import type { NarratorControls, NarratorSentence, NarratorStyle, SentencePlan, VoiceMatch } from "./types";

interface StyleBase {
  speed: number;
  pitch: number;
  gainDb: number;
  tilt: number;
  pause: number;
  /** Multiplier on meaning-driven changes and random variation. */
  expressiveness: number;
  /** Multiplier on emphasis. */
  emphasis: number;
}

export const STYLE_BASE: Record<NarratorStyle, StyleBase> = {
  serious: { speed: 0.95, pitch: -0.2, gainDb: 0, tilt: -0.3, pause: 1.15, expressiveness: 0.7, emphasis: 0.8 },
  conversational: { speed: 1.03, pitch: 0.2, gainDb: 0, tilt: 0.4, pause: 0.9, expressiveness: 1, emphasis: 0.9 },
  dramatic: { speed: 0.92, pitch: 0, gainDb: 0.5, tilt: 0.3, pause: 1.35, expressiveness: 1.3, emphasis: 1.3 },
  suspenseful: { speed: 0.88, pitch: -0.7, gainDb: -1.5, tilt: -1, pause: 1.5, expressiveness: 0.9, emphasis: 1.1 },
  emotional: { speed: 0.9, pitch: -0.3, gainDb: -1, tilt: -0.5, pause: 1.3, expressiveness: 1.1, emphasis: 1 },
  energetic: { speed: 1.1, pitch: 0.6, gainDb: 1.5, tilt: 1.5, pause: 0.75, expressiveness: 1.2, emphasis: 1.1 },
};

const TURN = /^(but|however|yet|then|suddenly|until|instead|still|and then|meanwhile|except|only then|that was when|now)\b/i;
const SUSPENSE = /\b(secret|mystery|mysterious|unknown|disappeared|vanished|missing|nobody|no one|silence|silent|stolen|hidden|strange|whisper\w*|shadow\w*|darkness|in the dark|dead of night)\b/i;
const SORROW = /\b(died|dead|death|dying|lost|loss|grief|griev\w*|funeral|tragedy|tragic|mourn\w*|alone|killed|buried|cried|tears|heartbroken|never came back|last time)\b/i;
const ENERGY = /\b(exploded|explosion|crowds?|roar\w*|won|win|victory|celebrat\w*|fire|fight\w*|war|clash\w*|rush\w*|loudest|packed|thousands|millions|erupted|battle|biggest|incredible|massive)\b/i;
const FIGURES = /\d|\b(percent|million|billion|thousand|hundred|first|second|third)\b/i;

const words = (s: string) => s.match(/[\p{L}\p{N}'’-]+/gu) ?? [];

/** Deterministic noise in [-1, 1] from a string (same sentence + take → same delivery). */
export function seeded(key: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

const STOP = new Set("the a an and or but of to in on at for with by from as is was were be been it its this that these those he she they we you i his her their our my your".split(" "));
const STRESS_WORDS = /^(only|never|every|all|none|no|first|last|entire|whole|most|least|always|ever|nothing|everything|everyone|nobody|again|still|even)$/i;
/** Spelled-out figures count like digits ("three thousand"). */
const NUMBER_WORDS = /^(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|hundreds|thousand|thousands|million|millions|billion|billions|half|double|twice|dozens?)$/i;

/** Words worth stressing, best first: figures, absolutes, superlatives, mid-sentence names. */
export function emphasisCandidates(text: string): string[] {
  const ws = words(text);
  const scored = ws.map((w, i) => {
    const clean = w.replace(/[’']s$/, "");
    let score = 0;
    if (/\d/.test(clean) || NUMBER_WORDS.test(clean)) score += 3;
    if (STRESS_WORDS.test(clean)) score += 2.5;
    if (/^[a-z]{4,}est$/i.test(clean) && !/(interest|honest|forest|modest|request|protest|guest|chest|west|rest|test|best)$/i.test(clean)) score += 2;
    if (clean === "best" || clean === "worst") score += 2;
    if (i > 0 && /^[A-Z][a-z]/.test(clean) && !STOP.has(clean.toLowerCase())) score += 1.2;
    if (STOP.has(clean.toLowerCase()) || clean.length < 3) score = 0;
    // Later words carry the new information in English sentences.
    if (score) score += (i / Math.max(1, ws.length)) * 0.5;
    return { w: clean, score };
  });
  return scored
    .filter((x) => x.score >= 1.5)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.w)
    .filter((w, i, a) => a.indexOf(w) === i);
}

export interface PlanInput {
  sentences: NarratorSentence[];
  style: NarratorStyle;
  controls: NarratorControls;
  match: Pick<VoiceMatch, "speed" | "pitchShift" | "sentencePause" | "paragraphPause" | "variation"> | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r = (v: number, d = 100) => Math.round(v * d) / d;

export function planDelivery({ sentences, style, controls, match }: PlanInput): SentencePlan[] {
  const base = STYLE_BASE[style];
  // Variation: the manual control, scaled by how varied the speaker's own delivery is.
  const variety = controls.variation * (match ? 0.5 + match.variation : 1) * base.expressiveness;
  const meaning = base.expressiveness * (0.5 + controls.variation * 0.5);
  const k = (controls.intensity - 0.5) * 2;
  const sentencePause = match?.sentencePause ?? 0.55;
  const paragraphPause = match?.paragraphPause ?? 1.1;
  const plans: SentencePlan[] = [];

  sentences.forEach((s, i) => {
    const reasons: string[] = [];
    const text = s.text.trim();
    const n = words(text).length;
    const next = sentences[i + 1];
    const lastInPara = !next || next.paragraph !== s.paragraph;
    const firstInPara = i === 0 || sentences[i - 1]!.paragraph !== s.paragraph;
    let speed = base.speed;
    let pitch = base.pitch;
    let gainDb = base.gainDb;
    let tilt = base.tilt;
    let pause = (lastInPara ? paragraphPause : sentencePause) * base.pause;

    const nudge = (label: string, d: { speed?: number; pitch?: number; gain?: number; tilt?: number; pause?: number }) => {
      speed += (d.speed ?? 0) * meaning;
      pitch += (d.pitch ?? 0) * meaning;
      gainDb += (d.gain ?? 0) * meaning;
      tilt += (d.tilt ?? 0) * meaning;
      pause *= 1 + ((d.pause ?? 1) - 1) * meaning;
      reasons.push(label);
    };

    if (/\?["'”’)]*$/.test(text)) nudge("question: lift, let it land", { pitch: 0.4, pause: style === "dramatic" || style === "suspenseful" ? 1.35 : 1.1 });
    if (/!["'”’)]*$/.test(text)) nudge("exclamation: brighter, louder", { speed: 0.04, pitch: 0.5, gain: 1.5, tilt: 1 });
    if (/(…|\.\.\.)["'”’)]*$/.test(text)) nudge("trailing off: slower, longer pause", { speed: -0.03, pause: 1.5 });
    if (n <= 5) nudge("short line: given weight", { speed: -0.04, pause: 1.3 });
    else if (n > 25) nudge("long sentence: keeps moving", { speed: 0.03, pause: 1.1 });
    if (FIGURES.test(text)) nudge("figures: slower for clarity", { speed: -0.035 });
    if (SORROW.test(text)) nudge("sombre: slower, softer, lower", { speed: -0.06, pitch: -0.5, gain: -1.5, tilt: -0.6, pause: 1.25 });
    else if (SUSPENSE.test(text)) nudge("suspense: slower, darker", { speed: -0.05, pitch: -0.3, gain: -1, tilt: -0.5, pause: 1.15 });
    if (ENERGY.test(text) && !SORROW.test(text)) nudge("action: faster, brighter", { speed: 0.04, gain: 1, tilt: 0.8 });
    if (/^\(.*\)$/.test(text)) nudge("aside: lower, quicker", { speed: 0.03, pitch: -0.5, gain: -1.5 });
    if (firstInPara && i > 0) nudge("new paragraph: pitch reset", { pitch: 0.4 });
    if (lastInPara) nudge("paragraph end: settle", { speed: -0.03, pitch: -0.3 });
    if (!next) nudge("closing line: slow the finish", { speed: -0.05, pitch: -0.2 });
    // A turn in the story gets a beat before it (lengthen the previous pause).
    if (TURN.test(text) && plans.length) {
      plans[plans.length - 1]!.pauseAfter = r(plans[plans.length - 1]!.pauseAfter * (1 + 0.3 * meaning));
      reasons.push("turn: beat before it");
    }

    // Intensity (manual).
    gainDb += k * 2.5;
    tilt += k * 2;
    speed += k * 0.05;
    pitch += k * 0.5;

    // Seeded variation so neighbouring sentences never share one cadence.
    const key = `${s.id}:${s.take}`;
    speed += seeded(key, 1) * 0.035 * variety;
    pitch += seeded(key, 2) * 0.6 * variety;
    gainDb += seeded(key, 3) * 0.8 * variety;
    pause *= 1 + seeded(key, 4) * 0.18 * variety;
    const prev = plans.at(-1);
    if (prev && variety > 0.05) {
      if (Math.abs(prev.speed / (match?.speed ?? 1) / controls.speed - speed) < 0.015) speed += (speed >= 1 ? -1 : 1) * 0.025 * Math.min(1, variety);
      if (Math.abs(prev.pitch - (match?.pitchShift ?? 0) - controls.pitch - pitch) < 0.2) pitch += (seeded(key, 5) >= 0 ? 1 : -1) * 0.35 * Math.min(1, variety);
    }

    // Emphasis: the best 0–2 words, by the control.
    const want = controls.emphasis * base.emphasis;
    const count = want < 0.15 ? 0 : want > 0.75 && n > 14 ? 2 : 1;
    let emphasis = emphasisCandidates(text).slice(0, count);

    // Profile + manual controls.
    speed = speed * (match?.speed ?? 1) * controls.speed;
    pitch += (match?.pitchShift ?? 0) + controls.pitch;
    pause *= controls.pauseScale;

    const o = s.override;
    if (o) {
      if (o.speed !== undefined) speed = o.speed * (match?.speed ?? 1);
      if (o.pitch !== undefined) pitch = o.pitch + (match?.pitchShift ?? 0);
      if (o.intensity !== undefined) {
        const ko = (o.intensity - 0.5) * 2;
        gainDb = base.gainDb + ko * 3;
        tilt = base.tilt + ko * 2.4;
      }
      if (o.pauseAfter !== undefined) pause = o.pauseAfter;
      if (o.emphasis !== undefined) emphasis = o.emphasis;
      reasons.push("manual override");
    }
    plans.push({
      speed: r(clamp(speed, 0.65, 1.45), 1000),
      pitch: r(clamp(pitch, -6, 6)),
      gainDb: r(clamp(gainDb, -6, 5), 10),
      tilt: r(clamp(tilt, -4, 4), 10),
      pauseAfter: r(clamp(pause, 0.12, 5)),
      emphasis,
      // Strong emphasis in the more theatrical styles adds a beat before the word.
      beat: emphasis.length > 0 && controls.emphasis >= 0.6 && (style === "dramatic" || style === "suspenseful" || style === "emotional"),
      reasons,
    });
  });
  if (plans.length) plans[plans.length - 1]!.pauseAfter = Math.max(plans[plans.length - 1]!.pauseAfter, 0.6);
  return plans;
}
