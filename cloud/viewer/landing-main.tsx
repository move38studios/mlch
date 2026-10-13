import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./viewer.css";
import { Landing, LANDING_ID } from "./Landing";

/*
 * The landing canvas runs the app's own canvas with nothing behind it: what
 * the canvas would send to the app's server is answered here and kept in this
 * tab only (gone on reload).
 */
const fetchFromPage = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(`/api/mulches/${LANDING_ID}`) || url.startsWith("/api/search") || url.startsWith("/api/settings")) {
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return fetchFromPage(input, init);
};

createRoot(document.getElementById("root")!).render(<Landing />);
