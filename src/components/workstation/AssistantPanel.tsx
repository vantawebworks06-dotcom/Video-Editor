"use client";

import { useEffect, useRef, useState } from "react";
import { api, Button, cx } from "@/components/ui";
import type { EditData } from "@/components/editor/types";
import type { PlayheadStore } from "@/components/editor/playhead";
import { type AssistantAction, describe, isReadOnly } from "@/lib/assistant/actions";
import { checkEdit, type HealthIssue } from "@/lib/assistant/health";
import { EXAMPLES, parseCommand } from "@/lib/assistant/parse";
import type { TranscriptAnalysis } from "@/lib/analysis/types";
import type { ProjectSettings } from "@/lib/domain/types";
import type { VoiceMeasurement } from "@/lib/domain/voice";

type Msg =
  | { id: number; from: "you"; text: string }
  | { id: number; from: "assistant"; kind: "plan"; actions: AssistantAction[]; state: "pending" | "running" | "done" | "cancelled" | "failed"; result?: string }
  | { id: number; from: "assistant"; kind: "text"; text: string; examples?: string[] }
  | { id: number; from: "assistant"; kind: "check"; issues: HealthIssue[] };

/** Omit that applies to each member of a union. */
type NewMsg = Msg extends infer M ? (M extends Msg ? Omit<M, "id"> : never) : never;

let nextId = 1;

/**
 * The editing assistant: plain-English commands (parsed by rules — no AI service), a preview of
 * what will change before anything runs, and "Check my edit" with one-click fixes.
 */
