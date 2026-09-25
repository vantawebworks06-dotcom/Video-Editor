import { useSyncExternalStore } from "react";

/**
 * Playhead position outside React state. The video reports its time ~4×/s while playing; keeping
 * that in the editor's state re-rendered the whole editor (timeline, inspector, scene list) on
 * every tick. Only components that call `usePlayhead` re-render now.
 */
export interface PlayheadStore {
  get(): number;
  set(t: number): void;
  subscribe(listener: () => void): () => void;
}

export function createPlayhead(): PlayheadStore {
  let t = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => t,
    set(next) {
      if (next === t) return;
      t = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function usePlayhead(store: PlayheadStore): number {
  return useSyncExternalStore(store.subscribe, store.get, () => 0);
}
