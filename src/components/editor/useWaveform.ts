"use client";

import { useEffect, useState } from "react";

/** Decode narration in the browser and reduce it to peak values for the timeline. */
export function useWaveform(url: string | null, buckets = 1200): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    (async () => {
      try {
        const buf = await (await fetch(url)).arrayBuffer();
        const ctx = new AudioContext();
        const audio = await ctx.decodeAudioData(buf);
        const data = audio.getChannelData(0);
        const size = Math.max(1, Math.floor(data.length / buckets));
        const out: number[] = [];
        for (let i = 0; i < buckets; i++) {
          let max = 0;
          for (let j = i * size; j < Math.min(data.length, (i + 1) * size); j += 16) max = Math.max(max, Math.abs(data[j]!));
          out.push(max);
        }
        const top = Math.max(0.01, ...out);
        if (!cancelled) setPeaks(out.map((v) => v / top));
        void ctx.close();
      } catch {
        if (!cancelled) setPeaks(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, buckets]);
  return peaks;
}
