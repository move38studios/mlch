"use client";

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { create } from "zustand";
import { desktop } from "@/lib/desktop/client";
import type { SharingView } from "@/app/api/account/route";

/**
 * Where shared links live (Settings, Sharing and the setup step): mlch.app
 * (sign in with Google, then subscribe), no sharing, or the person's own
 * server. Sign-in and checkout happen in the browser; the app hears back
 * through mlch:// links (main sends "account") and when it gets focus again.
 */

export const SERVER_GUIDE_URL = "https://mlch.app/server";

const PRIMARY = "h-9 px-3.5 rounded-lg bg-ink text-white text-[13.5px] font-medium disabled:bg-paper-2 disabled:text-ink-3 inline-flex items-center gap-1.5";
const SECONDARY = "h-8 px-2.5 rounded-lg text-[13px] text-ink-2 hover:bg-paper-2 hover:text-ink inline-flex items-center shrink-0";
const FIELD = "h-9 flex-1 min-w-0 rounded-lg border border-line bg-chrome px-3 text-[13.5px] outline-none focus:border-ink";

export const useSharing = create<{ view?: SharingView; loading: boolean; load(): Promise<SharingView | undefined> }>((set) => ({
  loading: false,
  async load() {
    set({ loading: true });
    try {
      const response = await fetch("/api/account");
      const view = response.ok ? ((await response.json()) as SharingView) : undefined;
      set({ view, loading: false });
      return view;
    } catch {
      set({ loading: false });
      return undefined;
    }
  },
}));

/** Whether Share buttons show: not when sharing is off. Reads the setting once per page. */
export function useSharingOn(): boolean {
  const mode = useSharing((s) => s.view?.mode);
  useEffect(() => {
    if (!useSharing.getState().view && !useSharing.getState().loading) void useSharing.getState().load();
  }, []);
  return mode !== "off";
}

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; body: Record<string, unknown> & { error?: string; url?: string } }> {
  const response = await fetch("/api/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: response.ok, body: (await response.json().catch(() => ({}))) as Record<string, unknown> & { error?: string; url?: string } };
}

function date(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";
}

function Option({ selected, onSelect, title, meta, children }: { selected: boolean; onSelect: () => void; title: string; meta?: string; children?: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`w-full text-left rounded-2xl bg-chrome px-5 py-4 flex items-start gap-4 transition-[border-color,box-shadow] ${
        selected ? "border-[1.5px] border-ink shadow-[var(--float-shadow)]" : "border border-line hover:border-line-2"
      }`}
    >
      <span className={`mt-0.5 h-5 w-5 shrink-0 rounded-full grid place-items-center ${selected ? "bg-ink text-white" : "border border-line-2"}`}>{selected && <Check size={12} strokeWidth={2.75} />}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold">{title}</span>
          {meta && <span className="text-[13px] text-ink-3">{meta}</span>}
        </span>
        {children && <span className="block mt-1 text-[13.5px] leading-relaxed text-ink-2">{children}</span>}
      </span>
    </button>
  );
}

function Done({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13.5px] text-ink">
      <span className="h-[18px] w-[18px] rounded-full bg-ink text-white grid place-items-center">
        <Check size={11} strokeWidth={3} />
      </span>
      {children}
    </span>
  );
}

/** The mlch.app account: sign in, subscribe, manage. */
function Account({ view, reload }: { view: SharingView; reload: () => Promise<unknown> }) {
  const account = view.account;
  const [waiting, setWaiting] = useState<"sign-in" | "billing">();
  const [error, setError] = useState<string>();

  // Back from the browser: mlch://signed-in or mlch://account (main), or the window gets focus again.
  useEffect(() => {
    if (!waiting) return;
    const again = () => void reload();
    const off = desktop()?.onMenu?.((command) => command === "account" && again());
    window.addEventListener("focus", again);
    return () => {
      off?.();
      window.removeEventListener("focus", again);
    };
  }, [waiting, reload]);
  useEffect(() => {
    if (waiting === "sign-in" && account?.signedIn) setWaiting(undefined);
    if (waiting === "billing" && account?.canShare) setWaiting(undefined);
  }, [waiting, account?.signedIn, account?.canShare]);

  async function open(action: "sign-in" | "checkout" | "portal") {
    setError(undefined);
    const result = await post({ action });
    if (!result.ok || !result.body.url) return setError(result.body.error ?? "Something went wrong.");
    window.open(result.body.url, "_blank");
    setWaiting(action === "sign-in" ? "sign-in" : "billing");
  }

  if (!account) return null;
  if (!account.signedIn) {
    return (
      <div className="mt-3 pl-9">
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={() => void open("sign-in")} className={PRIMARY}>
            Sign in with Google
          </button>
          {waiting === "sign-in" && (
            <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-3">
              <Loader2 size={13} className="animate-spin" /> Finish signing in in your browser
            </span>
          )}
        </div>
        {error && <p className="mt-2 text-[12.5px] text-danger">{error}</p>}
      </div>
    );
  }
  const sub = account.subscription;
  const lapsed = sub && !account.canShare;
  return (
    <div className="mt-3 pl-9 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Done>Signed in as {account.email}</Done>
        <span className="flex-1" />
        <button onClick={() => void post({ action: "sign-out" }).then(reload)} className={SECONDARY}>
          Sign out
        </button>
      </div>
      {account.canShare ? (
        <div className="flex items-center gap-2 flex-wrap">
          <Done>Subscribed{sub?.periodEnd ? `, renews ${date(sub.periodEnd)}` : ""}</Done>
          <span className="flex-1" />
          <button onClick={() => void open("portal")} className={SECONDARY}>
            Manage subscription
          </button>
        </div>
      ) : (
        <div>
          {lapsed && <p className="mb-2 text-[13px] text-ink-2">Your subscription has ended. Your links still work; new ones need a subscription.</p>}
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={() => void open("checkout")} className={PRIMARY}>
              Subscribe, $12 a year
            </button>
            {waiting === "billing" ? (
              <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-3">
                <Loader2 size={13} className="animate-spin" /> Finish in your browser
              </span>
            ) : (
              <span className="text-[12.5px] text-ink-3">Plus local tax</span>
            )}
          </div>
        </div>
      )}
      {account.error && <p className="text-[12.5px] text-danger">{account.error}</p>}
      {error && <p className="text-[12.5px] text-danger">{error}</p>}
    </div>
  );
}

