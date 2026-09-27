"use client";

import { useCallback, useEffect, useState } from "react";
import { api, Button, cx, Input, Panel, Tag } from "@/components/ui";

interface Connection {
  id: string;
  group: "ai" | "research" | "media" | "transcription";
  research: string | null;
  paid: boolean;
  label: string;
  purpose: string;
  required: boolean;
  source: "settings" | "environment" | "none";
  hint: string | null;
  status: string;
  message: string | null;
  lastTestedAt: string | null;
}

interface Integration {
  id: string;
  name: string;
  categories: string[];
  capabilities: { search: boolean; preview: string; capture: boolean; import: "file" | "authorised-copy" | "none" };
  credentials: { env: string[]; label: string; required: boolean; set: boolean }[];
  docsUrl: string;
  terms: string;
  limits: string;
  configured: boolean;
  untested: boolean;
  state: "CONNECTED" | "NOT_CONNECTED" | "REQUIRES_CONFIGURATION" | "RATE_LIMITED" | "UNAVAILABLE";
  note: string;
  connectionId: string | null;
}

const TEST_STATUS: Record<string, { text: string; tone: "ok" | "danger" | "accent" | "default" }> = {
  connected: { text: "Connected", tone: "ok" },
  public: { text: "Public API", tone: "ok" },
  configured: { text: "Configured (untested)", tone: "default" },
  untested: { text: "Saved (untested)", tone: "default" },
  not_connected: { text: "Not connected", tone: "default" },
  invalid_key: { text: "Invalid key", tone: "danger" },
  rate_limited: { text: "Rate limited", tone: "accent" },
  error: { text: "Error", tone: "danger" },
};

const STATE_STYLE: Record<Integration["state"], string> = {
  CONNECTED: "bg-ok/15 text-ok border-ok/30",
  NOT_CONNECTED: "bg-danger/15 text-danger border-danger/30",
  REQUIRES_CONFIGURATION: "bg-panel-2 text-muted border-line",
  RATE_LIMITED: "bg-accent/15 text-accent border-accent/30",
  UNAVAILABLE: "bg-danger/15 text-danger border-danger/30",
};

const IMPORT_TEXT = { file: "files can be imported", "authorised-copy": "preview/reference only — upload an authorised copy to use", none: "reference / capture only" };

