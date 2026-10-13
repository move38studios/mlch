/**
 * fal.ai: model catalogue, schemas, prices, uploads and the queue. Server-only.
 *
 * The agent chooses models and inputs; this module only speaks fal's HTTP
 * APIs. Endpoints, as of 2026-10:
 *   api.fal.ai/v1/models            search (q, category), metadata
 *   api.fal.ai/v1/models/pricing    unit price per endpoint
 *   fal.ai/api/openapi/queue/openapi.json?endpoint_id=  input/output schema
 *   rest.alpha.fal.ai/storage/upload/initiate  signed upload for inputs
 *   queue.fal.run/<endpoint>        submit; status and result URLs follow
 */

import { getCredential } from "@/lib/desktop/server";

const API = "https://api.fal.ai/v1";

export class FalError extends Error {}

function key(): string {
  const value = getCredential("fal");
  if (!value) throw new FalError("Add a fal API key in Settings to generate media.");
  return value;
}

async function falFetch(url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Key ${key()}`, ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
  return response;
}

async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let detail = body.slice(0, 400);
    try {
      const parsed = JSON.parse(body) as { detail?: unknown; error?: { message?: string } };
      detail = typeof parsed.detail === "string" ? parsed.detail : parsed.error?.message ?? JSON.stringify(parsed.detail ?? parsed).slice(0, 400);
    } catch {
      // keep the text
    }
    if (response.status === 401 || response.status === 403) throw new FalError(`fal refused the key (${response.status}): ${detail}`);
    throw new FalError(`${what} failed (${response.status}): ${detail}`);
  }
  return (await response.json()) as T;
}

/* ── catalogue ─────────────────────────────────────────────────── */

export interface FalModel {
  endpoint: string;
  name: string;
  category: string;
  description: string;
  released: string;
  family?: string;
  tags?: string[];
  price?: string;
}

interface RawModel {
  endpoint_id: string;
  metadata?: { display_name?: string; category?: string; description?: string; updated_at?: string; date?: string; status?: string; tags?: string[]; group?: { label?: string } };
}

export async function getPrices(endpoints: string[]): Promise<Map<string, { unit_price: number; unit: string }>> {
  const prices = new Map<string, { unit_price: number; unit: string }>();
  for (let i = 0; i < endpoints.length; i += 40) {
    const query = endpoints.slice(i, i + 40).map((e) => `endpoint_id=${encodeURIComponent(e)}`).join("&");
    try {
      const data = await json<{ prices: Array<{ endpoint_id: string; unit_price: number; unit: string }> }>(await falFetch(`${API}/models/pricing?${query}`), "Pricing");
      for (const price of data.prices) prices.set(price.endpoint_id, price);
    } catch {
      // Prices are a nicety for search; a failure leaves them out.
    }
  }
  return prices;
}

/**
 * The catalogue: by relevance for a query, newest first otherwise (fal's own
 * default order is what is trending, which favours old, cheap models).
 * `endpoints` looks up exact ids (to check that picks still exist).
 */
export async function searchModels(options: { query?: string; category?: string; limit?: number; endpoints?: string[] }): Promise<FalModel[]> {
  const params = new URLSearchParams({ status: "active", limit: String(Math.min(100, options.limit ?? 40)) });
  if (options.query) params.set("q", options.query);
  else if (!options.endpoints) params.set("sort", "recent");
  if (options.category) params.set("category", options.category);
  for (const endpoint of options.endpoints ?? []) params.append("endpoint_id", endpoint);
  const data = await json<{ models: RawModel[] }>(await falFetch(`${API}/models?${params}`), "Model search");
  const prices = await getPrices(data.models.map((m) => m.endpoint_id));
  return data.models.map((m) => {
    const price = prices.get(m.endpoint_id);
    return {
      endpoint: m.endpoint_id,
      name: m.metadata?.display_name ?? m.endpoint_id,
      category: m.metadata?.category ?? "",
      description: (m.metadata?.description ?? "").slice(0, 220),
      // When the model came out (not when its page was last edited).
      released: (m.metadata?.date ?? m.metadata?.updated_at ?? "").slice(0, 10),
      ...(m.metadata?.group?.label ? { family: m.metadata.group.label } : {}),
      ...(m.metadata?.tags?.length ? { tags: m.metadata.tags.slice(0, 6) } : {}),
      ...(price ? { price: `$${price.unit_price} per ${price.unit}` } : {}),
    };
  });
}

/* ── schemas ───────────────────────────────────────────────────── */

type JsonSchema = Record<string, unknown>;

/** Resolve $refs and keep only what helps fill the input (type, description, enum, default, items, properties). */
function compact(schema: unknown, components: Record<string, JsonSchema>, depth = 0): unknown {
  if (!schema || typeof schema !== "object" || depth > 6) return schema;
  const node = schema as JsonSchema;
  if (typeof node.$ref === "string") {
    const name = node.$ref.split("/").pop()!;
    return compact(components[name], components, depth + 1);
  }
  const out: JsonSchema = {};
  for (const keyName of ["type", "description", "enum", "default", "minimum", "maximum", "format", "examples"]) {
    if (node[keyName] !== undefined) out[keyName] = keyName === "description" ? String(node[keyName]).slice(0, 300) : node[keyName];
  }
  for (const combo of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(node[combo])) out[combo] = (node[combo] as unknown[]).map((s) => compact(s, components, depth + 1));
  }
  if (node.items) out.items = compact(node.items, components, depth + 1);
  if (node.properties && typeof node.properties === "object") {
    out.properties = Object.fromEntries(Object.entries(node.properties as JsonSchema).map(([k, v]) => [k, compact(v, components, depth + 1)]));
  }
  if (Array.isArray(node.required)) out.required = node.required;
  return out;
}

export interface FalSchema {
  endpoint: string;
  input: unknown;
  output: unknown;
  price?: string;
}

const schemaCache = new Map<string, { at: number; value: FalSchema }>();

export async function modelSchema(endpoint: string): Promise<FalSchema> {
  const cached = schemaCache.get(endpoint);
  if (cached && Date.now() - cached.at < 30 * 60_000) return cached.value;
  const response = await fetch(`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${encodeURIComponent(endpoint)}`, { signal: AbortSignal.timeout(30_000) });
  const spec = await json<{ paths?: Record<string, { post?: { requestBody?: { content?: Record<string, { schema?: unknown }> } } }>; components?: { schemas?: Record<string, JsonSchema> } }>(response, "Schema");
  const components = spec.components?.schemas ?? {};
  const submit = Object.entries(spec.paths ?? {}).find(([p, op]) => !p.includes("/requests/") && op.post)?.[1];
  const input = submit?.post?.requestBody?.content?.["application/json"]?.schema;
  if (!input) throw new FalError(`No input schema for ${endpoint}. Check the endpoint id with media_search.`);
  const outputName = Object.keys(components).find((name) => name.endsWith("Output"));
  const price = (await getPrices([endpoint])).get(endpoint);
  const value: FalSchema = {
    endpoint,
    input: compact(input, components),
    output: outputName ? compact(components[outputName], components) : undefined,
    ...(price ? { price: `$${price.unit_price} per ${price.unit}` } : {}),
  };
  schemaCache.set(endpoint, { at: Date.now(), value });
  return value;
}

/* ── uploads ───────────────────────────────────────────────────── */

/** Upload a mulch file so a model can use it as input; returns its URL. */
export async function uploadFile(bytes: Buffer, contentType: string, fileName: string): Promise<string> {
  const initiate = await json<{ upload_url?: string; file_url?: string }>(
    await falFetch("https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: contentType, file_name: fileName }),
    }),
    "Upload",
  );
  if (!initiate.upload_url?.startsWith("https://") || !initiate.file_url?.startsWith("https://")) throw new FalError("fal returned no upload URL.");
  const put = await fetch(initiate.upload_url, { method: "PUT", headers: { "Content-Type": contentType }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(300_000) });
  if (!put.ok) throw new FalError(`Upload failed (${put.status}).`);
  return initiate.file_url;
}

/* ── queue ─────────────────────────────────────────────────────── */

export interface QueueHandle {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
  cancelUrl?: string;
}

const QUEUE = "https://queue.fal.run/";

function queueUrl(url: unknown, fallback: string): string {
  return typeof url === "string" && url.startsWith(QUEUE) ? url : fallback;
}

export async function submit(endpoint: string, input: unknown): Promise<QueueHandle> {
  if (!/^[a-z0-9][a-z0-9._/-]{2,200}$/i.test(endpoint) || endpoint.includes("..")) throw new FalError(`Invalid endpoint ${endpoint}.`);
  const data = await json<{ request_id: string; status_url?: string; response_url?: string; cancel_url?: string }>(
    await falFetch(`${QUEUE}${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }),
    "Submit",
  );
  const base = `${QUEUE}${endpoint}/requests/${data.request_id}`;
  return {
    requestId: data.request_id,
    statusUrl: queueUrl(data.status_url, `${base}/status`),
    responseUrl: queueUrl(data.response_url, base),
    cancelUrl: queueUrl(data.cancel_url, `${base}/cancel`),
  };
}

