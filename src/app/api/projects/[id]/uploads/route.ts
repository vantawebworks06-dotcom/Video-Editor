import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { sniffMatches, storagePathFor, UPLOAD_RULES, type UploadKind, validateUploadRequest } from "@/lib/security/uploads";
import { BUCKET } from "@/lib/supabase/admin";

const KINDS = Object.keys(UPLOAD_RULES) as [UploadKind, ...UploadKind[]];

const StartBody = z.object({
  step: z.literal("start"),
  kind: z.enum(KINDS),
  filename: z.string().min(1).max(300),
  mime: z.string().min(3).max(100),
  size: z.number().int().positive(),
});
const CompleteBody = z.object({ step: z.literal("complete"), kind: z.enum(KINDS), path: z.string().min(10).max(400) });

const FIELD: Partial<Record<UploadKind, string>> = {
  narration: "narration_path",
  reference: "reference_video_path",
  music: "music_path",
};

/**
 * Two-step upload: (1) validate the declared file and hand back a signed upload URL for a
 * server-generated path; (2) after the browser uploads, sniff the real bytes before the file
 * is attached to the project. Duration/decodability is verified by the worker with ffprobe.
 */
export const POST = route(async (req: NextRequest, ctx: RouteContext<"/api/projects/[id]/uploads">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id);
  const body = await parseBody(req, z.discriminatedUnion("step", [StartBody, CompleteBody]));

  if (body.step === "start") {
    const { ext } = validateUploadRequest(body.kind, body.filename, body.mime, body.size);
    const path = storagePathFor(project.id, body.kind, ext);
    const { data, error } = await auth.supabase.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) throw new HttpError(500, `Could not start upload: ${error?.message ?? "unknown"}`);
    return NextResponse.json({ path, token: data.token });
  }

  // step === "complete"
  const expectedPrefix = `${project.id}/${UPLOAD_RULES[body.kind].folder}/${body.kind}-`;
  if (!body.path.startsWith(expectedPrefix) || body.path.includes("..")) throw new HttpError(400, "Invalid upload path");
  const ext = body.path.split(".").pop() ?? "";

  const { data: signed } = await auth.supabase.storage.from(BUCKET).createSignedUrl(body.path, 60);
  if (!signed) throw new HttpError(400, "Upload not found");
  const head = await fetch(signed.signedUrl, { headers: { Range: "bytes=0-1023" } });
  const bytes = new Uint8Array(await head.arrayBuffer());
  if (!sniffMatches(ext, bytes)) {
    await auth.supabase.storage.from(BUCKET).remove([body.path]);
    throw new HttpError(400, "The file contents do not match its type. Upload rejected.");
  }

  if (body.kind === "script") {
    const full = await fetch(signed.signedUrl);
    const text = (await full.text()).replace(/\u0000/g, "").slice(0, 200_000);
    await auth.supabase.from("projects").update({ script: text, transcript: null }).eq("id", project.id);
    return NextResponse.json({ ok: true, script: text.length });
  }
  const field = FIELD[body.kind];
  if (!field) throw new HttpError(400, "Unsupported upload kind for projects");
  const update: Record<string, unknown> = { [field]: body.path };
  if (body.kind === "narration") update.transcript = null;
  const { error } = await auth.supabase.from("projects").update(update).eq("id", project.id);
  if (error) throw error;
  return NextResponse.json({ ok: true });
});
