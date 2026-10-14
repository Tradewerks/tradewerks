import { ZodError } from "zod";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { logActivity } from "../services/logger.js";
import {
	listSupplierItemsQuerySchema,
	upsertSupplierItemSchema,
	updateSupplierItemSchema,
} from "../lib/validate/supplierItems.js";

function getActorInfo(context?: UserContext) {
	return {
		actor_type: context?.techId
			? "technician"
			: context?.dispatcherId
				? "dispatcher"
				: "system",
		actor_id: context?.techId || context?.dispatcherId,
		ip_address: context?.ipAddress,
		user_agent: context?.userAgent,
	};
}

const SUPPLIER_ITEM_SELECT = {
	id: true,
	supplier_id: true,
	inventory_item_id: true,
	vendor_sku: true,
	contract_price: true,
	last_price: true,
	last_purchased_at: true,
	is_preferred: true,
	lead_time_days: true,
	min_order_qty: true,
	notes: true,
	created_at: true,
	updated_at: true,
	supplier: { select: { id: true, name: true, is_active: true } },
	inventory_item: { select: { id: true, name: true, sku: true, unit: true } },
} as const;

type RawSupplierItem = {
	contract_price: unknown;
	last_price: unknown;
	min_order_qty: unknown;
	[key: string]: unknown;
};

// Prisma Decimal columns round-trip through JSON as strings (Decimal.toJSON()),
// which would silently violate the `number | null` contract the frontend types
// declare — matches the Number(...) conversion convention used for these same
// columns in reportsController.ts's attachPreferredVendors.
function serializeSupplierItem<T extends RawSupplierItem>(row: T) {
	return {
		...row,
		contract_price: row.contract_price != null ? Number(row.contract_price) : null,
		last_price: row.last_price != null ? Number(row.last_price) : null,
		min_order_qty: row.min_order_qty != null ? Number(row.min_order_qty) : null,
	};
}

/**
 * Exactly one preferred vendor per item. Cleared inside the caller's transaction
 * rather than after it, so a crash between the two writes can't leave an item with
 * two preferred vendors — which the forecast would then pick between arbitrarily.
 */
async function clearOtherPreferred(
	tx: { supplier_item: { updateMany: (args: unknown) => Promise<unknown> } },
	organizationId: string,
	inventoryItemId: string,
	keepId?: string,
) {
	await tx.supplier_item.updateMany({
		where: {
			organization_id: organizationId,
			inventory_item_id: inventoryItemId,
			is_preferred: true,
			...(keepId ? { id: { not: keepId } } : {}),
		},
		data: { is_preferred: false },
	});
}

export const listSupplierItems = async (organizationId: string, query: unknown) => {
	try {
		const parsed = listSupplierItemsQuerySchema.parse(query ?? {});
		const sdb = getScopedDb(organizationId);

		const rows = await sdb.supplier_item.findMany({
			where: {
				organization_id: organizationId,
				...(parsed.supplier_id ? { supplier_id: parsed.supplier_id } : {}),
				...(parsed.inventory_item_id
					? { inventory_item_id: parsed.inventory_item_id }
					: {}),
			},
			select: SUPPLIER_ITEM_SELECT,
			// Preferred first, then most recently bought from — the two orderings
			// anyone scanning this list is actually asking about. Explicit
			// nulls:"last" because Postgres defaults NULLS FIRST on desc, which
			// would otherwise rank a never-purchased (contract-only) row above one
			// with a real recent purchase date.
			orderBy: [
				{ is_preferred: "desc" },
				{ last_purchased_at: { sort: "desc", nulls: "last" } },
			],
		});

		return { err: "", supplierItems: rows.map(serializeSupplierItem) };
	} catch (e) {
		if (e instanceof ZodError) return { err: e.issues.map((i) => i.message).join(", ") };
		throw e;
	}
};

/**
 * Create or update the row for one (vendor, item) pair.
 *
 * Upsert rather than create: the pair is unique, and a price-list entry is a fact
 * about a relationship that either exists or doesn't. Making the caller discover
 * which one it is first would only invite a race.
 */
