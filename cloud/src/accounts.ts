/**
 * Accounts on mlch.app: who may make new shares. Only people who share sign
 * in (Google); viewers never do. Sharing needs a subscription ($12 a year
 * plus local tax, Stripe). When it lapses, existing links keep working and
 * keep updating; only new shares are refused.
 *
 * Self-hosted servers don't use any of this: they set SERVER_KEY and the app
 * sends that key instead (see `mayCreate`).
 *
 * Sign-in from the app (PKCE-style, so a grant is useless without the app):
 *   app → browser  GET  /auth/google?challenge=<base64url sha256(verifier)>
 *   Google → GET /auth/google/callback → page that opens mlch://signed-in?code=<grant>
 *   app → POST /api/account/token { code, verifier } → { token }  (the session, kept in Keychain)
 *
 * Wording on these pages is placeholder (George).
 */

import type { Env } from "./env";

export type Outbound = typeof fetch;
let outbound: Outbound = (...args) => fetch(...args);
/** Tests replace calls to Google and Stripe. */
export function setOutbound(next: Outbound): void {
  outbound = next;
}
/** Calls out of the Worker (Google, Stripe, Cloudflare Access), replaceable in tests. */
export const send: Outbound = (...args) => outbound(...args);

const GRANT_MS = 10 * 60_000;
/** Subscription states that may make new shares (past_due: Stripe is still retrying the card). */
const PAID = new Set(["active", "past_due"]);

