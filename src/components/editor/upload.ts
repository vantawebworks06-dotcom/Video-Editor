import { api } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";

export type UploadKind = "narration" | "reference" | "music" | "script";

/** Validate → signed upload straight to Supabase Storage → server-side byte sniffing. */
export async function uploadProjectFile(projectId: string, kind: UploadKind, file: File) {
  const start = await api<{ path: string; token: string }>(`/api/projects/${projectId}/uploads`, {
    method: "POST",
    json: { step: "start", kind, filename: file.name, mime: file.type || "application/octet-stream", size: file.size },
  });
  const { error } = await createClient().storage.from("projects").uploadToSignedUrl(start.path, start.token, file, { contentType: file.type });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  await api(`/api/projects/${projectId}/uploads`, { method: "POST", json: { step: "complete", kind, path: start.path } });
}