/** Your own server: its address and key. */
function OwnServer({ view, reload }: { view: SharingView; reload: () => Promise<unknown> }) {
  const [address, setAddress] = useState(view.server ?? "");
  const [key, setKey] = useState("");
  const [editingKey, setEditingKey] = useState(!view.ownKey);
  const [check, setCheck] = useState<{ state: "checking" } | { state: "ok" } | { state: "failed"; error: string }>();
  const bridge = desktop();

  async function verify() {
    setCheck({ state: "checking" });
    const result = await post({ action: "check-server" });
    setCheck(result.ok ? { state: "ok" } : { state: "failed", error: result.body.error ?? "Could not check the server." });
  }
  async function saveAddress() {
    const result = await post({ action: "mode", mode: "own", server: address });
    if (!result.ok) return setCheck({ state: "failed", error: result.body.error ?? "Could not save the address." });
    await reload();
    if (view.ownKey) await verify();
  }
  async function saveKey() {
    if (!bridge || !key.trim()) return;
    const result = await bridge.credentials.write({ shareKey: key.trim() });
    if (!result.ok) return setCheck({ state: "failed", error: result.error });
    setKey("");
    setEditingKey(false);
    // Main hands the key to the server process; give it a moment before checking.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await reload();
    await verify();
  }

  return (
    <div className="mt-3 pl-9 space-y-2.5">
      <a href={SERVER_GUIDE_URL} target="_blank" rel="noreferrer" className="inline-block text-[13px] text-ink-2 underline underline-offset-2 hover:text-ink">
        How to set up your server
      </a>
      <div className="flex items-center gap-2">
        <input value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void saveAddress()} placeholder="https://mlch-server.you.workers.dev" aria-label="Server address" className={FIELD} />
        <button onClick={() => void saveAddress()} disabled={!address.trim() || address.trim() === view.server} className={PRIMARY}>
          Save
        </button>
      </div>
      {editingKey ? (
        <div className="flex items-center gap-2">
          <input value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void saveKey()} type="password" placeholder="Server key" aria-label="Server key" className={FIELD} disabled={!bridge} />
          <button onClick={() => void saveKey()} disabled={!key.trim() || !bridge} className={PRIMARY}>
            Save
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Done>Key saved</Done>
          <span className="flex-1" />
          {view.server && (
            <button onClick={() => void verify()} className={SECONDARY}>
              Check
            </button>
          )}
          <button onClick={() => setEditingKey(true)} className={SECONDARY}>
            Change key
          </button>
        </div>
      )}
      {check?.state === "checking" && (
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-3">
          <Loader2 className="animate-spin" size={12} /> Checking
        </span>
      )}
      {check?.state === "ok" && <p className="text-[12.5px] text-ink-2">Connected</p>}
      {check?.state === "failed" && <p className="text-[12.5px] text-danger">{check.error}</p>}
    </div>
  );
}

/** The three choices, with what each needs under the chosen one. */
export function SharingChoice() {
  const view = useSharing((s) => s.view);
  const load = useSharing((s) => s.load);
  useEffect(() => void load(), [load]);

  async function choose(mode: "mlch" | "off" | "own") {
    if (view?.mode === mode) return;
    useSharing.setState({ view: view ? { ...view, mode } : view });
    await post({ action: "mode", mode });
    await load();
  }

  if (!view) return <div className="h-40" />;
  return (
    <div className="space-y-3">
      <div>
        <Option selected={view.mode === "mlch"} onSelect={() => void choose("mlch")} title="mlch.app" meta="$12 a year">
          Links on mlch.app. Sign in with Google, then subscribe. Anyone with a link can view it without an account.
        </Option>
        {view.mode === "mlch" && <Account view={view} reload={load} />}
      </div>
      <Option selected={view.mode === "off"} onSelect={() => void choose("off")} title="No sharing">
        No Share buttons; nothing is shared.
      </Option>
      <div>
        <Option selected={view.mode === "own"} onSelect={() => void choose("own")} title="Your own server">
          Run the mlch server on your own Cloudflare account, and enter its address and key here.
        </Option>
        {view.mode === "own" && <OwnServer key={view.server ?? ""} view={view} reload={load} />}
      </div>
    </div>
  );
}
