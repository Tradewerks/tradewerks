/**
 * taxEngine.ts
 * Centralized tax calculation engine — single source of truth for all tax math.
 * All monetary arithmetic uses integer cents to prevent floating-point drift.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaxRateConfig {
	id: string;
	name: string;
	rate: number; // 0-1 decimal
	jurisdiction?: string;
}

export interface TaxGroupConfig {
	id: string;
	name: string;
	rates: TaxRateConfig[];
}

export interface LineItemTaxInput {
	id: string;
	total_cents: number; // line item dollar total * 100, integer
	taxable: boolean;
	tax_group?: TaxGroupConfig | null;
}

export interface DocumentTaxInput {
	line_items: LineItemTaxInput[];
	discount_type?: "percent" | "amount" | null;
	discount_value?: number | null; // if "percent": 0-100. If "amount": dollar value
}

export interface GroupTaxSummary {
	group: TaxGroupConfig;
	taxable_amount_cents: number;
	tax_amount_cents: number;
}

export interface DocumentTaxOutput {
	subtotal_cents: number;
	discount_cents: number;
	line_item_tax_amounts: Record<string, number>; // line item id → tax_amount_cents
	groups_summary: GroupTaxSummary[];
	total_tax_cents: number;
	total_cents: number;
	effective_rate: number; // blended: total_tax_cents / taxable_amount (0 if no taxable items)
	snapshot: TaxSnapshot; // ready to store as JSON in DB
}

export interface TaxSnapshot {
	version: 1;
	locked_at: string; // ISO datetime or "draft"
	client_exempt: boolean;
	groups: {
		id: string;
		name: string;
		rates: {
			id: string;
			name: string;
			rate: number;
			jurisdiction?: string;
		}[];
		taxable_amount_cents: number;
		tax_amount_cents: number;
	}[];
	non_taxable_amount_cents: number;
	total_tax_cents: number;
	subtotal_cents: number;
	discount_cents: number;
	total_cents: number;
	effective_rate: number;
}

// ---------------------------------------------------------------------------
// Prisma mapping helper types
// ---------------------------------------------------------------------------

export interface PrismaTaxGroupWithRates {
	id: string;
	name: string;
	rates: {
		sort_order: number;
		tax_rate: {
			id: string;
			name: string;
			rate: { toNumber(): number } | number; // Prisma Decimal or plain number
			jurisdiction: string | null;
		};
	}[];
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Convert a dollar amount to integer cents.
 * Uses Math.round to handle minor floating-point imprecision in the input.
 */
export function dollarsToCents(dollars: number): number {
	return Math.round(dollars * 100);
}

/**
 * Convert integer cents to a dollar amount rounded to 2 decimal places.
 */
export function centsToDollars(cents: number): number {
	return Math.round(cents) / 100;
}

/**
 * Truncate toward zero, so the same magnitude rounds the same way whichever
 * sign it carries.
 *
 * `Math.floor` is sign-biased: it rounds a positive amount toward zero but a
 * negative one away from it. Credit adjustments carry negative line totals, so
 * with a bare floor a -$1.00 line at 8.25% credited 9c of tax where the
 * matching +$1.00 charge only ever collected 8c — a systematic over-refund,
 * always in the client's favour, on every credit line. Symmetric rounding is
 * the standard answer precisely because it is free of that bias.
 *
 * For a positive amount this is identical to `Math.floor`, so every quote,
 * invoice, job and visit that existed before credits did computes the same tax
 * it always has.
 */
export function floorTowardZero(value: number): number {
	return value < 0 ? -Math.floor(-value) : Math.floor(value);
}

/**
 * Map a Prisma tax group (with nested rates) to a plain TaxGroupConfig.
 * Rates are sorted by sort_order ascending before mapping.
 */
export function mapPrismaTaxGroup(group: PrismaTaxGroupWithRates): TaxGroupConfig {
	const sortedRates = [...group.rates].sort((a, b) => a.sort_order - b.sort_order);

	return {
		id: group.id,
		name: group.name,
		rates: sortedRates.map((r) => {
			const rateValue =
				typeof r.tax_rate.rate === "number"
					? r.tax_rate.rate
					: r.tax_rate.rate.toNumber();

			return {
				id: r.tax_rate.id,
				name: r.tax_rate.name,
				rate: rateValue,
				...(r.tax_rate.jurisdiction !== null && { jurisdiction: r.tax_rate.jurisdiction }),
			} satisfies TaxRateConfig;
		}),
	};
}

/**
 * Sum the combined rate for a set of tax group rate rows (Prisma shape).
 * Exported so controllers/services don't duplicate this logic.
 */
export function computeCombinedRate(
	rates: Array<{ tax_rate: { rate: { toNumber(): number } | number } }>,
): number {
	return rates.reduce((sum, gr) => {
		const r = gr.tax_rate.rate;
		return sum + (typeof r === "number" ? r : r.toNumber());
	}, 0);
}

// ---------------------------------------------------------------------------
// Main calculation engine
// ---------------------------------------------------------------------------

/**
 * Calculate all tax figures for a document (quote or invoice).
 *
 * @param input          Line items and discount configuration.
 * @param clientExempt   When true all line items are treated as non-taxable.
 * @param lockedAt       If provided, snapshot.locked_at is set to this ISO string.
 *                       If omitted, snapshot.locked_at is "draft".
 */
