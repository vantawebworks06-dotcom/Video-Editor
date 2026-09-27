/**
 * Assistant command parsing:  npm run test:assistant
 * Runs a table of plain-English requests through the parser against a fixed synthetic edit and
 * checks the exact actions produced (and that unclear or impossible requests are refused with
 * a reason instead of guessed).
 */
import { parseCommand, type AssistantContext } from "@/lib/assistant/parse";
import type { AssistantAction } from "@/lib/assistant/actions";
import { DEFAULT_SETTINGS, type ScenePlan } from "@/lib/domain/types";

const plan = (i: number, start: number, end: number, narration: string) => ({ sceneId: `scene_00${i}`, startTime: start, endTime: end, narration, graphics: [] }) as unknown as ScenePlan;
const ctx: AssistantContext = {
  plans: [plan(1, 0, 13.5, "In the summer of 1976…"), plan(2, 13.5, 20.6, "Within a year…"), plan(3, 20.6, 29.7, "The newspapers noticed…"), plan(4, 29.7, 40, "Rival crews…")],
  clips: [
    { clipId: "scene_001_c1", sceneId: "scene_001", start: 0, duration: 4, role: "primary", asset: { title: "Kingston aerial" } },
    { clipId: "scene_001_c2", sceneId: "scene_001", start: 4, duration: 9.5, role: "primary", asset: { title: "Harbour street" } },
    { clipId: "scene_003_c1", sceneId: "scene_003", start: 20.6, duration: 9.1, role: "primary", asset: { title: "Newspaper" } },
  ],
  settings: DEFAULT_SETTINGS,
  analysis: null,
  words: [
    { word: "The", start: 20.6, end: 20.8 },
    { word: "Gleaner", start: 24.2, end: 24.7 },
  ],
  playhead: 15,
  duration: 66.4,
  selectedClip: "scene_001_c2",
  selectedScene: "scene_001",
};

