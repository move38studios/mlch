import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { setOutbound, verifyStripe } from "../src/accounts";
import type { Env } from "../src/env";
import { APEX } from "./helpers";

// mlch.app's mode (accounts on) and a self-hosted server's (a key), on the same bindings.
const hosted = { ...(env as unknown as Env), ACCOUNTS: "on", DEV_SIGN_IN: "1", GOOGLE_CLIENT_SECRET: "secret", STRIPE_SECRET_KEY: "sk_test", STRIPE_WEBHOOK_SECRET: "whsec_test" } as Env;
const own = { ...(env as unknown as Env), SERVER_KEY: "the-key" } as Env;

const req = (target: Env, path: string, init: RequestInit = {}) => handle(new Request(`${APEX}${path}`, { redirect: "manual", ...init }), target);
const createShare = (target: Env, auth?: string) =>
  req(target, "/api/shares", { method: "POST", headers: { "Content-Type": "application/json", "X-Mlch-Install": "t", ...(auth ? { "X-Mlch-Auth": auth } : {}) }, body: JSON.stringify({ kind: "mulch", title: "T" }) });

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

/** Signs in through /auth/dev and returns a session token. */
async function signIn(email: string): Promise<string> {
  const { verifier, challenge } = await pkce();
  const pageResponse = await req(hosted, `/auth/dev?email=${encodeURIComponent(email)}&challenge=${challenge}`);
  const code = /mlch:\/\/signed-in\?code=([\w-]+)/.exec(await pageResponse.text())![1];
  const token = await req(hosted, "/api/account/token", { method: "POST", body: JSON.stringify({ code, verifier }) });
  expect(token.status).toBe(200);
  return ((await token.json()) as { token: string }).token;
}