export interface QueueStatus {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
  queue_position?: number;
  logs?: Array<{ message: string }>;
  error?: string;
}

export async function status(handle: QueueHandle): Promise<QueueStatus> {
  return json<QueueStatus>(await falFetch(`${handle.statusUrl}${handle.statusUrl.includes("?") ? "&" : "?"}logs=1`), "Status");
}

export async function result(handle: QueueHandle): Promise<unknown> {
  return json<unknown>(await falFetch(handle.responseUrl, {}, 60_000), "Result");
}

export async function cancel(handle: QueueHandle): Promise<void> {
  if (handle.cancelUrl) await falFetch(handle.cancelUrl, { method: "PUT" }).catch(() => undefined);
}

/* ── outputs ───────────────────────────────────────────────────── */

export interface OutputFile {
  url: string;
  contentType?: string;
  fileName?: string;
}

/** Every file in a result: objects with an https `url` (fal's File/Image/Video/Audio shapes). */
export function outputFiles(value: unknown, found: OutputFile[] = []): OutputFile[] {
  if (Array.isArray(value)) value.forEach((item) => outputFiles(item, found));
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.url === "string" && /^https:\/\//.test(record.url)) {
      found.push({
        url: record.url,
        ...(typeof record.content_type === "string" ? { contentType: record.content_type } : {}),
        ...(typeof record.file_name === "string" ? { fileName: record.file_name } : {}),
      });
    } else for (const child of Object.values(record)) outputFiles(child, found);
  }
  return found;
}
