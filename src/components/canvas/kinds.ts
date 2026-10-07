import type { NodeKind } from "@/lib/napkin/types";

export interface KindStyle {
  /** Small label shown on the card; absent for kinds that speak for themselves. */
  label?: string;
  /** Card classes: background, border, text. */
  card: string;
  /** Rotate slightly, like a post-it. */
  tilt?: boolean;
  /** Render text as markdown. */
  markdown?: boolean;
  /** Lines of text shown before the card clips. */
  clamp: number;
}

export const KIND_STYLES: Record<NodeKind, KindStyle> = {
  idea: { card: "bg-white border border-line shadow-sm text-[15px] leading-snug", clamp: 12 },
  note: { card: "bg-transparent border border-transparent text-[15px] leading-snug", clamp: 20 },
  question: { label: "Question", card: "bg-[#f8e58c] border border-[#e9d26a] shadow-md text-[14px] leading-snug", tilt: true, clamp: 8 },
  search: { label: "Search", card: "bg-white border border-line shadow-sm text-[13px] leading-snug", markdown: true, clamp: 7 },
  definition: { label: "Definition", card: "bg-[#eaf1f8] border border-[#c9d8e8] text-[13px] leading-snug", markdown: true, clamp: 8 },
  example: { label: "Example", card: "bg-[#ecf3e6] border border-[#cfdcc3] text-[13px] leading-snug", markdown: true, clamp: 8 },
  doc: { label: "File", card: "bg-white border border-line shadow-sm text-[13px] leading-snug", markdown: true, clamp: 8 },
  link: { label: "Link", card: "bg-white border border-line shadow-sm text-[13px] leading-snug", markdown: true, clamp: 7 },
  image: { card: "bg-white border border-line shadow-sm text-[12px]", clamp: 3 },
  artifact: { label: "File", card: "bg-white border border-ink/25 shadow-md text-[13px] leading-snug", clamp: 4 },
  writeup: { label: "Write-up", card: "bg-white border border-ink/25 shadow-md text-[13px] leading-snug", markdown: true, clamp: 14 },
};