export interface Account {
  id: string;
  email: string;
  name: string | null;
  status: string | null;
  period_end: number | null;
  stripe_customer: string | null;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const error = (status: number, message: string) => json(status, { error: message });

export function accountsOn(env: Env): boolean {
  return env.ACCOUNTS === "on" && !!env.DB;
}

function random(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
const hashed = async (text: string) => base64url(await sha256(text));

export function sameText(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

/* ── storage (D1; tables made on first use) ─────────────────────── */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, google_sub TEXT UNIQUE NOT NULL, email TEXT NOT NULL, name TEXT, created_at INTEGER NOT NULL, stripe_customer TEXT UNIQUE, subscription_id TEXT, status TEXT, period_end INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sign_ins (state TEXT PRIMARY KEY, challenge TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS grants (code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, challenge TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS shares_user ON shares (user_id)`,
  // Friend codes (admin.ts): a Stripe coupon and its promotion code. The same as migrations/0001_admin.sql.
  `CREATE TABLE IF NOT EXISTS coupons (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, coupon_id TEXT NOT NULL UNIQUE, percent_off INTEGER NOT NULL, max_redemptions INTEGER NOT NULL, expires_at INTEGER, created_at INTEGER NOT NULL, created_by TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, deactivated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS account_codes (user_id TEXT PRIMARY KEY, promotion_code_id TEXT NOT NULL, code TEXT NOT NULL, subscription_id TEXT, created_at INTEGER NOT NULL)`,
  // Only that an account was deleted, when and by which admin; never whose.
  `CREATE TABLE IF NOT EXISTS deletions (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, by TEXT NOT NULL)`,
];
const ready = new WeakMap<D1Database, Promise<unknown>>();
export function db(env: Env): Promise<D1Database> {
  const database = env.DB!;
  if (!ready.has(database)) ready.set(database, database.batch(SCHEMA.map((sql) => database.prepare(sql))));
  return ready.get(database)!.then(() => database);
}

async function sessionAccount(env: Env, token: string | undefined): Promise<Account | undefined> {
  if (!token || !accountsOn(env)) return undefined;
  const database = await db(env);
  const hash = await hashed(token);
  const account = await database.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).bind(hash).first<Account>();
  if (account) await database.prepare(`UPDATE sessions SET used_at = ? WHERE token_hash = ?`).bind(Date.now(), hash).run();
  return account ?? undefined;
}

export const canShare = (account: Account) => PAID.has(account.status ?? "");

/* ── who may make a new share ──────────────────────────────────── */

/**
 * The key or session in X-Mlch-Auth. A self-hosted server (SERVER_KEY) wants
 * its key; mlch.app (ACCOUNTS=on) a signed-in, subscribed person; a server
 * with neither (local development) lets anyone.
 */
export async function mayCreate(request: Request, env: Env): Promise<{ ok: true; userId?: string } | { ok: false; response: Response }> {
  const given = request.headers.get("X-Mlch-Auth")?.trim() ?? "";
  if (env.SERVER_KEY) {
    return given && sameText(given, env.SERVER_KEY) ? { ok: true } : { ok: false, response: error(401, "This server needs its key. Enter it in mlch: Settings, Sharing.") };
  }
  if (!accountsOn(env)) return { ok: true };
  const account = await sessionAccount(env, given || undefined);
  if (!account) return { ok: false, response: error(401, "Sign in to share from mlch.app: Settings, Sharing.") };
  if (!canShare(account)) return { ok: false, response: error(402, "Sharing on mlch.app needs a subscription: Settings, Sharing.") };
  return { ok: true, userId: account.id };
}

export async function recordShare(env: Env, id: string, userId: string, kind: string): Promise<void> {
  if (!accountsOn(env)) return;
  await (await db(env)).prepare(`INSERT INTO shares (id, user_id, kind, created_at) VALUES (?, ?, ?, ?)`).bind(id, userId, kind, Date.now()).run();
}

/* ── pages ─────────────────────────────────────────────────────── */

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A plain page on mlch.app: the wordmark, a line, maybe a link. */
export function page(title: string, line: string, link?: { href: string; label: string }, refresh?: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<link rel="icon" type="image/png" href="/brand/icon-32.png">${refresh ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(refresh)}">` : ""}
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#FCFCFA;color:#000;font:16px/1.5 -apple-system,system-ui,sans-serif}main{text-align:center;padding:24px}img{width:140px;margin-bottom:28px}p{margin:0 0 20px}a{display:inline-block;padding:10px 18px;border-radius:10px;background:#000;color:#fff;text-decoration:none;font-weight:500}</style>
</head><body><main><img src="/brand/wordmark.svg" alt="mlch"><p>${escapeHtml(line)}</p>${link ? `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>` : ""}</main></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

/* ── sign-in ───────────────────────────────────────────────────── */

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

async function startSignIn(env: Env, url: URL): Promise<Response> {
  const challenge = url.searchParams.get("challenge") ?? "";
  if (!CHALLENGE.test(challenge)) return page("mlch", "Start signing in from the mlch app.");
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return page("mlch", "Sign-in is not set up on this server.");
  const state = random();
  const database = await db(env);
  await database.prepare(`DELETE FROM sign_ins WHERE created_at < ?`).bind(Date.now() - GRANT_MS).run();
  await database.prepare(`INSERT INTO sign_ins (state, challenge, created_at) VALUES (?, ?, ?)`).bind(state, challenge, Date.now()).run();
  const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  google.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.APEX_ORIGIN}/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  }).toString();
  return Response.redirect(google.href, 302);
}

interface GoogleIdentity {
  sub: string;
  email: string;
  name?: string;
}

/** The person from Google's token response (read straight from Google over TLS, so the token is not re-verified). */
async function googleIdentity(env: Env, code: string): Promise<GoogleIdentity | undefined> {
  const response = await outbound("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: `${env.APEX_ORIGIN}/auth/google/callback`, grant_type: "authorization_code" }),
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { id_token?: string };
  const payload = body.id_token?.split(".")[1];
  if (!payload) return undefined;
  const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: string; email?: string; email_verified?: boolean; name?: string; aud?: string; iss?: string };
  if (claims.aud !== env.GOOGLE_CLIENT_ID || !["https://accounts.google.com", "accounts.google.com"].includes(claims.iss ?? "")) return undefined;
  if (!claims.sub || !claims.email || claims.email_verified === false) return undefined;
  return { sub: claims.sub, email: claims.email, name: claims.name };
}

/** The person signed in: a one-time grant for the app that started it. */
async function signedIn(env: Env, identity: GoogleIdentity, challenge: string): Promise<Response> {
  const database = await db(env);
  await database
    .prepare(`INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (google_sub) DO UPDATE SET email = excluded.email, name = excluded.name`)
    .bind(random(12), identity.sub, identity.email, identity.name ?? null, Date.now())
    .run();
  const user = await database.prepare(`SELECT id FROM users WHERE google_sub = ?`).bind(identity.sub).first<{ id: string }>();
  const code = random();
  await database.prepare(`INSERT INTO grants (code_hash, user_id, challenge, created_at) VALUES (?, ?, ?, ?)`).bind(await hashed(code), user!.id, challenge, Date.now()).run();
  const back = `mlch://signed-in?code=${code}`;
  return page("Signed in", `Signed in as ${identity.email}.`, { href: back, label: "Back to mlch" }, back);
}

async function finishSignIn(env: Env, url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!state || !code) return page("mlch", "Signing in was cancelled. Start again from the mlch app.");
  const database = await db(env);
  const pending = await database.prepare(`SELECT challenge, created_at FROM sign_ins WHERE state = ?`).bind(state).first<{ challenge: string; created_at: number }>();
  await database.prepare(`DELETE FROM sign_ins WHERE state = ?`).bind(state).run();
  if (!pending || Date.now() - pending.created_at > GRANT_MS) return page("mlch", "This sign-in has expired. Start again from the mlch app.");
  const identity = await googleIdentity(env, code);
  if (!identity) return page("mlch", "Google did not confirm the sign-in. Start again from the mlch app.");
  return signedIn(env, identity, pending.challenge);
}

/** POST /api/account/token { code, verifier } → { token }. */
async function exchange(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { code?: unknown; verifier?: unknown };
  if (typeof body.code !== "string" || typeof body.verifier !== "string") return error(400, "Send { code, verifier }.");
  const database = await db(env);
  const hash = await hashed(body.code);
  const grant = await database.prepare(`SELECT user_id, challenge, created_at FROM grants WHERE code_hash = ?`).bind(hash).first<{ user_id: string; challenge: string; created_at: number }>();
  await database.prepare(`DELETE FROM grants WHERE code_hash = ? OR created_at < ?`).bind(hash, Date.now() - GRANT_MS).run();
  if (!grant || Date.now() - grant.created_at > GRANT_MS || !sameText(await hashed(body.verifier), grant.challenge)) return error(400, "This sign-in has expired. Sign in again.");
  const token = random();
  await database.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, used_at) VALUES (?, ?, ?, ?)`).bind(await hashed(token), grant.user_id, Date.now(), Date.now()).run();
  return json(200, { token });
}

/* ── Stripe ────────────────────────────────────────────────────── */

/** The Stripe API version of every call (webhook payloads follow the endpoint's own version). */
const STRIPE_VERSION = "2026-01-28.clover";

export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** A Stripe call: GET without a form, POST with one, or the method given. */
export async function stripe<T>(env: Env, path: string, form?: Record<string, string>, options: { method?: string; idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Stripe-Version": STRIPE_VERSION };
  if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  const response = await outbound(`https://api.stripe.com/v1/${path}`, { method: options.method ?? (form ? "POST" : "GET"), headers, body: form ? new URLSearchParams(form) : undefined });
  const body = (await response.json()) as T & { error?: { message?: string; code?: string } };
  if (!response.ok) throw new StripeError(response.status, body.error?.code, `Stripe ${path}: ${body.error?.message ?? response.status}`);
  return body;
}

