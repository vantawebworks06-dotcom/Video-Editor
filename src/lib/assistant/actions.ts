/**
 * What the assistant can do. Commands typed in the assistant and "Fix" buttons in the edit check
 * both produce these actions; the editor runs them through the same API routes as the panels
 * (so timeline changes are undoable). No AI service is involved: see assistant/parse.ts.
 */
import type { MediaCategory } from "@/lib/analysis/types";
import type { Graphic, GraphicsStyle } from "@/lib/domain/graphics";
import type { Look } from "@/lib/domain/look";
import type { AudioMix, CaptionMode } from "@/lib/domain/types";
import type { VoiceProcessing } from "@/lib/domain/voice";

export type AssistantAction =
  | { type: "look"; scope: "project"; look: Look }
  | { type: "look"; scope: "clips"; clipKeys: string[]; look: Look | null }
  | { type: "graphicsStyle"; style: Partial<GraphicsStyle> }
  | { type: "addGraphic"; sceneId: string; graphic: Omit<Graphic, "id"> }
  | { type: "suggestGraphics" }
  | { type: "voice"; voice: VoiceProcessing }
  | { type: "mix"; mix: Partial<AudioMix> }
  | { type: "music"; track: string }
  | { type: "captions"; mode: CaptionMode }
  | { type: "seek"; t: number; label: string }
  | { type: "selectClip"; clipKey: string; sceneId: string; t: number }
  | { type: "replaceClip"; clipKey: string; sceneId: string }
  | { type: "research"; query: string; category: MediaCategory | null }
  | { type: "openRights" }
  | { type: "history"; direction: "undo" | "redo" }
  | { type: "render"; format: "draft" | "landscape" | "vertical" }
  | { type: "check" }
  | { type: "help" };

/** Actions that only move around or open things run immediately; the rest are confirmed first. */
export function isReadOnly(a: AssistantAction): boolean {
  return a.type === "seek" || a.type === "selectClip" || a.type === "replaceClip" || a.type === "research" || a.type === "openRights" || a.type === "check" || a.type === "help";
}

/** One line describing an action, for the confirmation preview. */
export function describe(a: AssistantAction): string {
  switch (a.type) {
    case "look":
      return a.scope === "project" ? `Set the project look to ${lookName(a.look)}` : a.look ? `Give ${plural(a.clipKeys.length, "clip")} the ${lookName(a.look)} look` : `Return ${plural(a.clipKeys.length, "clip")} to the project look`;
    case "graphicsStyle":
      return `Change the graphics style (${Object.entries(a.style)
        .map(([k, v]) => `${k} → ${k === "scale" ? `${Math.round(Number(v) * 100)}%` : String(v ?? "theme default")}`)
        .join(", ")})`;
    case "addGraphic":
      return `Add a ${a.graphic.kind.replace("_", " ")} “${a.graphic.title}${a.graphic.sub ? ` — ${a.graphic.sub}` : ""}” in ${a.sceneId.replace("scene_", "scene ")} at +${a.graphic.at.toFixed(1)} s`;
    case "suggestGraphics":
      return "Suggest graphics from the script (replaces earlier suggestions, keeps yours)";
    case "voice":
      return `Set voice processing to ${a.voice.preset}`;
    case "mix":
      return `Change the mix (${Object.entries(a.mix)
        .map(([k, v]) => `${k.replace("Volume", " volume").replace("duckingStrength", "ducking")} → ${Math.round(Number(v) * 100)}%`)
        .join(", ")})`;
    case "music":
      return a.track === "none" ? "Turn the music off" : a.track === "auto" ? "Use story-driven music" : `Use the “${a.track}” music bed`;
    case "captions":
      return a.mode === "OFF" ? "Turn captions off" : `Turn ${a.mode.toLowerCase()} captions on`;
    case "seek":
      return `Go to ${a.label}`;
    case "selectClip":
      return `Select clip ${a.clipKey}`;
    case "replaceClip":
      return `Find better footage for ${a.clipKey}`;
    case "research":
      return `Search ${a.category ? `${a.category} ` : ""}sources for “${a.query}”`;
    case "openRights":
      return "Open the asset rights review";
    case "history":
      return a.direction === "undo" ? "Undo the last edit" : "Redo";
    case "render":
      return `Render a ${a.format === "draft" ? "draft preview" : a.format} video`;
    case "check":
      return "Check the edit for problems";
    case "help":
      return "Show what I can do";
  }
}

function lookName(l: Look) {
  return l.preset === "custom" ? "custom" : l.preset.replace(/_/g, " ");
}
function plural(n: number, w: string) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}
