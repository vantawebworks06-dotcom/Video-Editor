"use client";

import { useCallback, useEffect, useState } from "react";
import { api, Button, cx, Input, RightsBadge, Tag, Thumb } from "@/components/ui";
import { stillThumbnail } from "@/lib/media/thumbnails";
import type { NormalizedAsset } from "@/lib/domain/types";

type LibAsset = NormalizedAsset & { rowId: string; isFavorite: boolean; userApproved: boolean };

const TYPES = [
  ["", "All"],
  ["video", "Video"],
  ["photo", "Photo"],
  ["gif", "GIF"],
  ["archive", "Archive"],
  ["meme", "Meme"],
] as const;
const PROVIDERS = [
  ["", "All providers"],
  ["pexels", "Pexels"],
  ["pixabay", "Pixabay"],
  ["wikimedia", "Wikimedia"],
  ["internet_archive", "Internet Archive"],
  ["giphy", "GIPHY"],
] as const;
const RIGHTS = [
  ["", "Any rights"],
  ["CLEAR", "Clear"],
  ["ATTRIBUTION_REQUIRED", "Attribution"],
  ["USER_REVIEW", "Review"],
  ["UNKNOWN", "Unknown"],
] as const;

function Chips({ options, value, onChange }: { options: readonly (readonly [string, string])[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)} className={cx("h-7 rounded-full border px-2.5 text-xs", value === v ? "border-accent bg-accent/15 text-accent" : "border-line text-muted hover:text-foreground")}>
          {l}
        </button>
      ))}
    </div>
  );
}

export default function LibraryPage() {
  const [type, setType] = useState("");
  const [provider, setProvider] = useState("");
  const [rights, setRights] = useState("");
  const [favorites, setFavorites] = useState(false);
  const [q, setQ] = useState("");
  const [assets, setAssets] = useState<LibAsset[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useCallback(() => {
    const sp = new URLSearchParams();
    if (type) sp.set("type", type);
    if (provider) sp.set("provider", provider);
    if (rights) sp.set("rights", rights);
    if (favorites) sp.set("favorites", "1");
    if (q.trim()) sp.set("q", q.trim());
    return api<{ assets: LibAsset[] }>(`/api/assets?${sp}`);
  }, [type, provider, rights, favorites, q]);

  const load = useCallback(
    () =>
      query()
        .then((d) => setAssets(d.assets))
        .catch((e: Error) => setError(e.message)),
    [query],
  );

  useEffect(() => {
    let alive = true;
    query()
      .then((d) => alive && setAssets(d.assets))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // Re-query on filter changes; the free-text box searches on submit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, provider, rights, favorites]);

  const toggleFav = async (a: LibAsset) => {
    await api(`/api/assets/${a.rowId}`, { method: "PATCH", json: { isFavorite: !a.isFavorite } });
    void load();
  };

  return (
    <div className="space-y-5 p-8">
      <div>
        <h1 className="text-2xl font-bold">Media Library</h1>
        <p className="text-sm text-muted">Every visual your projects have used or you have saved — with its source and licence kept permanently.</p>
      </div>
      <div className="space-y-2">
        <form
          className="flex max-w-md gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles…" />
          <Button>Search</Button>
        </form>
        <Chips options={TYPES} value={type} onChange={setType} />
        <Chips options={PROVIDERS} value={provider} onChange={setProvider} />
        <div className="flex items-center gap-3">
          <Chips options={RIGHTS} value={rights} onChange={setRights} />
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={favorites} onChange={(e) => setFavorites(e.target.checked)} /> Favourites only
          </label>
        </div>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {!assets ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : !assets.length ? (
        <p className="text-sm text-muted">Nothing here yet. Assets appear once a project has been generated.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          {assets.map((a) => (
            <div key={a.rowId} className="overflow-hidden rounded-lg border border-line bg-panel">
              <div className="relative aspect-video bg-black">
                <Thumb src={a.thumbnailUrl && stillThumbnail(a.thumbnailUrl)} fit="contain" />
                <span className="absolute left-1 top-1">
                  <RightsBadge status={a.rightsStatus} />
                </span>
                <button onClick={() => void toggleFav(a)} className={cx("absolute right-1 top-1 rounded bg-black/60 px-1.5 text-sm", a.isFavorite ? "text-accent" : "text-white/60")} title="Favourite">
                  ★
                </button>
              </div>
              <div className="space-y-1 p-2 text-[11px]">
                <div className="line-clamp-2 font-medium" title={a.title}>
                  {a.title}
                </div>
                <div className="text-muted">
                  {a.provider === "giphy" ? "Powered By GIPHY" : a.provider} · {a.type} {a.archival && <Tag>archive</Tag>}
                </div>
                <div className="line-clamp-1 text-muted" title={a.license}>
                  {a.license}
                </div>
                <a href={a.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-info hover:underline">
                  Source ↗
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
