import { Prisma } from "../../generated/prisma/client.js";
import { mapPrismaTaxGroup, type TaxGroupConfig } from "../services/taxEngine.js";
import { decideDefaultTax, type DefaultTaxDecision } from "../services/tax/precedence.js";
import { log } from "../services/appLogger.js";
import { readTaxSnapshot } from "../services/tax/snapshot.js";
import { getOrgTaxContext, type TaxMode } from "../services/tax/taxMode.js";
import {
	loadRateSet,
	resolveAddressTax,
	type AddressOutcome,
} from "../services/tax/taxResolver.js";
import { TAX_GROUP_WITH_RATES_INCLUDE, type DocumentLineItemRaw } from "./taxHelpers.js";

export { shouldResetAck } from "../services/tax/precedence.js";

export const LOCK_REFRESH_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PlanInput {
	organizationId: string;
	clientId: string;
	lines: DocumentLineItemRaw[];
	address: string | null;
	coords: unknown;
	lockedAt?: Date;
	adjustsInvoiceId?: string | null;
	/** Job visits: answer from the resolution cache only (see ResolveAddressArgs.cacheOnly). */
	cacheOnly?: boolean;
	/** The address rate this document already carries; reused in manual mode only. */
	kept?: KeptRateRef | null;
	tx: Prisma.TransactionClient;
}

export interface DocumentTaxPlan {
	/** Null when the org context was not needed (nothing could take a default group). */
	mode: TaxMode | null;
	client: { is_tax_exempt: boolean; tax_group_id: string | null } | null;
	/** Stored manual mode writes the resolved default group onto the line, as it always has. */
	stampDefaults: boolean;
	/** Applied to lines with no group of their own when the client has none. */
	defaultGroup: TaxGroupConfig | null;
	decision: DefaultTaxDecision;
	/** Some taxable, non-zero line is taxed by the default (no line group, no client group, not exempt). */
	needsDefault: boolean;
}

export interface KeptRateRef {
	rate_set_id: string;
	source: "provider" | "cached_stale";
	needs_review: boolean;
	review_reason: string | null;
	resolution_id: string | null;
	sourcing: "O" | "D" | null;
}

/** v2 + rate_set_id + source provider | cached_stale | qb_ast (qb_ast reads as provider). */
export function keptRateRef(
	snapshot: unknown,
	prev: { tax_needs_review: boolean; tax_resolution_id: string | null } | null
): KeptRateRef | null {
	const snap = readTaxSnapshot(snapshot);
	if (snap?.version !== 2 || !snap.rate_set_id) return null;
	if (snap.source !== "provider" && snap.source !== "cached_stale" && snap.source !== "qb_ast") {
		return null;
	}
	const source = snap.source === "cached_stale" ? "cached_stale" : "provider";
	// A QuickBooks review owns the reason and the row's flag; recompute carries that review itself,
	// so neither describes the rate.
	const qbReview = snap.qb_review === true;
	const review_reason = qbReview ? null : (snap.review_reason ?? null);
	const derived = review_reason != null || source === "cached_stale";
	return {
		rate_set_id: snap.rate_set_id,
		source,
		needs_review: qbReview ? derived : (prev?.tax_needs_review ?? derived),
		review_reason,
		resolution_id: prev?.tax_resolution_id ?? null,
		sourcing: snap.sourcing ?? null,
	};
}

const NOT_INHERITED = "Original invoice's rate could not be inherited";
const KEPT_UNAVAILABLE = "The kept address rate is no longer available";
const LOOKUP_FAILED = "Tax rate lookup failed";
const INHERITED_STALE = "Original invoice used a stale rate";

/** Saving or issuing a document must never fail because the rate lookup did. */
async function lookUpAddress(i: PlanInput): Promise<AddressOutcome> {
	try {
		return await resolveAddressTax({
			orgId: i.organizationId,
			address: i.address,
			coords: i.coords,
			maxAgeMs: i.lockedAt ? LOCK_REFRESH_AGE_MS : undefined,
			...(i.cacheOnly ? { cacheOnly: true } : {}),
		});
	} catch (err) {
		log.error(
			{ err, orgId: i.organizationId },
			"tax address resolution threw; falling back"
		);
		return {
			kind: "none",
			ambiguous: false,
			resolution_id: null,
			reasons: [LOOKUP_FAILED],
		};
	}
}