export function calculateDocumentTax(
	input: DocumentTaxInput,
	clientExempt: boolean,
	lockedAt?: Date,
): DocumentTaxOutput {
	const { line_items, discount_type, discount_value } = input;

	// ------------------------------------------------------------------
	// Step 1: subtotal
	// ------------------------------------------------------------------
	const subtotal_cents = line_items.reduce((sum, li) => sum + li.total_cents, 0);

	// ------------------------------------------------------------------
	// Step 2: discount
	// ------------------------------------------------------------------
	let discount_cents = 0;

	if (subtotal_cents > 0 && discount_type != null && discount_value != null) {
		const safeValue = Math.max(0, discount_value); // negative discount is a bug; treat as 0
		if (discount_type === "percent") {
			discount_cents = Math.floor((subtotal_cents * safeValue) / 100);
		} else if (discount_type === "amount") {
			discount_cents = dollarsToCents(safeValue);
		} else {
			// Exhaustive check — discount_type is typed but runtime callers may pass arbitrary strings
			const _exhaustive: never = discount_type;
			throw new Error(`Unknown discount_type: ${_exhaustive}`);
		}
		// Clamp to [0, subtotal_cents]
		discount_cents = Math.max(0, Math.min(discount_cents, subtotal_cents));
	}

	// ------------------------------------------------------------------
	// Step 3: per-line-item tax + proportional discount allocation
	// ------------------------------------------------------------------
	const line_item_tax_amounts: Record<string, number> = {};

	// Track per-group accumulations keyed by group id.
	// Using a Map to preserve insertion order and avoid prototype pollution.
	const groupAccumulator = new Map<
		string,
		{ group: TaxGroupConfig; taxable_amount_cents: number; tax_amount_cents: number }
	>();

	let taxable_subtotal_cents = 0; // sum of effective_taxable for all taxable items
	let non_taxable_amount_cents = 0;

	for (const li of line_items) {
		// Determine whether this line item is actually taxable
		const isEffectivelyTaxable =
			!clientExempt && li.taxable && li.tax_group != null && li.tax_group.rates.length > 0;

		if (!isEffectivelyTaxable) {
			non_taxable_amount_cents += li.total_cents;
			line_item_tax_amounts[li.id] = 0;
			continue;
		}

		// Safe to assert non-null here — checked above
		const tax_group = li.tax_group as TaxGroupConfig;

		// Proportional discount share for this line item
		let prop_discount = 0;
		if (subtotal_cents > 0) {
			prop_discount = Math.floor((li.total_cents / subtotal_cents) * discount_cents);
		}

		const effective_taxable = li.total_cents - prop_discount;

		// Accumulate into taxable subtotal
		taxable_subtotal_cents += effective_taxable;

		// Compute tax for each rate, summing with floor per rate
		let line_tax = 0;
		for (const taxRate of tax_group.rates) {
			line_tax += floorTowardZero(effective_taxable * taxRate.rate);
		}

		line_item_tax_amounts[li.id] = line_tax;

		// Accumulate into group summary
		const existing = groupAccumulator.get(tax_group.id);
		if (existing) {
			existing.taxable_amount_cents += effective_taxable;
			existing.tax_amount_cents += line_tax;
		} else {
			groupAccumulator.set(tax_group.id, {
				group: tax_group,
				taxable_amount_cents: effective_taxable,
				tax_amount_cents: line_tax,
			});
		}
	}

	// ------------------------------------------------------------------
	// Step 4: group summaries
	// ------------------------------------------------------------------
	const groups_summary: GroupTaxSummary[] = Array.from(groupAccumulator.values());

	// ------------------------------------------------------------------
	// Step 5–7: totals and effective rate
	// ------------------------------------------------------------------
	const total_tax_cents = groups_summary.reduce((sum, g) => sum + g.tax_amount_cents, 0);
	const total_cents = subtotal_cents - discount_cents + total_tax_cents;
	const effective_rate =
		taxable_subtotal_cents === 0 ? 0 : total_tax_cents / taxable_subtotal_cents;

	// ------------------------------------------------------------------
	// Step 8: snapshot
	// ------------------------------------------------------------------
	const snapshot: TaxSnapshot = {
		version: 1,
		locked_at: lockedAt ? lockedAt.toISOString() : "draft",
		client_exempt: clientExempt,
		groups: groups_summary.map((gs) => ({
			id: gs.group.id,
			name: gs.group.name,
			rates: gs.group.rates.map((r) => ({
				id: r.id,
				name: r.name,
				rate: r.rate,
				...(r.jurisdiction !== undefined && { jurisdiction: r.jurisdiction }),
			})),
			taxable_amount_cents: gs.taxable_amount_cents,
			tax_amount_cents: gs.tax_amount_cents,
		})),
		non_taxable_amount_cents,
		total_tax_cents,
		subtotal_cents,
		discount_cents,
		total_cents,
		effective_rate,
	};

	return {
		subtotal_cents,
		discount_cents,
		line_item_tax_amounts,
		groups_summary,
		total_tax_cents,
		total_cents,
		effective_rate,
		snapshot,
	};
}
