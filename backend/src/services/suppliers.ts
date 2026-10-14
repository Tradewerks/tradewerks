import { Prisma } from "../../generated/prisma/client.js";

type TransactionClient = Prisma.TransactionClient;

/** Matches the legacy free-text stock_batch.supplier column this supersedes. */
export const SUPPLIER_NAME_MAX = 200;

export class SupplierValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SupplierValidationError";
	}
}

/** Trims and collapses inner whitespace runs. Case preserved — this is display text. */
export function collapseWhitespace(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

/**
 * The dedupe key. Case + whitespace only, deliberately NOT fuzzy: "Ferguson"
 * and "Ferguson Plumbing" are different companies billing different prices, so
 * folding them together would corrupt every per-supplier cost figure the price
 * history exists to report. Near-misses are resolved by hand via the merge
 * endpoint instead.
 */
export function normalizeSupplierName(name: string): string {
	return collapseWhitespace(name).toLowerCase();
}

export interface SupplierRef {
	supplier_id?: string | null;
	supplier_name?: string | null;
}

export type VendorPriceSource = "contract" | "observed" | "none";

/**
 * A negotiated `contract_price` beats an observed `last_price`: a contract is
 * what you WILL pay, an observation is what you happened to pay. Shared by the
 * reorder forecast (attachPreferredVendors) and the item's own cost-history
 * rollup so the two never disagree about which vendor price is authoritative.
 */
export function resolveVendorPrice(
	contractPrice: Prisma.Decimal | number | null | undefined,
	lastPrice: Prisma.Decimal | number | null | undefined,
): { price: number | null; priceSource: VendorPriceSource } {
	const contract = contractPrice != null ? Number(contractPrice) : null;
	const observed = lastPrice != null ? Number(lastPrice) : null;
	return {
		price: contract ?? observed,
		priceSource: contract != null ? "contract" : observed != null ? "observed" : "none",
	};
}

/**
 * Resolves an intake path's supplier input to an entity, creating one when the
 * caller typed a name that doesn't exist yet. Runs inside the caller's
 * transaction (never opens its own) so the supplier, the lot and the movement
 * either all land or none do.
 *
 * Returns null when no supplier was stated — capture is optional on every
 * intake path, and a blocked receive over missing vendor metadata is worse than
 * an unattributed one.
 */
export async function resolveSupplier(
	tx: TransactionClient,
	organizationId: string,
	input: SupplierRef | null | undefined,
): Promise<{ id: string; name: string } | null> {
	if (!input) return null;

	if (input.supplier_id) {
		const existing = await tx.supplier.findFirst({
			where: { id: input.supplier_id, organization_id: organizationId },
			select: { id: true, name: true },
		});
		// The org filter is explicit because this runs on a raw transaction
		// client, not the scoped db — without it a cross-org id would resolve.
		if (!existing) throw new SupplierValidationError("Supplier not found");
		return existing;
	}

	const name = collapseWhitespace(input.supplier_name ?? "");
	if (!name) return null;
	if (name.length > SUPPLIER_NAME_MAX) {
		throw new SupplierValidationError(
			`Supplier name must be ${SUPPLIER_NAME_MAX} characters or fewer`,
		);
	}

	const name_key = normalizeSupplierName(name);
	const found = await tx.supplier.findFirst({
		where: { organization_id: organizationId, name_key },
		select: { id: true, name: true },
	});
	if (found) return found;

	// Find-then-create, same as getOrCreateBatch: two concurrent receives naming
	// a brand-new vendor race on the (organization_id, name_key) unique index.
	// The loser re-resolves to the winner's row instead of surfacing a raw DB
	// conflict on an otherwise-successful receive/adjust.
	try {
		return await tx.supplier.create({
			data: { organization_id: organizationId, name, name_key },
			select: { id: true, name: true },
		});
	} catch (e) {
		if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
			const winner = await tx.supplier.findFirst({
				where: { organization_id: organizationId, name_key },
				select: { id: true, name: true },
			});
			if (winner) return winner;
		}
		throw e;
	}
}
