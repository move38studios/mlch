import { jsonError } from "@/lib/http";
import { ASSET_ID } from "@/lib/ingest/ingest";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; asset: string }> };

/**
 * A page showing one 3D model of the mulch, for the agent's renders (main
 * captures it from four sides; ArrowRight turns it 90°). Our own page, not
 * generated content.
 */
export async function GET(_request: Request, { params }: Params) {
  const { id, asset } = await params;
  if (!ASSET_ID.test(asset) || !/\.(glb|gltf)$/.test(asset)) return jsonError(404, "Not found.");
  const src = `/api/mulches/${encodeURIComponent(id)}/assets/${asset}`;
  const html = `<!doctype html><html><head><meta charset="utf-8">
<script type="module" src="https://unpkg.com/@google/model-viewer@4/dist/model-viewer.min.js"></script>
<style>html,body{margin:0;height:100%;background:#f6f4ef}model-viewer{width:100%;height:100%}</style></head>
<body><model-viewer id="m" src="${src}" camera-orbit="0deg 75deg auto" interaction-prompt="none" shadow-intensity="1" exposure="1"></model-viewer>
<script>let a=0;addEventListener('keydown',e=>{if(e.key==='ArrowRight'){a+=90;document.getElementById('m').cameraOrbit=a+'deg 75deg auto';}});</script>
</body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline' https://unpkg.com; connect-src 'self' blob: data:; img-src 'self' blob: data:; style-src 'unsafe-inline'; worker-src blob:",
    },
  });
}
