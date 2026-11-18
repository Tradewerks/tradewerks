import type { CSSProperties } from "react";
import type { PublicOrg } from "../../api/publicLinks";

const FALLBACK = "#3b82f6";
const WHITE = "#ffffff";
const DARK = "#18181b";

function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/**
 * The org's colour goes on the primary action only, with whichever of white or
 * near-black text reads better on it: a fixed luminance cut-off left white text
 * under 4.5:1 on common mid-tone brands (blue-500, orange-500).
 */
export function brandButtonStyle(org: PublicOrg): CSSProperties {
	const hex = /^#[0-9a-f]{6}$/i.test(org.color) ? org.color : FALLBACK;
	const color = contrastRatio(hex, WHITE) >= contrastRatio(hex, DARK) ? WHITE : DARK;
	return { backgroundColor: hex, color };
}

export const primaryButtonClass =
	"flex min-h-12 w-full items-center justify-center rounded-lg px-4 text-base font-semibold transition-[filter,opacity] duration-150 ease-out hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40";

export const secondaryButtonClass =
	"flex min-h-12 w-full items-center justify-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-800 transition-colors duration-150 ease-out hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800";

export const textButtonClass =
	"flex min-h-11 w-full items-center justify-center text-sm text-zinc-600 underline-offset-2 hover:underline disabled:opacity-40 dark:text-zinc-400";

export const inputClass =
	"mt-1.5 block w-full rounded-lg border border-zinc-300 bg-white px-3 text-base text-zinc-900 outline-none transition-colors duration-150 ease-out focus:border-zinc-500 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-400 dark:focus-visible:ring-blue-400 dark:focus-visible:ring-offset-zinc-900";

const DATE_PARTS = { month: "short", day: "numeric", year: "numeric" } as const;

/** A date-only column (stored as UTC midnight): its own calendar day in any zone. */
export const formatPublicDay = (iso: string) =>
	new Date(iso).toLocaleDateString("en-US", { ...DATE_PARTS, timeZone: "UTC" });

/** A moment in time, shown on the day it falls on for the viewer. */
export const formatPublicInstant = (iso: string) =>
	new Date(iso).toLocaleDateString("en-US", DATE_PARTS);
