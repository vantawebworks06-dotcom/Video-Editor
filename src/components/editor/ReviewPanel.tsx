"use client";

import { useMemo, useState } from "react";
import { api, Button, cx, fmtTime, RightsBadge, Select, Tag, Thumb } from "@/components/ui";
import type { Word } from "@/lib/domain/types";
import type { Clip, EditData } from "./types";

const EFFECTS = ["none", "slow_zoom_in", "slow_zoom_out", "pan_left", "pan_right", "pan_up", "pan_down", "diagonal", "subtle_rotation", "punch_in"];

/** Narration under each clip. Words are time-ordered, so each clip scans only its own span. */
function narrationByClip(words: Word[], clips: Clip[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of clips) {
    const end = c.start + c.duration;
    let lo = 0;
    let hi = words.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid]!.end <= c.start) lo = mid + 1;
      else hi = mid;
    }
    const text: string[] = [];
    for (let i = lo; i < words.length && words[i]!.start < end; i++) if (words[i]!.end > c.start) text.push(words[i]!.word);
    out.set(c.rowId, text.join(" "));
  }
  return out;
}

/**
 * Scene-by-scene review of the generated timeline before the final render.
 * Every action touches only one clip or scene — nothing regenerates the whole project.
 */
export function ReviewPanel({
  projectId,
  data,
  selectedClip,
  onSelect,
  onReplace,
  onRegenerateScene,
  onChanged,
}: {
  projectId: string;
  data: EditData;
  selectedClip: string | null;
  onSelect: (c: Clip) => void;
  onReplace: (c: Clip, tab: "ai" | "search") => void;
  onRegenerateScene: (sceneId: string) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Recomputed only when the edit reloads, not on every status poll.
  const narration = useMemo(() => narrationByClip(data.words, data.clips), [data.words, data.clips]);
  const plans = useMemo(() => new Map(data.plans.map((p) => [p.sceneId, p])), [data.plans]);

  const act = async (c: Clip, json: unknown) => {
    setBusy(c.clipId);
    setError(null);
    try {
      await api(`/api/projects/${projectId}/clips/${c.clipId}`, { method: "PATCH", json });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  };

  return (
    <div className="h-full overflow-auto">
      {error && <p className="sticky top-0 z-10 border-b border-danger/30 bg-danger/15 px-3 py-2 text-xs text-danger">{error}</p>}
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-panel text-left text-muted">
          <tr>
            <th className="p-2">Visual</th>
            <th className="p-2">Narration</th>
            <th className="p-2">Duration</th>
            <th className="p-2">Source</th>
            <th className="p-2">Effect</th>
            <th className="p-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {data.clips.map((c) => {
            const own = c.asset.provider === "uploaded";
            const plan = plans.get(c.sceneId);
            return (
              <tr key={c.rowId} className={cx("align-top", selectedClip === c.clipId ? "bg-accent/10" : "hover:bg-panel-2")} onClick={() => onSelect(c)}>
                <td className="w-36 p-2">
                  <div className="relative flex aspect-video w-32 items-center justify-center overflow-hidden rounded bg-black text-[10px] text-muted">
                    <Thumb src={c.asset.thumbnailUrl} />
                    {own ? "Your footage" : !c.asset.thumbnailUrl ? c.asset.type : null}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Tag tone={c.role === "meme" ? "accent" : "default"}>{c.role === "meme" ? "reaction" : c.asset.type}</Tag>
                    {plan && <Tag>{plan.visualStrategy.replace(/_/g, " ")}</Tag>}
                  </div>
                </td>
                <td className="max-w-md p-2">
                  <div className="mb-0.5 text-muted">
                    {fmtTime(c.start)} – {fmtTime(c.start + c.duration)} · {c.sceneId.replace("scene_", "scene #")}
                  </div>
                  <p className="line-clamp-3">{narration.get(c.rowId) ||<span className="text-muted">(pause)</span>}</p>
                </td>
                <td className="p-2 whitespace-nowrap">{c.duration.toFixed(1)}s</td>
                <td className="max-w-[220px] p-2">
                  <div className="line-clamp-2 font-medium" title={c.asset.title}>
                    {c.asset.title}
                  </div>
                  <div className="text-muted">{c.asset.provider === "giphy" ? "Powered By GIPHY" : own ? "Your upload" : c.asset.provider}</div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <RightsBadge status={c.asset.rightsStatus} />
                    {!own && (
                      <a href={c.asset.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-info hover:underline" onClick={(e) => e.stopPropagation()}>
                        source ↗
                      </a>
                    )}
                  </div>
                  {!own && <div className="mt-0.5 line-clamp-1 text-muted" title={c.asset.license}>{c.asset.license}</div>}
                </td>
                <td className="p-2" onClick={(e) => e.stopPropagation()}>
                  <Select
                    className="h-7 w-36 text-xs"
                    value={c.motion}
                    disabled={busy !== null || own}
                    title={own ? "Your footage plays in sync with the narration" : "Change effect"}
                    onChange={(e) => void act(c, { action: "update", motion: { type: e.target.value, intensity: c.motionIntensity || 0.08 } })}
                  >
                    {EFFECTS.map((m) => (
                      <option key={m} value={m}>
                        {m.replace(/_/g, " ")}
                      </option>
                    ))}
                  </Select>
                  <div className="mt-1 text-muted">{c.layout.replace(/_/g, " ")}{c.blackAndWhite ? " · B&W" : ""}</div>
                </td>
                <td className="p-2 text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="flex flex-col items-end gap-1">
                    <Button size="sm" onClick={() => onReplace(c, "search")} disabled={busy !== null}>
                      Replace
                    </Button>
                    <Button size="sm" onClick={() => onReplace(c, "ai")} disabled={busy !== null}>
                      Find Better
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onRegenerateScene(c.sceneId)} disabled={busy !== null}>
                      Regenerate
                    </Button>
                    <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => confirm("Remove this visual? The neighbouring clip fills its time; the narration is not affected.") && void act(c, { action: "delete" })}>
                      {busy === c.clipId ? "…" : "Remove"}
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
