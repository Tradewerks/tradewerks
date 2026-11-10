import { useState, useMemo, useCallback } from "react";
import type { DiscountType, FinancialState } from "../../types/common";
import type { TaxGroup, TaxSnapshot } from "../../types/tax";
import { roundHalfUpSymmetric, truncateTowardZero, type TaxRounding } from "../../lib/taxRounding";

// ─── Multi-group tax types ────────────────────────────────────────────────────

export interface LineItemForCalc {
	id: string;
	total: number;
	taxable: boolean;
	tax_group_id: string | null;
}

/**
 * Frontend-only type. `group` is always a full `TaxGroup` (with `combined_rate`),
 * never the backend's `TaxGroupConfig`. Snapshot path reconstructs `combined_rate`
 * explicitly (see snapshotResult in useFinancialCalculations).
 */
export interface GroupTaxSummary {
	group: TaxGroup;
	taxable_amount: number;
	tax_amount: number;
}

export interface MultiGroupTaxResult {
	subtotal: number;
	discount_amount: number;
	groups_summary: GroupTaxSummary[];
	total_tax: number;
	total: number;
	effective_rate: number;
}

// ─── Core calculation function ────────────────────────────────────────────────

export function calculateMultiGroupTax(
	lineItems: LineItemForCalc[],
	taxGroups: TaxGroup[],
	discountType: DiscountType | null | undefined,
	discountValue: number | null | undefined,
	clientExempt: boolean,
	rounding: TaxRounding = "line_floor"
): MultiGroupTaxResult {
	// Work in integer cents — mirrors backend taxEngine.ts exactly
	const subtotal_cents = Math.round(lineItems.reduce((sum, item) => sum + item.total, 0) * 100);

	// Same operation order as the backend engine: (sub * v) / 100 and round(v * 100) avoid the
	// float drift of sub * (v / 100) and floor(v * 100), e.g. 0.29 * 100 = 28.999999999999996.
	const safeDiscount = Math.max(0, discountValue ?? 0);
	const rawDiscount_cents =
		discountType === "percent"
			? Math.floor((subtotal_cents * safeDiscount) / 100)
			: Math.round(safeDiscount * 100);
	const discount_cents =
		subtotal_cents > 0 && discountType != null && discountValue != null
			? Math.min(rawDiscount_cents, subtotal_cents)
			: 0;

	const subtotal = subtotal_cents / 100;
	const discount_amount = discount_cents / 100;

	if (clientExempt || taxGroups.length === 0) {
		return {
			subtotal,
			discount_amount,
			groups_summary: [],
			total_tax: 0,
			total: subtotal - discount_amount,
			effective_rate: 0,
		};
	}

	const groupMap = new Map<string, TaxGroup>();
	for (const g of taxGroups) groupMap.set(g.id, g);

	const groupAccumulator = new Map<
		string,
		{ group: TaxGroup; taxable_amount_cents: number; tax_amount_cents: number }
	>();

	let taxable_subtotal_cents = 0;

	for (const item of lineItems) {
		if (!item.taxable || !item.tax_group_id) continue;
		const group = groupMap.get(item.tax_group_id);
		if (!group) continue;

		const item_cents = Math.round(item.total * 100);
		const prop_discount_cents =
			subtotal_cents > 0 ? Math.floor((item_cents / subtotal_cents) * discount_cents) : 0;
		const effective_taxable_cents = item_cents - prop_discount_cents;

		taxable_subtotal_cents += effective_taxable_cents;

		// Half-up groups get their cents after the loop, once each group's base is complete.
		let item_tax_cents = 0;
		if (rounding !== "jurisdiction_half_up") {
			// Per rate, toward zero — identical to backend floorTowardZero(effective_taxable * rate)
			for (const gr of group.rates) {
				item_tax_cents += truncateTowardZero(effective_taxable_cents * gr.tax_rate.rate);
			}
		}

		const existing = groupAccumulator.get(group.id);
		if (existing) {
			existing.taxable_amount_cents += effective_taxable_cents;
			existing.tax_amount_cents += item_tax_cents;
		} else {
			groupAccumulator.set(group.id, {
				group,
				taxable_amount_cents: effective_taxable_cents,
				tax_amount_cents: item_tax_cents,
			});
		}
	}

	if (rounding === "jurisdiction_half_up") {
		for (const acc of groupAccumulator.values()) {
			const base = acc.taxable_amount_cents;
			for (const gr of acc.group.rates) {
				acc.tax_amount_cents += roundHalfUpSymmetric(base * gr.tax_rate.rate);
			}
		}
	}

	const total_tax_cents = Array.from(groupAccumulator.values()).reduce(
		(sum, g) => sum + g.tax_amount_cents,
		0
	);

	const groups_summary: GroupTaxSummary[] = Array.from(groupAccumulator.values()).map((g) => ({
		group: g.group,
		taxable_amount: g.taxable_amount_cents / 100,
		tax_amount: g.tax_amount_cents / 100,
	}));

	const total_tax = total_tax_cents / 100;
	const total = (subtotal_cents - discount_cents + total_tax_cents) / 100;
	// Fix #5: divide by taxable subtotal (matches backend), not full subtotal
	const effective_rate = taxable_subtotal_cents > 0 ? total_tax_cents / taxable_subtotal_cents : 0;

	return {
		subtotal,
		discount_amount,
		groups_summary,
		total_tax,
		total,
		effective_rate,
	};
}

