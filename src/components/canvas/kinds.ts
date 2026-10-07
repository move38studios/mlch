import type { NodeKind } from "@/lib/mulch/types";

/*
 * Card styles. The person's own words carry an ink outline (see NodeView);
 * everything else sits quieter on a hairline. Colour is used sparingly, as
 * highlighter tints: questions are post-its, definitions mist, examples sage.
 */
export interface KindStyle {
  /** Small lowercase label on the card; absent for kinds that speak for themselves. */
  label?: string;
  /** Background and type. The border comes from who made the card. */
  card: string;
  /** Has its own fill, so the hairline is dropped. */
  tinted?: boolean;
  /** Rotate slightly, like a post-it. */
  tilt?: boolean;
  /** Render text as markdown. */
  markdown?: boolean;
  /** Lines of text shown before the card clips. */
  clamp: number;
}

export const KIND_STYLES: Record<NodeKind, KindStyle> = {
  idea: { card: "bg-chrome text-[15.5px] leading-[1.4]", clamp: 12 },
  note: { card: "bg-transparent text-[16px] leading-[1.4]", clamp: 20 },
  question: { label: "question", card: "bg-amber-soft text-[14.5px] leading-[1.4] shadow-[0_6px_14px_-8px_rgba(0,0,0,0.35)]", tinted: true, tilt: true, clamp: 8 },
  search: { label: "source", card: "bg-chrome text-[13.5px] leading-[1.45]", markdown: true, clamp: 7 },
  definition: { label: "definition", card: "bg-mist text-[13.5px] leading-[1.45]", tinted: true, markdown: true, clamp: 8 },
  example: { label: "example", card: "bg-sage text-[13.5px] leading-[1.45]", tinted: true, markdown: true, clamp: 8 },
  doc: { label: "file", card: "bg-chrome text-[13.5px] leading-[1.45]", markdown: true, clamp: 8 },
  link: { label: "link", card: "bg-chrome text-[13.5px] leading-[1.45]", markdown: true, clamp: 7 },
  image: { card: "bg-chrome text-[12.5px]", clamp: 3 },
  media: { card: "bg-chrome text-[12.5px]", clamp: 3 },
  artifact: { label: "made", card: "bg-chrome text-[13.5px] leading-[1.45]", clamp: 4 },
  writeup: { label: "write-up", card: "bg-chrome text-[13.5px] leading-[1.5]", markdown: true, clamp: 14 },
};
