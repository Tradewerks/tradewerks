import z from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import { centsToDollars } from "../services/taxEngine.js";

export { centsToDollars };

export type MoneyInput = Prisma.Decimal | number | string | null | undefined;

// Decimal and string go through decimal.js's toFixed so a stored 1.005 is
// 101 cents (half-up), not the 100 a float multiply would give.
export function toCents(v: MoneyInput): number {
	if (v === null || v === undefined) return 0;
	if (typeof v === "number") {
		if (!Number.isFinite(v)) throw new RangeError(`Not a money amount: ${v}`);
		return Math.round(v * 100) + 0;
	}
	const d = new Prisma.Decimal(v);
	if (!d.isFinite()) throw new RangeError(`Not a money amount: ${d.toString()}`);
	const fixed = d.toFixed(2);
	// `+ 0` folds parseInt("-000") = -0 into 0 so Object.is comparisons hold.
	return Number.parseInt(fixed.replace(".", ""), 10) + 0;
}

export function sumCents(values: MoneyInput[]): number {
	let total = 0;
	for (const v of values) total += toCents(v);
	return total;
}

export function isWholeCents(v: number): boolean {
	return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
}

export const moneyAmount = (message: string) =>
	z
		.number()
		.positive(message)
		.refine(isWholeCents, "Amounts can have at most two decimal places");

// Matches frontend/src/util/util.ts formatCurrency exactly ("$1,000.00", not toFixed's "1000.00")
export const formatCurrency = (amount: number) =>
	new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(amount);
