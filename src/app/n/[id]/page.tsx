import { Suspense } from "react";
import { MulchView } from "@/components/canvas/MulchView";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <MulchView id={id} />
    </Suspense>
  );
}