async function stripeEvent(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("whsec_test"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return req(hosted, "/api/stripe/webhook", { method: "POST", headers: { "Stripe-Signature": `t=${t},v1=${mac}` }, body: payload });
}

afterEach(() => setOutbound((...args) => fetch(...args)));

describe("a self-hosted server", () => {
  it("makes new shares only with its key, and says so", async () => {
    expect((await createShare(own)).status).toBe(401);
    expect((await createShare(own, "wrong")).status).toBe(401);
    expect((await createShare(own, "the-key")).status).toBe(201);
    // How the app checks a key: an empty request is refused for its content only with the right key.
    const probe = (key: string) => req(own, "/api/shares", { method: "POST", headers: { "X-Mlch-Auth": key }, body: "{}" });
    expect((await probe("wrong")).status).toBe(401);
    expect((await probe("the-key")).status).toBe(400);
    expect(await (await req(own, "/api/server")).json()).toEqual({ mlch: 1, auth: "key" });
  });

  it("has no account pages", async () => {
    expect((await req(own, "/auth/google?challenge=x")).status).toBe(404);
  });

  it("serves everything from its own address when the origins are unset", async () => {
    const bare = { ...own, APEX_ORIGIN: "", SHARE_ORIGIN: "" } as Env;
    const response = await handle(new Request("https://mlch-server.someone.workers.dev/api/shares", { method: "POST", headers: { "X-Mlch-Auth": "the-key" }, body: JSON.stringify({ kind: "mulch", title: "T" }) }), bare);
    expect(((await response.json()) as { url: string }).url).toMatch(/^https:\/\/mlch-server\.someone\.workers\.dev\/s\//);
  });
});

describe("mlch.app accounts", () => {
  it("asks to sign in, then to subscribe, before a new share", async () => {
    expect(await (await req(hosted, "/api/server")).json()).toEqual({ mlch: 1, auth: "account" });
    expect((await createShare(hosted)).status).toBe(401);
    const token = await signIn("ana@example.com");
    const refused = await createShare(hosted, token);
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as { error: string }).error).toMatch(/subscription/);
    const account = await (await req(hosted, "/api/account", { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(account).toMatchObject({ email: "ana@example.com", canShare: false, subscription: null });
  });

  it("a grant works once, and only with the app's verifier", async () => {
    const { challenge } = await pkce();
    const html = await (await req(hosted, `/auth/dev?email=b@example.com&challenge=${challenge}`)).text();
    const code = /code=([\w-]+)/.exec(html)![1];
    expect((await req(hosted, "/api/account/token", { method: "POST", body: JSON.stringify({ code, verifier: "not-it" }) })).status).toBe(400);
    expect((await req(hosted, "/api/account/token", { method: "POST", body: JSON.stringify({ code, verifier: "not-it" }) })).status).toBe(400);
  });

  it("subscribing (Stripe webhook) allows new shares; lapsing stops new ones only", async () => {
    const token = await signIn("cy@example.com");
    // Checkout makes the Stripe customer first.
    const calls: string[] = [];
    setOutbound(async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url.replace("https://api.stripe.com/v1/", "")}`);
      if (url.includes("/customers")) return Response.json({ id: "cus_cy" });
      if (url.includes("/prices")) return Response.json({ data: [{ id: "price_1" }] });
      if (url.includes("/checkout/sessions")) {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("automatic_tax[enabled]")).toBe("true");
        expect(form.get("line_items[0][price]")).toBe("price_1");
        expect(form.get("mode")).toBe("subscription");
        return Response.json({ url: "https://checkout.stripe.com/c/pay/x" });
      }
      return new Response("{}", { status: 404 });
    });
    const checkout = await req(hosted, "/api/account/checkout", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    expect(await checkout.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/x" });
    expect(calls[0]).toBe("POST customers");

    expect((await stripeEvent("customer.subscription.created", { id: "sub_1", customer: "cus_cy", status: "active", items: { data: [{ current_period_end: 2_000_000_000 }] } })).status).toBe(200);
    const made = await createShare(hosted, token);
    expect(made.status).toBe(201);
    const account = await (await req(hosted, "/api/account", { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(account).toMatchObject({ canShare: true, subscription: { status: "active", periodEnd: 2_000_000_000_000 } });

    await stripeEvent("customer.subscription.deleted", { id: "sub_1", customer: "cus_cy", status: "canceled" });
    expect((await createShare(hosted, token)).status).toBe(402);
    // The share made while subscribed still takes changes.
    const { id, ownerToken } = (await made.json()) as { id: string; ownerToken: string };
    expect((await req(hosted, `/api/shares/${id}/snapshot`, { method: "PUT", headers: { Authorization: `Bearer ${ownerToken}` }, body: JSON.stringify({ version: 1, id: "m", title: "T", createdAt: 1, updatedAt: 1, nodes: {}, edges: {}, groups: {} }) })).status).toBe(200);
  });

  it("refuses webhooks without Stripe's signature", async () => {
    expect((await req(hosted, "/api/stripe/webhook", { method: "POST", headers: { "Stripe-Signature": "t=1,v1=00" }, body: "{}" })).status).toBe(400);
    expect(await verifyStripe("x", `t=${Math.floor(Date.now() / 1000) - 600},v1=00`, "whsec_test")).toBe(false);
  });

  it("signing out ends the session", async () => {
    const token = await signIn("dee@example.com");
    expect((await req(hosted, "/api/account/signout", { method: "POST", headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await req(hosted, "/api/account", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("starts Google sign-in with the app's challenge", async () => {
    const { challenge } = await pkce();
    const response = await req(hosted, `/auth/google?challenge=${challenge}`);
    expect(response.status).toBe(302);
    const google = new URL(response.headers.get("Location")!);
    expect(google.host).toBe("accounts.google.com");
    expect(google.searchParams.get("redirect_uri")).toBe(`${APEX}/auth/google/callback`);
    expect(google.searchParams.get("scope")).toBe("openid email profile");
  });

  it("a Google callback with a fresh state signs the person in", async () => {
    const { challenge } = await pkce();
    const start = await req(hosted, `/auth/google?challenge=${challenge}`);
    const state = new URL(start.headers.get("Location")!).searchParams.get("state");
    const claims = btoa(JSON.stringify({ sub: "g-1", email: "eve@example.com", email_verified: true, aud: "test-client", iss: "https://accounts.google.com" }));
    setOutbound(async () => Response.json({ id_token: `x.${claims}.y` }));
    const html = await (await req(hosted, `/auth/google/callback?state=${state}&code=abc`)).text();
    expect(html).toContain("eve@example.com");
    expect(html).toMatch(/mlch:\/\/signed-in\?code=/);
    // The state is used up.
    expect(await (await req(hosted, `/auth/google/callback?state=${state}&code=abc`)).text()).toMatch(/expired/);
  });
});

describe("the own-server guide", () => {
  it("is served at /server", async () => {
    const response = await req(hosted, "/server");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("npm run deploy:own");
  });
});
