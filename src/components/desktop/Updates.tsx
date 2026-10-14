"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { desktop, type UpdateState } from "@/lib/desktop/client";
import { formatDateTime } from "@/lib/format";

/** The app's update state, kept current (undefined in a browser). */
export function useUpdates(): UpdateState | undefined {
  const [state, setState] = useState<UpdateState>();
  useEffect(() => {
    const updates = desktop()?.updates;
    if (!updates) return;
    void updates.state().then(setState);
    return updates.onChange((next) => setState((current) => ({ ...current, ...next })));
  }, []);
  return state;
}

const CHIP = "no-drag float rounded-xl h-9 pl-3 pr-1 flex items-center gap-2 text-[13px]";
const CHIP_BUTTON = "h-7 px-2.5 rounded-lg bg-ink text-white text-[12.5px] font-medium inline-flex items-center";
const CLOSE = "p-1.5 rounded-lg text-ink-3 hover:bg-paper-2 hover:text-ink shrink-0";

/** On the home screen: an update ready, a new version out, or the update just installed (once). */
export function UpdateNotice() {
  const state = useUpdates();
  const [closed, setClosed] = useState(false);
  if (!state) return null;
  const updates = desktop()?.updates;
  if (state.status === "ready") {
    return (
      <div className={CHIP}>
        <span>Update ready</span>
        <button onClick={() => void updates?.restart()} className={CHIP_BUTTON}>
          Restart
        </button>
      </div>
    );
  }
  if (state.status === "available" && state.version && state.dismissed !== state.version && !closed) {
    const close = () => {
      setClosed(true);
      void updates?.setPrefs({ dismissed: state.version });
    };
    return (
      <div className={CHIP}>
        <span>mlch {state.version} is out</span>
        {state.mode === "notify" && state.url ? (
          <a href={state.url} target="_blank" rel="noreferrer" className={CHIP_BUTTON}>
            View
          </a>
        ) : (
          <button onClick={() => void updates?.download()} className={CHIP_BUTTON}>
            Download
          </button>
        )}
        <button onClick={close} className={CLOSE} aria-label="Close" title="Close">
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>
    );
  }
  if (state.updated && !closed) {
    const close = () => {
      setClosed(true);
      void updates?.seen();
    };
    return (
      <div className="no-drag float rounded-xl pl-3 pr-1 py-1 flex items-center gap-2 text-[13px] max-w-[480px]">
        <span className="min-w-0">
          <span className="font-medium">Updated to {state.updated.version}.</span>
          {state.updated.notes && <span className="text-ink-2"> {state.updated.notes}</span>}
        </span>
        <button onClick={close} className={CLOSE} aria-label="Close" title="Close">
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>
    );
  }
  return null;
}

/** Settings → Updates: the version, where updates stand, what to do, the choices. */
export function UpdatesStatus({ build }: { build?: { version: string; commit: string; official: boolean } }) {
  const state = useUpdates();
  const [checking, setChecking] = useState(false);
  const updates = desktop()?.updates;
  const status = state?.status;
  const notify = state?.mode === "notify";
  const line =
    !state ? undefined
    : status === "off" ? "Updates are off in this build."
    : status === "checking" || checking ? "Checking"
    : status === "available" ? `mlch ${state.version} is out.${notify ? " This build does not update itself." : ""}`
    : status === "downloading" ? `Downloading ${state.version ?? "the update"}${state.percent ? ` (${state.percent}%)` : ""}`
    : status === "ready" ? `${state.version ?? "An update"} is ready.`
    : status === "latest" ? `Up to date${state.checkedAt ? `, checked ${formatDateTime(state.checkedAt)}` : ""}`
    : status === "error" ? `Could not check: ${state.error ?? "unknown error"}`
    : notify && state.notify === false ? "Not checking for new versions."
    : undefined;
  const busy = checking || status === "checking" || status === "downloading";
  return (
    <div className="text-[14px]">
      <p className="tabular-nums">
        {build ? `Version ${build.version}${build.commit ? ` (${build.commit})` : ""}${build.official ? "" : state ? ", built from source" : ""}` : ""}
      </p>
      {line && <p className={`mt-1 text-[13px] ${status === "error" ? "text-danger" : "text-ink-3"}`}>{line}</p>}
      {state && state.mode && (
        <>
          <div className="mt-3 flex items-center gap-2">
            {status === "ready" ? (
              <button onClick={() => void updates?.restart()} className="h-8 px-3 rounded-lg bg-ink text-white text-[13px] font-medium">
                Restart to update
              </button>
            ) : status === "available" && !notify ? (
              <button onClick={() => void updates?.download()} className="h-8 px-3 rounded-lg bg-ink text-white text-[13px] font-medium">
                Download
              </button>
            ) : status === "available" && state.url ? (
              <a href={state.url} target="_blank" rel="noreferrer" className="h-8 px-3 rounded-lg bg-ink text-white text-[13px] font-medium inline-flex items-center">
                View release
              </a>
            ) : null}
            <button
              disabled={busy || status === "ready" || (notify && state.notify === false)}
              onClick={async () => {
                setChecking(true);
                await updates?.check();
                setChecking(false);
              }}
              className="h-8 px-2.5 rounded-lg text-[13px] text-ink-2 hover:bg-paper-2 hover:text-ink disabled:text-ink-3 disabled:hover:bg-transparent"
            >
              Check now
            </button>
          </div>
          <div className="mt-3 flex flex-col gap-2 text-[13px] text-ink-2">
            {notify ? (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={state.notify !== false} onChange={(e) => void updates?.setPrefs({ notify: e.target.checked })} />
                Tell me when a new version is out
              </label>
            ) : (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={state.autoDownload !== false} onChange={(e) => void updates?.setPrefs({ autoDownload: e.target.checked })} />
                Download updates automatically
              </label>
            )}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={state.channel === "beta"} onChange={(e) => void updates?.setChannel(e.target.checked ? "beta" : "latest")} />
              Beta updates
            </label>
          </div>
        </>
      )}
    </div>
  );
}
