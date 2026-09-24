import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/** "Editor" nav entry: open the most recently edited project. */
export default async function EditorEntry() {
  const supabase = await createClient();
  const { data } = await supabase.from("projects").select("id").order("updated_at", { ascending: false }).limit(1);
  if (data?.[0]) redirect(`/projects/${data[0].id}`);
  return (
    <div className="p-10 text-sm text-muted">
      No projects yet.{" "}
      <Link href="/projects" className="text-accent underline">
        Create one or open the demo
      </Link>
      .
    </div>
  );
}
