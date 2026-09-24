import { Editor } from "@/components/editor/Editor";

export default async function ProjectEditorPage(props: PageProps<"/projects/[id]">) {
  const { id } = await props.params;
  return <Editor projectId={id} />;
}
