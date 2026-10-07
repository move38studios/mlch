/** The desktop shell, as the page sees it (electron/preload.cjs). Absent in a plain browser. */

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface MulchDesktop {
  platform: string;
  backend: {
    state(): Promise<boolean>;
    restart(): Promise<boolean>;
    onStatus(callback: (online: boolean) => void): () => void;
  };
  openLogs(): Promise<void>;
  microphoneAccess(): Promise<boolean>;
  credentials: {
    status(): Promise<Result<Record<string, boolean>>>;
    write(value: Record<string, string | null>): Promise<Result<Record<string, boolean>>>;
    delete(name: string): Promise<Result<Record<string, boolean>>>;
  };
}

declare global {
  interface Window {
    mulchDesktop?: MulchDesktop;
  }
}

export function desktop(): MulchDesktop | undefined {
  return typeof window === "undefined" ? undefined : window.mulchDesktop;
}
