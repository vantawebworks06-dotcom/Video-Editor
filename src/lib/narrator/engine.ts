/**
 * Speech engines. Kokoro-82M v1.0 (Apache-2.0) through kokoro-js: ONNX Runtime on the CPU, no
 * network after the one-time model download (~310 MB, cached in .cache/models). fp32 is used:
 * on a slow CPU it measured ~3× faster than the q8 model (1.3 s vs 4.4 s per second of speech).
 */
import path from "node:path";

export interface SynthesisRequest {
  text: string;
  voice: string;
  /** Engine speed (1 = natural). */
  speed: number;
  /** Words to stress. */
  emphasis: string[];
  /** Also give each stressed word a short beat before it (dramatic delivery). */
  beat: boolean;
}

export interface SynthesisResult {
  samples: Float32Array;
  sampleRate: number;
  /** Phonemes the model received (for diagnostics). */
  phonemes: string;
}

export interface NarratorEngine {
  id: "kokoro";
  synthesize(req: SynthesisRequest): Promise<SynthesisResult>;
}

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const VOWEL = /[aeiouæɑɐɒɔəɛɜɪʊʌɚɝiːuː]/;

/**
 * Stress a phonemised word: primary stress on its stressed syllable (secondary → primary, or on
 * the first vowel when it had none). Kokoro, like misaki's "(+2)" markup, reads stress marks.
 */
export function stressPhonemes(p: string): string {
  if (p.includes("ˈ")) return p;
  if (p.includes("ˌ")) return p.replace("ˌ", "ˈ");
  const i = p.search(VOWEL);
  if (i < 0) return p;
  // Put the mark before the syllable onset (the consonant just before the vowel), as espeak does.
  const at = i > 0 && !VOWEL.test(p[i - 1]!) ? i - 1 : i;
  return `${p.slice(0, at)}ˈ${p.slice(at)}`;
}

const MARKS = /[ˈˌ]/g;
/** Words that lead into a noun phrase: a beat goes before them, not between them and the word. */
const LEAD_IN = new Set("the a an his her its their our my your this that these those such so very".split(" "));

/**
 * Emphasis on phonemes, measured to change delivery (see scripts/test-narrator.ts):
 * the stressed word keeps its primary stress while every other word in the sentence is reduced to
 * secondary stress, so it becomes the sentence's main accent; with `beat`, a comma pause goes
 * before its phrase ("It was, the loudest sound…"), which resets pitch into the word.
 *
 * `wordPhonemes` are the phonemes of each emphasised word on its own (same phonemiser), used to
 * find it in the sentence; `text` supplies the preceding word for the beat position.
 */
export function emphasise(sentence: string, targets: { word: string; phonemes: string }[], text: string, beat: boolean): string {
  if (!targets.length) return sentence;
  const words = sentence.split(" ");
  const bare = words.map((w) => w.replace(MARKS, "").replace(/[^\p{L}ː]/gu, ""));
  const keep = new Set<number>();
  const beats = new Set<number>();
  const textWords = text.split(/\s+/);
  for (const t of targets) {
    const want = t.phonemes.replace(MARKS, "").replace(/[^\p{L}ː]/gu, "");
    if (!want) continue;
    // espeak merges short function words into the next/previous word ("wʌzðə"): match inside too.
    const i = bare.findIndex((b, j) => !keep.has(j) && (b === want || (b.length > want.length && b.endsWith(want)) || (b.length > want.length && b.startsWith(want))));
    if (i < 0) continue;
    keep.add(i);
    if (!words[i]!.includes("ˈ")) words[i] = stressPhonemes(words[i]!.replace("ˌ", ""));
    if (beat && i > 0) {
      // Before the phrase's lead-in word: "was, the loudest", not "the, loudest". espeak often
      // merges an article into the previous word ("wʌzðə"), so split it off there.
      const tIdx = textWords.findIndex((w) => w.toLowerCase().replace(/[^\p{L}\p{N}'’-]/gu, "") === t.word.toLowerCase());
      const leadIn = tIdx > 0 && LEAD_IN.has(textWords[tIdx - 1]!.toLowerCase().replace(/[^\p{L}]/gu, ""));
      const prev = words[i - 1]!;
      const merged = prev.match(/^(.+?)(ð[ˈˌ]?(?:ə|ɪ|iː)|ɐ|[ˈˌ]?ən)$/);
      if (leadIn && merged && !/[,.;:!?—…]$/.test(merged[1]!)) words[i - 1] = `${merged[1]}, ${merged[2]!.replace(MARKS, "")}`;
      else beats.add(leadIn && i - 1 > 0 && prev.replace(MARKS, "").length <= 4 ? i - 1 : i);
    }
  }
  if (!keep.size) return sentence;
  return words
    .map((w, j) => {
      const out = keep.has(j) ? w : w.replace(/ˈ/g, "ˌ").replace(/ðˌ(ə|ɪ)/g, "ð$1");
      // No beat after existing punctuation.
      return beats.has(j) && j > 0 && !/[,.;:!?—…]$/.test(words[j - 1]!) ? `, ${out}` : out;
    })
    .join(" ")
    .replace(/ ,/g, ",");
}

type Kokoro = {
  generate(text: string, o: { voice: string; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
  tokenizer: (p: string, o: unknown) => unknown;
};

let loading: Promise<Kokoro> | null = null;

async function loadKokoro(cacheRoot: string): Promise<Kokoro> {
  const [{ KokoroTTS }, { env }] = await Promise.all([import("kokoro-js"), import("@huggingface/transformers")]);
  env.cacheDir = path.join(cacheRoot, "models");
  const tts = (await KokoroTTS.from_pretrained(MODEL, { dtype: "fp32", device: "cpu" })) as unknown as Kokoro;
  return tts;
}

/** One model per process, loaded on first use. */
export function kokoroEngine(cacheRoot: string): NarratorEngine {
  return {
    id: "kokoro",
    async synthesize(req) {
      loading ??= loadKokoro(cacheRoot).catch((e) => {
        loading = null;
        throw e;
      });
      const tts = await loading;
      const tok = tts.tokenizer;
      // kokoro-js phonemises inside generate(); intercept the phonemes on their way to the tokenizer.
      const withTokenizer = async <T>(hook: (p: string, o: unknown) => unknown, run: () => Promise<T>) => {
        tts.tokenizer = Object.assign(hook, tok);
        try {
          return await run();
        } finally {
          tts.tokenizer = tok;
        }
      };
      /** Phonemes only (stops before synthesis). */
      const phonemise = async (text: string) => {
        let got = "";
        await withTokenizer(
          (p) => {
            got = p;
            throw STOP;
          },
          () => tts.generate(text, { voice: req.voice, speed: 1 }),
        ).catch((e) => {
          if (e !== STOP) throw e;
        });
        return got;
      };
      let phonemes = await phonemise(req.text);
      if (req.emphasis.length) {
        const targets = await Promise.all(req.emphasis.map(async (word) => ({ word, phonemes: await phonemise(word) })));
        phonemes = emphasise(phonemes, targets, req.text, req.beat);
      }
      const out = await withTokenizer((_p, o) => tok(phonemes, o), () => tts.generate(req.text, { voice: req.voice, speed: req.speed }));
      return { samples: out.audio, sampleRate: out.sampling_rate, phonemes };
    },
  };
}

const STOP = new Error("phonemes only");
