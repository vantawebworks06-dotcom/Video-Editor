/**
 * Upload validation. Filenames and browser-declared MIME types are never trusted: the stored
 * object name is generated server-side, the extension/MIME must be on an allow-list, and the
 * first bytes are sniffed. Duration and decodability are verified with ffprobe by the worker.
 */
export type UploadKind = "narration" | "reference" | "music" | "script" | "image";

interface KindRule {
  folder: "audio" | "assets";
  maxBytes: number;
  maxSeconds: number | null;
  exts: Record<string, string[]>; // ext → accepted MIME types
}

const AUDIO: Record<string, string[]> = {
  mp3: ["audio/mpeg", "audio/mp3"],
  wav: ["audio/wav", "audio/x-wav", "audio/wave"],
  m4a: ["audio/mp4", "audio/x-m4a", "audio/aac"],
  aac: ["audio/aac"],
  ogg: ["audio/ogg"],
  flac: ["audio/flac"],
};
const VIDEO: Record<string, string[]> = {
  mp4: ["video/mp4"],
  mov: ["video/quicktime"],
  webm: ["video/webm"],
};

// Supabase free tier caps single uploads at 50 MB; raise with a paid plan + bucket limit.
const MB = 1024 * 1024;
export const UPLOAD_RULES: Record<UploadKind, KindRule> = {
  narration: { folder: "audio", maxBytes: 50 * MB, maxSeconds: 60 * 60, exts: { ...AUDIO, ...VIDEO } },
  reference: { folder: "assets", maxBytes: 50 * MB, maxSeconds: 60 * 60, exts: VIDEO },
  music: { folder: "audio", maxBytes: 50 * MB, maxSeconds: 30 * 60, exts: AUDIO },
  script: { folder: "assets", maxBytes: 1 * MB, maxSeconds: null, exts: { txt: ["text/plain"] } },
  image: { folder: "assets", maxBytes: 20 * MB, maxSeconds: null, exts: { jpg: ["image/jpeg"], jpeg: ["image/jpeg"], png: ["image/png"], webp: ["image/webp"] } },
};

export function validateUploadRequest(kind: UploadKind, filename: string, mime: string, size: number): { ext: string } {
  const rule = UPLOAD_RULES[kind];
  if (!rule) throw new Error("Unknown upload kind");
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (!/^[a-z0-9]{2,5}$/.test(ext) || !rule.exts[ext]) {
    throw new Error(`File type .${ext} is not allowed for ${kind}. Allowed: ${Object.keys(rule.exts).join(", ")}`);
  }
  if (!rule.exts[ext]!.includes(mime.toLowerCase())) throw new Error(`MIME type ${mime} does not match .${ext}`);
  if (!Number.isFinite(size) || size <= 0) throw new Error("Empty file");
  if (size > rule.maxBytes) throw new Error(`File is too large (max ${Math.round(rule.maxBytes / MB)} MB)`);
  return { ext };
}

/** Server-generated object path — user filenames never become paths. */
export function storagePathFor(projectId: string, kind: UploadKind, ext: string): string {
  const id = crypto.randomUUID();
  return `${projectId}/${UPLOAD_RULES[kind].folder}/${kind}-${id}.${ext}`;
}

/** Check magic bytes for the declared extension. */
export function sniffMatches(ext: string, head: Uint8Array): boolean {
  const b = (i: number) => head[i] ?? -1;
  const ascii = (from: number, len: number) => String.fromCharCode(...head.slice(from, from + len));
  switch (ext) {
    case "mp3":
      return ascii(0, 3) === "ID3" || (b(0) === 0xff && (b(1) & 0xe0) === 0xe0);
    case "wav":
      return ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE";
    case "flac":
      return ascii(0, 4) === "fLaC";
    case "ogg":
      return ascii(0, 4) === "OggS";
    case "aac":
      return b(0) === 0xff && (b(1) & 0xf6) === 0xf0;
    case "m4a":
    case "mp4":
    case "mov":
      return ascii(4, 4) === "ftyp" || ascii(4, 4) === "moov" || ascii(4, 4) === "mdat" || ascii(4, 4) === "wide";
    case "webm":
      return b(0) === 0x1a && b(1) === 0x45 && b(2) === 0xdf && b(3) === 0xa3;
    case "jpg":
    case "jpeg":
      return b(0) === 0xff && b(1) === 0xd8;
    case "png":
      return b(0) === 0x89 && ascii(1, 3) === "PNG";
    case "webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP";
    case "txt":
      return !head.slice(0, 512).some((c) => c === 0); // no NUL bytes
    default:
      return false;
  }
}
