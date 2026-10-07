/**
 * PowerPoint files from a structured slide list. Server-only.
 *
 * The model describes slides (layouts below); this lays them out with one
 * restrained theme so every deck is clean without the model doing geometry.
 */

import type PptxGenJSType from "pptxgenjs";
import { z } from "zod";

type PptxSlide = ReturnType<PptxGenJSType["addSlide"]>;

export const slideSchema = z.object({
  layout: z.enum(["title", "section", "bullets", "two-column", "quote", "statement", "image"]).describe(
    "title: deck opener. section: divider. bullets: heading + points. two-column: heading + left/right lists. quote: a quote with attribution. statement: one big sentence. image: heading + a napkin image.",
  ),
  title: z.string().max(200).optional(),
  subtitle: z.string().max(300).optional(),
  bullets: z.array(z.string().max(400)).max(10).optional(),
  left: z.array(z.string().max(300)).max(8).optional(),
  right: z.array(z.string().max(300)).max(8).optional(),
  leftTitle: z.string().max(80).optional(),
  rightTitle: z.string().max(80).optional(),
  quote: z.string().max(600).optional(),
  attribution: z.string().max(200).optional(),
  imageId: z.string().optional().describe("Id of an image item on the napkin (image layout)."),
  notes: z.string().max(3000).optional().describe("Speaker notes."),
});

export type Slide = z.infer<typeof slideSchema>;

export interface DeckTheme {
  /** Hex without #. */
  accent?: string;
  font?: string;
}

const INK = "1D1B17";
const MUTED = "6B655B";
const PAPER = "FFFFFF";

export async function buildPptx(
  title: string,
  slides: Slide[],
  theme: DeckTheme,
  loadImage: (id: string) => Promise<{ data: string; mimeType: string } | undefined>,
): Promise<Buffer> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
  pptx.title = title;
  const accent = /^[0-9a-f]{6}$/i.test(theme.accent ?? "") ? theme.accent! : "D2491F";
  const font = theme.font || "Helvetica Neue";
  const W = 13.33;

  const heading = (slide: PptxSlide, text: string | undefined) => {
    if (!text) return;
    slide.addText(text, { x: 0.7, y: 0.5, w: W - 1.4, h: 0.9, fontFace: font, fontSize: 30, bold: true, color: INK, valign: "top" });
    slide.addShape(pptx.ShapeType.rect, { x: 0.7, y: 1.42, w: 0.6, h: 0.06, fill: { color: accent }, line: { color: accent } });
  };
  const list = (items: string[], size = 20) =>
    items.map((text) => ({ text, options: { bullet: { indent: 18 }, fontFace: font, fontSize: size, color: INK, paraSpaceAfter: 10 } }));

  for (const spec of slides) {
    const slide = pptx.addSlide();
    slide.background = { color: PAPER };
    switch (spec.layout) {
      case "title":
        slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.25, h: 7.5, fill: { color: accent }, line: { color: accent } });
        slide.addText(spec.title ?? title, { x: 0.9, y: 2.3, w: W - 1.8, h: 1.6, fontFace: font, fontSize: 44, bold: true, color: INK, valign: "bottom" });
        if (spec.subtitle) slide.addText(spec.subtitle, { x: 0.9, y: 4.05, w: W - 1.8, h: 1.0, fontFace: font, fontSize: 22, color: MUTED, valign: "top" });
        break;
      case "section":
        slide.background = { color: INK };
        slide.addText(spec.title ?? "", { x: 0.9, y: 2.6, w: W - 1.8, h: 1.4, fontFace: font, fontSize: 40, bold: true, color: PAPER });
        if (spec.subtitle) slide.addText(spec.subtitle, { x: 0.9, y: 4.0, w: W - 1.8, h: 0.8, fontFace: font, fontSize: 20, color: "BDB6AA" });
        break;
      case "bullets":
        heading(slide, spec.title);
        if (spec.bullets?.length) slide.addText(list(spec.bullets), { x: 0.7, y: 1.8, w: W - 1.4, h: 5.2, valign: "top" });
        break;
      case "two-column": {
        heading(slide, spec.title);
        const colW = (W - 1.4 - 0.6) / 2;
        [
          [spec.leftTitle, spec.left, 0.7],
          [spec.rightTitle, spec.right, 0.7 + colW + 0.6],
        ].forEach(([sub, items, x]) => {
          let y = 1.8;
          if (sub) {
            slide.addText(sub as string, { x: x as number, y, w: colW, h: 0.5, fontFace: font, fontSize: 18, bold: true, color: accent });
            y += 0.6;
          }
          const lines = (items as string[] | undefined) ?? [];
          if (lines.length) slide.addText(list(lines, 18), { x: x as number, y, w: colW, h: 7 - y, valign: "top" });
        });
        break;
      }
      case "quote":
        slide.addText(`“${spec.quote ?? ""}”`, { x: 1.2, y: 1.6, w: W - 2.4, h: 3.4, fontFace: "Georgia", fontSize: 32, italic: true, color: INK, valign: "middle" });
        if (spec.attribution) slide.addText(`— ${spec.attribution}`, { x: 1.2, y: 5.1, w: W - 2.4, h: 0.6, fontFace: font, fontSize: 18, color: MUTED });
        break;
      case "statement":
        slide.addText(spec.title ?? spec.subtitle ?? "", { x: 1.0, y: 1.5, w: W - 2.0, h: 4.5, fontFace: font, fontSize: 40, bold: true, color: INK, valign: "middle" });
        break;
      case "image": {
        heading(slide, spec.title);
        const image = spec.imageId ? await loadImage(spec.imageId) : undefined;
        if (image) slide.addImage({ data: `data:${image.mimeType};base64,${image.data}`, x: 0.7, y: 1.8, w: W - 1.4, h: 5.2, sizing: { type: "contain", w: W - 1.4, h: 5.2 } });
        if (spec.subtitle) slide.addText(spec.subtitle, { x: 0.7, y: 6.9, w: W - 1.4, h: 0.4, fontFace: font, fontSize: 14, color: MUTED });
        break;
      }
    }
    if (spec.notes) slide.addNotes(spec.notes);
  }
  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}
