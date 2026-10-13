import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { setOutbound } from "../src/accounts";
import type { Env } from "../src/env";
import { APEX } from "./helpers";

const TEAM = "m38test.cloudflareaccess.com";
const AUD = "aud-mlch-admin";
const hosted = {
  ...(env as unknown as Env),
  ACCOUNTS: "on",
  DEV_SIGN_IN: "1",
  STRIPE_SECRET_KEY: "sk_test",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
} as Env;

const req = (target: Env, path: string, init: RequestInit = {}) => handle(new Request(`${APEX}${path}`, { redirect: "manual", ...init }), target);

/* ── Access tokens signed by a test key ───────────────────────── */

let keys: CryptoKeyPair;
let otherKeys: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64json = (value: unknown) => b64(new TextEncoder().encode(JSON.stringify(value)));
const rsa = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(rsa, true, ["sign", "verify"])) as CryptoKeyPair;
  otherKeys = (await crypto.subtle.generateKey(rsa, true, ["sign", "verify"])) as CryptoKeyPair;
  jwk = { ...((await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey), kid: "k1" };
});

async function accessToken(claims: Record<string, unknown> = {}, signer?: CryptoKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = b64json({ alg: "RS256", kid: "k1", typ: "JWT" });
  const body = b64json({ iss: `https://${TEAM}`, aud: [AUD], email: "george@m38.ai", sub: "u1", type: "app", iat: now, exp: now + 600, ...claims });
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer ?? keys.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64(signature)}`;
}

/** Stripe and Access, faked. Every call is recorded with its form and headers. */
interface Call {
  method: string;
  path: string;
  form: URLSearchParams;
  headers: Headers;
}
let calls: Call[] = [];
type Reply = (call: Call) => Response | undefined;
function fake(reply: Reply = () => undefined) {
  calls = [];
  setOutbound(async (input, init) => {
    const url = String(input);
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    const call = { method: init?.method ?? "GET", path: url.replace("https://api.stripe.com/v1/", ""), form: new URLSearchParams(init?.body ? String(init.body) : ""), headers: new Headers(init?.headers) };
    calls.push(call);
    const answer = reply(call);
    if (answer) return answer;
    if (call.path.startsWith("prices")) return Response.json({ data: [{ id: "price_1", product: "prod_mlch" }] });
    return Response.json({ error: { message: "not faked" } }, { status: 404 });
  });
}
afterEach(() => setOutbound((...args) => fetch(...args)));

async function admin(path: string, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers);
  headers.set("Cf-Access-Jwt-Assertion", token ?? (await accessToken()));
  if (init.method && init.method !== "GET") headers.set("Origin", APEX);
  return req(hosted, `/api/admin/${path}`, { ...init, headers });
}

/* ── accounts, as in accounts.test.ts ─────────────────────────── */

async function signIn(email: string): Promise<string> {
  const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const html = await (await req(hosted, `/auth/dev?email=${encodeURIComponent(email)}&challenge=${challenge}`)).text();
  const code = /mlch:\/\/signed-in\?code=([\w-]+)/.exec(html)![1];
  return ((await (await req(hosted, "/api/account/token", { method: "POST", body: JSON.stringify({ code, verifier }) })).json()) as { token: string }).token;
}

async function stripeEvent(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("whsec_test"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return req(hosted, "/api/stripe/webhook", { method: "POST", headers: { "Stripe-Signature": `t=${t},v1=${mac}` }, body: payload });
}

const accountOf = async (token: string) => (await (await req(hosted, "/api/account", { headers: { Authorization: `Bearer ${token}` } })).json()) as { canShare: boolean; subscription: { status: string } | null };
const createShare = (token: string) =>
  req(hosted, "/api/shares", { method: "POST", headers: { "Content-Type": "application/json", "X-Mlch-Install": `t-${token.slice(0, 6)}`, "X-Mlch-Auth": token }, body: JSON.stringify({ kind: "mulch", title: "T" }) });

/** Inserts a friend code as admin would have made it. */
async function makeCode(code: string, coupon: string) {
  fake((call) => {
    if (call.path === "coupons") return Response.json({ id: coupon });
    if (call.path === "promotion_codes") return Response.json({ id: `promo_${code}` });
  });
  const response = await admin("codes", { method: "POST", body: JSON.stringify({ code, uses: 5 }) });
  expect(response.status).toBe(201);
}

/* ── tests ─────────────────────────────────────────────────────── */

describe("admin access", () => {
  it("refuses without a valid Access token for an m38.ai address", async () => {
    fake();
    const status = async (token?: string, target = hosted) => (await req(target, "/api/admin/me", token === undefined ? {} : { headers: { "Cf-Access-Jwt-Assertion": token } })).status;
    expect(await status()).toBe(403);
    expect(await status("not.a.jwt")).toBe(403);
    expect(await status(await accessToken({ email: "someone@gmail.com" }))).toBe(403);
    expect(await status(await accessToken({ email: "george@m38.ai.evil.com" }))).toBe(403);
    expect(await status(await accessToken({ aud: ["another-app"] }))).toBe(403);
    expect(await status(await accessToken({ iss: "https://other.cloudflareaccess.com" }))).toBe(403);
    expect(await status(await accessToken({ exp: Math.floor(Date.now() / 1000) - 10 }))).toBe(403);
    expect(await status(await accessToken({}, otherKeys.privateKey))).toBe(403);
    // Fails closed when Access is not configured.
    expect(await status(await accessToken(), { ...hosted, ACCESS_AUD: undefined })).toBe(403);
    expect(await status(await accessToken(), { ...hosted, ACCESS_TEAM_DOMAIN: "" })).toBe(403);
    // The page too.
    expect((await req(hosted, "/admin")).status).toBe(403);

    const ok = await admin("me");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ email: "george@m38.ai" });
    const page = await req(hosted, "/admin", { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } });
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain("Friend codes");
  });

  it("takes changes only from its own page", async () => {
    fake();
    const response = await req(hosted, "/api/admin/codes", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": await accessToken(), Origin: "https://evil.example" }, body: "{}" });
    expect(response.status).toBe(403);
  });

  it("is not on a server without accounts", async () => {
    expect((await req({ ...hosted, ACCOUNTS: "" } as Env, "/api/admin/me", { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } })).status).toBe(404);
  });
});

describe("friend codes", () => {
  it("creates a 100%, forever coupon for the sharing product and a promotion code", async () => {
    fake((call) => {
      if (call.path === "coupons") return Response.json({ id: "co_1" });
      if (call.path === "promotion_codes") return Response.json({ id: "promo_1" });
    });
    const response = await admin("codes", { method: "POST", body: JSON.stringify({ code: "friend-ana", uses: 3, expires: "2099-01-31" }) });
    expect(response.status).toBe(400); // five years at most
    const made = await admin("codes", { method: "POST", body: JSON.stringify({ code: "friend-ana", uses: 3 }) });
    expect(made.status).toBe(201);
    expect(await made.json()).toMatchObject({ id: "promo_1", code: "FRIEND-ANA", percent: 100, uses: 3 });
    const coupon = calls.find((c) => c.path === "coupons")!;
    expect(coupon.method).toBe("POST");
    expect(coupon.form.get("duration")).toBe("forever");
    expect(coupon.form.get("percent_off")).toBe("100");
    expect(coupon.form.get("applies_to[products][0]")).toBe("prod_mlch");
    expect(coupon.headers.get("Idempotency-Key")).toBeTruthy();
    const promo = calls.find((c) => c.path === "promotion_codes")!;
    expect(promo.form.get("promotion[coupon]")).toBe("co_1");
    expect(promo.form.get("code")).toBe("FRIEND-ANA");
    expect(promo.form.get("max_redemptions")).toBe("3");
    expect(promo.headers.get("Idempotency-Key")).toBeTruthy();

    // The same code again, or bad input: refused, saying what is allowed.
    expect((await admin("codes", { method: "POST", body: JSON.stringify({ code: "FRIEND-ANA", uses: 3 }) })).status).toBe(409);
    const bad = await admin("codes", { method: "POST", body: JSON.stringify({ code: "x", uses: 0 }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/3 to 30/);
    expect((await admin("codes", { method: "POST", body: JSON.stringify({ code: "HALF", uses: 1, percent: 101 }) })).status).toBe(400);
  });

  it("lists codes with their uses from Stripe, and turns one off", async () => {
    await makeCode("LISTED", "co_listed");
    fake((call) => {
      if (call.path.startsWith("promotion_codes?")) return Response.json({ data: [{ id: "promo_LISTED", times_redeemed: 2 }], has_more: false });
      if (call.path === "promotion_codes/promo_LISTED") return Response.json({ id: "promo_LISTED", active: false });
    });
    const listed = (await (await admin("codes")).json()) as { codes: Array<{ code: string; used: number; uses: number; active: boolean }> };
    expect(listed.codes.find((c) => c.code === "LISTED")).toMatchObject({ used: 2, uses: 5, active: true });

    expect((await admin("codes/promo_LISTED/off", { method: "POST" })).status).toBe(200);
    const off = calls.find((c) => c.path === "promotion_codes/promo_LISTED")!;
    expect(off.method).toBe("POST");
    expect(off.form.get("active")).toBe("false");
    const after = (await (await admin("codes")).json()) as { codes: Array<{ code: string; active: boolean }> };
    expect(after.codes.find((c) => c.code === "LISTED")?.active).toBe(false);
    expect((await admin("codes/promo_nope/off", { method: "POST" })).status).toBe(404);
  });
});

describe("checkout and discounts", () => {
  it("accepts codes and asks for a card only when there is something to pay", async () => {
    const token = await signIn("fay@example.com");
    fake((call) => {
      if (call.path === "customers") return Response.json({ id: "cus_fay" });
      if (call.path === "checkout/sessions") return Response.json({ url: "https://checkout.stripe.com/c/pay/f" });
    });
    expect((await req(hosted, "/api/account/checkout", { method: "POST", headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    const session = calls.find((c) => c.path === "checkout/sessions")!;
    expect(session.form.get("allow_promotion_codes")).toBe("true");
    expect(session.form.get("payment_method_collection")).toBe("if_required");
  });

  it("a subscription discounted by a coupon that is not ours does not share", async () => {
    const token = await signIn("gil@example.com");
    fake((call) => (call.path === "customers" ? Response.json({ id: "cus_gil" }) : call.path === "checkout/sessions" ? Response.json({ url: "u" }) : undefined));
    await req(hosted, "/api/account/checkout", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    expect((await stripeEvent("customer.subscription.created", { id: "sub_gil", customer: "cus_gil", status: "active", discount: { coupon: { id: "co_elsewhere" }, promotion_code: "promo_x" } })).status).toBe(200);
    expect(await accountOf(token)).toMatchObject({ canShare: false, subscription: { status: "refused_discount" } });
    expect((await createShare(token)).status).toBe(402);
  });

  it("our code subscribes and is recorded; discount ids are looked up in Stripe", async () => {
    await makeCode("FRIEND-HAL", "co_hal");
    const token = await signIn("hal@example.com");
    fake((call) => {
      if (call.path === "customers") return Response.json({ id: "cus_hal" });
      if (call.path === "checkout/sessions") return Response.json({ url: "u" });
      if (call.path.startsWith("subscriptions/sub_hal?")) return Response.json({ id: "sub_hal", discounts: [{ id: "di_1", source: { coupon: "co_hal" }, promotion_code: "promo_FRIEND-HAL" }] });
    });
    await req(hosted, "/api/account/checkout", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    expect((await stripeEvent("customer.subscription.created", { id: "sub_hal", customer: "cus_hal", status: "active", discounts: ["di_1"] })).status).toBe(200);
    expect(calls.some((c) => c.path.startsWith("subscriptions/sub_hal?"))).toBe(true);
    expect(await accountOf(token)).toMatchObject({ canShare: true, subscription: { status: "active" } });
    expect((await createShare(token)).status).toBe(201);
    fake();
    const { accounts } = (await (await admin("accounts")).json()) as { accounts: Array<{ email: string; code: string | null; shares: number; status: string }> };
    expect(accounts.find((a) => a.email === "hal@example.com")).toMatchObject({ code: "FRIEND-HAL", shares: 1, status: "active" });
  });
});

describe("deleting an account", () => {
  it("removes Stripe customer, shares (R2 and Durable Object) and every D1 row, logging only who deleted", async () => {
    const token = await signIn("ivy@example.com");
    fake((call) => (call.path === "customers" ? Response.json({ id: "cus_ivy" }) : call.path === "checkout/sessions" ? Response.json({ url: "u" }) : undefined));
    await req(hosted, "/api/account/checkout", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    await stripeEvent("customer.subscription.created", { id: "sub_ivy", customer: "cus_ivy", status: "active" });
    const made = (await (await createShare(token)).json()) as { id: string; ownerToken: string };
    const bytes = new TextEncoder().encode("hello");
    expect((await req(hosted, `/api/shares/${made.id}/files/assets/a.txt`, { method: "PUT", headers: { Authorization: `Bearer ${made.ownerToken}`, "Content-Length": String(bytes.byteLength) }, body: bytes })).status).toBe(200);
    expect((await req(hosted, `/api/shares/${made.id}/snapshot`, { method: "PUT", headers: { Authorization: `Bearer ${made.ownerToken}` }, body: JSON.stringify({ version: 1, id: "m", title: "T", createdAt: 1, updatedAt: 1, nodes: {}, edges: {}, groups: {} }) })).status).toBe(200);
    expect((await env.SHARES.list({ prefix: `shares/${made.id}/` })).objects.length).toBe(2);

    const db = (env as unknown as Env).DB!;
    const user = await db.prepare(`SELECT id FROM users WHERE email = ?`).bind("ivy@example.com").first<{ id: string }>();
    fake((call) => {
      if (call.method === "DELETE" && call.path === "subscriptions/sub_ivy") return Response.json({ id: "sub_ivy", status: "canceled" });
      if (call.method === "DELETE" && call.path === "customers/cus_ivy") return Response.json({ id: "cus_ivy", deleted: true });
    });
    // The email must be typed to confirm.
    expect((await admin(`accounts/${user!.id}/delete`, { method: "POST", body: JSON.stringify({ email: "someone@example.com" }) })).status).toBe(400);
    expect(calls).toHaveLength(0);
    const deleted = await admin(`accounts/${user!.id}/delete`, { method: "POST", body: JSON.stringify({ email: "Ivy@example.com" }) });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true, shares: 1 });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE subscriptions/sub_ivy", "DELETE customers/cus_ivy"]);

    for (const table of ["users WHERE id = ?", "sessions WHERE user_id = ?", "shares WHERE user_id = ?", "grants WHERE user_id = ?", "account_codes WHERE user_id = ?"]) {
      expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).bind(user!.id).first("n")).toBe(0);
    }
    expect((await env.SHARES.list({ prefix: `shares/${made.id}/` })).objects).toHaveLength(0);
    const room = (env as unknown as Env).ROOMS.get((env as unknown as Env).ROOMS.idFromName(made.id));
    expect(await room.info()).toBeNull();
    expect((await req(hosted, `/api/shares/${made.id}/manifest`)).status).toBe(404);
    expect((await req(hosted, "/api/account", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    const log = await db.prepare(`SELECT * FROM deletions ORDER BY id DESC LIMIT 1`).first<Record<string, unknown>>();
    expect(log).toMatchObject({ by: "george@m38.ai" });
    expect(Object.keys(log!).sort()).toEqual(["at", "by", "id"]);
    expect((await admin(`accounts/${user!.id}/delete`, { method: "POST", body: JSON.stringify({ email: "ivy@example.com" }) })).status).toBe(404);
  });
});

describe("legal pages", () => {
  it("serves privacy, terms, refunds and company", async () => {
    for (const name of ["privacy", "terms", "refunds", "company"]) {
      const response = await req(hosted, `/${name}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("legal@m38.ai");
    }
    expect(await (await req(hosted, "/company")).text()).toContain("KVK");
    expect((await req(hosted, "/site.css")).status).toBe(200);
  });
});