let yearly: { id: string; product: string } | undefined;
/** The sharing subscription's price (by its lookup key) and its product. */
export async function yearlyPrice(env: Env): Promise<{ id: string; product: string }> {
  if (yearly) return yearly;
  const prices = await stripe<{ data: Array<{ id: string; product: string | { id: string } }> }>(env, `prices?active=true&lookup_keys[]=${encodeURIComponent(env.STRIPE_PRICE ?? "mlch_sharing_yearly")}`);
  const price = prices.data[0];
  if (!price) throw new Error("No price with that lookup key.");
  return (yearly = { id: price.id, product: typeof price.product === "string" ? price.product : (price.product?.id ?? "") });
}

async function customerOf(env: Env, account: Account): Promise<string> {
  if (account.stripe_customer) return account.stripe_customer;
  const customer = await stripe<{ id: string }>(env, "customers", { email: account.email, ...(account.name ? { name: account.name } : {}), "metadata[user_id]": account.id });
  await (await db(env)).prepare(`UPDATE users SET stripe_customer = ? WHERE id = ?`).bind(customer.id, account.id).run();
  return customer.id;
}

async function checkout(env: Env, account: Account): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) return error(503, "Subscriptions are not set up on this server.");
  if (canShare(account)) return portal(env, account);
  const session = await stripe<{ url: string }>(env, "checkout/sessions", {
    mode: "subscription",
    customer: await customerOf(env, account),
    client_reference_id: account.id,
    "line_items[0][price]": (await yearlyPrice(env)).id,
    "line_items[0][quantity]": "1",
    "automatic_tax[enabled]": "true",
    "customer_update[address]": "auto",
    "customer_update[name]": "auto",
    "tax_id_collection[enabled]": "true",
    "subscription_data[metadata][user_id]": account.id,
    // Friend codes (admin.ts); a card only when there is something to pay.
    allow_promotion_codes: "true",
    payment_method_collection: "if_required",
    success_url: `${env.APEX_ORIGIN}/account/subscribed`,
    cancel_url: `${env.APEX_ORIGIN}/account/back`,
  });
  return json(200, { url: session.url });
}

