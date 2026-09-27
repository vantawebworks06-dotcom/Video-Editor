"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/components/ui";
import type { TranscriptAnalysis } from "@/lib/analysis/types";

export interface AnalysisState {
  analysis: TranscriptAnalysis | null;
  stale: boolean;
  canAnalyze: boolean;
  loading: boolean;
  running: boolean;
  error: string | null;
  run: () => Promise<void>;
}

/** The project's transcript analysis: loaded once, re-run on demand. */
export function useAnalysis(projectId: string, reloadKey: unknown): AnalysisState {
  const [data, setData] = useState<{ analysis: TranscriptAnalysis | null; stale: boolean; canAnalyze: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ analysis: TranscriptAnalysis | null; stale: boolean; canAnalyze: boolean }>(`/api/projects/${projectId}/analysis`)
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [projectId, reloadKey]);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      setData(await api(`/api/projects/${projectId}/analysis`, { method: "POST" }));
    } catch (e) {
      setError((e as Error).message);
    }
    setRunning(false);
  }, [projectId]);

  return { analysis: data?.analysis ?? null, stale: data?.stale ?? false, canAnalyze: data?.canAnalyze ?? false, loading: !data && !error, running, error, run };
}
