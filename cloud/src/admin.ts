/**
 * mlch.app/admin: friend codes, accounts, and deleting an account (on an
 * emailed request, GDPR). Only on mlch.app (accounts on).
 *
 * Who: Cloudflare Access protects /admin and /api/admin/* at the edge (its
 * own Access application, m38.ai). The Worker checks the Access token again
 * (`Cf-Access-Jwt-Assertion`, signed by the team's keys) and wants an
 * @m38.ai address. Without ACCESS_TEAM_DOMAIN and ACCESS_AUD nothing is let in.
 *
 * Friend codes (as in onedollarconcept): a Stripe coupon (100% off by
 * default, forever, only the sharing product) and its promotion code, kept in
 * D1 so the webhook can tell our discounts from any other (accounts.ts).
 */

import type { Env } from "./env";
import { StripeError, accountsOn, db, send, stripe, yearlyPrice } from "./accounts";

const ADMIN_DOMAIN = "m38.ai";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const error = (status: number, message: string) => json(status, { error: message });

/* ── Cloudflare Access ─────────────────────────────────────────── */

interface Jwk extends JsonWebKey {
  kid?: string;
}
const certs = new Map<string, { keys: Jwk[]; fetched: number }>();
const CERTS_MS = 5 * 60_000;

function decode(part: string): Uint8Array {
  const text = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}
const decodeJson = (part: string) => JSON.parse(new TextDecoder().decode(decode(part))) as Record<string, unknown>;

/** https://<team>.cloudflareaccess.com from ACCESS_TEAM_DOMAIN (with or without https://). */
export function accessIssuer(env: Env): string | undefined {
  const host = (env.ACCESS_TEAM_DOMAIN ?? "").trim().replace(/^https:\/\//, "").replace(/\/+$/, "");
  return /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(host) ? `https://${host}` : undefined;
}

async function signingKeys(issuer: string, kid: string): Promise<Jwk[]> {
  const cached = certs.get(issuer);
  const now = Date.now();
  if (cached && now - cached.fetched < CERTS_MS && (cached.keys.some((k) => k.kid === kid) || now - cached.fetched < 30_000)) return cached.keys;
  const response = await send(`${issuer}/cdn-cgi/access/certs`, { redirect: "manual" });
  if (!response.ok) throw new Error(`Access certs: ${response.status}`);
  const body = (await response.json()) as { keys?: Jwk[] };
  if (!Array.isArray(body.keys)) throw new Error("Access certs: no keys");
  certs.set(issuer, { keys: body.keys, fetched: now });
  return body.keys;
}

const REFUSED = "Admin is only for m38.ai accounts signed in through Cloudflare Access at mlch.app/admin.";

/** The admin's email, or a 403 (503 when Access's keys can't be fetched). Fails closed. */
export async function requireAdmin(request: Request, env: Env): Promise<{ ok: true; email: string } | { ok: false; response: Response }> {
  const refuse = (status = 403, message = REFUSED) => ({ ok: false as const, response: error(status, message) });
  const issuer = accessIssuer(env);
  const audience = env.ACCESS_AUD?.trim();
  if (!issuer || !audience) return refuse(403, "Admin is not set up on this server (ACCESS_TEAM_DOMAIN, ACCESS_AUD).");
  const token = request.headers.get("Cf-Access-Jwt-Assertion") ?? "";
  const parts = token.split(".");
  if (token.length > 16_000 || parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return refuse();
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    return refuse();
  }
  const now = Date.now() / 1000;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  const [local, domain, ...more] = email.split("@");
  if (
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    claims.iss !== issuer ||
    !aud.includes(audience) ||
    typeof claims.exp !== "number" ||
    claims.exp <= now ||
    (typeof claims.nbf === "number" && claims.nbf > now + 30) ||
    !local ||
    domain !== ADMIN_DOMAIN ||
    more.length
  )
    return refuse();
  let keys: Jwk[];
  try {
    keys = await signingKeys(issuer, header.kid);
  } catch (cause) {
    console.error("admin: could not fetch Access keys", String(cause));
    return refuse(503, "Could not check the Access sign-in. Try again.");
  }
  const jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) return refuse();
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return refuse();
  } catch {
    return refuse();
  }
  return { ok: true, email };
}

/* ── friend codes ──────────────────────────────────────────────── */

interface CouponRow {
  id: string;
  code: string;
  coupon_id: string;
  percent_off: number;
  max_redemptions: number;
  expires_at: number | null;
  created_at: number;
  created_by: string;
  active: number;
  deactivated_at: number | null;
}

const CODE = /^[A-Z0-9][A-Z0-9-]{2,29}$/;