async function portal(env: Env, account: Account): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) return error(503, "Subscriptions are not set up on this server.");
  const session = await stripe<{ url: string }>(env, "billing_portal/sessions", { customer: await customerOf(env, account), return_url: `${env.APEX_ORIGIN}/account/back` });
  return json(200, { url: session.url });
}

/** Stripe's signature header: t=<seconds>,v1=<hex hmac of "t.payload">. Five minutes of tolerance. */
export async function verifyStripe(payload: string, header: string, secret: string, now = Date.now()): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((part) => part.split("=") as [string, string]).filter((pair) => pair.length === 2 && pair[0] !== "v1"));
  const signatures = header.split(",").filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > 300 || !signatures.length) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return signatures.some((signature) => sameText(signature, expected));
}

interface Subscription {
  id: string;
  customer: string;
  status: string;
  current_period_end?: number;
  items?: { data?: Array<{ current_period_end?: number }> };
  metadata?: { user_id?: string };
  /** Before API 2025-03-31: the one discount. */
  discount?: Discount | null;
  /** Discount ids, or the discounts when expanded. */
  discounts?: Array<string | Discount>;
}

type Ref = string | { id: string } | null | undefined;
interface Discount {
  coupon?: Ref;
  source?: { coupon?: Ref };
  promotion_code?: Ref;
}
const idOf = (ref: Ref) => (typeof ref === "string" ? ref : ref?.id);

/** A subscription whose discount is not one of our friend codes: never allowed to share. */
export const REFUSED_DISCOUNT = "refused_discount";

/** The subscription's discounts as objects, from Stripe when the event carries only their ids. */
async function discountsOf(env: Env, sub: Subscription): Promise<Discount[]> {
  const listed = [...(sub.discounts ?? []), ...(sub.discount ? [sub.discount] : [])];
  if (!listed.length) return [];
  if (listed.every((d) => typeof d === "object")) return listed as Discount[];
  const full = await stripe<Subscription>(env, `subscriptions/${encodeURIComponent(sub.id)}?expand[]=discounts`);
  return [...(full.discounts ?? []), ...(full.discount ? [full.discount] : [])].filter((d): d is Discount => typeof d === "object");
}

/** Our friend code behind each discount; undefined when any discount is not ours. */
async function ourCodes(env: Env, discounts: Discount[]): Promise<Array<{ id: string; code: string }> | undefined> {
  const database = await db(env);
  const codes: Array<{ id: string; code: string }> = [];
  for (const discount of discounts) {
    const coupon = idOf(discount.coupon) ?? idOf(discount.source?.coupon);
    const found = coupon ? await database.prepare(`SELECT id, code FROM coupons WHERE coupon_id = ?`).bind(coupon).first<{ id: string; code: string }>() : null;
    if (!found) {
      console.warn("subscription discount is not one of our friend codes", { coupon: coupon ?? null, promotionCode: idOf(discount.promotion_code) ?? null });
      return undefined;
    }
    codes.push(found);
  }
  return codes;
}

