/** The desktop shell, as the page sees it (electron/preload.cjs). Absent in a plain browser. */

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface MlchDesktop {
  platform: string;
  backend: {
    state(): Promise<boolean>;
    restart(): Promise<boolean>;
    onStatus(callback: (online: boolean) => void): () => void;
  };
  openLogs(): Promise<void>;
  microphoneAccess(): Promise<boolean>;
  /** Bring the window to the front (after a screenshot of another app). */
  showWindow?(): Promise<void>;
  /** The call being listened to, for the menu bar. */
  setCallState?(state: { mulchId: string } | null): Promise<void>;
  /** Open at login: read it, or set it. */
  openAtLogin?(value?: boolean): Promise<boolean>;
  /** Menu commands meant for the page ("zoom-in", "zoom-out", "zoom-fit", "stop-call"). */
  onMenu?(callback: (command: string) => void): () => void;
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
