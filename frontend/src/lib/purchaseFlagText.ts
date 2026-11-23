import i18n from "../i18n";
import { formatCurrency } from "../util/util";
import type { FieldPurchaseFlag } from "../types/fieldPurchases";

const t = i18n.t as unknown as (key: string, opts: Record<string, unknown>) => string;
const MONEY = ["total", "expected", "estimate", "limit", "would_be"];

/** A flag in the user's language. Flags without vars (older rows) show their saved English message. */
export function purchaseFlagText(f: FieldPurchaseFlag): string {
	const v = f.vars;
	if (!v) return f.message;
	const opts: Record<string, unknown> = { ...v, defaultValue: f.message };
	for (const k of MONEY) if (typeof v[k] === "number") opts[k] = formatCurrency(v[k]);
	const text = t(`purchaseFlags.${f.code}.${v.variant ?? "default"}`, opts);
	if (text === f.message || !v.by) return text;
	return `${text} ${t("purchaseFlags.by", { name: v.by, defaultValue: "" })}`.trim();
}
