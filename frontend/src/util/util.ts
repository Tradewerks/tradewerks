import type { StockStatus } from "../types/inventory";
import { isAxiosError } from "axios";

export const camelCaseToRegular = (str: string) => {
	return str
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/^./, (match) => match.toUpperCase());
};

export const addSpacesToCamelCase = (text: string) => {
	if (!text) return "";
	return text.replace(/([a-z])([A-Z])/g, "$1 $2").trim();
};

export const formatter = new Intl.NumberFormat(navigator.languages, {
	notation: "compact",
	compactDisplay: "short",
});

export const formatCurrency = (amount: number) => {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(amount);
};

/** Fallback timezone used when org timezone is unavailable (e.g. before first login). */
export const FALLBACK_TIMEZONE = "America/Chicago";

export const formatDateTime = (date: Date | string, tz = FALLBACK_TIMEZONE) => {
	const d = typeof date === "string" ? new Date(date) : date;
	return (
		d.toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
			timeZone: tz,
		}) +
		" at " +
		d.toLocaleTimeString("en-US", {
			hour: "numeric",
			minute: "2-digit",
			timeZone: tz,
		})
	);
};

export const formatDate = (date: Date | string, tz = FALLBACK_TIMEZONE) => {
	return new Date(date).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: tz,
	});
};

// Rail rows are one line wide; the year only earns its space when it differs.
export function formatShortDate(
	date: Date | string,
	tz = FALLBACK_TIMEZONE,
	now: Date = new Date(),
): string {
	const d = new Date(date);
	const year = (x: Date) => x.toLocaleDateString("en-US", { year: "numeric", timeZone: tz });
	return d.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		...(year(d) === year(now) ? {} : { year: "numeric" }),
		timeZone: tz,
	});
}

/**
 * Whole days from now to `date` — negative once it is in the past. Compared on
 * the calendar-day boundary rather than the millisecond, so a document expiring
 * later today reads as 0 days rather than "tomorrow".
 */
export function daysUntil(date: Date | string): number {
	const DAY_MS = 24 * 60 * 60 * 1000;
	const then = new Date(date);
	const target = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate());
	const now = new Date();
	const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
	return Math.round((target - today) / DAY_MS);
}

export function addMonths(isoDate: string, months: number): string {
	const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
	return new Date(y, m - 1 + months, d).toISOString().slice(0, 10);
}

export function addInterval(isoDate: string, unit: "days" | "weeks" | "months" | "years", count: number): string {
	if (unit === "months") return addMonths(isoDate, count);
	if (unit === "years") return addMonths(isoDate, count * 12);
	const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
	const days = unit === "weeks" ? count * 7 : count;
	return new Date(y, m - 1, d + days).toISOString().slice(0, 10);
}

export const formatDateOnly = (date: Date | string) => {
	return new Date(date).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
};

export const formatTime = (date: Date | string, tz = FALLBACK_TIMEZONE) => {
	const d = typeof date === "string" ? new Date(date) : date;
	return d.toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
		timeZone: tz,
	});
};
/* ── Week / day helpers ──────────────────────────────────────── */

// Returns the Start of the week
export function startOfWeek(d: Date): Date {
	const date = new Date(d);
	const day = date.getDay(); // 0 = Sun
	const diff = day === 0 ? -6 : 1 - day;
	date.setDate(date.getDate() + diff);
	date.setHours(0, 0, 0, 0);
	return date;
}

// Returns a new Date by n amount of calendar days
export function addDays(d: Date, n: number): Date {
	const date = new Date(d);
	date.setDate(date.getDate() + n);
	return date;
}

// Formats a date
export function formatWeekDay(d: Date, tz = FALLBACK_TIMEZONE): string {
	return d.toLocaleDateString("en-US", {
		timeZone: tz,
		weekday: "long",
		month: "short",
		day: "numeric",
	});
}

