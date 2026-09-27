import { NextResponse } from "next/server";
import { requireUser, route } from "@/lib/api/server";
import { browserAvailable } from "@/lib/capture/browser";
import { RESEARCH_PROVIDERS } from "@/lib/research";
import type { ProviderState } from "@/lib/research/types";
import { listConnections, resolveCredentials } from "@/lib/settings/apiKeys";

const FROM_TEST: Record<string, ProviderState> = {
  connected: "CONNECTED",
  public: "CONNECTED",
  invalid_key: "NOT_CONNECTED",
  rate_limited: "RATE_LIMITED",
  error: "UNAVAILABLE",
  not_connected: "REQUIRES_CONFIGURATION",
};

/**
 * Research integrations: what each platform permits, whether it is configured, and the last
 * known state. Configured-but-untested providers say so rather than claiming CONNECTED.
 */
export const GET = route(async () => {
  const { userId } = await requireUser();
  const [creds, connections] = await Promise.all([resolveCredentials(userId), listConnections(userId)]);
  const providers = RESEARCH_PROVIDERS.map((p) => {
    const conn = connections.find((c) => c.research === p.id);
    const configured = p.configured(creds);
    const keyless = !p.credentials.some((c) => c.required);
    let state: ProviderState;
    let note: string;
    if (!configured) {
      state = "REQUIRES_CONFIGURATION";
      note = `Needs ${p.credentials.filter((c) => c.required).map((c) => c.env.join(" + ")).join(", ")}.`;
    } else if (conn && conn.lastTestedAt && FROM_TEST[conn.status]) {
      state = FROM_TEST[conn.status]!;
      note = conn.message ?? `Last tested ${new Date(conn.lastTestedAt).toLocaleString()}.`;
    } else {
      state = "CONNECTED";
      note = keyless ? "Public API — no key needed." : "Configured — not tested yet (use Test).";
    }
    return {
      id: p.id,
      name: p.name,
      categories: p.categories,
      capabilities: p.capabilities,
      credentials: p.credentials.map((c) => ({ env: c.env, label: c.label, required: c.required, set: Boolean(creds[c.key]) })),
      docsUrl: p.docsUrl,
      terms: p.terms,
      limits: p.limits,
      configured,
      untested: configured && !keyless && !(conn && conn.lastTestedAt),
      state,
      note,
      connectionId: conn?.id ?? null,
    };
  });
  return NextResponse.json({ providers, capture: { available: browserAvailable(), note: browserAvailable() ? "Chrome/Edge found — screenshots run on the worker." : "No Chrome/Edge/Chromium found; set CAPTURE_BROWSER_PATH on the worker." } });
});
