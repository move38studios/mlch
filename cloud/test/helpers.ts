import { exports } from "cloudflare:workers";
import type { Mulch, OpBatch } from "../../src/lib/mulch/types";

export const APEX = "https://mlch.test";
export const SHARE = "https://share.mlch.test";

export function call(url: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(url, { redirect: "manual", ...init }));
}

export async function create(body: Record<string, unknown>, install = "test-install"): Promise<{ id: string; ownerToken: string; url: string; manifestUrl: string }> {
  const response = await call(`${APEX}/api/shares`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Mlch-Install": install },
    body: JSON.stringify(body),
  });
  if (response.status !== 201) throw new Error(`create failed: ${response.status} ${await response.text()}`);
  return response.json();
}

export function auth(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...extra };
}

export function putFile(id: string, token: string, path: string, body: string | Uint8Array): Promise<Response> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return call(`${APEX}/api/shares/${id}/files/${path}`, { method: "PUT", headers: auth(token, { "Content-Length": String(bytes.byteLength) }), body: bytes });
}

export function mulch(nodes: Mulch["nodes"] = {}): Mulch {
  return { version: 1, id: "m1", title: "Pricing ideas", createdAt: 1, updatedAt: 1, nodes, edges: {}, groups: {} };
}

export function idea(id: string, text: string) {
  return { id, kind: "idea" as const, x: 0, y: 0, text, origin: "user", createdAt: 1 };
}

export function batch(id: string, ops: OpBatch["ops"]): OpBatch {
  return { id, mulchId: "m1", ops, origin: "user", at: 2 };
}

export function putSnapshot(id: string, token: string, value: Mulch): Promise<Response> {
  return call(`${APEX}/api/shares/${id}/snapshot`, { method: "PUT", headers: auth(token, { "Content-Type": "application/json" }), body: JSON.stringify(value) });
}

export function pushOps(id: string, token: string, batches: OpBatch[]): Promise<Response> {
  return call(`${APEX}/api/shares/${id}/ops`, { method: "POST", headers: auth(token, { "Content-Type": "application/json" }), body: JSON.stringify({ batches }) });
}

/** A viewer's socket, collecting what it receives. */
export async function viewer(id: string): Promise<{ messages: Array<Record<string, unknown>>; next: (count: number) => Promise<Array<Record<string, unknown>>>; close: () => void }> {
  const response = await call(`${SHARE}/s/${id}/live`, { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;
  if (!socket) throw new Error(`no socket: ${response.status}`);
  socket.accept();
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
    for (const wake of waiters.splice(0)) wake();
  });
  const next = async (count: number) => {
    const deadline = Date.now() + 3000;
    while (messages.length < count) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} messages; got ${JSON.stringify(messages)}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    return messages.slice(0, count);
  };
  return { messages, next, close: () => socket.close() };
}
