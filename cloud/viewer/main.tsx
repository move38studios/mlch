import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./viewer.css";
import { shareId, Viewer } from "./Viewer";

/*
 * The app's cards ask the app's server to open or reveal files (POST
 * /api/mulches/<id>/open|reveal). Here there is no Finder: opening a file
 * opens (or downloads) it from the share, and reveal does nothing.
 */
const fetchFromApp = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const action = url.match(/^\/api\/mulches\/[^/]+\/(open|reveal)$/)?.[1];
  if (action && init?.method === "POST") {
    const { docPath } = JSON.parse(String(init.body ?? "{}")) as { docPath?: string };
    if (action === "open" && docPath) window.open(`/s/${shareId}/${docPath}`, "_blank", "noopener");
    return new Response(null, { status: 204 });
  }
  return fetchFromApp(input, init);
};

createRoot(document.getElementById("root")!).render(<Viewer />);
