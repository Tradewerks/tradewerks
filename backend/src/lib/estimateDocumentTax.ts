import { db } from "../db.js";
import { calculateDocumentTax } from "../services/taxEngine.js";
import { keptRateRef, planDocumentTax, type KeptRateRef } from "./documentTaxPlan.js";
import { resolveLineItemTaxInputs, type DocumentLineItemRaw } from "./taxHelpers.js";

export type TaxEstimate =
	| {
			status: "estimate";
			subtotal_cents: number;
			tax_cents: number;
			total_cents: number;
			place: string;
	  }
	| { status: "exempt" }
	| { status: "unknown" };

export interface EstimateInput {
	organizationId: string;
	clientId: string;
	address: string | null;
	coords: unknown;
	lines: { total: number; taxable: boolean; tax_group_id: string | null }[];
	kept?: KeptRateRef | null;
}

const AUTO_SUFFIX = " (auto)";
const placeOf = (name: string) =>
	name.endsWith(AUTO_SUFFIX) ? name.slice(0, -AUTO_SUFFIX.length) : name;

/**
 * Preview of what one occurrence would be taxed at today, through the real engine. Cache-only
 * address lookups, so it never spends a lookup or writes a resolution.
 */
export async function estimateDocumentTax(i: EstimateInput): Promise<TaxEstimate> {
	const lines: DocumentLineItemRaw[] = i.lines.map((l, idx) => ({
		id: `line-${idx}`,
		total: l.total,
		taxable: l.taxable,
		tax_group_id: l.tax_group_id,
	}));

	return db.$transaction(async (tx) => {
		await tx.$executeRaw`SET TRANSACTION READ ONLY`;

		const plan = await planDocumentTax({
			organizationId: i.organizationId,
			clientId: i.clientId,
			lines,
			address: i.address,
			coords: i.coords,
			cacheOnly: true,
			kept: i.kept ?? null,
			tx,
		});
		if (plan.client?.is_tax_exempt) return { status: "exempt" };

		const { decision, needsDefault } = plan;
		if (needsDefault) {
			const addressRate =
				decision.source === "provider" || decision.source === "cached_stale";
			if (decision.source === null || (plan.mode === "auto" && !addressRate)) {
				return { status: "unknown" };
			}
		}

		const { inputs, clientExempt } = await resolveLineItemTaxInputs(
			lines,
			i.clientId,
			i.organizationId,
			tx,
			{ client: plan.client, defaultGroup: plan.defaultGroup },
		);
		const out = calculateDocumentTax(
			{ line_items: inputs, discount_type: null, discount_value: null },
			clientExempt,
			undefined,
			"jurisdiction_half_up",
		);

		// "" = no line is taxed by any group (nothing taxable), so there is no rate to name.
		const group = needsDefault
			? decision.group
			: (inputs.find((l) => l.taxable && l.total_cents !== 0 && l.tax_group)?.tax_group ??
				null);
		return {
			status: "estimate",
			subtotal_cents: out.subtotal_cents,
			tax_cents: out.total_tax_cents,
			total_cents: out.total_cents,
			place: group ? placeOf(group.name) : "",
		};
	});
}

/** The address rate a plan's container job carries; its manual-mode visits are taxed at it. */
export async function planKeptRate(
	organizationId: string,
	planId: string,
): Promise<{ found: false } | { found: true; kept: KeptRateRef | null }> {
	const plan = await db.recurring_plan.findFirst({
		where: { id: planId, organization_id: organizationId },
		select: {
			job_container: {
				select: { tax_snapshot: true, tax_needs_review: true, tax_resolution_id: true },
			},
		},
	});
	if (!plan) return { found: false };
	const job = plan.job_container;
	return {
		found: true,
		kept: job
			? keptRateRef(job.tax_snapshot, {
					tax_needs_review: job.tax_needs_review,
					tax_resolution_id: job.tax_resolution_id,
				})
			: null,
	};
}