// ─── Hook options / return ────────────────────────────────────────────────────

interface UseFinancialCalculationsOptions {
	initialTaxRate?: number;
	initialDiscountType?: DiscountType;
	initialDiscountValue?: number;
	/** Active TaxGroups for the org — used for multi-group calculation */
	taxGroups?: TaxGroup[];
	/** Line items with taxable / tax_group_id — used for multi-group calculation */
	lineItemsForCalc?: LineItemForCalc[];
	/** Whether the client is tax-exempt */
	clientExempt?: boolean;
	/** When provided, the hook bypasses all calculation and returns values from the snapshot */
	snapshot?: TaxSnapshot | null;
	/** How live tax is rounded; pick it with roundingFor(document.tax_snapshot). */
	rounding?: TaxRounding;
}

interface UseFinancialCalculationsReturn extends FinancialState {
	// ── Legacy single-rate API (kept for backward compat) ──────────────────────
	setTaxRate: (rate: number) => void;
	setDiscountType: (type: DiscountType) => void;
	setDiscountValue: (value: number) => void;
	reset: () => void;
	setOriginals: (taxRate: number, discountType: DiscountType, discountValue: number) => void;
	originalTaxRate: number;
	originalDiscountType: DiscountType;
	originalDiscountValue: number;
	isTaxDirty: boolean;
	isDiscountDirty: boolean;
	undoTax: () => void;
	undoDiscount: () => void;

	// ── Multi-group additions ──────────────────────────────────────────────────
	/** Per-group tax breakdown (empty when no groups or all items untaxed) */
	groupsSummary: GroupTaxSummary[];
	/** Total tax across all groups */
	totalTax: number;
	/** True when operating in snapshot mode (issued invoice) */
	isSnapshotMode: boolean;

	// ── Resolved values (multi-group-aware) ───────────────────────────────────
	/** 0 when tax groups active (groups own the rate), taxRate otherwise */
	resolvedTaxRate: number;
	/** totalTax when groups active, taxAmount otherwise */
	resolvedTaxAmount: number;
	/** Engine-accurate total: groups path uses integer-cent result, legacy uses computed total */
	resolvedTotal: number;
}

