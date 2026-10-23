// backend/src/services/tax/rateChange.ts
import { titleCase, type RateSetView } from "./rateSet.js";

export type ChangedModel = "quote" | "job" | "invoice";

export interface RateChange {
	model: ChangedModel;
	from: RateSetView;
	to: RateSetView;
}

export interface RateChangeNotice {
	title: string;
	body: string;
	actionUrl: string;
}

type Component = RateSetView["components"][number];

/** 0.0825 → "8.25%", 0.00125 → "0.125%". Three decimals is the finest a district rate needs. */
export function formatRatePercent(rate: number): string {
	return `${Math.round(rate * 100_000) / 1000}%`;
}

const keyOf = (c: Component) => `${c.jurisdiction_type}|${c.jurisdiction_name.toUpperCase()}`;

function label(c: Component): string {
	if (c.jurisdiction_type === "state") return c.jurisdiction_name;
	const name = titleCase(c.jurisdiction_name);
	return c.jurisdiction_type === "county" && !/county$/i.test(name) ? `${name} County` : name;
}

// Rates come from Decimal(8,6) columns; anything below 1e-9 apart is the same stored value.
const sameRate = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** Names the jurisdictions whose rate moved, e.g. "Dane County 0.5% → 0.6%". */
export function describeJurisdictionChange(from: RateSetView, to: RateSetView): string {
	const before = new Map(from.components.map((c) => [keyOf(c), c]));
	const after = new Map(to.components.map((c) => [keyOf(c), c]));
	const parts: string[] = [];
	for (const [key, c] of after) {
		const prev = before.get(key);
		if (!prev) parts.push(`${label(c)} added at ${formatRatePercent(c.rate)}`);
		else if (!sameRate(prev.rate, c.rate))
			parts.push(`${label(c)} ${formatRatePercent(prev.rate)} → ${formatRatePercent(c.rate)}`);
	}
	for (const [key, c] of before) if (!after.has(key)) parts.push(`${label(c)} removed`);
	return parts.length > 0 ? parts.join(", ") : "jurisdiction details changed";
}

const LIST_URL: Record<ChangedModel, string> = {
	quote: "/dispatch/quotes?status=Draft",
	invoice: "/dispatch/invoices?status=Draft",
	// Open jobs span several statuses; the list has no single "draft" filter.
	job: "/dispatch/jobs",
};
const MAX_PAIRS = 3;
const drafts = (n: number) => `${n} ${n === 1 ? "draft" : "drafts"}`;

/** One notification per org per run; callers pass a non-empty list. */
export function buildRateChangeNotice(changes: RateChange[]): RateChangeNotice {
	const byPair = new Map<string, { change: RateChange; count: number }>();
	for (const c of changes) {
		const key = `${c.from.id}>${c.to.id}`;
		const hit = byPair.get(key);
		if (hit) hit.count += 1;
		else byPair.set(key, { change: c, count: 1 });
	}
	const pairs = [...byPair.values()].sort((a, b) => b.count - a.count);
	const lines = pairs
		.slice(0, MAX_PAIRS)
		.map(
			({ change, count }) =>
				`${drafts(count)} ${formatRatePercent(change.from.total_rate)} → ${formatRatePercent(change.to.total_rate)} (${describeJurisdictionChange(change.from, change.to)})`,
		);
	const rest = pairs.length - MAX_PAIRS;
	if (rest > 0) lines.push(`and ${rest} more rate ${rest === 1 ? "change" : "changes"}`);

	const perModel: Record<ChangedModel, number> = { quote: 0, invoice: 0, job: 0 };
	for (const c of changes) perModel[c.model] += 1;
	const top = (["quote", "invoice", "job"] as const).reduce((a, b) =>
		perModel[b] > perModel[a] ? b : a,
	);

	return {
		title: `Tax rate changed on ${drafts(changes.length)}`,
		body: lines.join("; "),
		actionUrl: LIST_URL[top],
	};
}
