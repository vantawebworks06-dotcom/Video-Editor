/**
 * Undo/redo for timeline edits. Before an edit the project's placements (scene_assets) and scene
 * plans are saved as an 'undo' snapshot; undo restores the newest one and saves the current state
 * as 'redo'. A new edit clears the redo stack. Snapshots are owner-scoped (RLS).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const KEEP = 40;

interface State {
  placements: Record<string, unknown>[];
  plans: { id: string; plan: unknown }[];
}

async function capture(db: SupabaseClient, projectId: string): Promise<State> {
  const [p, s] = await Promise.all([db.from("scene_assets").select("*").eq("project_id", projectId), db.from("scenes").select("id, plan").eq("project_id", projectId)]);
  if (p.error) throw new Error(p.error.message);
  if (s.error) throw new Error(s.error.message);
  return { placements: p.data ?? [], plans: (s.data ?? []) as State["plans"] };
}

async function restore(db: SupabaseClient, projectId: string, state: State) {
  const { error: dErr } = await db.from("scene_assets").delete().eq("project_id", projectId);
  if (dErr) throw new Error(dErr.message);
  // Scenes that no longer exist (regenerated since) can't be restored into.
  const { data: scenes } = await db.from("scenes").select("id").eq("project_id", projectId);
  const live = new Set((scenes ?? []).map((x) => x.id as string));
  const rows = state.placements.filter((r) => live.has(r.scene_id as string)).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "created_at" && k !== "updated_at")));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db.from("scene_assets").insert(rows.slice(i, i + 200));
    if (error) throw new Error(`Restoring the timeline failed: ${error.message}`);
  }
  for (const p of state.plans.filter((x) => live.has(x.id))) await db.from("scenes").update({ plan: p.plan }).eq("id", p.id);
}

async function bump(db: SupabaseClient, projectId: string) {
  const { data } = await db.from("projects").select("timeline_version").eq("id", projectId).single();
  await db
    .from("projects")
    .update({ timeline_version: Number(data?.timeline_version ?? 0) + 1 })
    .eq("id", projectId);
}

/**
 * Run `edit` as one undoable step labelled `label` (e.g. "Place TMZ interview"): the current state
 * is saved first, and the snapshot is dropped again if the edit fails (a rejected edit changes nothing).
 */
export async function undoable<T>(db: SupabaseClient, ctx: { userId: string; projectId: string }, label: string, edit: () => Promise<T>): Promise<T> {
  const id = await snapshot(db, ctx, label);
  try {
    const result = await edit();
    await committed(db, ctx.projectId);
    return result;
  } catch (e) {
    await discardSnapshot(db, id);
    throw e;
  }
}

/** A new edit went through: what was undone can no longer be redone. */
export async function committed(db: SupabaseClient, projectId: string) {
  await db.from("edit_snapshots").delete().eq("project_id", projectId).eq("kind", "redo");
}

/** Drop a snapshot whose edit did not happen. */
export async function discardSnapshot(db: SupabaseClient, id: string) {
  await db.from("edit_snapshots").delete().eq("id", id);
}

/** Save the current state before an edit; call committed() once it succeeds. Prefer undoable(). */
export async function snapshot(db: SupabaseClient, ctx: { userId: string; projectId: string }, label: string): Promise<string> {
  const state = await capture(db, ctx.projectId);
  const { data: row, error } = await db
    .from("edit_snapshots")
    .insert({
      project_id: ctx.projectId,
      user_id: ctx.userId,
      kind: "undo",
      label: label.slice(0, 200),
      data: state,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Saving undo state failed: ${error.message}`);
  const { data: old } = await db
    .from("edit_snapshots")
    .select("id")
    .eq("project_id", ctx.projectId)
    .eq("kind", "undo")
    .order("created_at", { ascending: false })
    .range(KEEP, KEEP + 100);
  if (old?.length)
    await db
      .from("edit_snapshots")
      .delete()
      .in(
        "id",
        old.map((o) => o.id),
      );
  return row.id as string;
}

/** Undo or redo the most recent edit. Returns its label, or null when there is nothing to do. */
export async function step(db: SupabaseClient, ctx: { userId: string; projectId: string }, direction: "undo" | "redo"): Promise<string | null> {
  const { data: snap } = await db
    .from("edit_snapshots")
    .select("id, label, data")
    .eq("project_id", ctx.projectId)
    .eq("kind", direction)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!snap) return null;
  const current = await capture(db, ctx.projectId);
  await restore(db, ctx.projectId, snap.data as State);
  await db.from("edit_snapshots").delete().eq("id", snap.id);
  await db.from("edit_snapshots").insert({
    project_id: ctx.projectId,
    user_id: ctx.userId,
    kind: direction === "undo" ? "redo" : "undo",
    label: snap.label,
    data: current,
  });
  await bump(db, ctx.projectId);
  return snap.label as string;
}

export async function historyState(db: SupabaseClient, projectId: string) {
  const [u, r] = await Promise.all([
    db.from("edit_snapshots").select("label, created_at").eq("project_id", projectId).eq("kind", "undo").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("edit_snapshots").select("label, created_at").eq("project_id", projectId).eq("kind", "redo").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  return {
    undo: (u.data?.label as string | undefined) ?? null,
    redo: (r.data?.label as string | undefined) ?? null,
  };
}
