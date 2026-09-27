/**
 * Plain-English editing commands → assistant actions, by rules (no AI service). A request can hold
 * several clauses ("make it warmer and turn captions on"); each clause is matched against the
 * command families below and resolved against the current edit ("this clip", "scene 3",
 * "at 1:20", "a bit warmer" relative to the current look). Unknown requests get the closest
 * example phrasings instead of a guess.
 */
import type { MediaCategory, TranscriptAnalysis } from "@/lib/analysis/types";
import { DEFAULT_DURATION, type GraphicKind, GraphicTheme } from "@/lib/domain/graphics";
import { DEFAULT_LOOK, type Look, LOOK_PRESETS, type LookPreset, lookValues, type LookValues } from "@/lib/domain/look";
import type { ProjectSettings, ScenePlan } from "@/lib/domain/types";
import { DEFAULT_VOICE, type VoicePreset } from "@/lib/domain/voice";
import { MUSIC_TRACKS } from "@/lib/render/libraryTracks";
import type { AssistantAction } from "./actions";

export interface AssistantClip {
  clipId: string;
  sceneId: string;
  start: number;
  duration: number;
  role: string;
  look?: Look | null;
  asset: { title: string };
}

export interface AssistantContext {
  plans: ScenePlan[];
  clips: AssistantClip[];
  settings: ProjectSettings;
  analysis: TranscriptAnalysis | null;
  words: { word: string; start: number; end: number }[];
  playhead: number;
  duration: number;
  selectedClip: string | null;
  selectedScene: string | null;
}

export type ParseResult = { ok: true; actions: AssistantAction[] } | { ok: false; error: string; examples: string[] };

export const EXAMPLES = [
  "make it warmer",
  "noir look on this clip",
  "black and white for scene 3",
  "reset the look",
  "add a lower third for Delroy Marsh, sound system engineer",
  "location tag Kingston, Jamaica at 0:05",
  "statistic 3,000 people",
  "three years later",
  "suggest graphics",
  "graphics style news",
  "clean up the voice",
  "podcast voice",
  "music quieter",
  "no music",
  "turn on dynamic captions",
  "go to 1:20",
  "go to scene 4",
  "where does it mention the Gleaner",
  "find footage of Kingston in 1976",
  "render a draft",
  "undo",
  "check my edit",
];

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const cap = (s: string) => s.replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");

/** "1:20", "1m20s", "80s", "80 seconds", "2 min", "the start", "the end". */
export function parseTime(s: string, duration: number): number | null {
  const t = s.trim().toLowerCase();
  if (/^(the )?(start|beginning|top)$/.test(t)) return 0;
  if (/^(the )?end$/.test(t)) return Math.max(0, duration - 0.5);
  let m = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = t.match(/^(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minutes?)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?))?$/);
  if (m && (m[1] || m[2])) return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  m = t.match(/^(\d+(?:\.\d+)?)$/);
  return m ? Number(m[1]) : null;
}

const TIME_RE = /\b(?:at|from)\s+(\d+:\d{1,2}(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:s|sec|secs|seconds|m|min|minutes)(?:\s*\d+(?:\.\d+)?\s*(?:s|sec|secs|seconds))?|the (?:start|beginning|end))\b/i;

function sceneByNumber(ctx: AssistantContext, n: number): ScenePlan | null {
  return ctx.plans[n - 1] ?? null;
}

function sceneAt(ctx: AssistantContext, t: number): ScenePlan | null {
  return ctx.plans.find((p) => t >= p.startTime && t < p.endTime) ?? ctx.plans.at(-1) ?? null;
}

/** Split into clauses on "and"/"then"/";", keeping "black and white" and quoted text intact. */
export function clauses(text: string): string[] {
  const quotes: string[] = [];
  let s = text.replace(/["“]([^"”]+)["”]/g, (_, q: string) => `\u0000${quotes.push(q) - 1}\u0000`);
  s = s.replace(/black\s+and\s+white/gi, "blackwhite").replace(/rock\s+and\s+roll/gi, "rock\u0001roll");
  return s
    .split(/\s*(?:;|,?\s+and then\s+|,?\s+then\s+|\s+and\s+(?=(?:make|turn|add|put|set|use|go|jump|render|remove|give|find|suggest|clean|music|captions?|graphics|voice|undo)\b))/i)
    .map((c) => c.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `"${quotes[Number(i)]}"`).replace(/blackwhite/g, "black and white").replace(/\u0001/g, " and "))
    .map((c) => c.trim())
    .filter(Boolean);
}