async function createCode(request: Request, env: Env, admin: string): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) return error(503, "Stripe is not set up on this server (STRIPE_SECRET_KEY).");
  const body = (await request.json().catch(() => ({}))) as { code?: unknown; uses?: unknown; expires?: unknown; percent?: unknown };
  const code = String(body.code ?? "").trim().toUpperCase();
  const uses = Number(body.uses);
  const percent = body.percent === undefined || body.percent === "" ? 100 : Number(body.percent);
  if (!CODE.test(code)) return error(400, "A code is 3 to 30 letters, digits or dashes, starting with a letter or digit.");
  if (!Number.isInteger(uses) || uses < 1 || uses > 10_000) return error(400, "Uses: a whole number from 1 to 10000.");
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) return error(400, "Percent off: a whole number from 1 to 100.");
  let expires: number | null = null;
  if (body.expires !== undefined && body.expires !== null && body.expires !== "") {
    const date = String(body.expires);
    expires = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Math.floor(Date.parse(`${date}T23:59:59Z`) / 1000) : NaN;
    if (!Number.isFinite(expires) || expires < Date.now() / 1000 + 3600 || expires > Date.now() / 1000 + 5 * 366 * 86_400) return error(400, "Expires: a date (YYYY-MM-DD) from tomorrow to five years ahead, or none.");
  }
  const database = await db(env);
  if (await database.prepare(`SELECT id FROM coupons WHERE code = ?`).bind(code).first()) return error(409, "That code exists. Choose another.");
  const { product } = await yearlyPrice(env);
  if (!product) return error(503, "The sharing price has no product in Stripe.");
  const coupon = await stripe<{ id: string }>(
    env,
    "coupons",
    { duration: "forever", percent_off: String(percent), "applies_to[products][0]": product, name: `mlch friend code ${code}`, "metadata[service]": "mlch", "metadata[code]": code },
    { idempotencyKey: `mlch-coupon-${code}-${percent}` },
  );
  const promo = await stripe<{ id: string }>(
    env,
    "promotion_codes",
    { "promotion[type]": "coupon", "promotion[coupon]": coupon.id, code, max_redemptions: String(uses), ...(expires ? { expires_at: String(expires) } : {}), "metadata[service]": "mlch" },
    { idempotencyKey: `mlch-promo-${code}-${coupon.id}` },
  );
  await database
    .prepare(`INSERT INTO coupons (id, code, coupon_id, percent_off, max_redemptions, expires_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(promo.id, code, coupon.id, percent, uses, expires ? expires * 1000 : null, Date.now(), admin)
    .run();
  console.log("admin: friend code created", { code, percent, uses, by: admin });
  return json(201, { id: promo.id, code, percent, uses, expiresAt: expires ? expires * 1000 : null });
}

async function listCodes(env: Env): Promise<Response> {
  const rows = (await (await db(env)).prepare(`SELECT * FROM coupons ORDER BY created_at DESC LIMIT 200`).all<CouponRow>()).results;
  // How often each was used: Stripe's count.
  const used = new Map<string, number>();
  if (env.STRIPE_SECRET_KEY && rows.length) {
    try {
      let after: string | undefined;
      for (let page = 0; page < 10; page++) {
        const list = await stripe<{ data: Array<{ id: string; times_redeemed: number }>; has_more: boolean }>(env, `promotion_codes?limit=100${after ? `&starting_after=${after}` : ""}`);
        for (const promo of list.data) used.set(promo.id, promo.times_redeemed);
        if (!list.has_more || !list.data.length) break;
        after = list.data[list.data.length - 1].id;
      }
    } catch (cause) {
      console.warn("admin: could not read promotion codes", String(cause));
    }
  }
  return json(200, {
    codes: rows.map((row) => ({
      id: row.id,
      code: row.code,
      percent: row.percent_off,
      uses: row.max_redemptions,
      used: used.get(row.id) ?? null,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      createdBy: row.created_by,
      active: !!row.active,
      deactivatedAt: row.deactivated_at,
    })),
  });
}

async function turnOff(env: Env, id: string, admin: string): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) return error(503, "Stripe is not set up on this server (STRIPE_SECRET_KEY).");
  const database = await db(env);
  const row = await database.prepare(`SELECT * FROM coupons WHERE id = ?`).bind(id).first<CouponRow>();
  if (!row) return error(404, "No such friend code. List them with GET /api/admin/codes.");
  await stripe(env, `promotion_codes/${encodeURIComponent(id)}`, { active: "false" }, { idempotencyKey: `mlch-promo-off-${id}` });
  await database.prepare(`UPDATE coupons SET active = 0, deactivated_at = COALESCE(deactivated_at, ?) WHERE id = ?`).bind(Date.now(), id).run();
  console.log("admin: friend code turned off", { code: row.code, by: admin });
  return json(200, { id, active: false });
}

/* ── accounts ──────────────────────────────────────────────────── */

interface AccountRow {
  id: string;
  email: string;
  created_at: number;
  status: string | null;
  period_end: number | null;
  stripe_customer: string | null;
  subscription_id: string | null;
  code: string | null;
  shares: number;
}

async function listAccounts(env: Env): Promise<Response> {
  const rows = (
    await (await db(env))
      .prepare(`SELECT u.id, u.email, u.created_at, u.status, u.period_end, c.code, (SELECT COUNT(*) FROM shares s WHERE s.user_id = u.id) AS shares FROM users u LEFT JOIN account_codes c ON c.user_id = u.id ORDER BY u.created_at DESC LIMIT 1000`)
      .all<AccountRow>()
  ).results;
  return json(200, { accounts: rows.map((row) => ({ id: row.id, email: row.email, status: row.status, periodEnd: row.period_end, code: row.code, shares: row.shares, createdAt: row.created_at })) });
}

/** A Stripe DELETE that counts "already gone" as done. */
async function stripeDelete(env: Env, path: string): Promise<void> {
  try {
    await stripe(env, path, undefined, { method: "DELETE" });
  } catch (cause) {
    if (cause instanceof StripeError && cause.status === 404) return;
    throw cause;
  }
}

/**
 * Deletes everything of an account: its Stripe subscription and customer,
 * every share it made (R2 files and the share's Durable Object), sessions,
 * grants, its code and the account row. Logs only that it happened and by whom.
 */
async function deleteAccount(request: Request, env: Env, id: string, admin: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { email?: unknown };
  const database = await db(env);
  const account = await database.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<AccountRow>();
  if (!account) return error(404, "No such account. List them with GET /api/admin/accounts.");
  if (typeof body.email !== "string" || body.email.trim().toLowerCase() !== account.email.toLowerCase()) return error(400, "Send { email } with the account's email to confirm.");
  if ((account.stripe_customer || account.subscription_id) && !env.STRIPE_SECRET_KEY) return error(503, "This account has a Stripe customer; Stripe is not set up on this server (STRIPE_SECRET_KEY).");
  // Stripe first: if it fails, nothing is deleted yet and the request can be repeated.
  if (account.subscription_id && account.status !== "canceled") await stripeDelete(env, `subscriptions/${encodeURIComponent(account.subscription_id)}`);
  if (account.stripe_customer) await stripeDelete(env, `customers/${encodeURIComponent(account.stripe_customer)}`);
  const shares = (await database.prepare(`SELECT id FROM shares WHERE user_id = ?`).bind(id).all<{ id: string }>()).results;
  for (const share of shares) await env.ROOMS.get(env.ROOMS.idFromName(share.id)).purge(share.id);
  await database.batch([
    database.prepare(`DELETE FROM shares WHERE user_id = ?`).bind(id),
    database.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id),
    database.prepare(`DELETE FROM grants WHERE user_id = ?`).bind(id),
    database.prepare(`DELETE FROM account_codes WHERE user_id = ?`).bind(id),
    database.prepare(`DELETE FROM users WHERE id = ?`).bind(id),
    database.prepare(`INSERT INTO deletions (at, by) VALUES (?, ?)`).bind(Date.now(), admin),
  ]);
  console.log("admin: an account was deleted", { by: admin });
  return json(200, { deleted: true, shares: shares.length });
}

/* ── routes ────────────────────────────────────────────────────── */

/** /admin (the page) and /api/admin/*. Undefined when not ours. */
export async function adminRoutes(request: Request, env: Env, parts: string[], serve: (path: string) => Promise<Response>): Promise<Response | undefined> {
  const page = parts[0] === "admin";
  const api = parts[0] === "api" && parts[1] === "admin";
  if (!page && !api) return undefined;
  if (!accountsOn(env)) return error(404, "This server has no accounts.");
  const allowed = await requireAdmin(request, env);
  if (!allowed.ok) return allowed.response;
  const admin = allowed.email;

  if (page) {
    if (request.method !== "GET" && request.method !== "HEAD") return error(405, "GET the admin page.");
    if (parts.length === 1) return serve("/admin/");
    if (parts.length === 2 && parts[1] === "admin.js") return serve("/admin/admin.js");
    return error(404, "Admin is at /admin.");
  }

  // Changes only from the admin page itself.
  if (request.method !== "GET" && request.headers.get("Origin") !== new URL(env.APEX_ORIGIN).origin) return error(403, "Make changes from mlch.app/admin.");
  const path = parts.slice(2);
  const method = request.method;
  if (path.length === 1 && path[0] === "me" && method === "GET") return json(200, { email: admin });
  if (path.length === 1 && path[0] === "codes") {
    if (method === "GET") return listCodes(env);
    if (method === "POST") return createCode(request, env, admin);
    return error(405, "GET to list codes, POST { code, uses, expires?, percent? } to make one.");
  }
  if (path.length === 3 && path[0] === "codes" && path[2] === "off") return method === "POST" ? turnOff(env, path[1], admin) : error(405, "POST to turn a code off.");
  if (path.length === 1 && path[0] === "accounts") return method === "GET" ? listAccounts(env) : error(405, "GET to list accounts.");
  if (path.length === 3 && path[0] === "accounts" && path[2] === "delete") return method === "POST" ? deleteAccount(request, env, path[1], admin) : error(405, "POST { email } to delete an account.");
  return error(404, "Admin paths: me, codes, codes/:id/off, accounts, accounts/:id/delete.");
}
