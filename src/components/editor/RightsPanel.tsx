"use client";

import { Button, RightsBadge, Tag, Thumb } from "@/components/ui";
import { stillThumbnail } from "@/lib/media/thumbnails";
import type { RightsStatus } from "@/lib/domain/types";
import type { Clip } from "./types";

const ORDER: RightsStatus[] = ["RESTRICTED", "UNKNOWN", "USER_REVIEW", "ATTRIBUTION_REQUIRED", "CLEAR"];

/** Asset Rights: every visual's source, licence and render eligibility in one place. */
export function RightsPanel({ clips, allowReview, allowApprovedUnknown, onSelect, onClose }: { clips: Clip[]; allowReview: boolean; allowApprovedUnknown: boolean; onSelect: (c: Clip) => void; onClose: () => void }) {
  const willRender = (c: Clip) => {
    const s = c.asset.rightsStatus;
    if (s === "RESTRICTED") return false;
    if (s === "UNKNOWN") return c.userApproved && allowApprovedUnknown;
    if (s === "USER_REVIEW") return allowReview || c.userApproved;
    return true;
  };
  const sorted = [...clips].sort((a, b) => ORDER.indexOf(a.asset.rightsStatus) - ORDER.indexOf(b.asset.rightsStatus) || a.start - b.start);
  const counts = ORDER.map((s) => [s, clips.filter((c) => c.asset.rightsStatus === s).length] as const).filter(([, n]) => n);
  const credits = [...new Set(clips.map((c) => c.asset.attribution).filter(Boolean))];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <aside className="flex h-full w-full max-w-xl flex-col border-l border-line bg-panel" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <h2 className="font-semibold">Asset Rights</h2>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {counts.map(([s, n]) => (
                <span key={s} className="flex items-center gap-1 text-xs text-muted">
                  <RightsBadge status={s} /> {n}
                </span>
              ))}
            </div>
          </div>
          <Button variant="ghost" onClick={onClose}>
            ✕
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-xs">
            <tbody className="divide-y divide-line">
              {sorted.map((c) => (
                <tr key={c.rowId} className="cursor-pointer hover:bg-panel-2" onClick={() => onSelect(c)}>
                  <td className="w-16 p-2">
                    <div className="relative h-9 w-14 overflow-hidden rounded bg-black">
                      <Thumb src={c.asset.thumbnailUrl && stillThumbnail(c.asset.thumbnailUrl)} />
                    </div>
                  </td>
                  <td className="p-2">
                    <div className="line-clamp-1 font-medium">{c.asset.title}</div>
                    <div className="text-muted">
                      {c.clipId} · {c.asset.provider === "giphy" ? "Powered By GIPHY" : c.asset.provider} · {c.asset.license}
                    </div>
                    <a className="text-info hover:underline" href={c.asset.sourceUrl} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
                      source ↗
                    </a>
                  </td>
                  <td className="p-2 text-right">
                    <RightsBadge status={c.asset.rightsStatus} />
                    <div className="mt-1">{willRender(c) ? <Tag tone="ok">renders</Tag> : <Tag tone="danger">skipped</Tag>}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-line p-4 text-xs">
            <div className="mb-1 font-semibold">Credits for your video description</div>
            <textarea readOnly className="h-32 w-full rounded border border-line bg-background p-2 font-mono text-[11px]" value={credits.join("\n")} />
          </div>
        </div>
      </aside>
    </div>
  );
}
