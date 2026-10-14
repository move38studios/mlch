"use client";

import { create } from "zustand";

/** Canvas-local UI state that node components read. */
interface CanvasUi {
  editingId?: string;
  /** Node whose full content is open in the side panel. */
  openId?: string;
  /** The side panel opens straight into editing the card's text (a card too small to edit in place). */
  openEditing?: boolean;
  /** Text to find and highlight in the side panel. */
  highlight?: { quote?: string; page?: number };
  setHighlight(highlight?: { quote?: string; page?: number }): void;
  /** Artifact shown full-window over the canvas. */
  viewerId?: string;
  setViewer(id?: string): void;
  /** Looking at a past checkpoint: nothing can be changed. */
  readOnly: boolean;
  setEditing(id?: string): void;
  setOpen(id?: string, options?: { edit?: boolean }): void;
}

export const useCanvasUi = create<CanvasUi>((set) => ({
  readOnly: false,
  setEditing: (editingId) => set({ editingId }),
  setOpen: (openId, options) => set({ openId, openEditing: !!options?.edit }),
  setViewer: (viewerId) => set({ viewerId }),
  setHighlight: (highlight) => set({ highlight }),
}));
