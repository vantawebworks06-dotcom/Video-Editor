import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { FONTS } from "@/lib/domain/graphics";
import { library } from "@/lib/render/library";

/** The render library's fonts (OFL), so the live preview draws graphics in the same typefaces. */
const ALLOWED = new Set(Object.values(FONTS).map((f) => f.file));

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/fonts/[file]">) {
  const { file } = await ctx.params;
  // Allowlist only: the name can never reach outside the fonts directory.
  if (!ALLOWED.has(file)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const data = await readFile(path.join(library.fontsDir, file));
    return new NextResponse(new Uint8Array(data), { headers: { "content-type": "font/ttf", "cache-control": "public, max-age=604800, immutable" } });
  } catch {
    return NextResponse.json({ error: "Font not installed — run npm run assets:generate" }, { status: 404 });
  }
}