// Formats a week range
export function formatWeekRange(weekStart: Date, tz = FALLBACK_TIMEZONE): string {
	const start = weekStart.toLocaleDateString("en-US", {
		timeZone: tz,
		month: "short",
		day: "numeric",
	});
	const end = addDays(weekStart, 6).toLocaleDateString("en-US", {
		timeZone: tz,
		month: "short",
		day: "numeric",
		year: "numeric",
	});
	return `${start} – ${end}`;
}

// Returns true if two days are the same.
export function isSameDay(a: Date, b: Date, tz = FALLBACK_TIMEZONE): boolean {
	return (
		a.toLocaleDateString("en-CA", { timeZone: tz }) ===
		b.toLocaleDateString("en-CA", { timeZone: tz })
	);
}

/* ── Inventory Status ────────────────────────────────────────── */

export const calculateStockStatus = (quantity: number, threshold: number | null): StockStatus => {
	if (threshold === null) return null;
	if (quantity === 0) return "out_of_stock";
	if (quantity <= threshold) return "low";
	return "sufficient";
};

// Prefers the server-computed stock_status (accounts for tracking-aware
// on-hand math); falls back to a client-side calc from quantity/threshold
// when it isn't present. Shared by ItemStatRow and InventoryItemDetailPage
// so the two never drift.
export const getItemStockStatus = (item: {
	stock_status: StockStatus;
	quantity: number;
	low_stock_threshold: number | null;
}): StockStatus =>
	item.stock_status ?? calculateStockStatus(item.quantity, item.low_stock_threshold);

export const getStatusLabel = (status: StockStatus): string => {
	switch (status) {
		case "out_of_stock":
			return "Out of Stock";
		case "low":
			return "Low Stock";
		case "sufficient":
			return "Sufficient";
		default:
			return "No Alert";
	}
};

export const getStatusBadgeClass = (status: StockStatus): string => {
	switch (status) {
		case "out_of_stock":
			return "bg-error/20 text-error-text border border-error/30";
		case "low":
			return "bg-yellow-500/20 text-warning-text border border-yellow-500/30";
		case "sufficient":
			return "bg-success/20 text-success-text border border-success/30";
		default:
			return "bg-surface text-text-tertiary border border-border";
	}
};

export const getStockStatusTextColor = (status: StockStatus): string => {
	switch (status) {
		case "out_of_stock":
			return "text-error-text";
		case "low":
			return "text-warning-text";
		default:
			return "text-text-primary";
	}
};

export const getStockStatusDotColor = (status: StockStatus): string => {
	switch (status) {
		case "out_of_stock":
			return "bg-red-400";
		case "low":
			return "bg-yellow-400";
		case "sufficient":
			return "bg-green-400";
		default:
			return "bg-zinc-500";
	}
};

export const getStockRingColor = (status: StockStatus): string => {
	switch (status) {
		case "out_of_stock":
			return "#ef4444";
		case "low":
			return "#eab308";
		case "sufficient":
			return "#22c55e";
		default:
			return "#3f3f46";
	}
};

/* ────────────────────────────────────────────────────────────── */

// Admin is basically dispatcher with extra permissions
// also works if need to add other roles like super admin or a lower dispatcher role in the future
export function isDispatcherRole(role: string): boolean {
	return role === "DISPATCHER" || role === "ADMIN";
}

export function isAdmin(role: string): boolean {
	return role === "ADMIN";
}

/**
 * What a caught mutation error can actually be shown to a user as. On an
 * axios error it reads the API's { error: { message } } envelope, which is
 * what carries a worded 422/403 refusal — AxiosError.message is only
 * "Request failed with status code 422". Falls back to a plain Error's
 * message, then to `fallback`.
 */
export function errorMessage(err: unknown, fallback: string): string {
	if (isAxiosError(err)) {
		const data = err.response?.data as { error?: { message?: unknown } } | undefined;
		const enveloped = data?.error?.message;
		return typeof enveloped === "string" && enveloped ? enveloped : fallback;
	}
	return err instanceof Error && err.message ? err.message : fallback;
}
