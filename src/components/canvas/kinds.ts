import type { NodeKind } from "@/lib/mulch/types";

/*
 * Card styles. The person's own words carry an ink outline (see NodeView);
 * everything else sits quieter on a hairline. Colour is used sparingly, as
 * highlighter tints: the person's typed notes are yellow post-its, questions
 * blush, definitions mist, examples sage.
 */
export interface KindStyle {
  /** Small lowercase label on the card; absent for kinds that speak for themselves. */
  label?: string;
  /** Background and type. The border comes from who made the card. */
  card: string;
  /** Has its own fill, so the hairline is dropped. */
  tinted?: boolean;
  /** Square corners, like a post-it. */
  square?: boolean;
  /** Render text as markdown. */
  markdown?: boolean;
  /** Lines of text shown before the card clips. */
  clamp: number;
}

export const KIND_STYLES: Record<NodeKind, KindStyle> = {
  idea: { card: "bg-chrome text-[15.5px] leading-[1.4]", clamp: 12 },
  note: { card: "bg-amber-soft text-[15.5px] leading-[1.4] min-h-[120px] shadow-[0_6px_14px_-8px_rgba(0,0,0,0.35)]", tinted: true, square: true, markdown: true, clamp: 20 },
  question: { label: "question", card: "bg-blush text-[14.5px] leading-[1.4]", tinted: true, clamp: 8 },
  search: { label: "source", card: "bg-chrome text-[13.5px] leading-[1.45]", markdown: true, clamp: 7 },
  definition: { label: "definition", card: "bg-mist text-[13.5px] leading-[1.45]", tinted: true, markdown: true, clamp: 8 },
  example: { label: "example", card: "bg-sage text-[13.5px] leading-[1.45]", tinted: true, markdown: true, clamp: 8 },
  doc: { label: "file", card: "bg-chrome text-[13.5px] leading-[1.45]", markdown: true, clamp: 8 },
  link: { label: "link", card: "bg-chrome text-[13.5px] leading-[1.45]", markdown: true, clamp: 7 },
  image: { card: "bg-chrome text-[12.5px]", clamp: 3 },
  media: { card: "bg-chrome text-[12.5px]", clamp: 3 },
  artifact: { label: "made", card: "bg-chrome text-[13.5px] leading-[1.45]", clamp: 4 },
  ref: { card: "bg-chrome text-[13.5px] leading-[1.45]", clamp: 3 },
  writeup: { label: "write-up", card: "bg-chrome text-[13.5px] leading-[1.5]", markdown: true, clamp: 14 },
};
