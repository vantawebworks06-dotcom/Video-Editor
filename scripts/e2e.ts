/**
 * End-to-end test against the real Supabase project and a running app + worker.
 * Creates a throwaway confirmed user, drives the HTTP API exactly like the browser,
 * then deletes the project, its storage objects and the user.
 *
 *   npm run start (or dev) on BASE_URL, npm run worker, then: npx tsx --env-file=.env.local scripts/e2e.ts
 */
import { createServerClient } from "@supabase/ssr";
import { createAdminClient } from "@/lib/supabase/admin";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createAdminClient();
// Loose view of /api/projects/[id]/status for polling.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Status = Record<string, any>;

async function sessionCookies(email: string, password: string): Promise<string> {
  const jar = new Map<string, string>();
  const sb = createServerClient(url, anon, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function main() {
  const email = `docucut-e2e-${Date.now()}@example.com`;
  const password = `E2e-${crypto.randomUUID()}`;
  const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const userId = created.user.id;
  console.log("test user created");
  let projectId: string | null = null;
  const t0 = Date.now();

  try {
    const cookie = await sessionCookies(email, password);
    const call = async <T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> => {
      const res = await fetch(`${BASE}${path}`, {
        method: init.method ?? "GET",
        headers: { cookie, ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      });
      const body = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${body.error}`);
      return body;
    };
    const wait = async (label: string, done: (s: Status) => boolean, key: "pipelineJob" | "renderJob") => {
      let last = "";
      for (;;) {
        const s = await call<Status>(`/api/projects/${projectId}/status`);
        const j = s[key];
        const line = `${label}: ${j?.status} ${Math.round(Number(j?.progress ?? 0) * 100)}% ${j?.current_stage ?? ""}`;
        if (line !== last) console.log("  " + line);
        last = line;
        if (j?.status === "FAILED") throw new Error(`${label} failed: ${j.error}`);
        if (done(s)) return s;
        await new Promise((r) => setTimeout(r, 3000));
      }
    };

    console.log("GET /api/projects:", (await call<{ projects: unknown[] }>("/api/projects")).projects.length, "projects");
    projectId = (await call<{ id: string }>("/api/projects/demo", { method: "POST" })).id;
    console.log("demo project created, generation queued");

    const gen = await wait("generate", (s) => s.pipelineJob?.status === "COMPLETE", "pipelineJob");
    console.log("  result:", JSON.stringify({ director: gen.pipelineJob.result?.director, scenes: gen.pipelineJob.result?.scenes, clips: gen.pipelineJob.result?.clips, warnings: gen.pipelineJob.result?.warnings?.length }));

    const edit = await call<{ plans: { sceneId: string }[]; clips: { clipId: string; asset: { provider: string; type: string; title: string; rightsStatus: string } }[]; words: unknown[] }>(`/api/projects/${projectId}/edit`);
    console.log(`edit: ${edit.plans.length} scenes, ${edit.clips.length} clips, ${edit.words.length} words`);
    const byProvider: Record<string, number> = {};
    for (const c of edit.clips) byProvider[`${c.asset.provider}/${c.asset.type}`] = (byProvider[`${c.asset.provider}/${c.asset.type}`] ?? 0) + 1;
    console.log("  sources:", JSON.stringify(byProvider));

    // Editing endpoints.
    const target = edit.clips.find((c) => c.asset.type === "photo") ?? edit.clips[0]!;
    await call(`/api/projects/${projectId}/clips/${target.clipId}`, { method: "PATCH", json: { action: "update", motion: { type: "pan_left", intensity: 0.1 }, blackAndWhite: true } });
    console.log(`PATCH clip ${target.clipId}: motion + B&W ok`);
    await call(`/api/projects/${projectId}/scenes/${edit.plans[1]!.sceneId}`, { method: "POST", json: { action: "text", enabled: true, text: "Everyone knew", style: "dramatic", position: "center", animation: "pop", at: 0.5, duration: 2 } });
    console.log(`POST scene text ok`);
    const rec = await call<{ director: string; candidates: { provider: string; providerAssetId: string; title: string; overall: number }[] }>(`/api/projects/${projectId}/clips/${target.clipId}/recommend`, { method: "POST" });
    console.log(`recommend: ${rec.candidates.length} candidates via ${rec.director}; top: ${rec.candidates[0]?.provider} "${rec.candidates[0]?.title.slice(0, 50)}" (${rec.candidates[0]?.overall})`);
    if (rec.candidates[0]) {
      const r = await call<{ rightsStatus: string }>(`/api/projects/${projectId}/clips/${target.clipId}/replace`, { method: "POST", json: { provider: rec.candidates[0].provider, providerAssetId: rec.candidates[0].providerAssetId } });
      console.log(`replace (Use This): ok, rights ${r.rightsStatus}`);
    }
    const search = await call<{ candidates: { provider: string }[]; errors: unknown[] }>("/api/media/search", { method: "POST", json: { query: "sound system speakers", types: ["video", "photo"] } });
    console.log(`media search: ${search.candidates.length} results, ${search.errors.length} errors`);
    const keys = await call<{ connections: { id: string; status: string; hint: string | null }[] }>("/api/settings/keys");
    console.log("settings connections:", keys.connections.map((c) => `${c.id}=${c.status}`).join(" "));
    console.log("no key material in response:", !JSON.stringify(keys).match(/[A-Za-z0-9]{30,}/));

    await call(`/api/projects/${projectId}/jobs`, { method: "POST", json: { type: "render", format: "draft" } });
    console.log("render queued");
    const r = await wait("render", (s) => s.renderJob?.status === "COMPLETE" && Boolean(s.latestExport?.url), "renderJob");
    console.log(`export: ${r.latestExport.format}, ${(r.latestExport.size_bytes / 1e6).toFixed(1)} MB, ${Number(r.latestExport.duration).toFixed(1)}s, warnings ${r.renderJob.warnings?.length ?? 0}`);
    const dl = await fetch(r.latestExport.url, { headers: { Range: "bytes=0-15" } });
    console.log(`signed download URL: HTTP ${dl.status}, ftyp=${Buffer.from(await dl.arrayBuffer()).toString("latin1").includes("ftyp")}`);
    console.log(`AI usage recorded: ${JSON.stringify(r.usage)}`);
    console.log(`E2E PASSED in ${Math.round((Date.now() - t0) / 1000)}s`);
  } finally {
    if (projectId) {
      for (const folder of ["audio", "assets", "thumbnails", "renders", "temp"]) {
        const { data } = await admin.storage.from("projects").list(`${projectId}/${folder}`, { limit: 1000 });
        if (data?.length) await admin.storage.from("projects").remove(data.map((f) => `${projectId}/${folder}/${f.name}`));
      }
    }
    await admin.auth.admin.deleteUser(userId); // cascades to public.users → projects → scenes/assets/jobs
    const { count } = await admin.from("projects").select("id", { count: "exact", head: true }).eq("user_id", userId);
    console.log(`cleanup: test user deleted, remaining projects for it: ${count}`);
  }
}

main().catch((e) => {
  console.error("E2E FAILED:", e);
  process.exit(1);
});
