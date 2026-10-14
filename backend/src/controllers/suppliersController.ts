import { ZodError } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { logActivity, buildChanges } from "../services/logger.js";
import { collapseWhitespace, normalizeSupplierName } from "../services/suppliers.js";
import {
	listSuppliersQuerySchema,
	createSupplierSchema,
	updateSupplierSchema,
	mergeSupplierSchema,
} from "../lib/validate/suppliers.js";

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

const SUPPLIER_SELECT = {
	id: true,
	name: true,
	account_number: true,
	contact_name: true,
	phone: true,
	email: true,
	notes: true,
	is_active: true,
	created_at: true,
	updated_at: true,
} as const;

const EDITABLE_FIELDS = [
	"name",
	"account_number",
	"contact_name",
	"phone",
	"email",
	"notes",
	"is_active",
] as const;

/**
 * Single-vendor read for the detail page. Always carries the usage counts —
 * unlike the list, which only pays for them when explicitly asked — since the
 * detail page's whole point is "how much do we buy from this vendor".
 */
export const getSupplierDetail = async (supplierId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);

	const supplier = await sdb.supplier.findFirst({
		where: { id: supplierId, organization_id: organizationId },
		select: { ...SUPPLIER_SELECT, _count: { select: { movements: true, batches: true } } },
	});
	if (!supplier) return { err: "Supplier not found" as const };

	return { err: "", supplier };
};

const SUPPLIER_MOVEMENT_INCLUDE = {
	inventory_item: { select: { id: true, name: true, sku: true, unit: true } },
	from_vehicle: { select: { id: true, name: true } },
	to_vehicle: { select: { id: true, name: true } },
} as const;

/**
 * Cursor-paginated purchase ledger for one vendor, across every item it's
 * named on — the cross-item counterpart to getInventoryMovements, which walks
 * the same table filtered by item instead of supplier. Same cursor contract.
 */
export const getSupplierMovements = async (
	supplierId: string,
	organizationId: string,
	cursor?: string,
	limit = 25,
) => {
	const sdb = getScopedDb(organizationId);

	const existing = await sdb.supplier.findFirst({
		where: { id: supplierId, organization_id: organizationId },
		select: { id: true },
	});
	if (!existing) return { err: "Supplier not found" as const };

	const take = Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit) : 25, 1), 100);

	const movements = await sdb.stock_movement.findMany({
		where: { supplier_id: supplierId, organization_id: organizationId },
		include: SUPPLIER_MOVEMENT_INCLUDE,
		orderBy: [{ created_at: "desc" }, { id: "desc" }],
		take: take + 1,
		...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
	});

	const hasNext = movements.length > take;
	const page = hasNext ? movements.slice(0, take) : movements;
	const nextCursor = hasNext ? page[page.length - 1].id : null;

	return { err: "", movements: page, nextCursor };
};

/**
 * Every lot this vendor supplied, across every item — the entity-linked
 * counterpart to listItemBatches, which walks the same table filtered by item
 * instead of supplier.
 */
export const getSupplierBatches = async (supplierId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);

	const existing = await sdb.supplier.findFirst({
		where: { id: supplierId, organization_id: organizationId },
		select: { id: true },
	});
	if (!existing) return { err: "Supplier not found" as const };

	const batches = await sdb.stock_batch.findMany({
		where: { supplier_id: supplierId, organization_id: organizationId },
		include: { inventory_item: { select: { id: true, name: true, sku: true } } },
		orderBy: { received_at: "desc" },
	});

	const mapped = batches.map((b) => ({
		id: b.id,
		item_id: b.inventory_item_id,
		item_name: b.inventory_item.name,
		item_sku: b.inventory_item.sku,
		batch_number: b.batch_number,
		received_at: b.received_at.toISOString(),
		expires_at: b.expires_at ? b.expires_at.toISOString() : null,
		recalled_at: b.recalled_at ? b.recalled_at.toISOString() : null,
		qty_received: Number(b.qty_received),
		qty_in_warehouse: Number(b.qty_in_warehouse),
		unit_cost: b.unit_cost != null ? Number(b.unit_cost) : null,
	}));

	return { err: "", batches: mapped };
};

