import { getScopedDb } from "../../lib/context.js";
import { log } from "../appLogger.js";
import { qbFetch } from "../quickbooksService.js";
import { parseQbFault } from "./qbFault.js";
import { findOrCreateQBItem } from "./qbItems.js";
import { qbQueryAll } from "./qbQuery.js";

export type TaxableItemRef = { id: string; name: string } | null;

export const TAXABLE_ITEM_NAME = "Taxable service (TradeWerks)";

const SERVICES_ITEM = { value: "1", name: "Services" } as const;

type TaxableItemReader = {
	organization: {
		findUnique(args: {
			where: { id: string };
			select: { qb_taxable_item_id: true; qb_taxable_item_realm_id: true };
		}): Promise<{
			qb_taxable_item_id: string | null;
			qb_taxable_item_realm_id: string | null;
		} | null>;
	};
};

export type ItemRefLine = {
	name?: string;
	taxable?: boolean | null;
	inventory_item?: {
		name?: string | null;
		external_mappings?: { external_id: string }[];
	} | null;
};

/**
 * The one ItemRef rule, shared by the push, the fingerprint recompute and the $0-tax block so
 * they cannot disagree. Under AST the item, not the line tax code, decides whether QuickBooks
 * taxes, and the generic "Services" item is non-taxable.
 */
export function qbLineItemRef(
	line: ItemRefLine,
	taxableItem: TaxableItemRef,
): { value: string; name: string } {
	const mapping = line.inventory_item?.external_mappings?.[0];
	if (mapping) {
		return {
			value: mapping.external_id,
			name: line.inventory_item?.name ?? line.name ?? SERVICES_ITEM.name,
		};
	}
	if (line.taxable !== false && taxableItem) {
		return { value: taxableItem.id, name: taxableItem.name };
	}
	return { ...SERVICES_ITEM };
}

/** DB only, so the fingerprint can be recomputed without QuickBooks. */
export async function loadTaxableItem(
	tx: TaxableItemReader,
	orgId: string,
	realmId: string,
): Promise<TaxableItemRef> {
	if (!realmId) return null;
	const org = await tx.organization.findUnique({
		where: { id: orgId },
		select: { qb_taxable_item_id: true, qb_taxable_item_realm_id: true },
	});
	// An id from a previously connected company would point at someone else's item.
	if (!org?.qb_taxable_item_id || org.qb_taxable_item_realm_id !== realmId) return null;
	return { id: org.qb_taxable_item_id, name: TAXABLE_ITEM_NAME };
}

export async function ensureTaxableItem(orgId: string, realmId: string): Promise<TaxableItemRef> {
	if (!realmId) return null;
	const sdb = getScopedDb(orgId);
	const stored = await loadTaxableItem(sdb, orgId, realmId);
	if (stored) return stored;
	// A rejected create must not fail the push: its lines fall back to "Services" and the
	// $0-tax gate still catches a shortfall.
	try {
		const id = await findOrCreateQBItem(orgId, TAXABLE_ITEM_NAME, undefined, true);
		await sdb.organization.update({
			where: { id: orgId },
			data: { qb_taxable_item_id: id, qb_taxable_item_realm_id: realmId },
		});
		return { id, name: TAXABLE_ITEM_NAME };
	} catch (err) {
		log.warn({ err, orgId }, "QuickBooks taxable stand-in item skipped");
		return null;
	}
}

// QuickBooks answers a reference to an inactive item with 610 ("Object Not Found ... made
// inactive") and to a missing one with 2500 ("Invalid Reference Id").
const ITEM_REF_FAULT_CODES = new Set(["610", "2500"]);

export function isItemRefFault(err: unknown): boolean {
	return parseQbFault(err).some((e) => ITEM_REF_FAULT_CODES.has(String(e?.code)));
}

/**
 * Re-resolves the stand-in after QuickBooks rejected the stored id. Returns null when the
 * stored item turns out to be fine (the fault was about some other reference), so the caller
 * does not retry a push that would fail the same way.
 */
async function reacquireTaxableItem(
	orgId: string,
	realmId: string,
	staleId: string,
): Promise<TaxableItemRef> {
	const sdb = getScopedDb(orgId);
	await sdb.organization.update({
		where: { id: orgId },
		data: { qb_taxable_item_id: null, qb_taxable_item_realm_id: null },
	});
	// A name query alone skips inactive items, and creating over one fails as a duplicate name.
	const [found] = await qbQueryAll<{ Id: string; SyncToken: string; Active?: boolean }>(
		orgId,
		"Item",
		`Name = '${TAXABLE_ITEM_NAME}' AND Active IN (true, false)`,
	);
	let id: string;
	let healed = true;
	if (found) {
		id = found.Id;
		if (found.Active === false) {
			await qbFetch(orgId, "POST", "/item", {
				Id: found.Id,
				SyncToken: found.SyncToken,
				sparse: true,
				Active: true,
			});
		} else if (found.Id === staleId) {
			healed = false;
		}
	} else {
		id = await findOrCreateQBItem(orgId, TAXABLE_ITEM_NAME, undefined, true);
	}
	await sdb.organization.update({
		where: { id: orgId },
		data: { qb_taxable_item_id: id, qb_taxable_item_realm_id: realmId },
	});
	return healed ? { id, name: TAXABLE_ITEM_NAME } : null;
}

export function linesUseItem(
	lines: { SalesItemLineDetail?: { ItemRef?: { value?: string } } }[],
	itemId: string,
): boolean {
	return lines.some((l) => l.SalesItemLineDetail?.ItemRef?.value === itemId);
}

/**
 * Runs a push that may reference the stored stand-in. If QuickBooks rejects a reference and
 * the payload used the stand-in, the stand-in is re-resolved and the push retried once. The
 * happy path makes no extra QuickBooks call.
 */
export async function withTaxableItemRecovery<T>(
	orgId: string,
	realmId: string,
	taxableItem: TaxableItemRef,
	usesItem: (item: NonNullable<TaxableItemRef>) => boolean,
	push: (item: TaxableItemRef) => Promise<T>,
): Promise<T> {
	try {
		return await push(taxableItem);
	} catch (err) {
		if (!taxableItem || !isItemRefFault(err) || !usesItem(taxableItem)) throw err;
		let fresh: TaxableItemRef = null;
		try {
			fresh = await reacquireTaxableItem(orgId, realmId, taxableItem.id);
		} catch (healErr) {
			log.warn(
				{ err: healErr, orgId },
				"QuickBooks taxable stand-in item could not be re-resolved",
			);
		}
		if (!fresh) throw err;
		log.info(
			{ orgId, staleId: taxableItem.id, id: fresh.id },
			"QuickBooks taxable stand-in re-resolved",
		);
		return push(fresh);
	}
}
