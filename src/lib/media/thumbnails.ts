/**
 * Static thumbnail for small, numerous previews (timeline, rights list). GIPHY thumbnails are
 * animated GIFs (often 0.3–2 MB each); GIPHY publishes a still frame of every rendition next to
 * it as `<name>_s.gif`. Other URLs are returned unchanged.
 */
export function stillThumbnail(url: string): string {
  try {
    const u = new URL(url);
    if (!/(^|\.)giphy\.com$/.test(u.hostname)) return url;
    const still = u.pathname.replace(/\/([a-z0-9_]+?)(?<!_s)\.gif$/i, "/$1_s.gif");
    if (still === u.pathname) return url;
    u.pathname = still;
    return u.toString();
  } catch {
    return url;
  }
}
