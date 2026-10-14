/**
 * The "Start here" mulch: one area per thing mlch does, as cards to read and
 * try. Made once, on first launch; the person opens it when they want.
 *
 * Every word here is a placeholder for George's wording (docs/PLAN-2.md, Wording).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { embedFiles } from "@/lib/agent/tools";
import { saveArtifact } from "@/lib/artifacts/artifacts";
import { buildDeck } from "@/lib/artifacts/deck";
import { saveAsset } from "@/lib/ingest/ingest";
import { newClientId } from "@/lib/mulch/ids";
import { applyToMulch, createMulch } from "@/lib/mulch/store";
import type { MulchNode, MulchOp, NodeKind } from "@/lib/mulch/types";

interface Card {
  kind?: NodeKind;
  title?: string;
  text: string;
  /** A link card (a YouTube link plays in place). */
  url?: string;
  /** A picture that ships with the app (public/brand), shown as a picture card. */
  picture?: { file: string; aspect: number; transparent?: boolean };
  /** The example deck, made when the mulch is. */
  deck?: true;
}

const AREAS: Array<{ title: string; cards: Card[] }> = [
  {
    title: "Talk and type",
    cards: [
      { text: "Press the mic and talk. Your points appear as cards." },
      { text: "Or type below and press Return." },
      { text: "Start with / to give an instruction: /organize this, /write a summary." },
      { text: "Hold ⌥ while you talk: what you say until you let go is one instruction, like a walkie-talkie." },
      { kind: "note", text: "Try it: hold ⌥ and say “make a three-slide deck from the Make and share column”." },
    ],
  },
  {
    title: "Move around",
    cards: [
      { text: "Drag the empty canvas to move. Mouse wheel or pinch to zoom." },
      { text: "⌘0 shows everything. Shift-drag selects." },
      { text: "Double-click a card to edit it." },
      { text: "⌘Z undoes. The clock button shows earlier versions of the canvas." },
      { text: "⌘J opens the conversation: what you said and typed, and what became of it." },
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
      { kind: "artifact", title: "An example deck", text: "", deck: true },
      { text: "Settings → Style: the look of what it makes (fonts, colours, your logo)." },
    ],
  },
  {
    title: "Find",
    cards: [
      { text: "⌘K searches this mulch or all of them." },
      { text: "Drop files, links or screenshots (⌘⇧2) onto the canvas." },
      { kind: "image", title: "What mlch runs on", text: "mlch on Claude Code or Codex, on your own Claude or ChatGPT plan or an API key.", picture: { file: "brand/stack.svg", aspect: 482 / 600, transparent: true } },
    ],
  },
  {
    title: "Watch",
    cards: [
      { kind: "link", url: "https://www.youtube.com/watch?v=zRrR4ryx-yE", title: "A concept video and Alan Kay talk at WWDC ’90", text: "Alan Kay at Apple’s developer conference in 1990." },
    ],
  },
];

/** The example deck's slides, in the house style's type. */
const DECK_CSS = `@font-face { font-family: "Schibsted Grotesk"; src: url("{{file:mlch:fonts/SchibstedGrotesk.woff2}}") format("woff2"); font-weight: 400 900; }
body { background: #000; }
.slide { background: #fcfcfa; color: #000; font-family: "Schibsted Grotesk", system-ui, sans-serif; }
.inner { height: 100%; box-sizing: border-box; padding: 140px 160px; display: flex; flex-direction: column; justify-content: center; gap: 40px; }
h1 { font-size: 140px; font-weight: 700; letter-spacing: -0.03em; line-height: 1; margin: 0; }
h2 { font-size: 96px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.05; margin: 0; }
p { font-size: 44px; line-height: 1.35; margin: 0; color: rgba(0,0,0,0.65); }
.cols { display: grid; grid-template-columns: repeat(3, 1fr); gap: 80px; }
.cols h3 { font-size: 56px; font-weight: 650; margin: 0 0 20px; }
.mark { display: inline-block; background: #ffc000; padding: 0 16px; }
.foot { position: absolute; left: 160px; bottom: 80px; font-size: 28px; color: rgba(0,0,0,0.4); }`;

const DECK_SLIDES = [
  `<div class="inner"><h1>Start here</h1><p>An example of a deck made in mlch.</p></div>`,
  `<div class="inner"><h2>Talk or type.<br>The canvas <span class="mark">fills in</span>.</h2></div>`,
  `<div class="inner"><div class="cols"><div><h3>Capture</h3><p>Your points become cards while you speak.</p></div><div><h3>Connect</h3><p>Sources, questions and links to what you explored before.</p></div><div><h3>Make</h3><p>Decks, pages and documents, shared with a link.</p></div></div></div>`,
  `<div class="inner"><h2>Ask for one</h2><p>Hold ⌥ and say what you want made.</p></div><div class="foot">made with mlch</div>`,
];

const COLUMN = 300;
const CARD_W = 240;
const CARD_GAP = 18;
const HEAD = 56;

function height(card: Card): number {
  const text = 70 + Math.ceil(card.text.length / 30) * 20 + (card.title ? 22 : 0);
  if (card.picture) return CARD_W * card.picture.aspect + text - 20;
  if (card.deck || card.url) return (CARD_W * 9) / 16 + text;
  return text;
}

/** Files some cards show, made in the mulch first: pictures by asset id, the deck by its path. */
interface Files {
  assets: Record<string, string>;
  deck?: string;
}

export function startHereOps(now = Date.now(), files: Files = { assets: {} }): MulchOp[] {
  const ops: MulchOp[] = [];
  AREAS.forEach((area, column) => {
    const x = column * (COLUMN + 40);
    let y = HEAD;
    const groupId = newClientId("g");
    const nodes: MulchNode[] = area.cards.flatMap((card) => {
      const extra: Partial<MulchNode> = {};
      if (card.url) extra.url = card.url;
      if (card.picture) {
        const assetId = files.assets[card.picture.file];
        if (!assetId) return [];
        Object.assign(extra, { assetId, fileName: path.basename(card.picture.file), ...(card.picture.transparent ? { transparent: true } : {}) });
      }
      if (card.deck) {
        if (!files.deck) return [];
        Object.assign(extra, { docPath: files.deck, fileName: path.basename(files.deck) });
      }
      const node: MulchNode = { id: newClientId("n"), kind: card.kind ?? "idea", x: x + 30, y, w: CARD_W, text: card.text, ...(card.title ? { title: card.title } : {}), ...extra, groupId, origin: "user", createdAt: now };
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
  const files: Files = { assets: {} };
  // The picture and the deck ship with the app; a card whose file cannot be made is left out.
  for (const card of AREAS.flatMap((area) => area.cards)) {
    if (!card.picture) continue;
    const bytes = await fs.readFile(path.join(process.cwd(), "public", card.picture.file)).catch(() => undefined);
    if (bytes) files.assets[card.picture.file] = await saveAsset(mulch.id, bytes, path.basename(card.picture.file));
  }
  const { content } = await embedFiles(buildDeck({ title: "Start here", slides: DECK_SLIDES, css: DECK_CSS }), undefined);
  files.deck = await saveArtifact(mulch.id, "Start here", "html", Buffer.from(content)).catch(() => undefined);
  await applyToMulch(mulch.id, startHereOps(Date.now(), files), "user");
  return mulch.id;
}
