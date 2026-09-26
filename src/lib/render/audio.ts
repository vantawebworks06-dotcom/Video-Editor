import { existsSync } from "node:fs";
import type { Timeline } from "@/lib/domain/types";
import { gainExpression } from "@/lib/pipeline/music";
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
  // Measured: the old 12:1 ducking left music ~25 dB under the voice — inaudible. Documentary beds
  // sit ~12-15 dB under narration and rise in the pauses; this keeps the voice on top without
  // burying the score.
  const ratio = (1.5 + mix.duckingStrength * 2.5).toFixed(2);
  const threshold = (0.15 - mix.duckingStrength * 0.05).toFixed(4);

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
  const musicCues = (t.audio.musicCues ?? []).filter((c) => c.end - c.start > 0.5 && existsSync(c.file));
  if (musicCues.length && mix.musicVolume > 0) {
    // Story-driven music: each section is its own input — trimmed, levelled, shaped by its gain
    // envelope (intensity curve), faded in/out for crossfades, delayed into place — then summed
    // and ducked under the voice like a single bed.
    const labels: string[] = [];
    musicCues.forEach((c, k) => {
      inputs.push("-stream_loop", "-1", "-i", c.file);
      const i = n++;
      const len = c.end - c.start;
      const ms = Math.round(c.start * 1000);
      const gain = `volume='${gainExpression(c.gains)}':eval=frame`;
      const fades = `afade=t=in:d=${Math.min(c.fadeIn, len / 2).toFixed(3)},afade=t=out:st=${Math.max(0, len - c.fadeOut).toFixed(3)}:d=${Math.min(c.fadeOut, len / 2).toFixed(3)}`;
      filters.push(`[${i}:a]${fmt},atrim=start=${c.offset.toFixed(3)}:duration=${len.toFixed(3)},asetpts=PTS-STARTPTS,volume=${(mix.musicVolume * c.trim).toFixed(3)},${gain},${fades},adelay=${ms}|${ms}[mc${k}]`);
      labels.push(`[mc${k}]`);
    });
    filters.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest:dropout_transition=0,apad,atrim=0:${D}[musicraw]`);
    if (voiceKey) filters.push(`[musicraw][vkey1]sidechaincompress=threshold=${threshold}:ratio=${ratio}:attack=15:release=450:makeup=1[music]`);
    else filters.push(`[musicraw]anull[music]`);
    buses.push("[music]");
  } else {
    bed(t.audio.music, mix.musicVolume, "music", "vkey1");
  }
  bed(t.audio.ambience, mix.ambienceVolume, "amb", "vkey2");
  if (voiceKey) {
    // Consume unused sidechain keys so the graph has no dangling outputs.
    const cuesUsed = (t.audio.musicCues ?? []).some((c) => c.end - c.start > 0.5 && existsSync(c.file)) && mix.musicVolume > 0;
    if (!cuesUsed && (!t.audio.music || mix.musicVolume <= 0)) filters.push(`[vkey1]anullsink`);
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
