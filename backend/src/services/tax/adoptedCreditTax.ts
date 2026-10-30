import { roundHalfUpSymmetric } from "./rounding.js";

/**
 * An AST-adopted invoice bills QuickBooks' tax, so a credit against it unwinds QuickBooks' figure
 * in proportion to our estimate. The credit that closes the original out takes whatever is left,
 * so the chain nets to exactly -qb rather than drifting by the rounding of each partial credit.
 * Net credits only (adjTaxCents <= 0): a net charge is new billing that keeps our estimate.
 * A mixed adjustment that nets negative is scaled as a whole, charge lines included.
 */
export function scaleCreditTaxToAdopted(args: {
	adjTaxCents: number;
	origOursCents: number;
	origQbCents: number;
	priorAdjTaxCents: number;
	isFullCredit: boolean;
}): number {
	const { adjTaxCents, origOursCents, origQbCents, priorAdjTaxCents, isFullCredit } = args;
	// `+ 0` keeps a zero-tax close-out a plain zero rather than -0.
	if (isFullCredit) return -(origQbCents + priorAdjTaxCents) + 0;
	if (origOursCents === 0) return 0;
	return roundHalfUpSymmetric((adjTaxCents * origQbCents) / origOursCents);
}
