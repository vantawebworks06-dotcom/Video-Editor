"use client";

import { useEffect, useState } from "react";
import { api, Button, ComingSoon, cx, Input, RightsBadge, Thumb } from "@/components/ui";
import type { AssetType, ProviderId, RightsStatus } from "@/lib/domain/types";
import type { Candidate, Clip } from "./types";

const PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: "pexels", label: "Pexels" },
  { id: "pixabay", label: "Pixabay" },
  { id: "wikimedia", label: "Wikimedia" },
  { id: "internet_archive", label: "Internet Archive" },
  { id: "giphy", label: "GIPHY" },
];
const TYPES: { id: AssetType; label: string }[] = [
  { id: "video", label: "Video" },
  { id: "photo", label: "Image" },
  { id: "gif", label: "GIF" },
];

function Chip({ on, children, onClick }: { on: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cx("h-7 rounded-full border px-2.5 text-xs", on ? "border-accent bg-accent/15 text-accent" : "border-line text-muted hover:text-foreground")}>
      {children}
    </button>
  );
}

export function ReplaceDialog({ projectId, clip, initialTab = "ai", onClose, onReplaced }: { projectId: string; clip: Clip; initialTab?: "ai" | "search"; onClose: () => void; onReplaced: () => void }) {
  const [tab, setTab] = useState<"ai" | "search">(initialTab);
  const [ai, setAi] = useState<{ candidates: Candidate[]; director: string; queries: string[]; errors: string[] } | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [query, setQuery] = useState(clip.queries[0] ?? "");
  const [providers, setProviders] = useState<ProviderId[]>(PROVIDERS.map((p) => p.id));
  const [types, setTypes] = useState<AssetType[]>(clip.role === "meme" ? ["gif"] : ["video", "photo"]);
  const [includeUnknown, setIncludeUnknown] = useState(false);
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [searchErrors, setSearchErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api<{ candidates: Candidate[]; director: string; queries: string[]; errors: string[] }>(`/api/projects/${projectId}/clips/${clip.clipId}/recommend`, { method: "POST" })
      .then(setAi)
      .catch((e: Error) => setAiError(e.message));
  }, [projectId, clip.clipId]);

  const search = async () => {
    setBusy("search");
    setSearchErrors([]);
    try {
      const rights: RightsStatus[] = ["CLEAR", "ATTRIBUTION_REQUIRED", "USER_REVIEW", ...(includeUnknown ? (["UNKNOWN"] as const) : [])];
      const r = await api<{ candidates: Candidate[]; errors: { provider: string; message: string }[] }>("/api/media/search", {
        method: "POST",
        json: { query, providers, types, rights },
      });
      setResults(r.candidates);
      setSearchErrors(r.errors.map((e) => `${e.provider}: ${e.message}`));
    } catch (e) {
      setSearchErrors([(e as Error).message]);
    }
    setBusy(null);
  };

  const use = async (c: Candidate) => {
    let approve = false;
    if (c.rightsStatus === "UNKNOWN") {
      approve = window.confirm(`The rights for "${c.title}" are unknown.\n\nOnly use it if you have confirmed you may. Approve and use it?`);
      if (!approve) return;
    }
    setBusy(c.id);
    try {
      await api(`/api/projects/${projectId}/clips/${clip.clipId}/replace`, { method: "POST", json: { provider: c.provider, providerAssetId: c.providerAssetId, approve } });
      onReplaced();
    } catch (e) {
      alert((e as Error).message);
      setBusy(null);
    }
  };

  const list = tab === "ai" ? ai?.candidates : results;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <div className="flex max-h-full w-full max-w-5xl flex-col rounded-xl border border-line bg-panel" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <div>
            <h2 className="font-semibold">Find better footage</h2>
            <p className="text-xs text-muted">
              {clip.clipId} · {clip.needType} · {clip.duration.toFixed(1)}s — only this clip changes
            </p>
          </div>
          <Button variant="ghost" onClick={onClose}>
            ✕
          </Button>
        </header>
        <div className="flex gap-2 border-b border-line px-5 py-2">
          <Chip on={tab === "ai"} onClick={() => setTab("ai")}>
            AI recommendations
          </Chip>
          <Chip on={tab === "search"} onClick={() => setTab("search")}>
            Search
          </Chip>
          <span className="ml-auto self-center">
            <ComingSoon>Upload your own image or clip</ComingSoon>
          </span>
        </div>
        {tab === "search" && (
          <div className="space-y-2 border-b border-line px-5 py-3">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
            >
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search Pexels, Pixabay, Wikimedia, Internet Archive, GIPHY…" />
              <Button variant="primary" disabled={!query.trim() || busy === "search"}>
                {busy === "search" ? "Searching…" : "Search"}
              </Button>
            </form>
            <div className="flex flex-wrap items-center gap-1.5">
              {PROVIDERS.map((p) => (
                <Chip key={p.id} on={providers.includes(p.id)} onClick={() => setProviders((v) => (v.includes(p.id) ? v.filter((x) => x !== p.id) : [...v, p.id]))}>
                  {p.label}
                </Chip>
              ))}
              <span className="mx-2 h-4 w-px bg-line" />
              {TYPES.map((t) => (
                <Chip key={t.id} on={types.includes(t.id)} onClick={() => setTypes((v) => (v.includes(t.id) ? v.filter((x) => x !== t.id) : [...v, t.id]))}>
                  {t.label}
                </Chip>
              ))}
              <span className="mx-2 h-4 w-px bg-line" />
              <Chip on={includeUnknown} onClick={() => setIncludeUnknown(!includeUnknown)}>
                Include unknown rights
              </Chip>
            </div>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto p-5">
          {tab === "ai" && !ai && !aiError && <p className="text-sm text-muted">Generating queries, searching providers and ranking candidates…</p>}
          {tab === "ai" && aiError && <p className="text-sm text-danger">{aiError}</p>}
          {tab === "ai" && ai && (
            <p className="mb-3 text-xs text-muted">
              {ai.director} · queries: {ai.queries.slice(0, 5).join(" · ")}
              {ai.errors.length > 0 && <span className="text-danger"> · {ai.errors.length} provider error(s)</span>}
            </p>
          )}
          {searchErrors.length > 0 && tab === "search" && <p className="mb-3 text-xs text-danger">{searchErrors.slice(0, 3).join(" · ")}</p>}
          {list && !list.length && <p className="text-sm text-muted">No usable results. Try another query, provider or type.</p>}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {list?.map((c) => (
              <div key={c.id} className="flex flex-col overflow-hidden rounded-lg border border-line bg-panel-2">
                <div className="relative aspect-video bg-black">
                  <Thumb src={c.thumbnailUrl} fit="contain" />
                  <span className="absolute left-1 top-1">
                    <RightsBadge status={c.rightsStatus} />
                  </span>
                  {c.overall !== undefined && <span className="absolute right-1 top-1 rounded bg-black/70 px-1.5 text-[10px] font-semibold text-accent">{c.overall}</span>}
                  {c.duration && <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px]">{c.duration.toFixed(1)}s</span>}
                </div>
                <div className="flex flex-1 flex-col gap-1 p-2">
                  <div className="line-clamp-2 text-xs font-medium" title={c.title}>
                    {c.title}
                  </div>
                  <div className="text-[10px] text-muted">
                    {c.provider === "giphy" ? "Powered By GIPHY" : c.provider} · {c.type} · {c.width ?? "?"}×{c.height ?? "?"}
                  </div>
                  {c.reason && <div className="line-clamp-2 text-[10px] text-muted" title={c.reason}>{c.reason}</div>}
                  <div className="mt-auto flex items-center justify-between pt-1">
                    <a href={c.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-[10px] text-info hover:underline">
                      Source ↗
                    </a>
                    <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void use(c)}>
                      {busy === c.id ? "…" : "Use This"}
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