/** A credit refunds tax at the rate it was charged, not at whatever the address resolves to today. */
async function inheritedOutcome(
	tx: Prisma.TransactionClient,
	organizationId: string,
	originalInvoiceId: string
): Promise<AddressOutcome | null> {
	const original = await tx.invoice.findFirst({
		where: { id: originalInvoiceId, organization_id: organizationId },
		select: { tax_snapshot: true, tax_resolution_id: true },
	});
	const snap = readTaxSnapshot(original?.tax_snapshot);
	if (snap?.version !== 2 || !snap.rate_set_id) return null;
	const rateSet = await loadRateSet(snap.rate_set_id);
	if (!rateSet) return null;
	const stale = snap.source === "cached_stale";
	return {
		kind: "rate",
		stale,
		resolution_id: original?.tax_resolution_id ?? null,
		rate_set: rateSet,
		sourcing: snap.sourcing ?? null,
		reasons: stale ? [INHERITED_STALE] : [],
	};
}

const withReasons = (d: DefaultTaxDecision, reasons: string[]): DefaultTaxDecision =>
	reasons.length === 0
		? d
		: {
				...d,
				needs_review: true,
				review_reason: [d.review_reason, ...reasons].filter(Boolean).join("; "),
			};

export async function planDocumentTax(i: PlanInput): Promise<DocumentTaxPlan> {
	const client = await i.tx.client.findFirst({
		where: { id: i.clientId, organization_id: i.organizationId },
		select: { is_tax_exempt: true, tax_group_id: true },
	});
	const clientExempt = client?.is_tax_exempt ?? false;
	const clientHasGroup = !!client?.tax_group_id;

	// Org context is only needed when some line could take a default group; skipping it
	// otherwise keeps exempt documents on exactly today's query set.
	const anyUngrouped = !clientExempt && i.lines.some((l) => !l.tax_group_id);
	const org = anyUngrouped ? await getOrgTaxContext(i.organizationId) : null;
	const mode: TaxMode | null = org?.mode ?? null;

	let outcome: AddressOutcome | null = null;
	let inheritanceFailed = false;
	const resolve = async () => {
		const inherited = i.adjustsInvoiceId
			? await inheritedOutcome(i.tx, i.organizationId, i.adjustsInvoiceId)
			: null;
		inheritanceFailed = !!i.adjustsInvoiceId && !inherited;
		outcome = inherited ?? (await lookUpAddress(i));
	};

	const { lines } = i;
	const explicitTaxableLine = lines.some((l) => l.taxable && l.tax_group_id);
	const needsDefault =
		!clientExempt &&
		!clientHasGroup &&
		lines.some((l) => l.taxable && !l.tax_group_id && l.total !== 0);

	// Manual mode keeps today's rule: any ungrouped line (non-taxable or zero-total included)
	// fetches the org default and gets it stamped, unless a kept address rate taxes it (see
	// stampDefaults). Auto mode needs it only as a fallback.
	const wantsOrgDefault =
		anyUngrouped && !clientHasGroup && (mode !== "auto" || needsDefault);
	const orgDefaultRow = wantsOrgDefault
		? await i.tx.tax_group.findFirst({
				where: {
					organization_id: i.organizationId,
					is_default: true,
					is_active: true,
				},
				include: TAX_GROUP_WITH_RATES_INCLUDE,
			})
		: null;
	const orgDefault = orgDefaultRow ? mapPrismaTaxGroup(orgDefaultRow) : null;

	if (org && mode === "auto" && needsDefault) await resolve();

	const keptSet =
		mode === "manual" && needsDefault && i.kept ? await loadRateSet(i.kept.rate_set_id) : null;
	const keptLost = mode === "manual" && needsDefault && !!i.kept && !keptSet;

	const decided = decideDefaultTax({
		mode: mode ?? "manual",
		clientExempt,
		clientHasGroup,
		explicitTaxableLine,
		needsDefault,
		outcome,
		orgDefault,
		legacyRate: org?.legacy_rate ?? 0,
		registeredStates: org?.registered_states ?? [],
		kept: keptSet && i.kept ? { ...i.kept, rate_set: keptSet } : null,
	});
	// The fresh lookup is a best guess at a rate the original may never have charged.
	const decision = withReasons(decided, [
		...(inheritanceFailed && needsDefault ? [NOT_INHERITED] : []),
		...(keptLost ? [KEPT_UNAVAILABLE] : []),
	]);

	return {
		mode,
		client: client ?? null,
		// Keyed on the stored mode: an auto org that lost tax_auto (downgrade, entitlement outage)
		// is taxed at the default but not stamped, or the line would read as manual_override later.
		// A kept rate is not a dispatcher's pick either, and is not a tax_group.
		stampDefaults: org?.stored_mode !== "auto" && !decision.kept_from_auto,
		defaultGroup: mode === "auto" || decision.kept_from_auto ? decision.group : orgDefault,
		decision,
		needsDefault,
	};
}
