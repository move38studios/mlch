/**
 * mlch.app's landing page: a small canvas, the product as its own preview.
 * The app's canvas runs here with nothing behind it (landing-main.tsx answers its
 * requests): cards can be moved, written and connected; nothing is saved, and
 * a reload starts again. Wording from the app's onboarding (George's).
 */

import { useEffect } from "react";
import { Download } from "lucide-react";
import { Canvas } from "@/components/canvas/Canvas";
import { SidePanel } from "@/components/canvas/SidePanel";
import { useCanvasUi } from "@/components/canvas/ui";
import { useMulch } from "@/lib/mulch/client";
import type { Mulch, MulchEdge, MulchNode } from "@/lib/mulch/types";

export const LANDING_ID = "landing";
/** The current release, marked as early (package.json's version, at build time). */
const VERSION = import.meta.env.VITE_MLCH_VERSION ?? "";
/** Where the source lives once it is public; empty hides the link. */
const SOURCE_URL = import.meta.env.VITE_MLCH_SOURCE_URL ?? "";

const at = Date.UTC(2026, 9, 13);
const card = (id: string, kind: MulchNode["kind"], x: number, y: number, text: string, extra: Partial<MulchNode> = {}): MulchNode => ({
  id,
  kind,
  x,
  y,
  text,
  origin: "user",
  createdAt: at,
  ...extra,
});
const ai = (node: MulchNode): MulchNode => ({ ...node, origin: "agent:landing" });

const NODES: MulchNode[] = [
  // The logo, as a picture on the canvas (served from /brand by the Worker at the asset address image cards use).
  card("logo", "image", 120, -330, "", { assetId: "icon.svg", w: 180 }),
  card("about", "idea", 0, 0, "A partner to think with, and a live canvas for every project, call and idea. While you talk, it maps, researches and connects what you say to everything you’ve explored before. Then it makes the deck.", { title: "A whiteboard that thinks with you", w: 420 }),
  card("note", "note", -330, -20, "An AI app for non-linear thinkers."),
  ai(card("talk", "idea", 520, -180, "You talk or type; mlch maps it onto the canvas while you speak.")),
  ai(card("lookup", "idea", 560, 20, "It looks things up as you go: sources, examples, definitions, the questions worth asking.")),
  ai(card("connect", "idea", 520, 230, "It spots where today’s thinking meets what you explored before, in other canvases and in your notes, and draws the line.")),
  ai(card("make", "idea", 80, 330, "Ask for a deck, a document or an interactive page, and share it with a link.")),
  ai(card("calls", "idea", -300, 260, "On calls it listens to both sides and keeps the notes.")),
];

const EDGES: MulchEdge[] = ["talk", "lookup", "connect", "make", "calls"].map((target) => ({ id: `e-${target}`, source: "about", target, origin: "agent:landing", createdAt: at }));

/** On a phone the same cards go in one column, so the canvas can open zoomed in at the top and be scrolled. */
const PHONE_ORDER = ["logo", "about", "note", "talk", "lookup", "connect", "make", "calls"];
const PHONE_Y: Record<string, number> = { logo: -280, about: 0, note: 300, talk: 520, lookup: 700, connect: 900, make: 1120, calls: 1300 };

function seed(phone: boolean): Mulch {
  const nodes = phone ? NODES.map((node) => ({ ...node, x: node.kind === "note" ? 40 : node.id === "logo" ? 70 : 0, y: PHONE_Y[node.id] ?? PHONE_ORDER.indexOf(node.id) * 200, w: node.id === "logo" ? 160 : 300 })) : NODES;
  return {
    version: 1,
    id: LANDING_ID,
    title: "mlch",
    createdAt: at,
    updatedAt: at,
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    // In one column the lines would only cross each other.
    edges: phone ? {} : Object.fromEntries(EDGES.map((edge) => [edge.id, edge])),
    groups: {},
  };
}

const LINKS: Array<[string, string]> = [
  ...(SOURCE_URL ? ([["Source code", SOURCE_URL]] as Array<[string, string]>) : []),
  ["Your own server", "/server"],
  ["Privacy", "/privacy"],
  ["Terms", "/terms"],
  ["Refunds", "/refunds"],
  ["Company", "/company"],
];

export function Landing() {
  const mulch = useMulch((s) => s.mulch);
  useEffect(() => {
    const phone = window.matchMedia("(max-width: 640px)").matches;
    useMulch.setState({ id: LANDING_ID, mulch: seed(phone), connected: true });
    useCanvasUi.setState({ readOnly: false });
    // A phone opens on the first card, readable; the rest is below.
    if (phone) {
      const focus = setTimeout(() => useMulch.getState().setFocus({ ids: ["logo", "about"] }), 500);
      // Focusing selects the card; a click on the empty canvas lets it go again.
      const release = setTimeout(() => document.querySelector(".react-flow__pane")?.dispatchEvent(new MouseEvent("click", { bubbles: true })), 1300);
      return () => {
        clearTimeout(focus);
        clearTimeout(release);
      };
    }
  }, []);

  return (
    <main className="landing h-full flex">
      <div className="relative flex-1 min-w-0">
        {mulch && <Canvas mulch={mulch} />}
        {/* Where the app has its input bar: the download, what it needs, and the site's links. */}
        <footer className="absolute inset-x-0 bottom-0 px-3 sm:px-4 pb-3 sm:pb-4 flex justify-center z-10 pointer-events-none">
          <div className="pointer-events-auto float rounded-2xl p-2 w-full sm:w-auto sm:min-w-[420px] max-w-[560px]">
            <a href="/download" className="h-14 rounded-xl bg-amber text-ink text-[17px] font-semibold flex items-center justify-center gap-2.5 whitespace-nowrap hover:brightness-[1.03]">
              <Download size={20} strokeWidth={2.25} /> Download for Mac
            </a>
            <p className="mt-1.5 text-center text-[12.5px] text-ink-3 tabular-nums">{VERSION ? `Early release ${VERSION}, ` : ""}macOS 14.4 or later, Apple silicon</p>
            <nav className="mt-1 flex flex-wrap justify-center gap-x-0.5 text-[12.5px] text-ink-2">
              {LINKS.map(([label, href]) => (
                <a key={href} href={href} className="px-2 py-1 rounded-lg hover:bg-paper-2 hover:text-ink">
                  {label}
                </a>
              ))}
            </nav>
          </div>
        </footer>
      </div>
      <SidePanel />
    </main>
  );
}
