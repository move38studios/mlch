/**
 * The "Start here" mulch: one area per thing mlch does, as cards to read and
 * try. Made once, on first launch; the person opens it when they want.
 *
 * Every word here is a placeholder for George's wording (docs/PLAN-2.md, Wording).
 */

import { newClientId } from "@/lib/mulch/ids";
import { applyToMulch, createMulch } from "@/lib/mulch/store";
import type { MulchNode, MulchOp, NodeKind } from "@/lib/mulch/types";

interface Card {
  kind?: NodeKind;
  title?: string;
  text: string;
}

const AREAS: Array<{ title: string; cards: Card[] }> = [
  {
    title: "Talk and type",
    cards: [
      { text: "Press the mic and talk. Your points appear as cards." },
      { text: "Or type below and press Return." },
      { text: "Start with / to give an instruction: /organize this, /write a summary." },
    ],
  },
  {
    title: "Move around",
    cards: [
      { text: "Drag the empty canvas to move. Mouse wheel or pinch to zoom." },
      { text: "⌘0 shows everything. Shift-drag selects." },
      { text: "Double-click a card to edit it." },
    ],
  },
  {
    title: "What the AI adds",
    cards: [
      { kind: "question", text: "Questions that push the thinking further." },
      { kind: "definition", title: "Definition", text: "Terms that matter." },
      { kind: "example", text: "Examples from the real world." },
      { kind: "search", title: "Sources", text: "Web results, with links." },
    ],
  },
  {
    title: "Calls",
    cards: [
      { text: "The headphones button listens to a call: you and the others." },
      { text: "⌃⌘L or the menu bar icon: a new mulch, already listening." },
      { text: "Type while it listens: make a quick deck from what we just discussed." },
    ],
  },
  {
    title: "What you already know",
    cards: [
      { text: "Settings → Sources: link folders once, like an Obsidian vault." },
      { text: "When something there or in another mulch relates, a link card appears, saying why." },
    ],
  },
  {
    title: "Make and share",
    cards: [
      { text: "Ask for a deck, a page, a document or an image." },
      { text: "Share sends a link to a made file, or to the whole canvas, live." },
    ],
  },
  {
    title: "Find",
    cards: [
      { text: "⌘K searches this mulch or all of them." },
      { text: "Drop files, links or screenshots (⌘⇧2) onto the canvas." },
    ],
  },
];

const COLUMN = 300;
const CARD_W = 240;
const CARD_GAP = 18;
const HEAD = 56;

function height(card: Card): number {
  return 70 + Math.ceil(card.text.length / 30) * 20 + (card.title ? 22 : 0);
}

export function startHereOps(now = Date.now()): MulchOp[] {
  const ops: MulchOp[] = [];
  AREAS.forEach((area, column) => {
    const x = column * (COLUMN + 40);
    let y = HEAD;
    const groupId = newClientId("g");
    const nodes: MulchNode[] = area.cards.map((card) => {
      const node: MulchNode = { id: newClientId("n"), kind: card.kind ?? "idea", x: x + 30, y, w: CARD_W, text: card.text, ...(card.title ? { title: card.title } : {}), groupId, origin: "user", createdAt: now };
      y += height(card) + CARD_GAP;
      return node;
    });
    ops.push({ op: "addGroup", group: { id: groupId, title: area.title, x, y: 0, w: COLUMN, h: y + 20, origin: "user", createdAt: now } });
    for (const node of nodes) ops.push({ op: "addNode", node });
  });
  return ops;
}

export async function createStartHere(): Promise<string> {
  const mulch = await createMulch("Start here");
  await applyToMulch(mulch.id, startHereOps(), "user");
  return mulch.id;
}
