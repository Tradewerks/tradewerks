import { create } from "zustand";

/** Set by useUnsavedGuard so controls outside the page (the shell's Sign out) can ask first. */
export const useUnsaved = create<{ dirty: boolean }>()(() => ({ dirty: false }));
