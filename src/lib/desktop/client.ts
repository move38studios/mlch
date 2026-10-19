/** The desktop shell, as the page sees it (electron/preload.cjs). Absent in a plain browser. */

/**
 * The app's updates (electron/main.cjs). "install": the build updates itself (official, or a fork with its own
 * feed); "notify": a build from source that only says when a new mlch is out; absent: off (development).
 */
export interface UpdateState {
  status: "off" | "idle" | "checking" | "available" | "downloading" | "ready" | "latest" | "error";
  mode?: "install" | "notify";
  /** The version out, being downloaded or ready. */
  version?: string;
  /** Where to get it (notify builds: the release page). */
  url?: string;
  /** Download updates without asking (install builds). */
  autoDownload?: boolean;
  /** Say when a new version is out (notify builds). */
  notify?: boolean;
  /** A version the person closed the notice for. */
  dismissed?: string;
  percent?: number;
  error?: string;
  checkedAt?: number;
  channel?: "latest" | "beta";
  /** The first run after an update: its version and notes, until seen. */
  updated?: { version: string; notes?: string };
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface MlchDesktop {
  platform: string;
  backend: {
    state(): Promise<boolean>;
    restart(): Promise<boolean>;
    onStatus(callback: (online: boolean) => void): () => void;
  };
  openLogs(): Promise<void>;
  /** Pick another folder for the library (moves the mulches there, or uses the ones already in it); the server restarts. */
  chooseLibrary?(): Promise<Result<string>>;
  microphoneAccess(): Promise<boolean>;
  /** Bring the window to the front (after a screenshot of another app). */
  showWindow?(): Promise<void>;
  /** The call being listened to, for the menu bar. */
  setCallState?(state: { mulchId: string } | null): Promise<void>;
  /** A PNG (base64) of part of the window, 1200 px wide: a shared link's preview. */
  capture?(rect: { x: number; y: number; width: number; height: number }): Promise<string | null>;
  /** A web link clicked in a made file shown in `rect`: opened in the browser if the last mouse press was there, just now and after `after` (ms). */
  openLink?(url: string, rect: { x: number; y: number; width: number; height: number }, after: number): Promise<boolean>;
  /** Open at login: read it, or set it. */
  openAtLogin?(value?: boolean): Promise<boolean>;
  /** Menu commands meant for the page ("zoom-in", "zoom-out", "zoom-fit", "stop-call"). */
  onMenu?(callback: (command: string) => void): () => void;
  updates?: {
    state(): Promise<UpdateState>;
    check(): Promise<UpdateState>;
    restart(): Promise<void>;
    download(): Promise<void>;
    setPrefs(patch: { autoDownload?: boolean; notify?: boolean; dismissed?: string }): Promise<UpdateState>;
    setChannel(channel: "latest" | "beta"): Promise<"latest" | "beta">;
    seen(): Promise<void>;
    onChange(callback: (state: UpdateState) => void): () => void;
  };
  credentials: {
    status(): Promise<Result<Record<string, boolean>>>;
    write(value: Record<string, string | null>): Promise<Result<Record<string, boolean>>>;
    delete(name: string): Promise<Result<Record<string, boolean>>>;
  };
}

declare global {
  interface Window {
    mlchDesktop?: MlchDesktop;
  }
}

export function desktop(): MlchDesktop | undefined {
  return typeof window === "undefined" ? undefined : window.mlchDesktop;
}
