"use client";

/**
 * The open mulch in the browser.
 *
 * The server holds the truth. This store mirrors it from the event stream,
 * applies the user's own ops immediately (and sends them), and keeps the
 * undo stack. Every batch, the user's or the agent's, is one undo step.
 */

import { create } from "zustand";
import { applyOps, invertOps } from "./ops";
import type { JobStatus, ServerEvent, TranscriptSegment, ViewAction } from "./events";
import type { Mulch, MulchOp, OpBatch } from "./types";

const UNDO_LIMIT = 200;

export const clientId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `c-${Math.random()}`;

interface UndoEntry {
  undo: MulchOp[];
  redo: MulchOp[];
}

interface MulchState {
  id?: string;
  mulch?: Mulch;
  transcript: TranscriptSegment[];
  jobs: Record<string, JobStatus>;
  paused: boolean;
  /** The agent's latest status line. */
  say?: { text: string; at: number };
  notice?: { level: "error" | "info"; message: string; at: number };
  connected: boolean;
  error?: string;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  /** Items to show (from the agent's focus tool or a search result). */
  focus?: { ids: string[]; page?: number; quote?: string; at: number };
  setFocus(focus: { ids: string[]; page?: number; quote?: string }): void;
  /** Results to make visible briefly, without moving the view. */
  pulse?: { ids: string[]; at: number };
  setPulse(ids: string[]): void;
  /** Stop, retry, or mark finished jobs seen. */
  jobAction(action: "cancel" | "retry" | "seen", payload: { jobId?: string; ids?: string[] }): Promise<void>;
  /** A view move from the agent. */
  view?: { action: ViewAction; at: number };
  /** Ids of nodes added by others since the last time the canvas looked (for entrance animation). */
  fresh: Record<string, number>;

  connect(id: string): () => void;
  /** Apply the user's ops now and send them. `undoable: false` for measurements. */
  apply(ops: MulchOp[], options?: { undoable?: boolean }): void;
  undo(): void;
  redo(): void;
  dismissNotice(): void;
}

async function send(id: string, ops: MulchOp[]): Promise<void> {
  const response = await fetch(`/api/mulches/${id}/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, ops }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Save failed (${response.status})`);
  }
}

export const useMulch = create<MulchState>((set, get) => {
  function pushUndo(stack: UndoEntry[], entry: UndoEntry): UndoEntry[] {
    if (!entry.undo.length) return stack;
    return [...stack, entry].slice(-UNDO_LIMIT);
  }

  function receive(event: ServerEvent) {
    switch (event.type) {
      case "snapshot":
        set({
          mulch: event.mulch,
          transcript: event.transcript,
          jobs: Object.fromEntries(event.jobs.map((job) => [job.id, job])),
          paused: event.paused,
          connected: true,
          error: undefined,
        });
        return;
      case "ops": {
        const batch: OpBatch = event.batch;
        if (batch.clientId === clientId) return;
        const before = get().mulch;
        if (!before) return;
        const after = applyOps(before, batch.ops, batch.at);
        const fresh = { ...get().fresh };
        for (const op of batch.ops) if (op.op === "addNode") fresh[op.node.id] = Date.now();
        set({
          mulch: after,
          fresh,
          undoStack: pushUndo(get().undoStack, { undo: invertOps(before, batch.ops), redo: batch.ops }),
        });
        return;
      }
      case "transcript":
        set({ transcript: [...get().transcript, event.segment] });
        return;
      case "job":
        set({ jobs: { ...get().jobs, [event.job.id]: event.job } });
        return;
      case "paused":
        set({ paused: event.paused });
        return;
      case "say":
        set({ say: { text: event.text, at: Date.now() } });
        return;
      case "notice":
        set({ notice: { level: event.level, message: event.message, at: Date.now() } });
        return;
      case "focus":
        set({ focus: { ids: event.ids, page: event.page, quote: event.quote, at: Date.now() } });
        return;
      case "view":
        set({ view: { action: event.action, at: Date.now() } });
        return;
    }
  }

  function commit(ops: MulchOp[], undoable: boolean, stacks?: Partial<Pick<MulchState, "undoStack" | "redoStack">>) {
    const { id, mulch } = get();
    if (!id || !mulch || !ops.length) return;
    const after = applyOps(mulch, ops, Date.now());
    if (after === mulch) {
      if (stacks) set(stacks);
      return;
    }
    const entry = { undo: invertOps(mulch, ops), redo: ops };
    set({
      mulch: after,
      ...(undoable ? { undoStack: pushUndo(get().undoStack, entry), redoStack: [] } : {}),
      ...stacks,
    });
    send(id, ops).catch((error: Error) => set({ notice: { level: "error", message: error.message, at: Date.now() } }));
  }

  return {
    transcript: [],
    jobs: {},
    paused: false,
    connected: false,
    undoStack: [],
    redoStack: [],
    fresh: {},

    connect(id) {
      set({ id, mulch: undefined, transcript: [], jobs: {}, undoStack: [], redoStack: [], fresh: {}, connected: false, error: undefined, say: undefined });
      let source: EventSource | undefined;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      const open = () => {
        source = new EventSource(`/api/mulches/${id}/events`);
        source.onmessage = (message) => {
          try {
            receive(JSON.parse(message.data) as ServerEvent);
          } catch (error) {
            console.error("Bad event", error);
          }
        };
        source.onerror = () => {
          source?.close();
          set({ connected: false });
          if (closed) return;
          // A 404 never recovers; check once, else reconnect.
          fetch(`/api/mulches/${id}`).then((response) => {
            if (response.status === 404) set({ error: "Not found." });
            else retry = setTimeout(open, 1000);
          }, () => (retry = setTimeout(open, 1000)));
        };
      };
      open();
      return () => {
        closed = true;
        clearTimeout(retry);
        source?.close();
      };
    },

    apply(ops, options = {}) {
      commit(ops, options.undoable !== false);
    },

    undo() {
      const stack = get().undoStack;
      const entry = stack[stack.length - 1];
      if (!entry) return;
      commit(entry.undo, false, { undoStack: stack.slice(0, -1), redoStack: [...get().redoStack, entry] });
    },

    redo() {
      const stack = get().redoStack;
      const entry = stack[stack.length - 1];
      if (!entry) return;
      commit(entry.redo, false, { redoStack: stack.slice(0, -1), undoStack: [...get().undoStack, entry] });
    },

    setPulse(ids) {
      set({ pulse: { ids, at: Date.now() } });
    },

    async jobAction(action, payload) {
      const { id } = get();
      if (!id) return;
      const response = await fetch(`/api/mulches/${id}/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        set({ notice: { level: "error", message: data.error || `Request failed (${response.status})`, at: Date.now() } });
      }
    },

    setFocus(focus) {
      set({ focus: { ...focus, at: Date.now() } });
    },

    dismissNotice() {
      set({ notice: undefined });
    },
  };
});
