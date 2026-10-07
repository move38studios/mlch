import { NapkinView } from "@/components/canvas/NapkinView";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <NapkinView id={id} />;
}
