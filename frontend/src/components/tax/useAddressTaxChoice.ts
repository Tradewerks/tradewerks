import { useCallback, useMemo, useState } from "react";
import type {
	AddressTaxChoice,
	AddressTaxChoiceDetails,
	TaxGroup,
	TaxSnapshot,
} from "../../types/tax";
import type { Coordinates } from "../../types/location";
import type { DiscountType } from "../../types/common";
import {
	calculateMultiGroupTax,
	type LineItemForCalc,
} from "../../hooks/forms/useFinancialCalculations";
import {
	autoTaxableAmount,
	autoTaxableLineCents,
	type AutoTaxEstimate,
} from "../../lib/taxEditorMode";
import type { TaxRounding } from "../../lib/taxRounding";
import {
	addressChoiceEstimates,
	addressMoved,
	addressTaxChoiceDetails,
	isDraftSnapshot,
	lineGroupForChoice,
} from "./addressTaxChoice";

interface Args {
	docNoun: "quote" | "job";
	snapshot: TaxSnapshot | null | undefined;
	keptEstimate: AutoTaxEstimate | null;
	geo: { address?: string; coords?: Coordinates } | undefined;
	doc: { address?: string | null; coords?: Coordinates | null };
	lines: LineItemForCalc[];
	discountAmount: number;
	discountType: DiscountType;
	discountValue: number;
	taxGroups: TaxGroup[];
	rounding: TaxRounding;
}

/** The quote/job editor side of the address-change prompt (spec §1). */
export function useAddressTaxChoice(args: Args) {
	const { snapshot, keptEstimate, geo, doc, lines, discountAmount, taxGroups } = args;
	const { discountType, discountValue } = args;
	const [choice, setChoice] = useState<AddressTaxChoice | null>(null);
	// A server refusal the local check missed (e.g. a rate the job inherits from its quote).
	const [refusal, setRefusal] = useState<AddressTaxChoiceDetails | null>(null);

	const moved = addressMoved(geo, doc);
	const ask = (moved && keptEstimate != null && isDraftSnapshot(snapshot)) || refusal != null;

	const rounding = keptEstimate?.rounding ?? args.rounding;
	const estimates = useMemo(
		() =>
			addressChoiceEstimates({
				autoTaxableAmount: autoTaxableAmount(lines, discountAmount),
				lineBasesCents: autoTaxableLineCents(lines, discountAmount),
				keptEstimate,
				rounding,
				taxGroups,
			}),
		[lines, discountAmount, keptEstimate, rounding, taxGroups],
	);

	/** Any address edit invalidates an earlier answer. */
	const onAddressChange = useCallback(() => {
		setChoice(null);
		setRefusal(null);
	}, []);

	const sent = ask ? choice : null;

	const chosenGroup =
		sent === "default"
			? estimates.defaultGroup
			: sent != null && typeof sent === "object"
				? (estimates.activeGroups.find((x) => x.id === sent.group_id) ?? null)
				: null;
	const chosenGroupId = chosenGroup?.id ?? null;
	// The server puts the ungrouped taxable lines into the chosen group and rounds that group as
	// a whole, lines already in it included; the summary shows those lines' tax separately, so the
	// choice adds only what the merge adds.
	const chosenCents = useMemo(() => {
		if (!chosenGroupId) return null;
		const taxCents = (ls: LineItemForCalc[]) =>
			Math.round(
				calculateMultiGroupTax(ls, taxGroups, discountType, discountValue, false, rounding)
					.total_tax * 100,
			);
		const merged = lines.map((l) =>
			l.taxable && !l.tax_group_id ? { ...l, tax_group_id: chosenGroupId } : l,
		);
		return taxCents(merged) - taxCents(lines);
	}, [chosenGroupId, lines, taxGroups, discountType, discountValue, rounding]);

	/** FinancialSummary's `chosenTax`: Keep falls through to the existing kept row. */
	let summaryChoice: { label: string; cents: number } | "pending" | null = null;
	if (ask && choice == null) summaryChoice = "pending";
	else if (chosenGroup) summaryChoice = { label: chosenGroup.name, cents: chosenCents ?? 0 };

	return {
		ask,
		canSubmit: !ask || choice != null,
		/** The address still reads as moved for the summary unless the answer keeps the rate. */
		addressChangedForSummary: moved && choice !== "keep",
		payloadChoice: sent ?? undefined,
		summaryChoice,
		lineGroup: (line: { taxable: boolean | undefined; tax_group_id: string | null }) =>
			lineGroupForChoice(sent, line),
		/** True when the error was the refusal; the panel then carries it, no banner needed. */
		handleError: (err: unknown): boolean => {
			const details = addressTaxChoiceDetails(err);
			if (!details) return false;
			setRefusal(details);
			setChoice(null);
			return true;
		},
		reset: onAddressChange,
		onAddressChange,
		panelProps: {
			docNoun: args.docNoun,
			rateLabel: refusal?.rate_label ?? keptEstimate?.place ?? "",
			rate: refusal?.rate ?? keptEstimate?.rate ?? 0,
			newAddress: geo?.address ?? "",
			keepCents: estimates.keepCents,
			defaultGroup: estimates.defaultGroup,
			defaultCents: estimates.defaultCents,
			groupCents: estimates.groupCents,
			taxGroups: estimates.activeGroups,
			value: choice,
			onChange: setChoice,
		},
	};
}