export const listSuppliers = async (organizationId: string, query: unknown) => {
	try {
		const parsed = listSuppliersQuerySchema.parse(query ?? {});
		const sdb = getScopedDb(organizationId);

		const suppliers = await sdb.supplier.findMany({
			where: {
				organization_id: organizationId,
				...(parsed.active === "all" ? {} : { is_active: parsed.active === "true" }),
				...(parsed.search
					? { name: { contains: parsed.search, mode: "insensitive" as const } }
					: {}),
			},
			select: {
				...SUPPLIER_SELECT,
				...(parsed.include_usage === "true"
					? { _count: { select: { movements: true, batches: true } } }
					: {}),
			},
			orderBy: { name: "asc" },
		});

		return { err: "", suppliers };
	} catch (e) {
		if (e instanceof ZodError) return { err: e.issues.map((i) => i.message).join(", ") };
		throw e;
	}
};

export const createSupplier = async (
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	// Declared outside the try so the catch block can use it to resolve a
	// concurrent-create race without re-parsing `data`.
	let name_key: string | undefined;
	try {
		const parsed = createSupplierSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const name = collapseWhitespace(parsed.name);
		name_key = normalizeSupplierName(parsed.name);

		// The existing row rides along with the conflict rather than being
		// swallowed: a picker that just typed a duplicate spelling should adopt
		// the vendor that already exists, and it can't do that from a string.
		const existing = await sdb.supplier.findFirst({
			where: { organization_id: organizationId, name_key },
			select: SUPPLIER_SELECT,
		});
		if (existing) {
			return {
				err: `A supplier named "${existing.name}" already exists`,
				conflict: true,
				supplier: existing,
			};
		}

		const supplier = await sdb.supplier.create({
			data: {
				organization_id: organizationId,
				name,
				name_key,
				account_number: parsed.account_number ?? null,
				contact_name: parsed.contact_name ?? null,
				phone: parsed.phone ?? null,
				email: parsed.email ?? null,
				notes: parsed.notes ?? null,
				is_active: parsed.is_active ?? true,
			},
			select: SUPPLIER_SELECT,
		});

		await logActivity({
			event_type: "supplier.created",
			action: "created",
			entity_type: "supplier",
			entity_id: supplier.id,
			organization_id: organizationId,
			...getActorInfo(context),
			changes: { name: { old: null, new: supplier.name } },
		});

		return { err: "", supplier };
	} catch (e) {
		if (e instanceof ZodError) return { err: e.issues.map((i) => i.message).join(", ") };
		// Two requests creating the same brand-new vendor name race on the
		// (organization_id, name_key) unique constraint; the loser gets the same
		// friendly conflict response as the pre-check above instead of a raw 500.
		if (name_key && e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
			const sdb = getScopedDb(organizationId);
			const existing = await sdb.supplier.findFirst({
				where: { organization_id: organizationId, name_key },
				select: SUPPLIER_SELECT,
			});
			if (existing) {
				return {
					err: `A supplier named "${existing.name}" already exists`,
					conflict: true,
					supplier: existing,
				};
			}
		}
		throw e;
	}
};

