import type { TextClip, Timeline, Word } from "@/lib/domain/types";
import { fontAvailable } from "./library";

/**
 * Build an ASS subtitle document for text emphasis and captions. Text lives in this file,
 * never on the FFmpeg command line, so user text cannot inject filter syntax.
 */
export function buildAss(t: Timeline): string {
  const W = t.width;
  const H = t.height;
  const textFont = fontAvailable("Anton-Regular.ttf") ? "Anton" : "Arial Black";
  const capFont = fontAvailable("Inter.ttf") ? "Inter" : "Arial";
  const outline = Math.max(2, Math.round(H / 270));
  const capSize = t.captions.fontSize;

  const styles = [
    // Name, Font, Size, Primary, Secondary, Outline, Back, Bold, Italic, Underline, Strike, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Align, ML, MR, MV, Encoding
    `Style: Emphasis,${textFont},120,&H00FFFFFF,&H000000FF,&H00101010,&H96000000,0,0,0,0,100,100,2,0,1,${outline * 2},${outline},5,60,60,60,1`,
    `Style: Statement,${textFont},96,&H00101010,&H000000FF,&H00FFFFFF,&H00F2F2F2,0,0,0,0,100,100,1,0,3,${Math.round(outline * 4)},0,5,80,80,60,1`,
    `Style: Stat,${textFont},170,&H0000D7FF,&H000000FF,&H00101010,&H96000000,0,0,0,0,100,100,2,0,1,${outline * 2},${outline},5,60,60,60,1`,
    `Style: Caption,${capFont},${capSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,${outline + 1},${Math.max(1, outline - 1)},2,${Math.round(W * 0.08)},${Math.round(W * 0.08)},${Math.round(H * 0.07)},1`,
  ];

  const events: string[] = [];
  for (const clip of t.texts) events.push(...textEvents(clip, W, H));
  if (t.captions.mode !== "OFF") events.push(...captionEvents(t, W, H));

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

/** Strip ASS control characters from user/AI text. */
export function escapeAss(text: string): string {
  return text.replace(/[{}\\]/g, "").replace(/\r?\n/g, " ").trim();
}

function ts(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
}

function anchor(pos: TextClip["position"], W: number, H: number): { an: number; x: number; y: number } {
  switch (pos) {
    case "top":
      return { an: 8, x: W / 2, y: H * 0.1 };
    case "bottom":
      return { an: 2, x: W / 2, y: H * 0.78 };
    case "left":
      return { an: 4, x: W * 0.08, y: H / 2 };
    case "right":
      return { an: 6, x: W * 0.92, y: H / 2 };
    default:
      return { an: 5, x: W / 2, y: H / 2 };
  }
}

function textEvents(c: TextClip, W: number, H: number): string[] {
  const text = escapeAss(c.text);
  if (!text) return [];
  const style = c.style === "statistic" ? "Stat" : c.style === "statement" ? "Statement" : "Emphasis";
  const { an, x, y } = anchor(c.position, W, H);
  const size = `\\fs${Math.round(c.fontSize)}`;
  const start = c.start;
  const end = c.start + c.duration;
  const base = `\\an${an}${size}`;
  const line = (s: number, e: number, tags: string, body: string) =>
    `Dialogue: 2,${ts(s)},${ts(e)},${style},,0,0,0,,{${tags}}${body}`;

  switch (c.animation) {
    case "pop":
      return [line(start, end, `${base}\\pos(${x},${y})\\fscx40\\fscy40\\t(0,110,\\fscx112\\fscy112)\\t(110,190,\\fscx100\\fscy100)\\fad(0,160)`, text)];
    case "slide_up":
      return [line(start, end, `${base}\\move(${x},${y + H * 0.06},${x},${y},0,260)\\fad(140,160)`, text)];
    case "fade":
      return [line(start, end, `${base}\\pos(${x},${y})\\fad(250,250)`, text)];
    case "typewriter": {
      // Reveal word by word.
      const words = text.split(/\s+/);
      const step = Math.min(0.25, (c.duration * 0.5) / words.length);
      return words.map((_, i) =>
        line(start + i * step, i === words.length - 1 ? end : start + (i + 1) * step, `${base}\\pos(${x},${y})`, words.slice(0, i + 1).join(" ")),
      );
    }
    default:
      return [line(start, end, `${base}\\pos(${x},${y})`, text)];
  }
}

/** Caption chunks: up to ~6 words / 2.6s, broken at sentence ends. */
export function chunkWords(words: Word[]): { start: number; end: number; idx: number[] }[] {
  const chunks: { start: number; end: number; idx: number[] }[] = [];
  let cur: number[] = [];
  words.forEach((w, i) => {
    cur.push(i);
    const first = words[cur[0]!]!;
    const tooLong = w.end - first.start > 2.6 || cur.length >= 6;
    if (/[.!?,;:]$/.test(w.word) || tooLong || i === words.length - 1) {
      chunks.push({ start: first.start, end: w.end, idx: cur });
      cur = [];
    }
  });
  // Hold each chunk until the next begins (avoids flicker), max +0.6s.
  for (let i = 0; i < chunks.length - 1; i++) {
    chunks[i]!.end = Math.min(chunks[i + 1]!.start, chunks[i]!.end + 0.6);
  }
  return chunks;
}

function captionEvents(t: Timeline, W: number, H: number): string[] {
  const words = t.captions.words;
  const emph = new Set(t.captions.emphasized);
  const pos =
    t.captions.position === "middle"
      ? `\\an5\\pos(${W / 2},${H * 0.62})`
      : t.captions.position === "top"
        ? `\\an8\\pos(${W / 2},${H * 0.08})`
        : "";
  const clean = (w: Word) => escapeAss(w.word);
  const out: string[] = [];

  for (const chunk of chunkWords(words)) {
    if (t.captions.mode === "STANDARD") {
      out.push(`Dialogue: 1,${ts(chunk.start)},${ts(chunk.end)},Caption,,0,0,0,,{${pos}}${chunk.idx.map((i) => clean(words[i]!)).join(" ")}`);
      continue;
    }
    // DYNAMIC: one event per word; the spoken word pops, emphasised words stay yellow.
    chunk.idx.forEach((active, k) => {
      const s = words[active]!.start;
      const e = k === chunk.idx.length - 1 ? chunk.end : words[chunk.idx[k + 1]!]!.start;
      if (e <= s) return;
      const body = chunk.idx
        .map((i) => {
          const w = clean(words[i]!);
          if (i === active) return `{\\c&H0000E5FF&\\fscx112\\fscy112}${w}{\\r}`;
          if (emph.has(i)) return `{\\c&H0000D7FF&}${w}{\\r}`;
          return w;
        })
        .join(" ");
      out.push(`Dialogue: 1,${ts(s)},${ts(e)},Caption,,0,0,0,,{${pos}}${body}`);
    });
  }
  return out;
}