async function webhook(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) return error(503, "Not set up.");
  const payload = await request.text();
  if (!(await verifyStripe(payload, request.headers.get("Stripe-Signature") ?? "", env.STRIPE_WEBHOOK_SECRET))) return error(400, "Bad signature.");
  const event = JSON.parse(payload) as { type: string; data: { object: Subscription } };
  if (!event.type.startsWith("customer.subscription.")) return json(200, { ignored: true });
  const sub = event.data.object;
  const end = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
  const deleted = event.type === "customer.subscription.deleted";
  // A discount must be one of our friend codes (a coupon made elsewhere in the Stripe account must not unlock sharing).
  const codes = deleted ? [] : await ourCodes(env, await discountsOf(env, sub));
  const status = deleted ? "canceled" : codes ? sub.status : REFUSED_DISCOUNT;
  if (status === REFUSED_DISCOUNT) console.warn("subscription not granted sharing: discount not ours", sub.id);
  const database = await db(env);
  // By the customer Stripe has for the person, else the user id given at checkout.
  const result = await database
    .prepare(`UPDATE users SET subscription_id = ?, status = ?, period_end = ?, stripe_customer = COALESCE(stripe_customer, ?) WHERE stripe_customer = ? OR (stripe_customer IS NULL AND id = ?)`)
    .bind(sub.id, status, end ? end * 1000 : null, sub.customer, sub.customer, sub.metadata?.user_id ?? "")
    .run();
  if (!result.meta.changes) console.warn("subscription for no known account", sub.id);
  else if (codes?.[0]) {
    const user = await database.prepare(`SELECT id FROM users WHERE stripe_customer = ?`).bind(sub.customer).first<{ id: string }>();
    if (user)
      await database
        .prepare(`INSERT INTO account_codes (user_id, promotion_code_id, code, subscription_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET promotion_code_id = excluded.promotion_code_id, code = excluded.code, subscription_id = excluded.subscription_id`)
        .bind(user.id, codes[0].id, codes[0].code, sub.id, Date.now())
        .run();
  }
  return json(200, { received: true });
}

/* ── routes ────────────────────────────────────────────────────── */

function bearer(request: Request): string | undefined {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
}

export function accountView(account: Account) {
  return { email: account.email, name: account.name, subscription: account.status ? { status: account.status, periodEnd: account.period_end } : null, canShare: canShare(account) };
}

/** /auth/… and /account/… pages, /api/account/… and /api/stripe/webhook. Undefined when not ours. */
export async function accountRoutes(request: Request, env: Env, url: URL, parts: string[]): Promise<Response | undefined> {
  const path = parts.join("/");
  const ours = parts[0] === "auth" || parts[0] === "account" || (parts[0] === "api" && (parts[1] === "account" || path === "api/stripe/webhook"));
  if (!ours) return undefined;
  if (!accountsOn(env)) return error(404, "This server has no accounts.");
  const method = request.method;

  if (path === "auth/google" && method === "GET") return startSignIn(env, url);
  if (path === "auth/google/callback" && method === "GET") return finishSignIn(env, url);
  // Local tests only: sign in as any address without Google.
  if (path === "auth/dev" && method === "GET" && env.DEV_SIGN_IN === "1") {
    const email = url.searchParams.get("email") ?? "";
    const challenge = url.searchParams.get("challenge") ?? "";
    if (!email || !CHALLENGE.test(challenge)) return error(400, "Give email and challenge.");
    return signedIn(env, { sub: `dev:${email}`, email }, challenge);
  }
  if (path === "account/subscribed") return page("Subscribed", "Subscribed. Sharing is on.", { href: "mlch://account", label: "Back to mlch" });
  if (path === "account/back") return page("mlch", "You can close this page.", { href: "mlch://account", label: "Back to mlch" });
  if (path === "api/stripe/webhook" && method === "POST") return webhook(request, env);
  if (path === "api/account/token" && method === "POST") return exchange(request, env);

  const token = bearer(request);
  const account = await sessionAccount(env, token);
  if (!account) return error(401, "Signed out. Sign in again: Settings, Sharing.");
  if (path === "api/account" && method === "GET") return json(200, accountView(account));
  if (path === "api/account/checkout" && method === "POST") return checkout(env, account);
  if (path === "api/account/portal" && method === "POST") return portal(env, account);
  if (path === "api/account/signout" && method === "POST") {
    await (await db(env)).prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await hashed(token!)).run();
    return json(200, { signedOut: true });
  }
  return error(404, "Unknown account path.");
}
