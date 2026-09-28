import { NextResponse, type NextRequest } from "next/server";
import { HttpError, requireProject, requireUser, route } from "@/lib/api/server";
import { narratorText, parseNarrator, transcriptFromTimings } from "@/lib/narrator/state";

/**
 * Make the generated narration the project's narration: its audio, its script, and a transcript
 * from the exact sentence timings (so the edit lines up without re-aligning).
 */
export const POST = route(async (_req: NextRequest, ctx: RouteContext<"/api/projects/[id]/narrator/use">) => {
  const auth = await requireUser();
  const project = await requireProject(auth, (await ctx.params).id, "id, narrator");
  const n = parseNarrator(project.narrator);
  if (!n.output) throw new HttpError(400, "Generate the narration first.");
  const transcript = transcriptFromTimings(n, n.output.timings, n.output.duration);
  const { error } = await auth.supabase
    .from("projects")
    .update({ narration_path: n.output.narrationPath, script: narratorText(n), transcript, narration_duration: n.output.duration })
    .eq("id", project.id);
  if (error) throw error;
  return NextResponse.json({ ok: true, duration: n.output.duration, words: transcript.words.length });
});