export const upsertSupplierItem = async (
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = upsertSupplierItemSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const [supplier, item] = await Promise.all([
			sdb.supplier.findFirst({
				where: { id: parsed.supplier_id, organization_id: organizationId },
				select: { id: true, name: true },
			}),
			sdb.inventory_item.findFirst({
				where: { id: parsed.inventory_item_id, organization_id: organizationId },
				select: { id: true, name: true },
			}),
		]);
		if (!supplier) return { err: "Supplier not found" };
		if (!item) return { err: "Inventory item not found" };

		const editable = {
			...(parsed.vendor_sku !== undefined ? { vendor_sku: parsed.vendor_sku } : {}),
			...(parsed.contract_price !== undefined
				? { contract_price: parsed.contract_price }
				: {}),
			...(parsed.lead_time_days !== undefined
				? { lead_time_days: parsed.lead_time_days }
				: {}),
			...(parsed.min_order_qty !== undefined ? { min_order_qty: parsed.min_order_qty } : {}),
			...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
			...(parsed.is_preferred !== undefined ? { is_preferred: parsed.is_preferred } : {}),
		};

		const supplierItem = await sdb.$transaction(async (tx) => {
			// Clear before writing the new preferred flag, not after: the unique
			// index is checked per-statement, not at commit, so setting this row
			// preferred while another still holds the flag raises P2002 immediately.
			if (parsed.is_preferred) {
				const existing = await tx.supplier_item.findUnique({
					where: {
						supplier_id_inventory_item_id: {
							supplier_id: parsed.supplier_id,
							inventory_item_id: parsed.inventory_item_id,
						},
					},
					select: { id: true },
				});
				await clearOtherPreferred(
					tx as never,
					organizationId,
					parsed.inventory_item_id,
					existing?.id,
				);
			}

			return tx.supplier_item.upsert({
				where: {
					supplier_id_inventory_item_id: {
						supplier_id: parsed.supplier_id,
						inventory_item_id: parsed.inventory_item_id,
					},
				},
				create: {
					organization_id: organizationId,
					supplier_id: parsed.supplier_id,
					inventory_item_id: parsed.inventory_item_id,
					...editable,
				},
				update: editable,
				select: SUPPLIER_ITEM_SELECT,
			});
		});

		await logActivity({
			event_type: "supplier_item.saved",
			action: "updated",
			entity_type: "supplier_item",
			entity_id: supplierItem.id,
			organization_id: organizationId,
			...getActorInfo(context),
			reason: `${supplier.name} → ${item.name}`,
		});

		return { err: "", supplierItem: serializeSupplierItem(supplierItem) };
	} catch (e) {
		if (e instanceof ZodError) return { err: e.issues.map((i) => i.message).join(", ") };
		throw e;
	}
};

export const updateSupplierItem = async (
	supplierItemId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updateSupplierItemSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const existing = await sdb.supplier_item.findFirst({
			where: { id: supplierItemId, organization_id: organizationId },
			select: { id: true, inventory_item_id: true },
		});
		if (!existing) return { err: "Supplier item not found" };

		const supplierItem = await sdb.$transaction(async (tx) => {
			if (parsed.is_preferred) {
				await clearOtherPreferred(
					tx as never,
					organizationId,
					existing.inventory_item_id,
					existing.id,
				);
			}
			return tx.supplier_item.update({
				where: { id: supplierItemId },
				data: parsed,
				select: SUPPLIER_ITEM_SELECT,
			});
		});

		await logActivity({
			event_type: "supplier_item.updated",
			action: "updated",
			entity_type: "supplier_item",
			entity_id: supplierItemId,
			organization_id: organizationId,
			...getActorInfo(context),
		});

		return { err: "", supplierItem: serializeSupplierItem(supplierItem) };
	} catch (e) {
		if (e instanceof ZodError) return { err: e.issues.map((i) => i.message).join(", ") };
		throw e;
	}
};

/**
 * Make this vendor the one the forecast names for its item.
 *
 * Its own endpoint because it's the common single-click action, and because doing
 * it through the generic update would make "prefer this one" indistinguishable
 * from an ordinary edit in the activity log.
 */
export const setPreferredSupplierItem = async (
	supplierItemId: string,
	organizationId: string,
	context?: UserContext,
) => {
	const sdb = getScopedDb(organizationId);

	const existing = await sdb.supplier_item.findFirst({
		where: { id: supplierItemId, organization_id: organizationId },
		select: { id: true, inventory_item_id: true },
	});
	if (!existing) return { err: "Supplier item not found" };

	const supplierItem = await sdb.$transaction(async (tx) => {
		await clearOtherPreferred(
			tx as never,
			organizationId,
			existing.inventory_item_id,
			supplierItemId,
		);
		return tx.supplier_item.update({
			where: { id: supplierItemId },
			data: { is_preferred: true },
			select: SUPPLIER_ITEM_SELECT,
		});
	});

	await logActivity({
		event_type: "supplier_item.preferred",
		action: "updated",
		entity_type: "supplier_item",
		entity_id: supplierItemId,
		organization_id: organizationId,
		...getActorInfo(context),
	});

	return { err: "", supplierItem: serializeSupplierItem(supplierItem) };
};

export const deleteSupplierItem = async (
	supplierItemId: string,
	organizationId: string,
	context?: UserContext,
) => {
	const sdb = getScopedDb(organizationId);

	const existing = await sdb.supplier_item.findFirst({
		where: { id: supplierItemId, organization_id: organizationId },
		select: { id: true },
	});
	if (!existing) return { err: "Supplier item not found" };

	// Hard delete, unlike suppliers themselves: this row is a price quote, not
	// history. The purchases that produced last_price stay in the ledger.
	await sdb.supplier_item.delete({ where: { id: supplierItemId } });

	await logActivity({
		event_type: "supplier_item.deleted",
		action: "deleted",
		entity_type: "supplier_item",
		entity_id: supplierItemId,
		organization_id: organizationId,
		...getActorInfo(context),
	});

	return { err: "", id: supplierItemId };
};