export default function SettingsPage() {
  const [data, setData] = useState<{ connections: Connection[]; canSaveKeys: boolean; missingForSaving: string[] } | null>(null);
  const [integrations, setIntegrations] = useState<{ providers: Integration[]; capture: { available: boolean; note: string } } | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { text: string; tone: string }>>({});
  const [tab, setTab] = useState<"integrations" | "keys">("integrations");

  const load = useCallback(async () => {
    const [k, i] = await Promise.all([api<typeof data>("/api/settings/keys"), api<typeof integrations>("/api/integrations")]);
    setData(k);
    setIntegrations(i);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (provider: string, action: "save" | "test" | "delete") => {
    setBusy(`${provider}:${action}`);
    try {
      const r = await api<{ status?: { state: string; message: string } }>("/api/settings/keys", {
        method: "POST",
        json: action === "save" ? { action, provider, key: keys[provider] } : { action, provider },
      });
      if (r.status) setResults((x) => ({ ...x, [provider]: { text: `${TEST_STATUS[r.status!.state]?.text ?? r.status!.state}: ${r.status!.message}`, tone: TEST_STATUS[r.status!.state]?.tone ?? "default" } }));
      if (action === "save") setKeys((k) => ({ ...k, [provider]: "" }));
      await load();
    } catch (e) {
      setResults((x) => ({ ...x, [provider]: { text: (e as Error).message, tone: "danger" } }));
    }
    setBusy(null);
  };

  const keyRow = (c: Connection, compact = false) => {
    const st = TEST_STATUS[c.status] ?? { text: c.status, tone: "default" as const };
    const r = results[c.id];
    return (
      <div className="space-y-1.5">
        {!compact && (
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 font-medium">{c.label}</div>
              <div className="text-xs text-muted">{c.purpose}</div>
            </div>
            <div className="text-right text-xs">
              <Tag tone={st.tone}>{st.text}</Tag>
              <div className="mt-1 text-muted">{c.hint ? `${c.hint} · from ${c.source}` : ""}</div>
            </div>
          </div>
        )}
        {compact && c.hint && (
          <div className="text-[11px] text-muted">
            Key {c.hint} · from {c.source === "settings" ? "Settings (encrypted)" : "environment"}
          </div>
        )}
        <div className="flex gap-2">
          <Input
            type="password"
            autoComplete="off"
            placeholder={c.id === "internetArchive" ? "access:secret (optional)" : c.id === "wikimediaToken" ? "OAuth access token (optional)" : c.id === "reddit" ? "client_id:client_secret" : c.id === "metaOembed" ? "app-id|client-token" : "Paste API key / token"}
            value={keys[c.id] ?? ""}
            onChange={(e) => setKeys((k) => ({ ...k, [c.id]: e.target.value }))}
            disabled={!data?.canSaveKeys}
          />
          <Button disabled={!data?.canSaveKeys || !keys[c.id] || busy !== null} onClick={() => void act(c.id, "save")}>
            Save
          </Button>
          <Button disabled={busy !== null} onClick={() => (!c.paid || confirm(`Testing ${c.label} makes one billed request. Continue?`)) && void act(c.id, "test")}>
            {busy === `${c.id}:test` ? "Testing…" : "Test"}
          </Button>
          {c.source === "settings" && (
            <Button variant="danger" disabled={busy !== null} onClick={() => void act(c.id, "delete")}>
              Remove
            </Button>
          )}
        </div>
        {r && <p className={cx("text-xs", r.tone === "ok" ? "text-ok" : r.tone === "danger" ? "text-danger" : r.tone === "accent" ? "text-accent" : "text-muted")}>{r.text}</p>}
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-muted">Credentials stay on the server: keys saved here are encrypted (AES-256-GCM) and never shown again; environment variables work too and apply when no key is saved.</p>
      </div>
      <div className="flex gap-1 border-b border-line">
        {(["integrations", "keys"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cx("px-3 py-2 text-xs font-semibold uppercase tracking-wider", tab === t ? "border-b-2 border-accent" : "text-muted hover:text-foreground")}>
            {t === "integrations" ? "Integrations" : "AI & media keys"}
          </button>
        ))}
      </div>
      {data && !data.canSaveKeys && (
        <p className="rounded-md border border-accent/30 bg-accent/10 p-3 text-xs text-accent">
          Saving keys here needs {data.missingForSaving.join(" and ")} on the server. Until then, set the environment variables shown below — Test still works.
        </p>
      )}

      {tab === "integrations" && (
        <>
          <p className="text-sm text-muted">
            Research sources. Each card says what the platform&apos;s current terms allow: DocuCut searches and previews through official APIs and embeds, captures screenshots only of public pages, and never downloads media a platform forbids downloading — for those, upload a copy you are authorised to use.
          </p>
          {!integrations ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : (
            <div className="grid gap-3">
              {integrations.providers.map((p) => {
                const conn = data?.connections.find((c) => c.id === p.connectionId);
                return (
                  <section key={p.id} className="rounded-lg border border-line bg-panel p-4">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="font-semibold">{p.name}</h2>
                          <span className={cx("inline-flex h-5 items-center rounded border px-1.5 text-[10px] font-bold tracking-wide", STATE_STYLE[p.state])}>{p.state.replace(/_/g, " ")}</span>
                          {p.untested && <Tag>not tested</Tag>}
                        </div>
                        <p className="mt-0.5 text-xs text-muted">{p.note}</p>
                      </div>
                      <a href={p.docsUrl} target="_blank" rel="noreferrer noopener" className="shrink-0 text-xs text-info hover:underline">
                        API docs ↗
                      </a>
                    </div>
                    <dl className="mt-3 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted">Allowed</dt>
                      <dd>{p.terms}</dd>
                      <dt className="text-muted">Limits / cost</dt>
                      <dd>{p.limits}</dd>
                      <dt className="text-muted">Provides</dt>
                      <dd>
                        {p.capabilities.search ? `search (${p.categories.join(", ")})` : "no search — paste links"} · preview: {p.capabilities.preview} · {p.capabilities.capture ? "capture allowed" : "no capture"} · {IMPORT_TEXT[p.capabilities.import]}
                      </dd>
                      {p.credentials.length > 0 && (
                        <>
                          <dt className="text-muted">Configuration</dt>
                          <dd className="space-y-0.5">
                            {p.credentials.map((c) => (
                              <div key={c.env.join("+")}>
                                <code className="rounded bg-panel-2 px-1 text-[11px]">{c.env.join(" + ")}</code> — {c.label} {c.required ? "" : "(optional)"} {c.set ? <Tag tone="ok">set</Tag> : <Tag>missing</Tag>}
                              </div>
                            ))}
                          </dd>
                        </>
                      )}
                    </dl>
                    {conn && <div className="mt-3 border-t border-line pt-3">{keyRow(conn, true)}</div>}
                  </section>
                );
              })}
              <section className="rounded-lg border border-line bg-panel p-4 text-xs">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold">Screenshot capture (worker)</h2>
                  <span className={cx("inline-flex h-5 items-center rounded border px-1.5 text-[10px] font-bold", integrations.capture.available ? STATE_STYLE.CONNECTED : STATE_STYLE.REQUIRES_CONFIGURATION)}>{integrations.capture.available ? "AVAILABLE" : "REQUIRES CONFIGURATION"}</span>
                </div>
                <p className="mt-1 text-muted">{integrations.capture.note} Optional: <code className="rounded bg-panel-2 px-1">CAPTURE_BROWSER_PATH</code>.</p>
              </section>
            </div>
          )}
        </>
      )}

      {tab === "keys" && (
        <Panel title="AI, media libraries and transcription">
          {!data ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.connections
                .filter((c) => c.group !== "research")
                .map((c) => (
                  <li key={c.id} className="py-4">
                    {keyRow(c)}
                  </li>
                ))}
            </ul>
          )}
        </Panel>
      )}
    </div>
  );
}
