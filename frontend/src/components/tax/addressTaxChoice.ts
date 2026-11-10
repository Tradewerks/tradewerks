import { isAxiosError } from "axios";
import type {
	AddressTaxChoice,
	AddressTaxChoiceDetails,
	TaxGroup,
	TaxSnapshot,
} from "../../types/tax";
import type { Coordinates } from "../../types/location";
import { autoEstimateTax, type AutoTaxEstimate } from "../../lib/taxEditorMode";
import type { TaxRounding } from "../../lib/taxRounding";

export type { AddressTaxChoice, AddressTaxChoiceDetails } from "../../types/tax";

export const isAddressTaxChoiceError = (err: unknown): boolean =>
	isAxiosError(err) && err.response?.data?.error?.code === "ADDRESS_TAX_CHOICE_REQUIRED";

export function addressTaxChoiceDetails(err: unknown): AddressTaxChoiceDetails | null {
	if (!isAddressTaxChoiceError(err) || !isAxiosError(err)) return null;
	const d = err.response?.data?.error?.details as Partial<AddressTaxChoiceDetails> | undefined;
	return {
		rate_label: d?.rate_label ?? "the address",
		rate: Number(d?.rate ?? 0),
		documents: d?.documents ?? [],
	};
}

/**
 * Mirrors the server's addressMoves: a new non-empty address, or a moved pin. An emptied address
 * is not sent as a change by these editors, so it is not one here either.
 */
export function addressMoved(
	geo: { address?: string; coords?: Coordinates } | undefined,
	doc: { address?: string | null; coords?: Coordinates | null },
): boolean {
	if (!geo?.address) return false;
	if (geo.address !== doc.address) return true;
	if (!geo.coords || geo.coords === doc.coords) return false;
	return geo.coords.lat !== doc.coords?.lat || geo.coords.lon !== doc.coords?.lon;
}

/** Only an unissued draft can be re-taxed, so only it asks. */
export const isDraftSnapshot = (snapshot: TaxSnapshot | null | undefined): boolean =>
	snapshot?.locked_at === "draft";

export function groupEstimate(group: TaxGroup, rounding: TaxRounding): AutoTaxEstimate {
	const rates = group.rates.map((r) => Number(r.tax_rate.rate));
	return {
		rate: rates.reduce((a, b) => a + b, 0),
		rates,
		place: group.name,
		rounding,
	};
}

const toCents = (dollars: number) => Math.round(dollars * 100);

export interface AddressChoiceEstimates {
	keepCents: number | null;
	defaultGroup: { id: string; name: string; rate: number } | null;
	defaultCents: number | null;
	groupCents: (groupId: string) => number | null;
	activeGroups: TaxGroup[];
}

/**
 * What each answer would tax the ungrouped taxable lines at: the kept rate, or a group's rates
 * on the same per-line bases and the document's rounding, as Save computes them.
 */
export function addressChoiceEstimates(args: {
	autoTaxableAmount: number;
	lineBasesCents: number[];
	keptEstimate: AutoTaxEstimate | null;
	rounding: TaxRounding;
	taxGroups: TaxGroup[];
}): AddressChoiceEstimates {
	const { autoTaxableAmount, lineBasesCents, keptEstimate, rounding } = args;
	const activeGroups = args.taxGroups.filter((g) => g.is_active);
	const cents = (e: AutoTaxEstimate) =>
		toCents(autoEstimateTax(autoTaxableAmount, e, lineBasesCents));
	const def = activeGroups.find((g) => g.is_default) ?? null;
	const defEstimate = def ? groupEstimate(def, rounding) : null;
	return {
		keepCents: keptEstimate ? cents(keptEstimate) : null,
		defaultGroup:
			def && defEstimate ? { id: def.id, name: def.name, rate: defEstimate.rate } : null,
		defaultCents: defEstimate ? cents(defEstimate) : null,
		groupCents: (groupId) => {
			const g = activeGroups.find((x) => x.id === groupId);
			return g ? cents(groupEstimate(g, rounding)) : null;
		},
		activeGroups,
	};
}

/**
 * A picked group lands on the ungrouped taxable lines server-side; the editor's line payload
 * must carry it too, or sending those lines with no group would undo the choice.
 */
export function lineGroupForChoice(
	choice: AddressTaxChoice | null,
	line: { taxable: boolean | undefined; tax_group_id: string | null },
): string | null {
	if (choice && typeof choice === "object" && line.taxable !== false && !line.tax_group_id) {
		return choice.group_id;
	}
	return line.tax_group_id;
}