export const updateSupplier = async (
	supplierId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	// Declared outside the try so the catch block can resolve a concurrent
	// rename race without re-deriving it from `data`.
	let name_key: string | undefined;
	try {
		const parsed = updateSupplierSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const existing = await sdb.supplier.findFirst({
			where: { id: supplierId, organization_id: organizationId },
			select: SUPPLIER_SELECT,
		});
		if (!existing) return { err: "Supplier not found" };

		const name = parsed.name != null ? collapseWhitespace(parsed.name) : undefined;
		if (name != null) {
			name_key = normalizeSupplierName(name);
			const duplicate = await sdb.supplier.findFirst({
				where: { organization_id: organizationId, name_key, id: { not: supplierId } },
				select: SUPPLIER_SELECT,
			});
			if (duplicate) {
				return {
					err: `A supplier named "${duplicate.name}" already exists`,
					conflict: true,
					supplier: duplicate,
				};
			}
		}

		const deactivating = parsed.is_active === false && existing.is_active;

		const supplier = await sdb.$transaction(async (tx) => {
			const updated = await tx.supplier.update({
				where: { id: supplierId },
				data: {
					...(name != null ? { name, name_key: normalizeSupplierName(name) } : {}),
					...(parsed.account_number !== undefined
						? { account_number: parsed.account_number }
						: {}),
					...(parsed.contact_name !== undefined
						? { contact_name: parsed.contact_name }
						: {}),
					...(parsed.phone !== undefined ? { phone: parsed.phone } : {}),
					...(parsed.email !== undefined ? { email: parsed.email } : {}),
					...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
					...(parsed.is_active !== undefined ? { is_active: parsed.is_active } : {}),
				},
				select: SUPPLIER_SELECT,
			});

			// A deactivated supplier is filtered out of the reorder forecast
			// (attachPreferredVendors) but its supplier_item rows survive untouched —
			// without this, an is_preferred row for a now-inactive vendor keeps
			// showing as "Preferred" on the item detail page while the forecast
			// silently picks a different vendor (or none), the two views disagreeing
			// about who to buy from.
			if (deactivating) {
				await tx.supplier_item.updateMany({
					where: {
						organization_id: organizationId,
						supplier_id: supplierId,
						is_preferred: true,
					},
					data: { is_preferred: false },
				});
			}

			return updated;
		});

		const changes = buildChanges(existing, { ...parsed, name }, EDITABLE_FIELDS);
		if (Object.keys(changes).length > 0) {
			await logActivity({
				event_type: "supplier.updated",
				action: "updated",
				entity_type: "supplier",
				entity_id: supplierId,
				organization_id: organizationId,
				...getActorInfo(context),
				changes,
			});
		}

		return { err: "", supplier };
	} catch (e) {
		if (e instanceof ZodError) return { err: e.issues.map((i) => i.message).join(", ") };
		// Two requests renaming a supplier to the same new name race on the
		// (organization_id, name_key) unique constraint; surface the same
		// friendly conflict response as the pre-check above instead of a raw 500.
		if (name_key && e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
			const sdb = getScopedDb(organizationId);
			const duplicate = await sdb.supplier.findFirst({
				where: { organization_id: organizationId, name_key, id: { not: supplierId } },
				select: SUPPLIER_SELECT,
			});
			if (duplicate) {
				return {
					err: `A supplier named "${duplicate.name}" already exists`,
					conflict: true,
					supplier: duplicate,
				};
			}
		}
		throw e;
	}
};

/**
 * Folds one supplier into another: every movement and lot naming the source is
 * repointed at the target, then the source is deactivated rather than deleted so
 * the audit log still resolves.
 *
 * Not an optional nicety. The migration turns years of free-text vendor names
 * into entities, so typo-vendors ("Fergsuon") exist from day one with no other
 * way to reconcile them.
 */
