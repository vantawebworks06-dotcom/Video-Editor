import { api } from "@/components/ui";
import { getSupabaseEnv } from "@/lib/supabase/env";

export type UploadKind = "narration" | "reference" | "music" | "script";

const ATTEMPTS = 3;

/**
 * PUT the file to a Supabase signed upload URL — the same request supabase-js'
 * `uploadToSignedUrl` makes — but through XMLHttpRequest, which reports upload progress
 * (fetch can't). The browser streams the File from disk; it is never read into memory.
 */
function putSigned(objectPath: string, token: string, file: File, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  const { url, anonKey } = getSupabaseEnv();
  const target = `${url}/storage/v1/object/upload/sign/projects/${objectPath.split("/").map(encodeURIComponent).join("/")}?token=${encodeURIComponent(token)}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", target);
    xhr.setRequestHeader("apikey", anonKey);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `HTTP ${xhr.status}`;
      try {
        message = (JSON.parse(xhr.responseText) as { message?: string }).message ?? message;
      } catch {
        // not JSON: keep the HTTP status
      }
      reject(Object.assign(new Error(`Upload failed: ${message}`), { retryable: xhr.status >= 500 || xhr.status === 429 }));
    };
    xhr.onerror = () => reject(Object.assign(new Error("Upload failed: network error"), { retryable: true }));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    const body = new FormData();
    body.append("cacheControl", "3600");
    body.append("", file);
    xhr.send(body);
  });
}

/**
 * Validate → signed upload straight to Supabase Storage (with progress, retried on network
 * errors/5xx) → server-side byte sniffing.
 */
export async function uploadProjectFile(projectId: string, kind: UploadKind, file: File, opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}) {
  const start = await api<{ path: string; token: string }>(`/api/projects/${projectId}/uploads`, {
    method: "POST",
    json: { step: "start", kind, filename: file.name, mime: file.type || "application/octet-stream", size: file.size },
  });
  for (let attempt = 1; ; attempt++) {
    try {
      await putSigned(start.path, start.token, file, opts.onProgress, opts.signal);
      break;
    } catch (err) {
      if (attempt >= ATTEMPTS || !(err as { retryable?: boolean }).retryable || opts.signal?.aborted) throw err;
      opts.onProgress?.(0);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  await api(`/api/projects/${projectId}/uploads`, { method: "POST", json: { step: "complete", kind, path: start.path } });
}
