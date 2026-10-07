import { Suspense } from "react";
import { NapkinView } from "@/components/canvas/NapkinView";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <NapkinView id={id} />
    </Suspense>
  );
}