export function AssistantPanel({
  projectId,
  open,
  onClose,
  edit,
  settings,
  analysis,
  playhead,
  selectedClip,
  selectedScene,
  run,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  edit: EditData | null;
  settings: ProjectSettings;
  analysis: TranscriptAnalysis | null;
  playhead: PlayheadStore;
  selectedClip: string | null;
  selectedScene: string | null;
  /** Runs one action in the editor; returns a short result line. */
  run: (a: AssistantAction) => Promise<string>;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([{ id: 0, from: "assistant", kind: "text", text: "Tell me what to change — looks, graphics, voice, music, captions — or ask me to check the edit.", examples: EXAMPLES.slice(0, 5) }]);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);

  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 30);
  }, [open]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  const push = (m: NewMsg) => setMsgs((x) => [...x, { ...m, id: nextId++ } as Msg]);
  const patch = (id: number, p: Partial<Extract<Msg, { kind: "plan" }>>) => setMsgs((x) => x.map((m) => (m.id === id ? ({ ...m, ...p } as Msg) : m)));

  const runCheck = async () => {
    if (!edit) return push({ from: "assistant", kind: "text", text: "Generate the edit first — then I can check it." });
    // Always check the saved edit (a just-made change may not have reached the editor yet), plus the
    // narration measurement if one was made (it informs the voice checks).
    const [fresh, status, voice] = await Promise.all([
      api<EditData>(`/api/projects/${projectId}/edit`),
      api<{ project: { settings: ProjectSettings } }>(`/api/projects/${projectId}/status`),
      api<{ latest: { measurement: VoiceMeasurement } | null }>(`/api/projects/${projectId}/audio/voice`).then((r) => r.latest?.measurement ?? null).catch(() => null),
    ]);
    const issues = checkEdit({ plans: fresh.plans, clips: fresh.clips.map((c) => ({ ...c, asset: { id: c.asset.id, title: c.asset.title, type: c.asset.type, provider: c.asset.provider, rightsStatus: c.asset.rightsStatus } })), settings: status.project.settings, analysis, duration: fresh.duration, voice });
    push({ from: "assistant", kind: "check", issues });
  };

  const execute = async (id: number, actions: AssistantAction[]) => {
    patch(id, { state: "running" });
    const results: string[] = [];
    try {
      for (const a of actions) {
        if (a.type === "check") await runCheck();
        else if (a.type === "help") push({ from: "assistant", kind: "text", text: "Things you can ask:", examples: EXAMPLES });
        else results.push(await run(a));
      }
      patch(id, { state: "done", result: results.filter(Boolean).join(" · ") || undefined });
      // Actions that open another view (research, replace dialog, rights) need the space.
      if (actions.some((a) => a.type === "research" || a.type === "replaceClip" || a.type === "openRights")) onClose();
    } catch (e) {
      patch(id, { state: "failed", result: (e as Error).message });
    }
  };

  const submit = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    setText("");
    setHistory((h) => [t, ...h.filter((x) => x !== t)].slice(0, 30));
    setHIdx(-1);
    push({ from: "you", text: t });
    if (!edit) return push({ from: "assistant", kind: "text", text: "Generate the edit first — then I can work on it." });
    const r = parseCommand(t, { plans: edit.plans, clips: edit.clips, settings, analysis, words: edit.words, playhead: playhead.get(), duration: edit.duration, selectedClip, selectedScene });
    if (!r.ok) return push({ from: "assistant", kind: "text", text: r.error, examples: r.examples });
    const id = nextId++;
    setMsgs((x) => [...x, { id, from: "assistant", kind: "plan", actions: r.actions, state: "pending" }]);
    // Moving around / opening things needs no confirmation.
    if (r.actions.every(isReadOnly)) void execute(id, r.actions);
  };

  if (!open) return null;
  return (
    <aside className="fixed top-14 right-3 bottom-3 z-40 flex w-[400px] flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-2xl" aria-label="Editing assistant">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <div>
          <div className="text-sm font-semibold">Assistant</div>
          <div className="text-[10px] text-muted">Rule-based · offline · timeline changes undoable</div>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" onClick={() => void runCheck()} title="Check the edit for problems">
            Check edit
          </Button>
          <button className="px-2 text-muted hover:text-foreground" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
      </div>
      <div ref={log} className="min-h-0 flex-1 space-y-2 overflow-auto p-3 text-xs">
        {msgs.map((m) =>
          m.from === "you" ? (
            <div key={m.id} className="ml-10 rounded-lg bg-accent/15 px-2.5 py-1.5 text-right">
              {m.text}
            </div>
          ) : m.kind === "text" ? (
            <div key={m.id} className="mr-6 space-y-1.5 rounded-lg bg-panel-2 px-2.5 py-2">
              <div>{m.text}</div>
              {m.examples && (
                <div className="flex flex-wrap gap-1">
                  {m.examples.map((e) => (
                    <button key={e} onClick={() => submit(e)} className="rounded-full border border-line px-2 py-0.5 text-[10px] text-muted hover:border-accent hover:text-foreground">
                      {e}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : m.kind === "plan" ? (
            <div key={m.id} className="mr-6 space-y-1.5 rounded-lg bg-panel-2 px-2.5 py-2">
              <ul className="list-disc space-y-0.5 pl-4">
                {m.actions.map((a, i) => (
                  <li key={i}>{describe(a)}</li>
                ))}
              </ul>
              {m.state === "pending" && (
                <div className="flex gap-1.5">
                  <Button size="sm" variant="primary" onClick={() => void execute(m.id, m.actions)}>
                    Do it
                  </Button>
                  <Button size="sm" onClick={() => patch(m.id, { state: "cancelled" })}>
                    Cancel
                  </Button>
                </div>
              )}
              {m.state === "running" && <div className="text-muted">Working…</div>}
              {m.state === "done" && <div className="text-ok">Done{m.result ? ` — ${m.result}` : "."}</div>}
              {m.state === "cancelled" && <div className="text-muted">Cancelled.</div>}
              {m.state === "failed" && <div className="text-danger">{m.result}</div>}
            </div>
          ) : (
            <CheckResult key={m.id} issues={m.issues} run={run} onClose={onClose} />
          ),
        )}
      </div>
      <form
        className="border-t border-line p-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowUp" && history.length) {
              e.preventDefault();
              const i = Math.min(history.length - 1, hIdx + 1);
              setHIdx(i);
              setText(history[i]!);
            }
            if (e.key === "ArrowDown" && hIdx >= 0) {
              e.preventDefault();
              const i = hIdx - 1;
              setHIdx(i);
              setText(i >= 0 ? history[i]! : "");
            }
          }}
          placeholder="e.g. add a lower third for Delroy Marsh, sound system engineer"
          className="h-9 w-full rounded border border-line bg-background px-2.5 text-xs outline-none focus:border-accent"
        />
        <div className="mt-1 text-[10px] text-muted">Enter to send · ↑ for earlier commands · Ctrl+K to open/close</div>
      </form>
    </aside>
  );
}

function CheckResult({ issues, run, onClose }: { issues: HealthIssue[]; run: (a: AssistantAction) => Promise<string>; onClose: () => void }) {
  const [done, setDone] = useState<Record<string, "running" | "done" | string>>({});
  if (!issues.length) return <div className="mr-6 rounded-lg bg-ok/10 px-2.5 py-2 text-ok">No problems found. The edit looks ready to render.</div>;
  const counts = { problem: issues.filter((i) => i.severity === "problem").length, warning: issues.filter((i) => i.severity === "warning").length, tip: issues.filter((i) => i.severity === "tip").length };
  return (
    <div className="mr-2 space-y-1.5 rounded-lg bg-panel-2 px-2.5 py-2">
      <div className="font-semibold">
        Edit check: {counts.problem} problem{counts.problem === 1 ? "" : "s"}, {counts.warning} warning{counts.warning === 1 ? "" : "s"}, {counts.tip} tip{counts.tip === 1 ? "" : "s"}
      </div>
      {issues.map((i) => (
        <div key={i.id} className={cx("rounded border-l-2 bg-background/40 px-2 py-1.5", i.severity === "problem" ? "border-danger" : i.severity === "warning" ? "border-accent" : "border-info")}>
          <div className="font-medium">{i.title}</div>
          <div className="text-[11px] text-muted">{i.detail}</div>
          {i.fix && (
            <div className="mt-1 flex items-center gap-2">
              <Button
                size="sm"
                disabled={done[i.id] === "running" || done[i.id] === "done"}
                onClick={() => {
                  setDone((d) => ({ ...d, [i.id]: "running" }));
                  run(i.fix!)
                    .then(() => {
                      setDone((d) => ({ ...d, [i.id]: "done" }));
                      if (i.fix!.type === "replaceClip" || i.fix!.type === "openRights" || i.fix!.type === "research") onClose();
                    })
                    .catch((e: Error) => setDone((d) => ({ ...d, [i.id]: e.message })));
                }}
              >
                {i.fixLabel ?? "Fix"}
              </Button>
              {done[i.id] === "done" && <span className="text-[10px] text-ok">done</span>}
              {done[i.id] && done[i.id] !== "done" && done[i.id] !== "running" && <span className="text-[10px] text-danger">{done[i.id]}</span>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
