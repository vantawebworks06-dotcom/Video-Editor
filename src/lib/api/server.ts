import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AuthedContext {
  supabase: SupabaseClient;
  userId: string;
}

/** Resolve the signed-in user (RLS-scoped client) or throw 401. */
export async function requireUser(): Promise<AuthedContext> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new HttpError(401, "Please sign in.");
  return { supabase, userId: data.user.id };
}

export async function requireProject(ctx: AuthedContext, projectId: string) {
  if (!z.uuid().safeParse(projectId).success) throw new HttpError(404, "Project not found");
  const { data } = await ctx.supabase.from("projects").select("*").eq("id", projectId).maybeSingle();
  if (!data) throw new HttpError(404, "Project not found");
  return data as Record<string, unknown> & { id: string; user_id: string; name: string; settings: unknown; is_demo: boolean };
}

export async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

/** Wrap a route handler: consistent JSON errors, no stack traces or secrets in responses. */
export function route<Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) {
  return async (...args: Args): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
      console.error("[api]", err);
      const message = err instanceof Error && /SUPABASE_SERVICE_ROLE_KEY|APP_ENCRYPTION_KEY/.test(err.message) ? err.message : "Something went wrong. Check the server logs.";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  };
}

export async function activeJob(supabase: SupabaseClient, projectId: string) {
  const { data } = await supabase
    .from("pipeline_jobs")
    .select("id, status")
    .eq("project_id", projectId)
    .in("status", ["QUEUED", "RUNNING"])
    .limit(1);
  return data?.[0] ?? null;
}
