import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireUser, route } from "@/lib/api/server";
import { canEncrypt } from "@/lib/security/crypto";
import { CONNECTIONS, deleteKey, listConnections, saveKey, testConnection } from "@/lib/settings/apiKeys";
import { hasServiceRole } from "@/lib/supabase/admin";

const Provider = z.enum(CONNECTIONS.map((c) => c.id) as [string, ...string[]]);

/** Connection summaries only — key material never leaves the server. */
export const GET = route(async () => {
  const { userId } = await requireUser();
  return NextResponse.json({
    connections: await listConnections(userId),
    canSaveKeys: hasServiceRole() && canEncrypt(),
    missingForSaving: [!hasServiceRole() && "SUPABASE_SERVICE_ROLE_KEY", !canEncrypt() && "APP_ENCRYPTION_KEY"].filter(Boolean),
  });
});

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), provider: Provider, key: z.string().min(8).max(500) }),
  z.object({ action: z.literal("delete"), provider: Provider }),
  z.object({ action: z.literal("test"), provider: Provider }),
]);

export const POST = route(async (req: Request) => {
  const { userId } = await requireUser();
  const body = await parseBody(req, Body);
  const provider = body.provider as (typeof CONNECTIONS)[number]["id"];
  if (body.action === "save") {
    if (!hasServiceRole() || !canEncrypt()) throw new HttpError(400, "Saving keys requires SUPABASE_SERVICE_ROLE_KEY and APP_ENCRYPTION_KEY on the server. You can also set the provider's environment variable instead.");
    try {
      await saveKey(userId, provider, body.key);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    return NextResponse.json({ ok: true, status: await testConnection(userId, provider) });
  }
  if (body.action === "delete") {
    if (hasServiceRole()) await deleteKey(userId, provider);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ ok: true, status: await testConnection(userId, provider) });
});
