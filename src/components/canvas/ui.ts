"use client";

import { create } from "zustand";

/** Canvas-local UI state that node components read. */
interface CanvasUi {
  editingId?: string;
  /** Node whose full content is open in the side panel. */
  openId?: string;
  /** Looking at a past checkpoint: nothing can be changed. */
  readOnly: boolean;
  setEditing(id?: string): void;
  setOpen(id?: string): void;
}

export const useCanvasUi = create<CanvasUi>((set) => ({
  readOnly: false,
  setEditing: (editingId) => set({ editingId }),
  setOpen: (openId) => set({ openId }),
}));
