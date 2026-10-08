import type { LimitKey } from "./types";

export const LIMIT_LABELS: Record<LimitKey, string> = {
	dispatchers: "Dispatchers",
	technicians: "Technicians",
	ai_calls_month: "AI requests / month",
	tax_lookups_month: "Tax lookups / month",
	receipt_scans_month: "Receipt scans / month",
};
export const LIMIT_KEYS = Object.keys(LIMIT_LABELS) as LimitKey[];