export function parseCommand(text: string, ctx: AssistantContext): ParseResult {
  const parts = clauses(text);
  if (!parts.length) return { ok: false, error: "Type what you'd like to change.", examples: EXAMPLES.slice(0, 6) };
  const actions: AssistantAction[] = [];
  for (const c of parts) {
    const r = parseClause(c, ctx);
    if ("error" in r) return { ok: false, error: parts.length > 1 ? `“${c}”: ${r.error}` : r.error, examples: r.examples ?? closestExamples(c) };
    actions.push(...r.actions);
  }
  return { ok: true, actions };
}

type ClauseResult = { actions: AssistantAction[] } | { error: string; examples?: string[] };

function parseClause(raw: string, ctx: AssistantContext): ClauseResult {
  const c = raw.trim();
  const l = c.toLowerCase().replace(/[’']/g, "'");
  const one = (a: AssistantAction): ClauseResult => ({ actions: [a] });

  if (/^(help|\?|what can you do|commands|examples)\b/.test(l)) return one({ type: "help" });
  if (/^(undo|go back one step|revert( that)?)\b/.test(l)) return one({ type: "history", direction: "undo" });
  if (/^redo\b/.test(l)) return one({ type: "history", direction: "redo" });
  if (/\b(check|review|audit|problems?|issues?|what's wrong|what is wrong|health|anything missing|mistakes?)\b/.test(l) && !/\b(look|music|voice|caption)/.test(l)) return one({ type: "check" });

  // Render / export.
  if (/^(render|export|make|create|build)\b.*\b(draft|preview|video|film|final|vertical|landscape|mp4|render)\b/.test(l) && /\b(render|export|draft|preview|mp4)\b/.test(l) && !/\blook\b/.test(l)) {
    const format = /\bvertical|portrait|9:16|shorts?|reels?|tiktok\b/.test(l) ? "vertical" : /\b(final|full|landscape|hd|1080)\b/.test(l) ? "landscape" : "draft";
    return one({ type: "render", format });
  }

  // Research: "find footage of X".
  let m = c.match(/^(?:please\s+)?(?:find|search(?: for)?|look for|get|fetch|source)(?: me)?(?: some| more)?\s+(?:stock\s+)?(footage|photos?|pictures?|images?|videos?|clips?|b-?roll|archive(?:\s+footage)?|sources?|news(?:\s+reports?)?|interviews?|articles?)\s+(?:of|about|for|showing|with|from|on)\s+(.+)$/i);
  if (m) {
    const noun = m[1]!.toLowerCase();
    const category: MediaCategory | null = /footage|video|clip|b-?roll|archive/.test(noun) ? "video" : /photo|picture|image/.test(noun) ? "photo" : /news|article/.test(noun) ? "article" : /interview/.test(noun) ? "interview" : null;
    return one({ type: "research", query: cap(m[2]!), category });
  }

  // Find a moment in the narration.
  m = c.match(/^(?:where\s+(?:does\s+(?:it|the narration|he|she|they)\s+)?(?:mention|say|talk about|says|mentions|is)|find\s+(?:where\s+(?:it\s+)?(?:mentions|says)|the\s+(?:part|bit|moment)\s+(?:about|where))|go to\s+(?:where\s+(?:it\s+)?(?:mentions|says)|the\s+(?:part|bit|moment)\s+(?:about|where)))\s+(.+?)\??$/i);
  if (m) {
    const q = cap(m[1]!).replace(/^["']|["']$/g, "").toLowerCase();
    const hit = findInNarration(q, ctx);
    return hit ? one({ type: "seek", t: hit.t, label: `“${hit.text}” (${fmt(hit.t)})` }) : { error: `I couldn't find “${q}” in the narration.` };
  }

  // Navigation.
  m = l.match(/^(?:go|jump|skip|seek|move|take me)(?: back| forward)?\s+to\s+(?:scene|section)\s*#?(\d+)$/) ?? l.match(/^(?:scene|section)\s*#?(\d+)$/);
  if (m) {
    const p = sceneByNumber(ctx, Number(m[1]));
    return p ? one({ type: "seek", t: p.startTime, label: `scene ${Number(m[1])} (${fmt(p.startTime)})` }) : { error: `There are ${ctx.plans.length} scenes.` };
  }
  m = l.match(/^(?:go|jump|skip|seek|move|take me)(?: back| forward)?\s+to\s+(.+)$/);
  if (m) {
    const t = parseTime(m[1]!.replace(/^(the )?(time )?/, (x) => (/start|beginning|end/.test(m![1]!) ? x : "")), ctx.duration);
    if (t !== null) return t > ctx.duration + 0.5 ? { error: `The narration is only ${fmt(ctx.duration)} long.` } : one({ type: "seek", t, label: fmt(t) });
  }

  // Graphics style.
  if (/\bgraphics?\b|\blower thirds?\b|\btitles?\b|\baccent\b/.test(l) && !/\badd|put|insert|show|create\b/.test(l)) {
    const theme = GraphicTheme.options.find((t) => new RegExp(`\\b${t}\\b`).test(l));
    if (theme && /\b(style|theme|look|use|make|set|switch|change)\b|^graphics? /.test(l)) return one({ type: "graphicsStyle", style: { theme } });
    if (/\b(bigger|larger|smaller|tinier|size)\b/.test(l)) {
      const k = /\b(bigger|larger)\b/.test(l) ? 1 : -1;
      return one({ type: "graphicsStyle", style: { scale: r2(clamp(ctx.settings.graphics.scale + k * amount(l) * 0.1, 0.6, 1.5)) } });
    }
    const col = colorIn(l);
    if (col !== undefined && /\baccent|colou?r\b/.test(l)) return one({ type: "graphicsStyle", style: { accent: col } });
  }
  if (/\b(suggest|auto(?:matic(?:ally)?)?|generate)\b.*\bgraphics?\b|\bgraphics?\b.*\bfrom (?:the )?script\b/.test(l)) return one({ type: "suggestGraphics" });

  // Add a graphic.
  const g = parseGraphic(c, l, ctx);
  if (g) return g;

  // Captions.
  if (/\b(captions?|subtitles?|subs)\b/.test(l)) {
    if (/\b(off|remove|no|disable|hide|without)\b/.test(l)) return one({ type: "captions", mode: "OFF" });
    return one({ type: "captions", mode: /\b(dynamic|animated|word[- ]by[- ]word|tiktok|karaoke|highlight)/.test(l) ? "DYNAMIC" : "STANDARD" });
  }

  // Voice.
  if (/\b(voice|narration|narrator|vocals?|dialogue|speech|background noise|hiss|noise|echo|room)\b/.test(l) && !/\bmusic\b/.test(l)) {
    if (/\b(louder|boost|raise|turn (?:it |the \w+ )?up|(?:voice|narration) up)\b/.test(l) && !/\bnoise\b/.test(l)) return one({ type: "mix", mix: { voiceVolume: r2(clamp(ctx.settings.mix.voiceVolume * (1 + 0.2 * amount(l)), 0, 1.5)) } });
    if (/\b(quieter|softer|lower|turn (?:it |the \w+ )?down|(?:voice|narration) down|reduce the voice)\b/.test(l) && !/\bnoise\b/.test(l)) return one({ type: "mix", mix: { voiceVolume: r2(clamp(ctx.settings.mix.voiceVolume * (1 - 0.2 * amount(l)), 0, 1.5)) } });
    const preset = (["podcast", "broadcast", "documentary", "natural"] as VoicePreset[]).find((p) => l.includes(p));
    if (preset) return one({ type: "voice", voice: { ...DEFAULT_VOICE, preset } });
    if (/\b(no|off|disable|raw|remove)\b.*\b(processing|effects?|enhancement)\b|\b(unprocessed|original voice)\b/.test(l)) return one({ type: "voice", voice: { ...DEFAULT_VOICE, preset: "off" } });
    if (/\b(clean|fix|improve|enhance|better|polish|reduce|remove|denoise|cut|less)\b/.test(l)) return one({ type: "voice", voice: { ...DEFAULT_VOICE, preset: "auto" } });
  }

  // Music.
  if (/\b(music|soundtrack|score|song|bed|ducking)\b/.test(l)) {
    const track = MUSIC_TRACKS.find((t) => l.includes(t.name.toLowerCase()) || l.includes(t.key.toLowerCase()));
    if (track) return one({ type: "music", track: track.key });
    if (/\b(no|off|remove|mute|kill|without|stop)\b/.test(l)) return one({ type: "music", track: "none" });
    if (/\bduck/.test(l)) {
      const k = /\b(less|lighter|softer)\b/.test(l) ? -1 : 1;
      return one({ type: "mix", mix: { duckingStrength: r2(clamp(ctx.settings.mix.duckingStrength + k * 0.15 * amount(l), 0, 1)) } });
    }
    if (/\b(quieter|softer|lower|down|less|reduce|too loud)\b/.test(l)) return one({ type: "mix", mix: { musicVolume: r2(clamp(ctx.settings.mix.musicVolume * (1 - 0.25 * amount(l)), 0, 1.5)) } });
    if (/\b(louder|turn (?:it |the music )?up|music up|more|boost|raise)\b/.test(l)) return one({ type: "mix", mix: { musicVolume: r2(clamp(ctx.settings.mix.musicVolume * (1 + 0.25 * amount(l)), 0, 1.5)) } });
    if (/\b(on|back|auto|story|add|use)\b/.test(l)) return one({ type: "music", track: "auto" });
  }

  // Looks.
  const look = parseLook(l, ctx);
  if (look) return look;

  return { error: "I didn't understand that. Try one of these:" };
}

function amount(l: string): number {
  if (/\b(much|a lot|way|lots|really|very|heavily|strongly)\b/.test(l)) return 2;
  if (/\b(slightly|a bit|a little|bit|little|touch|tad|subtly)\b/.test(l)) return 0.5;
  return 1;
}

const COLORS: Record<string, string> = { red: "#d7263d", yellow: "#ffd400", gold: "#f2b441", orange: "#ff8c1a", green: "#3aa655", teal: "#1fa3a3", blue: "#2f6fdb", purple: "#8a5cf6", pink: "#e0559b", white: "#ffffff", black: "#111111" };
function colorIn(l: string): string | null | undefined {
  const hex = l.match(/#[0-9a-f]{6}\b/);
  if (hex) return hex[0];
  if (/\b(default|theme|reset)\b/.test(l)) return null;
  const name = Object.keys(COLORS).find((k) => new RegExp(`\\b${k}\\b`).test(l));
  return name ? COLORS[name] : undefined;
}

function fmt(t: number) {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, "0")}`;
}

function findInNarration(q: string, ctx: AssistantContext): { t: number; text: string } | null {
  const needle = q.replace(/[^\p{L}\p{N}\s]/gu, "").trim();
  if (!needle) return null;
  const s = ctx.analysis?.sentences.find((x) => x.text.toLowerCase().includes(needle));
  if (s) return { t: s.start, text: s.text.length > 60 ? `${s.text.slice(0, 57)}…` : s.text };
  const first = needle.split(/\s+/)[0]!;
  const w = ctx.words.find((x) => x.word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") === first);
  return w ? { t: w.start, text: w.word } : null;
}

const KIND_WORDS: [RegExp, GraphicKind][] = [
  [/\b(lower[- ]?third|name (?:tag|title|graphic|card|strap)|name super|super|nameplate)\b/, "lower_third"],
  [/\b(location(?: tag)?|place(?: tag| name)?|dateline)\b/, "location"],
  [/\b(date(?: stamp)?|year(?: stamp)?|timestamp)\b/, "date"],
  [/\b(time[- ]?jump)\b/, "time_jump"],
  [/\b(stat(?:istic)?|number|figure|big number|counter)\b/, "statistic"],
  [/\b(pull[- ]?quote|quote|quotation)\b/, "quote"],
  [/\b(headline|newspaper|clipping)\b/, "headline"],
  [/\b(chapter(?: title| card)?|title card|section title)\b/, "chapter"],
];

function parseGraphic(c: string, l: string, ctx: AssistantContext): ClauseResult | null {
  // "three years later" / "a decade later" on its own is a time jump.
  const later = l.match(/^(?:add\s+(?:a\s+)?)?((?:\w+|\d+)\s+(?:years?|months?|weeks?|days?|decades?|hours?)\s+(?:later|earlier|before|after)|(?:the\s+)?next\s+(?:day|morning|year|week))$/);
  let kind: GraphicKind | null = later ? "time_jump" : null;
  let rest = later ? later[1]! : "";
  if (!kind) {
    const verb = /^(?:please\s+)?(?:add|put|insert|show|create|make|place|give me|i want|use)\b/.test(l);
    for (const [re, k] of KIND_WORDS) {
      const mm = l.match(re);
      if (!mm) continue;
      // Without a verb, a kind word must start the clause ("quote …", "lower third …").
      if (!verb && mm.index! > 0) continue;
      kind = k;
      rest = c.slice(mm.index! + mm[0].length);
      break;
    }
  }
  if (!kind) return null;

  // Where: "at 1:20", "in scene 3", else the playhead.
  let t = ctx.playhead;
  const tm = rest.match(TIME_RE);
  if (tm) {
    const v = parseTime(tm[1]!, ctx.duration);
    if (v !== null) t = v;
    rest = rest.replace(tm[0], " ");
  }
  const sm = rest.match(/\b(?:in|on)\s+scene\s*#?(\d+)\b/i);
  if (sm) {
    const p = sceneByNumber(ctx, Number(sm[1]));
    if (!p) return { error: `There are ${ctx.plans.length} scenes.` };
    if (!tm) t = p.startTime + 0.5;
    rest = rest.replace(sm[0], " ");
  }
  rest = rest.replace(/^\s*(?:for|saying|that says|with|of|:|-|reading|showing)\s+/i, "").replace(/^\s*(?:the\s+)?(?:text|words?)\s+/i, "").trim();

  let title = "";
  let sub = "";
  if (kind === "quote") {
    const q = rest.match(/^"([^"]+)"\s*(?:(?:by|from|—|--|-|,)\s*(.+))?$/);
    if (q) [title, sub] = [q[1]!, q[2] ?? ""];
    else [title, sub] = splitPair(rest);
  } else if (kind === "statistic") {
    const n = rest.match(/^([$£€]?\d[\d,.]*\s?(?:%|percent|million|billion|thousand|[kmb]\b)?)\s*(.*)$/i);
    if (n) [title, sub] = [n[1]!.trim(), n[2]!.trim()];
    else [title, sub] = splitPair(rest);
  } else if (kind === "time_jump") {
    title = rest;
  } else {
    [title, sub] = splitPair(rest);
  }
  title = cap(title.replace(/^"|"$/g, ""));
  sub = cap(sub.replace(/^"|"$/g, ""));
  if (!title) return { error: `What should the ${kind.replace("_", " ")} say? For example: “add a lower third for Delroy Marsh, sound system engineer”.` };
  const plan = sceneAt(ctx, t);
  if (!plan) return { error: "Generate the edit first — graphics sit on the edit's scenes." };
  const at = r2(clamp(t - plan.startTime, 0, Math.max(0, plan.endTime - plan.startTime - 0.5)));
  return { actions: [{ type: "addGraphic", sceneId: plan.sceneId, graphic: { kind, title: title.slice(0, 90), sub: sub.slice(0, 140), at, duration: DEFAULT_DURATION[kind], position: "auto", animation: "auto", source: "user" } }] };
}

/** "Name, role" / "Name - role" / "Name (role)" / "Name as role" / "Name who is role". */
function splitPair(s: string): [string, string] {
  const t = s.trim();
  let m = t.match(/^(.+?)\s*\((.+)\)$/);
  if (m) return [m[1]!, m[2]!];
  m = t.match(/^(.+?)\s*(?:,|\s[-–—]\s|\s+as\s+(?:the\s+)?|\s+who\s+is\s+(?:a\s+|the\s+)?|\s+the\s+(?=[a-z]))(.+)$/i);
  if (m) return [m[1]!, m[2]!];
  return [t, ""];
}

const PRESET_WORDS: [RegExp, Exclude<LookPreset, "custom">][] = [
  [/\bnoir\b/, "noir"],
  [/\bvintage|retro|old[- ]school|70s|seventies\b/, "vintage"],
  [/\bfaded|matte|washed[- ]out|film look\b/, "faded_film"],
  [/\bbleach(?:[- ]bypass)?\b/, "bleach_bypass"],
  [/\bteal(?: and| &)? orange|blockbuster|cinematic\b/, "teal_orange"],
  [/\bcold thriller|thriller|cold look\b/, "cold_thriller"],
  [/\bwarm documentary|documentary look\b/, "warm_documentary"],
  [/\bnatural look|natural colou?rs?\b/, "natural"],
];

function parseLook(l: string, ctx: AssistantContext): ClauseResult | null {
  // Scope: this clip / scene N / this scene / (default) the whole film.
  let scope: "project" | "clips" = "project";
  let clipKeys: string[] = [];
  if (/\b(this|selected|current) (clip|shot|visual|image|photo|video)\b/.test(l)) {
    if (!ctx.selectedClip) return { error: "Select a clip on the timeline first, then ask again." };
    scope = "clips";
    clipKeys = [ctx.selectedClip];
  } else {
    const sm = l.match(/\bscene\s*#?(\d+)\b/);
    const sceneId = sm ? sceneByNumber(ctx, Number(sm[1]))?.sceneId : /\b(this|current|selected) scene\b/.test(l) ? (ctx.selectedScene ?? sceneAt(ctx, ctx.playhead)?.sceneId) : null;
    if (sm && !sceneId) return { error: `There are ${ctx.plans.length} scenes.` };
    if (sceneId) {
      scope = "clips";
      clipKeys = ctx.clips.filter((c) => c.sceneId === sceneId).map((c) => c.clipId);
      if (!clipKeys.length) return { error: "That scene has no visuals yet." };
    }
  }
  const baseLook = (): Look => (scope === "clips" ? (ctx.clips.find((c) => c.clipId === clipKeys[0])?.look ?? ctx.settings.look) : ctx.settings.look);
  const done = (look: Look | null): ClauseResult => ({ actions: [scope === "project" ? { type: "look", scope: "project", look: look ?? { ...DEFAULT_LOOK } } : { type: "look", scope: "clips", clipKeys, look }] });

  if (/\b(reset|remove|clear|no|original|undo)\b.*\b(look|grade|grading|colou?rs?|filter|effects?)\b|\b(no filter|original colou?rs?)\b/.test(l)) {
    return done(scope === "clips" && /\b(project|film)\b/.test(l) ? null : { ...DEFAULT_LOOK });
  }
  for (const [re, preset] of PRESET_WORDS) if (re.test(l)) return done({ preset, ...LOOK_PRESETS[preset] });

  // Relative adjustments to the current look.
  const k = amount(l);
  const v: LookValues = { ...lookValues(baseLook()) };
  let changed = false;
  const adj = (key: keyof LookValues, d: number, lo: number, hi: number) => {
    v[key] = r2(clamp(v[key] + d * k, lo, hi));
    changed = true;
  };
  if (/\b(black and white|b&w|b\/w|monochrome|gr[ae]yscale|mono)\b/.test(l)) {
    v.saturation = 0;
    changed = true;
  }
  if (/\bwarm(er)?\b/.test(l)) adj("temperature", 0.2, -1, 1);
  if (/\b(cool(er)?|cold(er)?|blu(e|er))\b/.test(l)) adj("temperature", -0.2, -1, 1);
  if (/\bbright(er|en)?\b|\blighter\b/.test(l)) adj("exposure", 0.15, -1, 1);
  if (/\bdark(er|en)?\b(?! corners)/.test(l) && !/\bvignette\b/.test(l)) adj("exposure", -0.15, -1, 1);
  if (/\b(more contrast|punch(ier|y)?|contrasty|higher contrast)\b/.test(l)) adj("contrast", 0.1, 0.5, 1.6);
  if (/\b(less contrast|flatter|flat|softer contrast|lower contrast)\b/.test(l)) adj("contrast", -0.1, 0.5, 1.6);
  if (/\b(more (saturated|colou?rful|vivid)|saturate|vibrant|vivid|colou?rful|more colou?r)\b/.test(l)) adj("saturation", 0.2, 0, 2);
  if (/\b(less (saturated|colou?r)|desaturated?|muted|dull|washed)\b/.test(l)) adj("saturation", -0.2, 0, 2);
  if (/\b(no|remove|without) grain\b/.test(l)) {
    v.grain = 0;
    changed = true;
  } else if (/\b(less grain)\b/.test(l)) adj("grain", -0.2, 0, 1);
  else if (/\b(grain|grainy|film grain|more grain)\b/.test(l)) adj("grain", 0.2, 0, 1);
  if (/\b(no|remove|without) vignette\b/.test(l)) {
    v.vignette = 0;
    changed = true;
  } else if (/\b(vignette|dark(er)? corners|darken the (edges|corners))\b/.test(l)) adj("vignette", 0.2, 0, 1);
  if (/\b(sharp(er|en)?|crisp(er)?)\b/.test(l)) adj("sharpen", 0.2, 0, 1);
  if (/\b(faded|lift(ed)? (the )?blacks|matte)\b/.test(l)) adj("fade", 0.15, 0, 1);
  if (!changed) return null;
  return done({ preset: "custom", ...v });
}

/** The examples closest to what was typed (shared words), for a helpful "didn't understand". */
export function closestExamples(text: string): string[] {
  const words = new Set(text.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  return [...EXAMPLES]
    .map((e) => ({ e, s: e.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
    .map((x) => x.e);
}
