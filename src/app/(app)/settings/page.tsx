"use client";

import { useEffect, useState } from "react";
import { api, Button, Input, Panel, Tag } from "@/components/ui";

interface Connection {
  id: string;
  label: string;
  purpose: string;
  required: boolean;
  source: "settings" | "environment" | "none";
  hint: string | null;
  status: string;
  message: string | null;
  lastTestedAt: string | null;
}

const STATUS: Record<string, { text: string; tone: "ok" | "danger" | "accent" | "default" }> = {
  connected: { text: "Connected", tone: "ok" },
  public: { text: "Public API", tone: "ok" },
  configured: { text: "Configured (untested)", tone: "default" },
  untested: { text: "Saved (untested)", tone: "default" },
  not_connected: { text: "Not connected", tone: "default" },
  invalid_key: { text: "Invalid key", tone: "danger" },
  rate_limited: { text: "Rate limited", tone: "accent" },
  error: { text: "Error", tone: "danger" },
};

export default function SettingsPage() {
  const [data, setData] = useState<{ connections: Connection[]; canSaveKeys: boolean; missingForSaving: string[] } | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});

  const load = async () => setData(await api("/api/settings/keys"));
  useEffect(() => {
    void load();
  }, []);

  const act = async (provider: string, action: "save" | "test" | "delete") => {
    setBusy(`${provider}:${action}`);
    try {
      const r = await api<{ status?: { state: string; message: string } }>("/api/settings/keys", {
        method: "POST",
        json: action === "save" ? { action, provider, key: keys[provider] } : { action, provider },
      });
      if (r.status) setResults((x) => ({ ...x, [provider]: `${STATUS[r.status!.state]?.text ?? r.status!.state}: ${r.status!.message}` }));
      if (action === "save") setKeys((k) => ({ ...k, [provider]: "" }));
      await load();
    } catch (e) {
      setResults((x) => ({ ...x, [provider]: (e as Error).message }));
    }
    setBusy(null);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-muted">Keys are encrypted server-side and never shown again after saving. Environment variables work too and take effect when no key is saved here.</p>
      </div>
      {data && !data.canSaveKeys && (
        <p className="rounded-md border border-accent/30 bg-accent/10 p-3 text-xs text-accent">
          Saving keys here needs {data.missingForSaving.join(" and ")} on the server. Until then, set provider keys as environment variables (see README) — the Test buttons still work.
        </p>
      )}
      <Panel title="API Connections">
        {!data ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.connections.map((c) => {
              const st = STATUS[c.status] ?? { text: c.status, tone: "default" as const };
              return (
                <li key={c.id} className="space-y-2 py-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2 font-medium">
                        {c.label} {c.required && <Tag tone="accent">recommended</Tag>}
                      </div>
                      <div className="text-xs text-muted">{c.purpose}</div>
                    </div>
                    <div className="text-right text-xs">
                      <Tag tone={st.tone}>{st.text}</Tag>
                      <div className="mt-1 text-muted">
                        {c.hint ? `${c.hint} · from ${c.source}` : c.source === "none" ? "" : c.source}
                      </div>
                    </div>
                  </div>
                  {c.message && <p className="text-xs text-muted">{c.message}</p>}
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      autoComplete="off"
                      placeholder={c.id === "internetArchive" ? "access:secret (optional)" : c.id === "wikimediaToken" ? "OAuth access token (optional)" : "Paste API key"}
                      value={keys[c.id] ?? ""}
                      onChange={(e) => setKeys((k) => ({ ...k, [c.id]: e.target.value }))}
                      disabled={!data.canSaveKeys}
                    />
                    <Button disabled={!data.canSaveKeys || !keys[c.id] || busy !== null} onClick={() => void act(c.id, "save")}>
                      Save
                    </Button>
                    <Button disabled={busy !== null} onClick={() => void act(c.id, "test")}>
                      {busy === `${c.id}:test` ? "Testing…" : `Test ${c.label.split(" ")[0]}`}
                    </Button>
                    {c.source === "settings" && (
                      <Button variant="danger" disabled={busy !== null} onClick={() => void act(c.id, "delete")}>
                        Remove
                      </Button>
                    )}
                  </div>
                  {results[c.id] && <p className="text-xs">{results[c.id]}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