export const useFinancialCalculations = (
	subtotal: number,
	options: UseFinancialCalculationsOptions = {}
): UseFinancialCalculationsReturn => {
	const {
		initialTaxRate = 0,
		initialDiscountType = "amount",
		initialDiscountValue = 0,
		taxGroups = [],
		lineItemsForCalc = [],
		clientExempt = false,
		snapshot = null,
		rounding = "line_floor",
	} = options;

	const [taxRate, setTaxRateState] = useState<number>(initialTaxRate);
	const [discountType, setDiscountTypeState] = useState<DiscountType>(initialDiscountType);
	const [discountValue, setDiscountValueState] = useState<number>(initialDiscountValue);

	const [originalTaxRate, setOriginalTaxRate] = useState<number>(initialTaxRate);
	const [originalDiscountType, setOriginalDiscountType] =
		useState<DiscountType>(initialDiscountType);
	const [originalDiscountValue, setOriginalDiscountValue] =
		useState<number>(initialDiscountValue);

	const setTaxRate = useCallback((rate: number) => setTaxRateState(Number(rate)), []);
	const setDiscountType = useCallback((type: DiscountType) => setDiscountTypeState(type), []);
	const setDiscountValue = useCallback(
		(value: number) => setDiscountValueState(Number(value)),
		[]
	);

	const setOriginals = useCallback(
		(tr: number, dt: DiscountType, dv: number) => {
			const t = Number(tr);
			const v = Number(dv);
			setTaxRateState(t);
			setDiscountTypeState(dt);
			setDiscountValueState(v);
			setOriginalTaxRate(t);
			setOriginalDiscountType(dt);
			setOriginalDiscountValue(v);
		},
		[]
	);

	const isTaxDirty = useMemo(() => taxRate !== originalTaxRate, [taxRate, originalTaxRate]);

	const isDiscountDirty = useMemo(
		() =>
			discountType !== originalDiscountType ||
			discountValue !== originalDiscountValue,
		[discountType, discountValue, originalDiscountType, originalDiscountValue]
	);

	const undoTax = useCallback(() => setTaxRateState(originalTaxRate), [originalTaxRate]);

	const undoDiscount = useCallback(() => {
		setDiscountTypeState(originalDiscountType);
		setDiscountValueState(originalDiscountValue);
	}, [originalDiscountType, originalDiscountValue]);

	const reset = useCallback(() => {
		setTaxRateState(Number(initialTaxRate));
		setDiscountTypeState(initialDiscountType);
		setDiscountValueState(Number(initialDiscountValue));
	}, [initialTaxRate, initialDiscountType, initialDiscountValue]);

	// ── Snapshot mode: all values come from the locked snapshot ──────────────
	const isSnapshotMode = snapshot !== null;

	const snapshotResult = useMemo((): UseFinancialCalculationsReturn | null => {
		if (!snapshot) return null;
		const snap = snapshot;

		const snapDiscount = snap.discount_cents / 100;
		const snapTax = snap.total_tax_cents / 100;
		const snapTotal = snap.total_cents / 100;

		const snapGroups: GroupTaxSummary[] = snap.groups.map((sg) => ({
			group: {
				id: sg.id,
				organization_id: "",
				name: sg.name,
				description: null,
				is_default: false,
				is_active: true,
				// Reconstruct rates from snapshot for display
				rates: sg.rates.map((r, idx) => ({
					id: r.id,
					sort_order: idx,
					tax_rate: {
						id: r.id,
						organization_id: "",
						name: r.name,
						rate: r.rate,
						description: null,
						jurisdiction: r.jurisdiction ?? null,
						is_default: false,
						is_active: true,
						created_at: snap.locked_at,
						updated_at: snap.locked_at,
					},
				})),
				combined_rate: sg.rates.reduce((s, r) => s + r.rate, 0),
				created_at: snap.locked_at,
				updated_at: snap.locked_at,
			},
			taxable_amount: sg.taxable_amount_cents / 100,
			tax_amount: sg.tax_amount_cents / 100,
		}));

		return {
			// FinancialState (legacy)
			taxRate: snap.effective_rate * 100,
			taxAmount: snapTax,
			discountType: "amount" as DiscountType,
			discountValue: snapDiscount,
			discountAmount: snapDiscount,
			total: snapTotal,

			// Legacy setters (no-ops in snapshot mode)
			setTaxRate: () => {},
			setDiscountType: () => {},
			setDiscountValue: () => {},
			reset: () => {},
			setOriginals: () => {},
			originalTaxRate: snap.effective_rate * 100,
			originalDiscountType: "amount" as DiscountType,
			originalDiscountValue: snapDiscount,
			isTaxDirty: false,
			isDiscountDirty: false,
			undoTax: () => {},
			undoDiscount: () => {},

			// Multi-group
			groupsSummary: snapGroups,
			totalTax: snapTax,
			isSnapshotMode: true,

			// Resolved (snapshot: all values are already authoritative)
			resolvedTaxRate: snap.effective_rate * 100,
			resolvedTaxAmount: snapTax,
			resolvedTotal: snapTotal,

			// Suppressed — not used in snapshot mode, but subtotal prop is still needed
			// for the parent. Return the snapshot's subtotal via taxAmount/total chain.
			// (subtotal comes from the prop passed to the hook, not from here)
		};
	}, [snapshot]);

	// ── Multi-group live calculation ──────────────────────────────────────────
	const multiGroupResult = useMemo(
		() =>
			calculateMultiGroupTax(
				lineItemsForCalc,
				taxGroups,
				discountType,
				discountValue,
				clientExempt,
				rounding
			),
		[lineItemsForCalc, taxGroups, discountType, discountValue, clientExempt, rounding]
	);

	// ── Legacy single-rate fallback calculations ──────────────────────────────
	const taxAmount = useMemo(
		() => Number(subtotal) * (Number(taxRate) / 100),
		[subtotal, taxRate]
	);

	const discountAmount = useMemo(() => {
		const s = Number(subtotal);
		const v = Number(discountValue);
		return discountType === "percent" ? s * (v / 100) : v;
	}, [subtotal, discountType, discountValue]);

	const total = useMemo(
		() => Number(subtotal) + taxAmount - discountAmount,
		[subtotal, taxAmount, discountAmount]
	);

	// ── Return ────────────────────────────────────────────────────────────────
	if (isSnapshotMode && snapshotResult) {
		return snapshotResult;
	}

	// When taxGroups are provided, use multi-group results for the new fields
	// but keep legacy fields for backward compat with existing callers
	const hasMultiGroup = taxGroups.length > 0;

	const groupsSummary = hasMultiGroup ? multiGroupResult.groups_summary : [];
	const totalTax = hasMultiGroup ? multiGroupResult.total_tax : taxAmount;

	return {
		// ── Legacy FinancialState (unchanged for existing callers) ────────────
		taxRate,
		taxAmount,
		discountType,
		discountValue,
		discountAmount,
		total,

		// ── Legacy setters ────────────────────────────────────────────────────
		setTaxRate,
		setDiscountType,
		setDiscountValue,
		reset,
		setOriginals,
		originalTaxRate,
		originalDiscountType,
		originalDiscountValue,
		isTaxDirty,
		isDiscountDirty,
		undoTax,
		undoDiscount,

		// ── Multi-group additions ─────────────────────────────────────────────
		groupsSummary,
		totalTax,
		isSnapshotMode: false,

		// ── Resolved values (multi-group-aware) ───────────────────────────────
		resolvedTaxRate: hasMultiGroup ? 0 : (isNaN(taxRate) ? 0 : taxRate),
		resolvedTaxAmount: hasMultiGroup ? totalTax : (isNaN(taxAmount) ? 0 : taxAmount),
		resolvedTotal: hasMultiGroup ? multiGroupResult.total : (isNaN(total) ? 0 : total),
	};
};
