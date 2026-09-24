import { existsSync } from "node:fs";
import type { Timeline } from "@/lib/domain/types";
import { library } from "./library";

export interface AudioGraph {
  inputs: string[];
  filters: string[];
  label: string | null;
  inputCount: number;
}

/**
 * Mix VOICE > SFX > MUSIC > AMBIENCE. Music and ambience are ducked under the narration
 * with a sidechain compressor keyed by the voice. `firstInput` is the FFmpeg input index
 * the audio inputs start at.
 */
export function buildAudioGraph(t: Timeline, firstInput: number): AudioGraph {
  const inputs: string[] = [];
  const filters: string[] = [];
  const mix = t.audio.mix;
  const D = t.duration.toFixed(3);
  let n = firstInput;
  const buses: string[] = [];
  const fmt = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";

  let voiceKey: string | null = null;
  if (t.audio.voice) {
    inputs.push("-i", t.audio.voice);
    const i = n++;
    filters.push(`[${i}:a]${fmt},loudnorm=I=-16:TP=-1.5:LRA=11,volume=${mix.voiceVolume.toFixed(3)},apad,atrim=0:${D},asplit=3[voice][vkey1][vkey2]`);
    buses.push("[voice]");
    voiceKey = "vkey";
  }

  // Ducking: higher strength → harder ratio, lower threshold.
  const ratio = (2 + mix.duckingStrength * 14).toFixed(2);
  const threshold = (0.1 - mix.duckingStrength * 0.085).toFixed(4);

  const bed = (file: string | null, volume: number, label: string, key: string) => {
    if (!file || volume <= 0) return;
    inputs.push("-stream_loop", "-1", "-i", file);
    const i = n++;
    filters.push(`[${i}:a]${fmt},volume=${volume.toFixed(3)},atrim=0:${D},afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, t.duration - 2.5).toFixed(3)}:d=2.5[${label}raw]`);
    if (voiceKey) {
      filters.push(`[${label}raw][${key}]sidechaincompress=threshold=${threshold}:ratio=${ratio}:attack=15:release=450:makeup=1[${label}]`);
    } else {
      filters.push(`[${label}raw]anull[${label}]`);
    }
    buses.push(`[${label}]`);
  };
  bed(t.audio.music, mix.musicVolume, "music", "vkey1");
  bed(t.audio.ambience, mix.ambienceVolume, "amb", "vkey2");
  if (voiceKey) {
    // Consume unused sidechain keys so the graph has no dangling outputs.
    if (!t.audio.music || mix.musicVolume <= 0) filters.push(`[vkey1]anullsink`);
    if (!t.audio.ambience || mix.ambienceVolume <= 0) filters.push(`[vkey2]anullsink`);
  }

  // One input per distinct SFX file; each cue is a delayed copy.
  const cues = t.audio.sfx.filter((c) => c.start < t.duration && existsSync(library.sfx(c.kind)));
  const byKind = new Map<string, typeof cues>();
  for (const c of cues) byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c]);
  for (const [kind, list] of byKind) {
    inputs.push("-i", library.sfx(kind as never));
    const i = n++;
    const outs = list.map((_, k) => `[sfx_${kind}_${k}]`);
    filters.push(`[${i}:a]${fmt},${list.length === 1 ? "anull" : `asplit=${list.length}`}${outs.join("")}`);
    list.forEach((c, k) => {
      const ms = Math.round(c.start * 1000);
      filters.push(`${outs[k]}volume=${(mix.sfxVolume * c.volume).toFixed(3)},adelay=${ms}|${ms}[sfxd_${kind}_${k}]`);
      buses.push(`[sfxd_${kind}_${k}]`);
    });
  }

  if (!buses.length) return { inputs, filters, label: null, inputCount: n - firstInput };
  filters.push(`${buses.join("")}amix=inputs=${buses.length}:normalize=0:duration=longest:dropout_transition=0,atrim=0:${D},alimiter=limit=0.95:level=disabled[aout]`);
  return { inputs, filters, label: "aout", inputCount: n - firstInput };
}
