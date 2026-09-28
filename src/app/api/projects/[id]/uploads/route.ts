import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, parseBody, requireProject, requireUser, route } from "@/lib/api/server";
import { sniffMatches, storagePathFor, UPLOAD_RULES, type UploadKind, validateUploadRequest } from "@/lib/security/uploads";
import { BUCKET, createAdminClient, hasServiceRole } from "@/lib/supabase/admin";
import { sampleFolder } from "@/lib/narrator/samples";
import { createItem } from "@/lib/data/media";
import { MediaCategory } from "@/lib/domain/media";

const KINDS = Object.keys(UPLOAD_RULES) as [UploadKind, ...UploadKind[]];

const StartBody = z.object({
  step: z.literal("start"),
  kind: z.enum(KINDS),
  filename: z.string().min(1).max(300),
  mime: z.string().min(3).max(100),
  size: z.number().int().positive(),
});
const MediaMeta = z.object({
  filename: z.string().max(300).optional(),
  title: z.string().trim().max(500).optional(),
  category: MediaCategory.optional(),
  sentenceIdx: z.number().int().min(0).nullable().optional(),
  rightsNotes: z.string().max(4000).nullable().optional(),
  rightsConfirmed: z.boolean().optional(),
  /** The research item this file is an authorised copy of (e.g. a YouTube video the user has rights to). */
  derivedFrom: z.uuid().nullable().optional(),
  /** Voice uploads: the voice profile the sample belongs to. */
  profileId: z.uuid().optional(),
});
const CompleteBody = z.object({ step: z.literal("complete"), kind: z.enum(KINDS), path: z.string().min(10).max(400), meta: MediaMeta.optional() });

const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
const VIDEO_EXT = new Set(["mp4", "mov", "webm"]);

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

  if (body.kind === "media") {
    // A user file joins the media library: a renderable asset (images/video) + a media item with
    // provenance. Rights stay "needs review" unless the user states they hold them.
    const meta = body.meta ?? {};
    const kind = IMAGE_EXT.has(ext) ? (ext === "gif" ? "gif" : "photo") : VIDEO_EXT.has(ext) ? "video" : "audio";
    const confirmed = Boolean(meta.rightsConfirmed);
    const title = (meta.title || meta.filename || `Upload ${new Date().toLocaleDateString()}`).replace(/\p{Cc}/gu, "").slice(0, 300);
    let assetId: string | null = null;
    if (kind !== "audio") {
      const { data: asset, error } = await auth.supabase
        .from("assets")
        .insert({
          user_id: auth.userId,
          provider: "uploaded",
          provider_asset_id: body.path,
          type: kind,
          title,
          media_url: `storage:${body.path}`,
          download_url: `storage:${body.path}`,
          source_url: "User upload",
          license: confirmed ? "Rights confirmed by the project owner" : "User-provided — rights not confirmed",
          rights_status: confirmed ? "CLEAR" : "USER_REVIEW",
          rights_notes: meta.rightsNotes ? [meta.rightsNotes] : [],
          user_approved: true,
          retrieved_at: new Date().toISOString(),
          metadata: { categories: ["upload"] },
        })
        .select("id")
        .single();
      if (error) throw error;
      assetId = asset.id;
    }
    const category = meta.category ?? (kind === "video" ? "video" : kind === "audio" ? "audio" : "photo");
    const item = await createItem(auth.supabase, { userId: auth.userId, projectId: project.id }, {
      category,
      provider: "upload",
      externalId: body.path,
      title,
      sourceUrl: null,
      platform: "User upload",
      assetId,
      storagePath: body.path,
      sentenceIdx: meta.sentenceIdx ?? null,
      rightsNotes: meta.rightsNotes ?? null,
      license: confirmed ? "Rights confirmed by the project owner" : null,
      derivedFrom: meta.derivedFrom ?? null,
      status: "APPROVED",
      importedAt: new Date().toISOString(),
      metadata: { originalFilename: meta.filename?.slice(0, 300) ?? null, fileType: kind, ext, rightsConfirmed: confirmed },
    });
    // The worker measures the file (dimensions, duration) and makes a thumbnail for video.
    await auth.supabase.from("pipeline_jobs").insert({ project_id: project.id, user_id: auth.userId, kind: "import_media", payload: { itemId: item.id } });
    return NextResponse.json({ ok: true, itemId: item.id });
  }

  if (body.kind === "voice") {
    const profileId = body.meta?.profileId;
    if (!profileId) throw new HttpError(400, "Choose a voice profile for this sample.");
    // RLS scopes the profile to its owner.
    const { data: profile } = await auth.supabase.from("voice_profiles").select("id, samples").eq("id", profileId).maybeSingle();
    if (!profile) {
      await auth.supabase.storage.from(BUCKET).remove([body.path]);
      throw new HttpError(404, "Voice profile not found");
    }
    // Into the profile's own folder (kept when the project is deleted; see lib/narrator/samples).
    let path = body.path;
    if (hasServiceRole()) {
      const dest = `${sampleFolder(project.id, profile.id)}/${body.path.split("/").pop()}`;
      const { error: mvErr } = await createAdminClient().storage.from(BUCKET).move(body.path, dest);
      if (!mvErr) path = dest;
    }
    const name = (body.meta?.title || body.meta?.filename || "Recording").replace(/\p{Cc}/gu, "").slice(0, 120);
    const samples = [...((profile.samples as unknown[]) ?? []), { path, name, duration: null, addedAt: new Date().toISOString() }];
    const { error } = await auth.supabase.from("voice_profiles").update({ samples, updated_at: new Date().toISOString() }).eq("id", profile.id);
    if (error) throw error;
    return NextResponse.json({ ok: true, path });
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
