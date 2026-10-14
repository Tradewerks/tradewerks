import { create } from "zustand";
import type { ReactNode } from "react";

export type ToastKind = "success" | "error" | "warning" | "info";

export interface ToastAction {
	label: string;
	onClick: () => void;
}

export interface ToastEntry {
	id: number;
	kind: ToastKind;
	message: ReactNode;
	/** Overrides the kind's default icon — e.g. LabelQueueToast's QrCode glyph. */
	icon?: ReactNode;
	action?: ToastAction;
	/** Set while the exit animation plays, before the entry is removed. */
	leaving?: boolean;
}

export interface PushOptions {
	icon?: ReactNode;
	action?: ToastAction;
	/** Auto-dismiss delay in ms. Defaults to AUTO_DISMISS_MS. */
	durationMs?: number;
}

const AUTO_DISMISS_MS = 4000;
// Matches ToastViewport's duration-200 exit transition
const EXIT_MS = 200;
// Gap between toasts pushed in the same burst
const STAGGER_MS = 150;

interface ToastState {
	toasts: ToastEntry[];
	push: (kind: ToastKind, message: ReactNode, options?: PushOptions) => number;
	dismiss: (id: number) => void;
}

let nextId = 0;
let nextShowAt = 0;

// Holds the pending show timer, then the auto-dismiss timer
const dismissTimers = new Map<number, number>();

function clearDismissTimer(id: number) {
	const timer = dismissTimers.get(id);
	if (timer !== undefined) {
		clearTimeout(timer);
		dismissTimers.delete(id);
	}
}

export const useToastStore = create<ToastState>((set, get) => ({
	toasts: [],
	push: (kind, message, options) => {
		const id = ++nextId;
		const show = () => {
			set((s) => ({
				toasts: [
					...s.toasts,
					{ id, kind, message, icon: options?.icon, action: options?.action },
				],
			}));
			dismissTimers.set(
				id,
				window.setTimeout(() => get().dismiss(id), options?.durationMs ?? AUTO_DISMISS_MS),
			);
		};
		const now = Date.now();
		const showAt = Math.max(now, nextShowAt);
		nextShowAt = showAt + STAGGER_MS;
		if (showAt === now) show();
		else dismissTimers.set(id, window.setTimeout(show, showAt - now));
		return id;
	},
	dismiss: (id) => {
		clearDismissTimer(id);
		if (!get().toasts.some((t) => t.id === id && !t.leaving)) return;
		set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
		window.setTimeout(() => {
			set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
		}, EXIT_MS);
	},
}));