export const mergeSuppliers = async (
	sourceId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = mergeSupplierSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		if (parsed.target_id === sourceId) {
			return { err: "Cannot merge a supplier into itself" };
		}

		const [source, target] = await Promise.all([
			sdb.supplier.findFirst({
				where: { id: sourceId, organization_id: organizationId },
				select: SUPPLIER_SELECT,
			}),
			sdb.supplier.findFirst({
				where: { id: parsed.target_id, organization_id: organizationId },
				select: SUPPLIER_SELECT,
			}),
		]);
		if (!source) return { err: "Supplier not found" };
		if (!target) return { err: "Target supplier not found" };
		if (!target.is_active) {
			// A retired target would bury the source's history behind a supplier
			// every picker and the reorder forecast already filter out
			// (`is_active: true`) — merging into it is never the intended action.
			return { err: "Cannot merge into a deactivated supplier" };
		}

		const moved = await sdb.$transaction(async (tx) => {
			const movements = await tx.stock_movement.updateMany({
				where: { organization_id: organizationId, supplier_id: sourceId },
				data: { supplier_id: target.id },
			});
			const batches = await tx.stock_batch.updateMany({
				where: { organization_id: organizationId, supplier_id: sourceId },
				data: { supplier_id: target.id },
			});

			// Price-list rows don't repoint as cleanly as movements/batches: the
			// target may already have its own (supplier_id, inventory_item_id) row
			// for an item the source also quotes, and the unique constraint forbids
			// two. Split into the clean case (bulk repoint) and the conflict case
			// (fold the source's data into the target's existing row, then drop the
			// source's row) so no supplier_item is silently orphaned behind the
			// now-deactivated source.
			const [sourceItems, targetItems] = await Promise.all([
				tx.supplier_item.findMany({ where: { supplier_id: sourceId } }),
				tx.supplier_item.findMany({ where: { supplier_id: target.id } }),
			]);
			const targetItemByInventoryId = new Map(
				targetItems.map((row) => [row.inventory_item_id, row]),
			);
			const conflictingInventoryIds = [...targetItemByInventoryId.keys()];

			const supplierItemsRepointed = await tx.supplier_item.updateMany({
				where: {
					supplier_id: sourceId,
					organization_id: organizationId,
					...(conflictingInventoryIds.length
						? { inventory_item_id: { notIn: conflictingInventoryIds } }
						: {}),
				},
				data: { supplier_id: target.id },
			});

			for (const sourceItem of sourceItems) {
				const targetItem = targetItemByInventoryId.get(sourceItem.inventory_item_id);
				if (!targetItem) continue; // already repointed above

				// Fold the source row's data into the target's before dropping it —
				// a target row that happened to exist first (e.g. auto-created by
				// recordMovements with no manual pricing yet) shouldn't silently win
				// over a source row that actually carries a negotiated price, vendor
				// SKU, or notes just because it's the one being kept.
				const fold: Record<string, unknown> = {};
				if (targetItem.contract_price == null && sourceItem.contract_price != null) {
					fold.contract_price = sourceItem.contract_price;
				}
				if (targetItem.vendor_sku == null && sourceItem.vendor_sku != null) {
					fold.vendor_sku = sourceItem.vendor_sku;
				}
				if (targetItem.notes == null && sourceItem.notes != null) {
					fold.notes = sourceItem.notes;
				}
				if (targetItem.lead_time_days == null && sourceItem.lead_time_days != null) {
					fold.lead_time_days = sourceItem.lead_time_days;
				}
				if (targetItem.min_order_qty == null && sourceItem.min_order_qty != null) {
					fold.min_order_qty = sourceItem.min_order_qty;
				}
				// last_price/last_purchased_at track whichever side observed the more
				// recent actual purchase, not just "target wins by default".
				if (
					sourceItem.last_purchased_at != null &&
					(targetItem.last_purchased_at == null ||
						sourceItem.last_purchased_at > targetItem.last_purchased_at)
				) {
					fold.last_price = sourceItem.last_price;
					fold.last_purchased_at = sourceItem.last_purchased_at;
				}

				if (sourceItem.is_preferred && !targetItem.is_preferred) {
					await tx.supplier_item.updateMany({
						where: {
							organization_id: organizationId,
							inventory_item_id: sourceItem.inventory_item_id,
							is_preferred: true,
						},
						data: { is_preferred: false },
					});
					fold.is_preferred = true;
				}

				if (Object.keys(fold).length > 0) {
					await tx.supplier_item.update({
						where: { id: targetItem.id },
						data: fold,
					});
				}
				await tx.supplier_item.delete({ where: { id: sourceItem.id } });
			}

			await tx.supplier.update({
				where: { id: sourceId },
				data: { is_active: false },
			});
			return {
				movements: movements.count,
				batches: batches.count,
				supplierItems: supplierItemsRepointed.count,
			};
		});

		await logActivity({
			event_type: "supplier.merged",
			action: "updated",
			entity_type: "supplier",
			entity_id: sourceId,
			organization_id: organizationId,
			...getActorInfo(context),
			reason: `Merged into ${target.name}`,
			changes: {
				merged_into: { old: null, new: target.id },
				movements_repointed: { old: null, new: moved.movements },
				batches_repointed: { old: null, new: moved.batches },
				supplier_items_repointed: { old: null, new: moved.supplierItems },
				is_active: { old: source.is_active, new: false },
			},
		});

		return { err: "", moved, target };
	} catch (e) {
		if (e instanceof ZodError) return { err: e.issues.map((i) => i.message).join(", ") };
		throw e;
	}
};