type Want = (a: AssistantAction[]) => boolean;
const is = (type: AssistantAction["type"], pred: (a: never) => boolean = () => true): Want => (a) => a.length === 1 && a[0]!.type === type && pred(a[0] as never);
const CASES: [string, Want | "error", Partial<AssistantContext>?][] = [
  ["make it warmer", is("look", (a: { scope: string; look: { temperature: number; preset: string } }) => a.scope === "project" && a.look.temperature === 0.2 && a.look.preset === "custom")],
  ["make it a lot warmer", is("look", (a: { look: { temperature: number } }) => a.look.temperature === 0.4)],
  ["slightly cooler please", is("look", (a: { look: { temperature: number } }) => a.look.temperature === -0.1)],
  ["noir look on this clip", is("look", (a: { scope: string; clipKeys: string[]; look: { preset: string } }) => a.scope === "clips" && a.clipKeys[0] === "scene_001_c2" && a.look.preset === "noir")],
  ["black and white for scene 1", is("look", (a: { scope: string; clipKeys: string[]; look: { saturation: number } }) => a.scope === "clips" && a.clipKeys.length === 2 && a.look.saturation === 0)],
  ["vintage", is("look", (a: { look: { preset: string } }) => a.look.preset === "vintage")],
  ["reset the look", is("look", (a: { look: { preset: string } }) => a.look.preset === "none")],
  ["more contrast and less grain", is("look", (a: { look: { contrast: number } }) => a.look.contrast === 1.1)],
  ["add a lower third for Delroy Marsh, sound system engineer", is("addGraphic", (a: { sceneId: string; graphic: { kind: string; title: string; sub: string; at: number } }) => a.graphic.kind === "lower_third" && a.graphic.title === "Delroy Marsh" && a.graphic.sub === "sound system engineer" && a.sceneId === "scene_002" && a.graphic.at === 1.5)],
  ["lower third Delroy Marsh (engineer) at 0:05", is("addGraphic", (a: { sceneId: string; graphic: { title: string; sub: string; at: number } }) => a.graphic.title === "Delroy Marsh" && a.graphic.sub === "engineer" && a.sceneId === "scene_001" && a.graphic.at === 5)],
  ["location tag Kingston, Jamaica in scene 3", is("addGraphic", (a: { sceneId: string; graphic: { kind: string; title: string; sub: string } }) => a.graphic.kind === "location" && a.graphic.title === "Kingston" && a.graphic.sub === "Jamaica" && a.sceneId === "scene_003")],
  ["statistic 3,000 people every Saturday", is("addGraphic", (a: { graphic: { kind: string; title: string; sub: string } }) => a.graphic.kind === "statistic" && a.graphic.title === "3,000" && a.graphic.sub === "people every Saturday")],
  ['add a quote "The loudest thing on the island" by The Gleaner', is("addGraphic", (a: { graphic: { kind: string; title: string; sub: string } }) => a.graphic.kind === "quote" && a.graphic.title === "The loudest thing on the island" && a.graphic.sub === "The Gleaner")],
  ["three years later", is("addGraphic", (a: { graphic: { kind: string; title: string } }) => a.graphic.kind === "time_jump" && a.graphic.title === "three years later")],
  ["add a lower third", "error"],
  ["suggest graphics", is("suggestGraphics")],
  ["graphics style news", is("graphicsStyle", (a: { style: { theme: string } }) => a.style.theme === "news")],
  ["make the graphics bigger", is("graphicsStyle", (a: { style: { scale: number } }) => a.style.scale === 1.1)],
  ["accent colour red", is("graphicsStyle", (a: { style: { accent: string } }) => a.style.accent === "#d7263d")],
  ["clean up the voice", is("voice", (a: { voice: { preset: string } }) => a.voice.preset === "auto")],
  ["remove the background noise", is("voice", (a: { voice: { preset: string } }) => a.voice.preset === "auto")],
  ["podcast voice", is("voice", (a: { voice: { preset: string } }) => a.voice.preset === "podcast")],
  ["make the narration louder", is("mix", (a: { mix: { voiceVolume: number } }) => a.mix.voiceVolume === 1.2)],
  ["clean up the narration", is("voice", (a: { voice: { preset: string } }) => a.voice.preset === "auto")],
  ["turn the voice down a bit", is("mix", (a: { mix: { voiceVolume: number } }) => a.mix.voiceVolume === 0.9)],
  ["turn the music up", is("mix", (a: { mix: { musicVolume: number } }) => Math.abs(a.mix.musicVolume - 0.44) < 0.01)],
  ["music quieter", is("mix", (a: { mix: { musicVolume: number } }) => Math.abs(a.mix.musicVolume - 0.26) < 0.01)],
  ["no music", is("music", (a: { track: string }) => a.track === "none")],
  ["duck the music more", is("mix", (a: { mix: { duckingStrength: number } }) => a.mix.duckingStrength === 0.85)],
  ["turn on dynamic captions", is("captions", (a: { mode: string }) => a.mode === "DYNAMIC")],
  ["captions off", is("captions", (a: { mode: string }) => a.mode === "OFF")],
  ["go to 1:20", is("seek", (a: { t: number }) => a.t === 80) , { duration: 120 }],
  ["go to 1:20", "error"],
  ["jump to scene 3", is("seek", (a: { t: number }) => a.t === 20.6)],
  ["go to scene 9", "error"],
  ["where does it mention the Gleaner", is("seek", (a: { t: number }) => a.t === 20.6)],
  ["find footage of Kingston in 1976", is("research", (a: { query: string; category: string }) => a.query === "Kingston in 1976" && a.category === "video")],
  ["search for news reports about the Harbour Street sound clash", is("research", (a: { query: string; category: string }) => a.query === "the Harbour Street sound clash" && a.category === "article")],
  ["render a draft", is("render", (a: { format: string }) => a.format === "draft")],
  ["export the vertical version", is("render", (a: { format: string }) => a.format === "vertical")],
  ["undo", is("history", (a: { direction: string }) => a.direction === "undo")],
  ["check my edit", is("check")],
  ["make it warmer and turn captions on", (a) => a.length === 2 && a[0]!.type === "look" && a[1]!.type === "captions"],
  ["noir look on this clip", "error", { selectedClip: null }],
  ["make me a sandwich", "error"],
];

let failures = 0;
for (const [text, want, over] of CASES) {
  const r = parseCommand(text, { ...ctx, ...over });
  const ok = want === "error" ? !r.ok : r.ok && want(r.actions);
  const got = r.ok ? JSON.stringify(r.actions).slice(0, 150) : `error: ${r.error}`;
  console.log(`${ok ? "✓" : "✗"} ${text.padEnd(58)} ${ok ? "" : got}`);
  if (!ok) failures++;
}
console.log(failures ? `\n${failures} of ${CASES.length} failed` : `\nall ${CASES.length} passed`);
process.exit(failures ? 1 : 0);
