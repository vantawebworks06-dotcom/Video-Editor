"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/components/ui";
import type { MediaItem, MediaPatch } from "@/lib/domain/media";

export interface MediaState {
  items: MediaItem[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  patch: (id: string, p: MediaPatch) => Promise<MediaItem | null>;
  remove: (id: string) => Promise<boolean>;
  /** Research status per sentence (badges in the transcript). */
  bySentence: Record<number, { discovered: number; approved: number; used: number }>;
}

/** Every media item of the project (library, research results, uploads), shared by all sections. */
export function useMedia(projectId: string, reloadKey: unknown): MediaState {
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await api<{ items: MediaItem[] }>(`/api/projects/${projectId}/media`);
      setItems(r.items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    api<{ items: MediaItem[] }>(`/api/projects/${projectId}/media`)
      .then((r) => alive && setItems(r.items))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [projectId, reloadKey]);

  const patch = useCallback(
    async (id: string, p: MediaPatch) => {
      try {
        const r = await api<{ item: MediaItem }>(`/api/projects/${projectId}/media/${id}`, { method: "PATCH", json: p });
        setItems((cur) => (cur ?? []).map((x) => (x.id === id ? r.item : x)));
        return r.item;
      } catch (e) {
        setError((e as Error).message);
        return null;
      }
    },
    [projectId],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await api(`/api/projects/${projectId}/media/${id}`, { method: "DELETE" });
        setItems((cur) => (cur ?? []).filter((x) => x.id !== id));
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      }
    },
    [projectId],
  );

  const bySentence = useMemo(() => {
    const out: MediaState["bySentence"] = {};
    for (const it of items ?? []) {
      if (it.sentenceIdx === null || it.status === "REJECTED") continue;
      const b = (out[it.sentenceIdx] ??= { discovered: 0, approved: 0, used: 0 });
      if (it.status === "USED" || it.usage > 0) b.used++;
      else if (it.status === "APPROVED") b.approved++;
      else b.discovered++;
    }
    return out;
  }, [items]);

  return { items: items ?? [], loading: items === null && !error, error, reload, patch, remove, bySentence };
}

/** Drag payload for placing a library item on the timeline. */
export const MEDIA_DRAG_TYPE = "application/x-docucut-media";
