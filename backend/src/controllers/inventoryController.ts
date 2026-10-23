import { isModuleOn } from "../services/entitlementService.js";
import * as XLSX from "xlsx";
import { z, ZodError } from "zod";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { db } from "../db.js";
import {
	Prisma,
	type field_purchase_status,
	type inventory_item_origin,
	type line_item_disposition,
	type stock_location_type,
} from "../../generated/prisma/client.js";
import {
	updateThresholdSchema,
	createInventoryItemSchema,
	updateInventoryItemSchema,
	adjustStockSchema,
	usageQuerySchema,
	consumptionTrendQuerySchema,
	valueHistoryQuerySchema,
	priceHistoryQuerySchema,
	movementsQuerySchema,
	locationField,
	type TrendBucket,
} from "../lib/validate/inventory.js";
import { isStorableStockQty, STOCK_QTY_MESSAGE } from "../lib/validate/shared.js";
import { getItemReorderForecast } from "./reportsController.js";
import {
	receiveInventorySchema,
	listSerialsQuerySchema,
	listBatchesQuerySchema,
	toggleTrackingSchema,
	updateBatchSchema,
	updateSerialSchema,
} from "../lib/validate/inventoryTracking.js";
import { logActivity, buildChanges } from "../services/logger.js";
import { log } from "../services/appLogger.js";
import { sendLowStockAlert } from "../services/lowStockAlerts.js";
import {
	recordMovements,
	InsufficientStockError,
	getOrCreateBatch,
	InsufficientBatchStockError,
	TrackingValidationError,
	lockInventoryRows,
	type ActorInfo,
	type MovementInput,
} from "../services/stockMovements.js";
import {
	shortCode,
	buildTrackingInputs,
	TrackingValidationError as RealTrackingValidationError,
	lockBatchRows,
	lockSerialRows,
	type ItemTrackingFlags,
} from "../services/inventoryTracking.js";
import {
	resolveSupplier,
	SupplierValidationError,
	normalizeSupplierName,
	resolveVendorPrice,
} from "../services/suppliers.js";
import {
	withStockStatus,
	unitBasis,
	mergeUnitBases,
	CONSUMPTION_MOVEMENT_PREDICATE,
	CONSUMPTION_SIGNED_QTY,
	type StockQty,
} from "../lib/inventory.js";
import { DEFAULT_UNIT_CODE, normalizeUnitCode } from "../lib/units.js";
import { emitInventoryUpdated } from "../services/socketService.js";

function zodMessage(e: ZodError): string {
	return `Validation failed: ${e.issues.map((i) => i.message).join(", ")}`;
}

/** Parses input via safeParse so a validation failure is a typed `{ err }` result, not a thrown exception. */
function parseInput<S extends z.ZodType>(
	schema: S,
	input: unknown,
): { ok: true; data: z.output<S> } | { ok: false; err: string } {
	const result = schema.safeParse(input);
	return result.success
		? { ok: true, data: result.data }
		: { ok: false, err: zodMessage(result.error) };
}

interface InventoryRecord {
	id: string;
	name: string;
	quantity: StockQty;
	low_stock_threshold: StockQty | null;
	alert_emails_enabled: boolean;
	alert_email: string | null;
}


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

function toActorInfo(context?: UserContext): ActorInfo {
	return {
		actor_type: context?.techId ? "technician" : context?.dispatcherId ? "dispatcher" : "system",
		actor_id: context?.techId || context?.dispatcherId,
	};
}


export const getAllInventory = async (organizationId: string, sort?: string) => {
	let orderBy: Record<string, unknown> = { name: "asc" };

	switch (sort) {
		case "quantity_asc":
			orderBy = { quantity: "asc" };
			break;
		case "quantity_desc":
			orderBy = { quantity: "desc" };
			break;
		case "recently_added":
			orderBy = { created_at: "desc" };
			break;
		case "most_used":
			orderBy = { visit_line_items: { _count: "desc" } };
			break;
		case "name":
		default:
			orderBy = { name: "asc" };
			break;
	}

	const sdb = getScopedDb(organizationId);
	const items = await sdb.inventory_item.findMany({
		where: { is_active: true, provisional: false },
		orderBy,
		include: {
			_count: { select: { visit_line_items: true } },
			tags: { orderBy: { label: "asc" } },
		},
	});

	return items.map(withStockStatus);
};

// Mirrors getAllInventory's shape for the detail page. Unlike the list, provisional/
// inactive items are still returned so a direct link never 404s.
export const getInventoryItemById = async (itemId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const item = await sdb.inventory_item.findFirst({
		where: { id: itemId },
		include: {
			_count: { select: { visit_line_items: true } },
			tags: { orderBy: { label: "asc" } },
		},
	});

	if (!item) return { err: "Inventory item not found" as const };
	return { err: "", item: withStockStatus(item) };
};

export const getLowStockInventory = async (organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const items = await sdb.inventory_item.findMany({
		where: {
			is_active: true,
			low_stock_threshold: { not: null },
		},
	});

	return items
		.map(withStockStatus)
		.filter((item) => item.stock_status === "low" || item.stock_status === "out_of_stock")
		.sort((a, b) => {
			if (a.stock_status === "out_of_stock" && b.stock_status !== "out_of_stock") return -1;
			if (a.stock_status !== "out_of_stock" && b.stock_status === "out_of_stock") return 1;
			return Number(a.quantity) - Number(b.quantity);
		});
};

// UPC-A (12 digits) and EAN-13 (13 digits, UPC-compatible when 0-prefixed) encode
// the same barcode — a scanner and the stored record can disagree on which form
// was kept. Only the barcode field gets this treatment; sku/alt_ids are opaque
// strings with no digit-form equivalence.
const barcodeCandidates = (trimmed: string): string[] => {
	const candidates = [trimmed];
	if (/^0\d{12}$/.test(trimmed)) candidates.push(trimmed.slice(1));
	if (/^\d{12}$/.test(trimmed)) candidates.push("0" + trimmed);
	return candidates;
};

// Resolve a scanned code to a single active inventory item. Lookup is
// prioritized so a match is deterministic even if the same string lives in
// more than one field: exact barcode → exact sku → alt_ids contains.
export const scanInventoryByCode = async (organizationId: string, code: string) => {
	const trimmed = code.trim();
	if (!trimmed) return { err: "Empty code" };

	const sdb = getScopedDb(organizationId);
	const item =
		(await sdb.inventory_item.findFirst({
			where: { is_active: true, provisional: false, barcode: { in: barcodeCandidates(trimmed) } },
			include: { tags: true },
		})) ??
		(await sdb.inventory_item.findFirst({
			where: { is_active: true, provisional: false, sku: trimmed },
			include: { tags: true },
		})) ??
		(await sdb.inventory_item.findFirst({
			where: { is_active: true, provisional: false, alt_ids: { has: trimmed } },
			include: { tags: true },
		}));

	if (!item) return { err: "NOT_FOUND" };
	return { err: "", item: withStockStatus(item) };
};

// Lenient, case-insensitive prefix matchers for serial/lot QR labels — accept
// both a colon and a hyphen as the separator (SN:, SN-, sn:, sn- / LOT:, LOT-, ...).
const SN_PREFIX = /^sn[-:]/i;
const LOT_PREFIX = /^lot[-:]/i;

type ResolvedItemPayload = Prisma.inventory_itemGetPayload<{ include: { tags: true } }>;
type ResolvedItem = ReturnType<typeof withStockStatus<ResolvedItemPayload>>;

type ResolveCodeResult =
	| { err: "Empty code" }
	| { err: "NOT_FOUND" }
	| { err: ""; type: "item"; item: ResolvedItem }
	| { err: ""; type: "serial"; code: string; serialUnitId: string; status: string; item: ResolvedItem }
	| { err: ""; type: "batch"; code: string; batchId: string; batchNumber: string; item: ResolvedItem };

// Fetches the parent inventory_item for a resolved serial/batch (org-scoped)
// and shapes it exactly like scanInventoryByCode's "item" variant.
async function fetchResolvedItem(organizationId: string, inventoryItemId: string): Promise<ResolvedItem | null> {
	const sdb = getScopedDb(organizationId);
	const item = await sdb.inventory_item.findFirst({
		where: { id: inventoryItemId },
		include: { tags: true },
	});
	return item ? withStockStatus(item) : null;
}

async function buildSerialResult(
	organizationId: string,
	unit: { id: string; code: string; status: string; inventory_item_id: string },
): Promise<ResolveCodeResult> {
	const item = await fetchResolvedItem(organizationId, unit.inventory_item_id);
	if (!item) return { err: "NOT_FOUND" };
	return {
		err: "",
		type: "serial",
		code: unit.code,
		serialUnitId: unit.id,
		status: unit.status,
		item,
	};
}

async function buildBatchResult(
	organizationId: string,
	batch: { id: string; code: string; batch_number: string; inventory_item_id: string },
): Promise<ResolveCodeResult> {
	const item = await fetchResolvedItem(organizationId, batch.inventory_item_id);
	if (!item) return { err: "NOT_FOUND" };
	return {
		err: "",
		type: "batch",
		code: batch.code,
		batchId: batch.id,
		batchNumber: batch.batch_number,
		item,
	};
}

// Scan-anything entry point (item/serial/batch). Typed prefixes (SN:, LOT:)
// resolve directly against the serial/batch tables — never fall through to
// item lookup, so a scanned unit/lot label reads as unambiguous. Unprefixed
// codes keep today's exact item-lookup behavior via scanInventoryByCode, and
// only fall back to a raw serial_number/batch_number match once that lookup
// has already missed.
export const resolveInventoryCode = async (organizationId: string, code: string): Promise<ResolveCodeResult> => {
	const trimmed = code.trim();
	if (!trimmed) return { err: "Empty code" };

	if (SN_PREFIX.test(trimmed)) {
		const sdb = getScopedDb(organizationId);
		const unit = await sdb.serial_unit.findFirst({ where: { code: trimmed.replace(SN_PREFIX, "") } });
		if (!unit) return { err: "NOT_FOUND" };
		return buildSerialResult(organizationId, unit);
	}

	if (LOT_PREFIX.test(trimmed)) {
		const sdb = getScopedDb(organizationId);
		const batch = await sdb.stock_batch.findFirst({ where: { code: trimmed.replace(LOT_PREFIX, "") } });
		if (!batch) return { err: "NOT_FOUND" };
		return buildBatchResult(organizationId, batch);
	}

	const result = await scanInventoryByCode(organizationId, trimmed);
	if (!result.err) {
		return { err: "", type: "item", item: result.item as ResolvedItem };
	}

	// Unprefixed fallback: item lookup missed — try a raw serial_number, then a
	// raw batch_number, exact match before giving up.
	const sdb = getScopedDb(organizationId);
	const serialHit = await sdb.serial_unit.findFirst({ where: { serial_number: trimmed } });
	if (serialHit) return buildSerialResult(organizationId, serialHit);

	const batchHit = await sdb.stock_batch.findFirst({ where: { batch_number: trimmed } });
	if (batchHit) return buildBatchResult(organizationId, batchHit);

	return { err: "NOT_FOUND" };
};

// Lazily assigns a printable code to items that predate barcode scanning —
// only called from the label-printing flow, never on read paths. The write is
// conditional on barcode still being null (updateMany, not update) so two
// concurrent calls on the same item never both "win" with different random
// codes — whichever commits first sticks, the loser's updateMany matches zero
// rows and both callers report the same final barcode. Retries the write on a
// cross-item unique conflict since the short base32 code space, while large,
// isn't collision-proof.
export const ensureItemCode = async (itemId: string, organizationId: string) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.inventory_item.findFirst({ where: { id: itemId } });
		if (!existing) return { err: "Inventory item not found" };

		if (!existing.barcode) {
			for (let attempt = 0; attempt < 5; attempt++) {
				try {
					await sdb.inventory_item.updateMany({
						where: { id: itemId, barcode: null },
						data: { barcode: shortCode("ITM") },
					});
					break; // claimed it (or another call already did) — fall through to the re-fetch below
				} catch (e) {
					if (uniqueConflictField(e) === "barcode") continue;
					throw e;
				}
			}
		}

		const final = await sdb.inventory_item.findFirst({ where: { id: itemId }, include: { tags: true } });
		if (!final) return { err: "Inventory item not found" };
		if (!final.barcode) return { err: "Failed to assign item code" };
		return { item: withStockStatus(final) };
	} catch (e) {
		console.error("Ensure item code error:", e);
		return { err: "Internal server error" };
	}
};

// Shared P2002 target-match idiom: true when the Prisma unique-constraint
// violation names `field`, checked three ways — the structured meta.target
// array, a raw string meta.target, and (when the @prisma/adapter-pg driver
// populates neither) a message-substring fallback.
function p2002TargetHits(e: unknown, field: string): boolean {
	if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
	const target = e.meta?.target;
	return (
		(Array.isArray(target) && target.includes(field)) ||
		(typeof target === "string" && target.includes(field)) ||
		e.message.includes(field)
	);
}

// inventory_item now has two per-org unique constraints: sku and barcode.
// Surface a clear 4xx on conflict, not a 500. The @prisma/adapter-pg driver
// often populates neither meta.target nor the field name in the message for
// transaction-scoped P2002s — when it does, we can name the exact field;
// otherwise we fall back to a combined message so the user still gets a 4xx.
// Returns: "sku" | "barcode" when identifiable, "unknown" for an
// inventory_item P2002 we can't attribute, or null when it isn't our conflict.
const uniqueConflictField = (e: unknown): "sku" | "barcode" | "unknown" | null => {
	if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") {
		return null;
	}
	if (p2002TargetHits(e, "barcode")) return "barcode";
	if (p2002TargetHits(e, "sku")) return "sku";
	if (e.meta?.modelName === "inventory_item") return "unknown";
	return null;
};

const conflictMessage = (field: "sku" | "barcode" | "unknown"): string =>
	field === "barcode"
		? "Barcode already in use"
		: field === "sku"
			? "SKU already in use"
			: "SKU or barcode already in use";

export const createInventoryItem = async (
	data: unknown,
	organizationId: string,
	context?: UserContext,
	/** Spreadsheet import routes through here too, and is not a dispatcher typing a form. */
	origin: inventory_item_origin = "dispatch_quick_add",
) => {
	try {
		const parsed = createInventoryItemSchema.parse(data);
		const sdb = getScopedDb(organizationId);
		const item = await sdb.$transaction(async (tx) => {
			const created = await tx.inventory_item.create({
				data: {
					organization_id: organizationId,
					origin,
					name: parsed.name,
					description: parsed.description,
					location: parsed.location ?? null,
					quantity: 0, // recordMovements sets the initial qty below
					unit: parsed.unit,
					unit_price: parsed.unit_price ?? null,
					cost: parsed.cost ?? null,
					sku: parsed.sku ?? null,
					// Blank collapses to null so "no category" is one value, not null vs "".
					category: parsed.category?.trim() || null,
					taxable: parsed.taxable ?? true,
					barcode: parsed.barcode ?? null,
					low_stock_threshold: parsed.low_stock_threshold ?? null,
					image_urls: parsed.image_urls,
					alert_emails_enabled: parsed.alert_emails_enabled,
					alert_email: parsed.alert_email ?? null,
					alt_ids: parsed.alt_ids.map((s) => s.trim()).filter(Boolean),
					is_serialized: parsed.is_serialized,
					is_batch_tracked: parsed.is_batch_tracked,
				},
				include: { tags: true },
			});

			if (parsed.quantity > 0) {
				const supplier = await resolveSupplier(
					tx as unknown as Prisma.TransactionClient,
					organizationId,
					parsed,
				);
				await recordMovements(tx as unknown as Prisma.TransactionClient, organizationId, toActorInfo(context), [
					{
						inventory_item_id: created.id,
						qty: parsed.quantity,
						from_location_type: "external",
						to_location_type: "warehouse",
						reason: "receive",
						unit_cost: parsed.cost_at_receipt ?? undefined,
						supplier_id: supplier?.id,
					},
				]);
			}

			await logActivity({
				event_type: "inventory_item.created",
				action: "created",
				entity_type: "inventory_item",
				entity_id: created.id,
				organization_id: organizationId,
				...getActorInfo(context),
				changes: {
					name: { old: null, new: created.name },
					quantity: { old: null, new: parsed.quantity },
					location: { old: null, new: created.location },
					// Logged so price-history has an anchor point at creation. Numbers, not
					// Decimals: Prisma's Decimal round-trips through Json inconsistently.
					cost: { old: null, new: created.cost != null ? Number(created.cost) : null },
					unit_price: {
						old: null,
						new: created.unit_price != null ? Number(created.unit_price) : null,
					},
				},
			});

			// quantity was set to 0 at create; recordMovements incremented it to parsed.quantity.
			// Return with the known final quantity to avoid an extra round-trip.
			return { ...created, quantity: parsed.quantity };
		});

		emitInventoryUpdated(organizationId, { itemId: item.id });

		return { err: "", item: withStockStatus(item) };
	} catch (e) {
		// Expected validation outcomes — not internal errors, don't log a stack trace.
		if (e instanceof ZodError) {
			return {
				err: zodMessage(e),
			};
		}
		if (e instanceof SupplierValidationError) {
			return { err: e.message };
		}
		const createConflict = uniqueConflictField(e);
		if (createConflict) {
			return { err: conflictMessage(createConflict) };
		}
		console.error("Create inventory item error:", e);
		return { err: "Internal server error" };
	}
};

// Business-rule failure raised inside the update transaction when `unit` would
// change on an item that still has stock on hand and the caller did not
// acknowledge the re-denomination. Thrown so nothing commits; mapped to a
// 400-style { err } result in the catch below (same idiom as
// TrackingStockNotZeroError in updateItemTracking).
class UnitChangeNotAcknowledgedError extends Error {}

export const updateInventoryItem = async (
	itemId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		// acknowledge_unit_change is a request flag, not a column — split it off so
		// the spread into `data` below never reaches Prisma.
		const { acknowledge_unit_change: acknowledgeUnitChange, ...parsed } =
			updateInventoryItemSchema.parse(data);

		const sdb = getScopedDb(organizationId);
		const existing = await sdb.inventory_item.findFirst({
			where: { id: itemId },
		});

		if (!existing) {
			return { err: "Inventory item not found" };
		}

		// A re-spelling of the same unit ("Each" -> "each", "gallon" -> "gal" — the
		// column was freetext before the catalog) is not a unit change and needs no
		// acknowledgement; only a different catalog code re-denominates stock.
		const unitChanged =
			parsed.unit !== undefined &&
			parsed.unit !== (normalizeUnitCode(existing.unit) ?? existing.unit);

		// No "quantity" here — the schema omits it; warehouse qty only moves via recordMovements.
		const changes = buildChanges(existing, parsed, [
			"name",
			"description",
			"location",
			"unit",
			"unit_price",
			"cost",
			"sku",
			"category",
			"taxable",
			"barcode",
			"low_stock_threshold",
			"image_urls",
			"alert_emails_enabled",
			"alert_email",
			"alt_ids",
		] as const);

		const updated = await sdb.$transaction(async (tx) => {
			// Decision 5: a unit change on an item with stock on hand is allowed
			// only with explicit acknowledgement. Nothing is converted — the cached
			// quantities simply start reading in the new unit — so the caller has to
			// say they know that. On-hand is read under the item lock, the same way
			// updateItemTracking checks its zero-stock gate, and the check covers the
			// warehouse cache, every vehicle's qty_on_hand, and (for tracked items)
			// live serials/lots, since the caches can drift from the unit rows.
			let unitChangeNote: string | null = null;
			if (unitChanged) {
				await lockInventoryRows(tx as unknown as Prisma.TransactionClient, [itemId]);
				const locked = await tx.inventory_item.findUnique({
					where: { id: itemId },
					select: { quantity: true },
				});
				const vehicleSum = await tx.vehicle_stock_item.aggregate({
					where: { inventory_item_id: itemId, vehicle: { organization_id: organizationId } },
					_sum: { qty_on_hand: true },
				});
				const warehouseQty = Number(locked?.quantity ?? 0);
				const vehicleQty = Number(vehicleSum._sum.qty_on_hand ?? 0);
				// Two decimals is the ledger's own scale; clears float noise from the sum.
				const totalOnHand = Math.round((warehouseQty + vehicleQty) * 100) / 100;

				const live =
					existing.is_serialized || existing.is_batch_tracked
						? await countTrackingLiveness(
								tx as unknown as Prisma.TransactionClient,
								itemId,
								organizationId,
							)
						: null;
				const liveTracked = (live?.liveSerials ?? 0) + (live?.liveLots ?? 0);

				if (totalOnHand !== 0 || liveTracked > 0) {
					if (!acknowledgeUnitChange) {
						throw new UnitChangeNotAcknowledgedError(
							totalOnHand !== 0
								? `Changing the unit re-denominates ${totalOnHand} units on hand; pass acknowledge_unit_change to confirm`
								: `Changing the unit re-denominates ${live!.liveSerials} live serial unit(s) and ${live!.liveLots} live lot(s) still on hand; pass acknowledge_unit_change to confirm`,
						);
					}
					unitChangeNote =
						`Unit changed from ${existing.unit} to ${parsed.unit} with ${totalOnHand} on hand ` +
						`(warehouse ${warehouseQty}, vehicles ${vehicleQty}` +
						(live ? `, live serials ${live.liveSerials}, live lots ${live.liveLots}` : "") +
						`); quantities were NOT converted — re-denomination acknowledged by the caller`;
				}
			}

			const item = await tx.inventory_item.update({
				where: { id: itemId },
				data: {
					...parsed,
					...(parsed.alt_ids !== undefined && {
						alt_ids: parsed.alt_ids.map((s) => s.trim()).filter(Boolean),
					}),
					// Same normalization as create — the spread above would
					// otherwise persist "  Filters  " verbatim.
					...(parsed.category !== undefined && {
						category: parsed.category?.trim() || null,
					}),
				},
				include: { tags: true },
			});

			const auditChanges = {
				...changes,
				// ChangeSet is old/new per key; the note is a new fact, not a diff.
				...(unitChangeNote ? { unit_change_note: { old: null, new: unitChangeNote } } : {}),
			};
			if (Object.keys(auditChanges).length > 0) {
				await logActivity({
					event_type: "inventory_item.updated",
					action: "updated",
					entity_type: "inventory_item",
					entity_id: itemId,
					organization_id: organizationId,
					...getActorInfo(context),
					changes: auditChanges,
				});
			}

			return item;
		});

		emitInventoryUpdated(organizationId, { itemId });

		return { err: "", item: withStockStatus(updated) };
	} catch (e) {
		// Expected validation outcomes — not internal errors, don't log a stack trace.
		if (e instanceof ZodError) {
			return {
				err: zodMessage(e),
			};
		}
		if (e instanceof UnitChangeNotAcknowledgedError) {
			return { err: e.message };
		}
		const updateConflict = uniqueConflictField(e);
		if (updateConflict) {
			return { err: conflictMessage(updateConflict) };
		}
		console.error("Update inventory item error:", e);
		return { err: "Internal server error" };
	}
};

export const deleteInventoryItem = async (itemId: string, organizationId: string, context?: UserContext) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.inventory_item.findFirst({
			where: { id: itemId },
		});

		if (!existing) {
			return { err: "Inventory item not found" };
		}

		await sdb.$transaction(async (tx) => {
			await tx.inventory_item.update({
				where: { id: itemId },
				// Null sku + barcode on soft-delete — both org-scoped unique
				// constraints aren't partial, so a deleted item would otherwise
				// permanently block those values from ever being reassigned.
				data: { is_active: false, barcode: null, sku: null },
			});

			// Soft delete skips cascade; clean up QB mappings manually.
			await tx.item_external_mapping.deleteMany({
				where: { inventory_item_id: itemId },
			});

			await logActivity({
				event_type: "inventory_item.deleted",
				action: "deleted",
				entity_type: "inventory_item",
				entity_id: itemId,
				organization_id: organizationId,
				...getActorInfo(context),
				changes: {
					is_active: { old: true, new: false },
					name: { old: existing.name, new: null },
					sku: { old: existing.sku, new: null },
					barcode: { old: existing.barcode, new: null },
				},
			});
		});

		emitInventoryUpdated(organizationId, { itemId });

		return { err: "", message: "Inventory item deleted successfully" };
	} catch (e) {
		console.error("Delete inventory item error:", e);
		return { err: "Internal server error" };
	}
};

export const adjustInventoryStock = async (
	itemId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = adjustStockSchema.parse(data);

		const sdb = getScopedDb(organizationId);
		const existing = await sdb.inventory_item.findFirst({
			where: { id: itemId },
		});

		if (!existing) {
			return { err: "Inventory item not found" };
		}

		const qty = Math.abs(parsed.delta);
		const isReceive = parsed.delta > 0;
		const isTracked = existing.is_serialized || existing.is_batch_tracked;

		// Positive delta on a tracked item can't say which units/lot it's adding —
		// that capture only exists on the dedicated receive endpoint.
		if (isTracked && isReceive) {
			return { err: "Use POST /inventory/:id/receive to add stock for a tracked item" };
		}

		// Serial/batch tracking — uncapped/strict; resolved BEFORE the transaction
		// opens so a validation failure never opens one. Only meaningful on the
		// loss/deduction side — a positive delta on a tracked item is already
		// rejected above. buildTrackingInputs is imported directly from
		// inventoryTracking.js (real, unmocked even in this file's tests) rather
		// than via stockMovements.js, matching the existing shortCode import — see
		// task-1 report for why the resulting TrackingValidationError is caught
		// locally via RealTrackingValidationError instead of the (test-mocked)
		// TrackingValidationError used by the outer catch below.
		let tracking: { serial?: MovementInput["serial"]; batch_allocations?: MovementInput["batch_allocations"] } = {};
		if (!isReceive) {
			try {
				const [resolvedLine] = await buildTrackingInputs(
					null as unknown as Prisma.TransactionClient,
					organizationId,
					new Map<string, ItemTrackingFlags>([
						[itemId, { is_serialized: existing.is_serialized, is_batch_tracked: existing.is_batch_tracked }],
					]),
					[
						{
							inventory_item_id: itemId,
							qty,
							raw: { serial_unit_ids: parsed.serial_unit_ids, batch_picks: parsed.batch_picks },
						},
					],
				);
				tracking = resolvedLine.tracking;
			} catch (e) {
				if (e instanceof RealTrackingValidationError) return { err: e.message };
				throw e;
			}
		}

		const actor = toActorInfo(context);

		let lowStockItemIds: string[] = [];

		const updated = await sdb.$transaction(async (tx) => {
			const movement: MovementInput = {
				inventory_item_id: itemId,
				qty,
				from_location_type: isReceive ? "external" : "warehouse",
				to_location_type: isReceive ? "warehouse" : "adjustment",
				reason: isReceive ? "receive" : "loss",
				serial: tracking.serial,
				batch_allocations: tracking.batch_allocations,
			};

			const result = await recordMovements(tx as unknown as Prisma.TransactionClient, organizationId, actor, [
				movement,
			]);
			lowStockItemIds = result.lowStockItemIds;

			const item = await tx.inventory_item.findUnique({ where: { id: itemId } });

			await logActivity({
				event_type: "inventory_item.stock_adjusted",
				action: "updated",
				entity_type: "inventory_item",
				entity_id: itemId,
				organization_id: organizationId,
				...getActorInfo(context),
				changes: {
					quantity: { old: existing.quantity, new: item?.quantity },
					delta: { old: null, new: parsed.delta },
				},
			});

			return item!;
		});

		// Only alert when quantity first crosses below threshold, not on every deduction
		// Coerced: these are Decimals, and `>` between them compares string forms
		// (so "9" > "10" is true), which would invert the gate.
		if (
			lowStockItemIds.includes(itemId) &&
			Number(existing.quantity) > Number(existing.low_stock_threshold ?? 0)
		) {
			sendLowStockAlert(updated as InventoryRecord).catch(() => {});
		}

		emitInventoryUpdated(organizationId, { itemId });

		return { err: "", item: withStockStatus(updated) };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: zodMessage(e),
			};
		}
		if (e instanceof InsufficientStockError) {
			return { err: "Stock cannot go below zero" };
		}
		if (e instanceof InsufficientBatchStockError || e instanceof TrackingValidationError) {
			return { err: e.message };
		}
		console.error("Adjust inventory stock error:", e);
		return { err: "Internal server error" };
	}
};

// Receives new stock into the warehouse for one item — optionally capturing
// per-unit serial numbers (serialized items) or a lot/batch (batch-tracked
// items). Plain (non-tracked) items behave exactly like createInventoryItem's
// initial-qty path. Serial/batch inputs on a non-tracked item are rejected by
// applyTracking (via recordMovements) — not duplicated here.
export const receiveInventoryItem = async (
	itemId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.inventory_item.findFirst({ where: { id: itemId } });

		if (!existing) {
			return { err: "Inventory item not found" };
		}

		const parsed = receiveInventorySchema.parse(data);

		// Auto-assign: for a serialized item opted into auto_serial, synthesize one
		// AUTO- serial number per unit so downstream (tracking-input build + the
		// post-receive re-fetch) treats them exactly like caller-supplied numbers.
		// A non-integer qty for a serialized item still fails the service's
		// count === qty guard, so no extra check is needed here.
		const serialNumbers =
			existing.is_serialized && parsed.auto_serial
				? Array.from({ length: parsed.qty }, () => shortCode("AUTO"))
				: parsed.serial_numbers;

		// Serial tracking — uncapped/strict; resolved BEFORE the transaction opens
		// so a validation failure never opens one (inventoryController.test.ts
		// "...no partial writes" / "$transaction not toHaveBeenCalled"). This caller
		// always CREATES brand-new units (never references existing ones), so
		// parsed.serial_numbers maps onto the helper's new_serials slot, not
		// serial_unit_ids. buildTrackingInputs only sets `serial_number` on each
		// created entry — resolvedBatch?.id is merged in afterward, once the batch
		// is resolved inside the transaction. The batch-tracked "provide either
		// batch or batch_id" presence check stays controller-side: it doesn't
		// depend on translating raw input, and resolvedBatch itself isn't known
		// until the transaction resolves it (getOrCreateBatch/stock_batch.findFirst
		// both need the live tx), so there's nothing for the helper to do here.
		let newSerialTracking: MovementInput["serial"];
		if (existing.is_serialized) {
			try {
				const [resolvedLine] = await buildTrackingInputs(
					null as unknown as Prisma.TransactionClient,
					organizationId,
					new Map<string, ItemTrackingFlags>([
						[itemId, { is_serialized: true, is_batch_tracked: existing.is_batch_tracked }],
					]),
					[{ inventory_item_id: itemId, qty: parsed.qty, raw: { new_serials: serialNumbers } }],
					{ serialIdField: "serial_numbers" },
				);
				newSerialTracking = resolvedLine.tracking.serial;
			} catch (e) {
				if (e instanceof RealTrackingValidationError) return { err: e.message };
				throw e;
			}
		}
		if (existing.is_batch_tracked && !parsed.batch && !parsed.batch_id) {
			return { err: "Provide either batch or batch_id for a batch-tracked item" };
		}

		const actor = toActorInfo(context);

		const { item, createdSerials, batchInfo } = await sdb.$transaction(async (tx) => {
			let resolvedBatch: { id: string; code: string; batch_number: string } | undefined;

			// A legacy client sends its vendor only as batch.supplier free text;
			// promoting it here means the movement gets an origin too, instead of
			// the lot being the sole place the purchase was ever attributed.
			const supplier = await resolveSupplier(
				tx as unknown as Prisma.TransactionClient,
				organizationId,
				{
					supplier_id: parsed.supplier_id,
					supplier_name: parsed.supplier_name ?? parsed.batch?.supplier,
				},
			);

			if (parsed.batch) {
				const created = await getOrCreateBatch(tx as unknown as Prisma.TransactionClient, organizationId, {
					inventory_item_id: itemId,
					batch_number: parsed.batch.batch_number,
					expires_at: parsed.batch.expires_at ? new Date(parsed.batch.expires_at) : null,
					supplier: supplier?.name ?? parsed.batch.supplier ?? null,
					supplier_id: supplier?.id ?? null,
					// Falls back to the receive-level cost — one purchase, one price.
					unit_cost: parsed.batch.unit_cost ?? parsed.unit_cost ?? null,
				});
				resolvedBatch = { id: created.id, code: created.code, batch_number: parsed.batch.batch_number };
			} else if (parsed.batch_id) {
				const batchRow = await tx.stock_batch.findFirst({
					where: { id: parsed.batch_id, organization_id: organizationId, inventory_item_id: itemId },
					select: { id: true, code: true, batch_number: true },
				});
				if (!batchRow) throw new Error("Batch not found");
				resolvedBatch = { id: batchRow.id, code: batchRow.code, batch_number: batchRow.batch_number };
			}

			const movement: MovementInput = {
				inventory_item_id: itemId,
				qty: parsed.qty,
				from_location_type: "external",
				to_location_type: "warehouse",
				reason: "receive",
				note: parsed.note,
				unit_cost: parsed.unit_cost,
				supplier_id: supplier?.id,
				serial: newSerialTracking
					? {
							create: (newSerialTracking.create ?? []).map((c) => ({
								...c,
								batch_id: resolvedBatch?.id,
							})),
						}
					: undefined,
				batch_allocations:
					existing.is_batch_tracked && !existing.is_serialized && resolvedBatch
						? [{ batch_id: resolvedBatch.id, qty: parsed.qty }]
						: undefined,
			};

			await recordMovements(tx as unknown as Prisma.TransactionClient, organizationId, actor, [movement]);

			let createdSerials: { id: string; code: string; serial_number: string; status: string }[] = [];
			if (existing.is_serialized && serialNumbers) {
				createdSerials = await tx.serial_unit.findMany({
					where: {
						organization_id: organizationId,
						inventory_item_id: itemId,
						serial_number: { in: serialNumbers },
					},
					orderBy: { created_at: "desc" },
					select: { id: true, code: true, serial_number: true, status: true },
				});
			}

			const updatedItem = await tx.inventory_item.findUnique({ where: { id: itemId } });

			await logActivity({
				event_type: "inventory_item.stock_adjusted",
				action: "updated",
				entity_type: "inventory_item",
				entity_id: itemId,
				organization_id: organizationId,
				...getActorInfo(context),
				changes: {
					quantity: { old: existing.quantity, new: updatedItem?.quantity },
					received: { old: null, new: parsed.qty },
				},
			});

			return { item: updatedItem!, createdSerials, batchInfo: resolvedBatch };
		});

		emitInventoryUpdated(organizationId, { itemId });

		return {
			err: "",
			item: withStockStatus(item),
			created_serials: createdSerials.length > 0 ? createdSerials : undefined,
			batch: batchInfo,
		};
	} catch (e) {
		if (e instanceof ZodError) {
			return { err: zodMessage(e) };
		}
		if (
			e instanceof InsufficientBatchStockError ||
			e instanceof TrackingValidationError ||
			e instanceof SupplierValidationError
		) {
			return { err: e.message };
		}
		if (e instanceof Error && e.message === "Batch not found") {
			return { err: e.message };
		}
		if (isSerialNumberConflict(e)) {
			return { err: "One or more serial numbers already exist for this item", conflict: true };
		}
		console.error("Receive inventory item error:", e);
		return { err: "Internal server error" };
	}
};

// A re-receive of an already-known serial_number hits serial_unit's
// [organization_id, inventory_item_id, serial_number] unique index and
// throws P2002. Distinguished from the `code` mint-collision (transparently
// retried inside inventoryTracking.ts — never reaches here) by inspecting
// e.meta.target for the serial_number column specifically. Same house idiom
// as uniqueConflictField above.
const isSerialNumberConflict = (e: unknown): boolean => p2002TargetHits(e, "serial_number");

// Business-rule failure raised inside the tracking-toggle transaction when the
// item still has stock on hand. Thrown from inside $transaction so nothing
// commits, then mapped to a 400-style { err } result in the outer catch below
// (this file's convention — see InsufficientBatchStockError/
// TrackingValidationError handling in receiveInventoryItem above).
class TrackingStockNotZeroError extends Error {}

// Shared by the PATCH tracking-toggle enforcement and the GET tracking-eligibility
// predictor, so both surfaces can never disagree on the disable/switch rule.
interface TrackingLiveness {
	/** Units still physically somewhere. The hard blocker on disabling. */
	liveSerials: number;
	/** Lots still holding stock, in the warehouse or on any vehicle. */
	liveLots: number;
	/** Every unit/lot ever recorded, live or terminal — what a disable archives. */
	totalSerials: number;
	totalLots: number;
}

/** Counts live vs total tracked rows for one item. Org filtered explicitly since the
 * enforcement call site holds a raw transaction client, not a scoped one. */
const countTrackingLiveness = async (
	client: Prisma.TransactionClient,
	itemId: string,
	organizationId: string,
): Promise<TrackingLiveness> => {
	const [liveSerials, liveWarehouseLots, liveVehicleLots, totalSerials, totalLots] =
		await Promise.all([
			client.serial_unit.count({
				where: {
					inventory_item_id: itemId,
					organization_id: organizationId,
					status: { in: ["in_warehouse", "on_vehicle"] },
				},
			}),
			client.stock_batch.count({
				where: {
					inventory_item_id: itemId,
					organization_id: organizationId,
					qty_in_warehouse: { gt: 0 },
				},
			}),
			client.vehicle_stock_batch.count({
				where: {
					batch: { inventory_item_id: itemId, organization_id: organizationId },
					qty_on_hand: { gt: 0 },
				},
			}),
			client.serial_unit.count({
				where: { inventory_item_id: itemId, organization_id: organizationId },
			}),
			client.stock_batch.count({
				where: { inventory_item_id: itemId, organization_id: organizationId },
			}),
		]);

	// Warehouse and vehicle lots are counted apart only because they live in
	// different tables — the rule treats "holding stock anywhere" as one fact.
	return {
		liveSerials,
		liveLots: liveWarehouseLots + liveVehicleLots,
		totalSerials,
		totalLots,
	};
};

/** Reasons a disable/switch is refused; empty means the flip is allowed. Enforcement
 * prefixes the first with "Cannot disable or switch tracking while …"; eligibility
 * returns them verbatim as `blockers`. */
const trackingLivenessBlockers = (live: TrackingLiveness): string[] => {
	const blockers: string[] = [];
	if (live.liveSerials > 0) {
		blockers.push(
			`${live.liveSerials} serial unit(s) are still in the warehouse or on a vehicle — consume, return, or remove them first`,
		);
	}
	if (live.liveLots > 0) {
		blockers.push(
			`${live.liveLots} batch(es) still hold stock in the warehouse or on a vehicle — draw them down to zero first`,
		);
	}
	return blockers;
};

// PATCH /inventory/:id/tracking — flips is_serialized/is_batch_tracked. Gated
// on zero total on-hand stock (warehouse quantity + every vehicle's
// qty_on_hand for this item) so serial_unit/stock_batch rows never desync
// from physical stock. Provisional items can never be tracked.
//
// Disabling additionally requires no *live* units or lots — terminal serials and
// drained lots are deliberately left behind as read-only history.
export const updateItemTracking = async (
	itemId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.inventory_item.findFirst({ where: { id: itemId } });

		if (!existing) {
			return { err: "Inventory item not found" };
		}

		const parsed = toggleTrackingSchema.parse(data);

		if (existing.provisional) {
			return { err: "Provisional items cannot be tracked" };
		}

		const changesToApply: Record<string, { old: boolean; new: boolean }> = {};
		if (parsed.is_serialized !== undefined && parsed.is_serialized !== existing.is_serialized) {
			changesToApply.is_serialized = { old: existing.is_serialized, new: parsed.is_serialized };
		}
		if (
			parsed.is_batch_tracked !== undefined &&
			parsed.is_batch_tracked !== existing.is_batch_tracked
		) {
			changesToApply.is_batch_tracked = {
				old: existing.is_batch_tracked,
				new: parsed.is_batch_tracked,
			};
		}

		if (Object.keys(changesToApply).length === 0) {
			return { err: "", item: withStockStatus(existing) };
		}

		const updated = await sdb.$transaction(async (tx) => {
			await lockInventoryRows(tx as unknown as Prisma.TransactionClient, [itemId]);

			const locked = await tx.inventory_item.findUnique({ where: { id: itemId } });
			const vehicleSum = await tx.vehicle_stock_item.aggregate({
				where: { inventory_item_id: itemId, vehicle: { organization_id: organizationId } },
				_sum: { qty_on_hand: true },
			});

			const totalOnHand =
				Number(locked?.quantity ?? 0) + Number(vehicleSum._sum.qty_on_hand ?? 0);

			if (totalOnHand !== 0) {
				throw new TrackingStockNotZeroError(
					`Cannot change tracking settings while ${totalOnHand} units are on hand (warehouse + vehicles) — reduce to zero first`,
				);
			}

			// "Block unless nothing is live": disabling/switching a tracked dimension is
			// allowed once no unit or lot still holds stock; terminal serials/drained lots
			// survive on purpose as read-only history. Checked directly rather than via
			// totalOnHand === 0 above, since the cached quantity and unit rows can drift.
			const disablingTracked =
				(changesToApply.is_serialized?.old === true &&
					changesToApply.is_serialized?.new === false) ||
				(changesToApply.is_batch_tracked?.old === true &&
					changesToApply.is_batch_tracked?.new === false);

			// Recorded on the activity entry so the audit log distinguishes "disabled clean"
			// from "disabled, history retained".
			let archivedHistory: { serials: number; batches: number } | null = null;

			if (disablingTracked) {
				const live = await countTrackingLiveness(
					tx as unknown as Prisma.TransactionClient,
					itemId,
					organizationId,
				);

				// Report the first blocker only; the eligibility endpoint returns the full list.
				const [blocker] = trackingLivenessBlockers(live);
				if (blocker) {
					throw new TrackingStockNotZeroError(
						`Cannot disable or switch tracking while ${blocker}`,
					);
				}

				if (live.totalSerials > 0 || live.totalLots > 0) {
					archivedHistory = { serials: live.totalSerials, batches: live.totalLots };
				}
			}

			const item = await tx.inventory_item.update({
				where: { id: itemId },
				data: {
					...(parsed.is_serialized !== undefined ? { is_serialized: parsed.is_serialized } : {}),
					...(parsed.is_batch_tracked !== undefined
						? { is_batch_tracked: parsed.is_batch_tracked }
						: {}),
				},
			});

			await logActivity({
				event_type: "inventory_item.tracking_updated",
				action: "updated",
				entity_type: "inventory_item",
				entity_id: itemId,
				organization_id: organizationId,
				...getActorInfo(context),
				changes: {
					...changesToApply,
					// ChangeSet is old/new per key; nothing about the history rows
					// changed, so old is null and new carries what was retained.
					...(archivedHistory
						? { archived_history: { old: null, new: archivedHistory } }
						: {}),
				},
			});

			return item;
		});

		emitInventoryUpdated(organizationId, { itemId });

		return { err: "", item: withStockStatus(updated) };
	} catch (e) {
		if (e instanceof ZodError) {
			return { err: zodMessage(e) };
		}
		if (e instanceof TrackingStockNotZeroError) {
			return { err: e.message };
		}
		console.error("Update item tracking error:", e);
		return { err: "Internal server error" };
	}
};

export const deductInventoryForVisit = async (
	visitId: string,
	tx: Prisma.TransactionClient,
	organizationId: string,
	context?: UserContext,
): Promise<{ lowStockItemIds: string[] }> => {
	if (!(await isModuleOn(organizationId, "inventory"))) {
		log.debug({ organizationId, visitId }, "stock deduction skipped: inventory module is off");
		return { lowStockItemIds: [] };
	}
	// With Vehicle Stock off the truck is not a stock location, so intake lands in the warehouse.
	const vehicleStockOn = await isModuleOn(organizationId, "vehicle_stock");
	// Lines already consumed from vehicle stock (fulfillment_status "used") are
	// skipped — their warehouse impact happened at restock. NULL must be matched
	// explicitly: Prisma `not` excludes NULL rows (SQL semantics).
	const lineItems = await tx.job_visit_line_item.findMany({
		where: {
			visit_id: visitId,
			inventory_item_id: { not: null },
			OR: [{ fulfillment_status: null }, { fulfillment_status: { not: "used" } }],
		},
	});
	if (lineItems.length === 0) return { lowStockItemIds: [] };

	const rows = lineItems as unknown as {
		id: string;
		inventory_item_id: string;
		quantity: unknown;
		disposition: line_item_disposition | null;
		disposition_location: stock_location_type | null;
		disposition_vehicle_id: string | null;
	}[];

	// NULL reads as `consume` - what every linked line did before the column.
	const dispositionOf = (r: (typeof rows)[number]) => r.disposition ?? "consume";

	// An intake with no per-unit cost averages in at nothing, and the catalog
	// cost is the only basis available until field procurement lands.
	const receiveItemIds = [
		...new Set(rows.filter((r) => dispositionOf(r) === "receive").map((r) => r.inventory_item_id)),
	];
	const receiveCosts = new Map<string, number>();
	if (receiveItemIds.length > 0) {
		const costRows = await tx.inventory_item.findMany({
			where: { id: { in: receiveItemIds }, organization_id: organizationId },
			select: { id: true, cost: true },
		});
		for (const c of costRows) {
			if (c.cost !== null) receiveCosts.set(c.id, Number(c.cost));
		}
	}

	// 12.5 ft billed moves 12.5 ft, not 13. allowNegative: completion must
	const movements: MovementInput[] = [];
	let consumed = 0;
	let received = 0;
	let nonStock = 0;
	for (const r of rows) {
		const qty = Number(r.quantity);
		const disposition = dispositionOf(r);
		if (disposition === "non_stock") {
			// Keeps the catalog link, so price history and margin still see the line,
			// without debiting the warehouse for stock that was never there.
			nonStock++;
			continue;
		}
		if (qty <= 0) continue;
		if (disposition === "receive") {
			// Vehicle deleted since (FK is SET NULL): the stock did arrive somewhere,
			// so land it in the warehouse rather than fail the completion.
			const toVehicleId =
				vehicleStockOn && r.disposition_location === "vehicle"
					? r.disposition_vehicle_id
					: null;
			const unitCost = receiveCosts.get(r.inventory_item_id);
			movements.push({
				inventory_item_id: r.inventory_item_id,
				qty,
				from_location_type: "external",
				to_location_type: toVehicleId ? "vehicle" : "warehouse",
				...(toVehicleId ? { to_vehicle_id: toVehicleId } : {}),
				reason: "receive",
				...(unitCost !== undefined ? { unit_cost: unitCost } : {}),
				visit_id: visitId,
				visit_line_item_id: r.id,
			});
			received++;
			continue;
		}
		movements.push({
			inventory_item_id: r.inventory_item_id,
			qty,
			from_location_type: "warehouse",
			to_location_type: "consumed",
			reason: "direct_consumption",
			visit_id: visitId,
			visit_line_item_id: r.id,
		});
		consumed++;
	}

	const { lowStockItemIds } = await recordMovements(
		tx,
		organizationId,
		toActorInfo(context),
		movements,
		{ allowNegative: true, allowUntracked: true },
	);

	// `non_stock` included: "used" means SETTLED, and its settlement is no
	// movement. Left `planned` it would look like outstanding work forever.
	await tx.job_visit_line_item.updateMany({
		where: { id: { in: rows.map((r) => r.id) } },
		data: { fulfillment_status: "used" },
	});

	await logActivity({
		event_type: "inventory_item.stock_adjusted",
		action: "updated",
		entity_type: "job_visit",
		entity_id: visitId,
		organization_id: organizationId,
		...getActorInfo(context),
		changes: {
			lines_consumed: { old: null, new: consumed },
			...(received > 0 ? { lines_received: { old: null, new: received } } : {}),
			...(nonStock > 0 ? { lines_non_stock: { old: null, new: nonStock } } : {}),
			reason: { old: null, new: `Inventory settled at completion of visit ${visitId}` },
		},
	});

	return { lowStockItemIds };
};

export const updateInventoryThreshold = async (
	itemId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updateThresholdSchema.parse(data);

		const sdb = getScopedDb(organizationId);
		const existing = await sdb.inventory_item.findFirst({
			where: { id: itemId },
		});

		if (!existing) {
			return { err: "Inventory item not found" };
		}

		const updated = await sdb.$transaction(async (tx) => {
			const item = await tx.inventory_item.update({
				where: { id: itemId },
				data: { low_stock_threshold: parsed.low_stock_threshold },
			});

			await logActivity({
				event_type: "inventory_item.threshold_updated",
				action: "updated",
				entity_type: "inventory_item",
				entity_id: itemId,
				organization_id: organizationId,
				...getActorInfo(context),
				changes: buildChanges(
					existing,
					{ low_stock_threshold: parsed.low_stock_threshold },
					["low_stock_threshold"] as const,
				),
			});

			return item;
		});

		return { err: "", item: withStockStatus(updated) };
	} catch (e) {
		log.error({ err: e }, "Update threshold error");
		if (e instanceof ZodError) {
			return {
				err: zodMessage(e),
			};
		}
		return { err: "Internal server error" };
	}
};

// ── Bulk import ───────────────────────────────────────────────────────────────

export const importInventoryFromFile = async (
	buffer: Buffer,
	orgId: string,
	context?: UserContext,
): Promise<{
	imported: number;
	skipped: { row: number; reason: string }[];
	// Rows that DID import, but not exactly as written (unlike skipped, which produced nothing).
	warnings: { row: number; message: string }[];
}> => {
	const workbook = XLSX.read(buffer, { type: "buffer" });
	const sheet = workbook.Sheets[workbook.SheetNames[0]];
	const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

	const skipped: { row: number; reason: string }[] = [];
	const warnings: { row: number; message: string }[] = [];
	let imported = 0;

	const str = (v: unknown) => String(v ?? "").trim();
	const toNum = (v: unknown) => { const n = parseFloat(str(v)); return isNaN(n) ? undefined : n; };

	// Decimal(10,2) columns — parsed as floats (fractional stock is legitimate), and
	// validated via isStorableStockQty so this path can't accept what the single-item
	// path rejects. Negative values aren't checked here; createInventoryItem's schema
	// already reports that.
	const toStockQty = (v: unknown): { ok: true; value: number | undefined } | { ok: false } => {
		const raw = str(v);
		if (!raw) return { ok: true, value: undefined };
		const n = parseFloat(raw);
		if (isNaN(n)) return { ok: true, value: undefined };
		if (!isStorableStockQty(n)) return { ok: false };
		return { ok: true, value: n };
	};

	const sdb = getScopedDb(orgId);

	const resolveTagIds = async (rawTags: string): Promise<string[]> => {
		const labels = rawTags.split(",").map((s) => s.trim()).filter(Boolean);
		if (labels.length === 0) return [];
		const ids: string[] = [];
		for (const label of labels) {
			const existing = await sdb.inventory_tag.findFirst({
				where: { organization_id: orgId, label: { equals: label, mode: "insensitive" } },
			});
			if (existing) {
				ids.push(existing.id);
			} else {
				const created = await sdb.inventory_tag.create({
					data: { organization_id: orgId, label },
				});
				ids.push(created.id);
			}
		}
		return ids;
	};

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		const rowNum = i + 2;

		const name = str(row["name"] ?? row["name*"]);
		const location = str(row["location"] ?? row["location*"]);

		if (!name) { skipped.push({ row: rowNum, reason: "Missing required field: name" }); continue; }

		const quantityResult = toStockQty(row["quantity"]);
		if (!quantityResult.ok) {
			skipped.push({
				row: rowNum,
				reason: `Invalid quantity "${str(row["quantity"])}": ${STOCK_QTY_MESSAGE}`,
			});
			continue;
		}

		const thresholdResult = toStockQty(row["low_stock_threshold"]);
		if (!thresholdResult.ok) {
			skipped.push({
				row: rowNum,
				reason: `Invalid low_stock_threshold "${str(row["low_stock_threshold"])}": ${STOCK_QTY_MESSAGE}`,
			});
			continue;
		}

		// Accepts both the "Unit" header the low-stock export writes and lowercase "unit".
		// Unlike the API, an unrecognized unit coerces to the default and warns instead of
		// failing the row — losing a whole item over a unit typo is worse.
		const rawUnit = str(row["unit"] ?? row["Unit"]);
		const unit = normalizeUnitCode(rawUnit);
		if (rawUnit && !unit) {
			warnings.push({
				row: rowNum,
				message: `Unrecognized unit "${rawUnit}" — imported as "${DEFAULT_UNIT_CODE}"`,
			});
		}

		const data = {
			name,
			location,
			description: str(row["description"]) || "",
			sku: str(row["sku"]) || null,
			quantity: quantityResult.value ?? 0,
			unit: unit ?? DEFAULT_UNIT_CODE,
			unit_price: toNum(row["unit_price"]) ?? null,
			cost: toNum(row["cost"]) ?? null,
			low_stock_threshold: thresholdResult.value ?? null,
			alert_email: str(row["alert_email"]) || null,
			alert_emails_enabled: false,
			image_urls: [],
		};

		const result = await createInventoryItem(data, orgId, context, "import");
		if (result.err) {
			skipped.push({ row: rowNum, reason: result.err });
		} else {
			const rawTags = str(row["tags"]);
			if (rawTags) {
				const tagIds = await resolveTagIds(rawTags);
				if (tagIds.length > 0) {
					await sdb.inventory_item.update({
						where: { id: result.item!.id },
						data: { tags: { set: tagIds.map((id) => ({ id })) } },
					});
				}
			}
			imported++;
		}
	}

	return { imported, skipped, warnings };
};

// ── Low-stock export ──────────────────────────────────────────────────────────

export const exportLowStockToXlsx = async (orgId: string): Promise<Buffer> => {
	const items = await getLowStockInventory(orgId);

	const statusLabel = (s: string | null) =>
		s === "out_of_stock" ? "Out of Stock" : s === "low" ? "Low" : "";

	const rows = items.map((item) => ({
		Name: item.name,
		SKU: item.sku ?? "",
		Location: item.location ?? "",
		Quantity: item.quantity,
		Unit: (item as Record<string, unknown>)["unit"] ?? "each",
		"Low Stock Threshold": item.low_stock_threshold ?? "",
		"Stock Status": statusLabel(item.stock_status),
		"Unit Price": item.unit_price != null ? Number(item.unit_price) : "",
		Cost: item.cost != null ? Number(item.cost) : "",
	}));

	const ws = XLSX.utils.json_to_sheet(rows);
	ws["!cols"] = [22, 14, 20, 10, 8, 18, 14, 12, 12].map((wch) => ({ wch }));
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, ws, "Low Stock Report");

	return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
};

// ── Movement history ──────────────────────────────────────────────────────────

const MOVEMENT_INCLUDE = {
	from_vehicle: { select: { id: true, name: true } },
	to_vehicle: { select: { id: true, name: true } },
} as const;

export const getInventoryMovements = async (
	itemId: string,
	organizationId: string,
	cursor?: string,
	limit = 25,
	query: unknown = {},
) => {
	const sdb = getScopedDb(organizationId);

	const existing = await sdb.inventory_item.findFirst({
		where: { id: itemId },
		select: { id: true },
	});
	if (!existing) return { err: "Inventory item not found" as const };

	// cursor/limit stay as explicit args (existing callers pass them positionally);
	// `query` carries the newer filters. created_after narrows the ledger here on
	// the server rather than the UI hiding rows it already fetched.
	const q = parseInput(movementsQuerySchema, query);
	if (!q.ok) return { err: q.err };
	const parsed = q.data;

	const take = Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit) : 25, 1), 100);

	const movements = await sdb.stock_movement.findMany({
		where: {
			inventory_item_id: itemId,
			...(parsed.created_after ? { created_at: { gte: parsed.created_after } } : {}),
		},
		include: MOVEMENT_INCLUDE,
		orderBy: [{ created_at: "desc" }, { id: "desc" }],
		take: take + 1,
		...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
	});

	const hasNext = movements.length > take;
	const page = hasNext ? movements.slice(0, take) : movements;
	const nextCursor = hasNext ? page[page.length - 1].id : null;

	return { err: "", movements: page, nextCursor };
};

// ── History & Reports tab (item detail page) ──────────────────────────────────

// GET /inventory/:id/usage — consumption of this item traced back to the job +
// client it was used on, grouped per job+client. Offset-paginated since these are
// GROUP BY aggregate rows, not raw ledger rows with a stable cursor id.
// created_after narrows server-side, same contract as getInventoryMovements —
// the History tab's range control feeds this the same way it feeds the ledger.
export const getItemUsage = async (itemId: string, organizationId: string, query: unknown = {}) => {
	const sdb = getScopedDb(organizationId);

	const existing = await sdb.inventory_item.findFirst({
		where: { id: itemId },
		select: { id: true },
	});
	if (!existing) return { err: "Inventory item not found" as const };

	const q = parseInput(usageQuerySchema, query);
	if (!q.ok) return { err: q.err };
	const parsed = q.data;

	const take = Math.min(Math.max(parsed.limit ?? 20, 1), 100);
	const offset = Math.max(parsed.offset ?? 0, 0);

	const rows = await sdb.$queryRaw<
		{
			jobId: string;
			jobNumber: string;
			jobName: string;
			clientId: string;
			clientName: string;
			qtyConsumed: number;
			units: string[] | null;
			lastConsumedAt: Date;
		}[]
	>`
		SELECT
			j.id AS "jobId",
			j.job_number AS "jobNumber",
			j.name AS "jobName",
			c.id AS "clientId",
			c.name AS "clientName",
			-- Net of reversals (lib/inventory.ts CONSUMPTION_*), same as the forecast.
			SUM(${CONSUMPTION_SIGNED_QTY})::float AS "qtyConsumed",
			-- Per-row units, so a mixed-unit group's sum can be withheld per row.
			array_agg(DISTINCT sm.unit) AS "units",
			MAX(sm.created_at) AS "lastConsumedAt"
		FROM stock_movement sm
		-- Joined through the visit, not the line item: reversing a parts-used line
		-- to zero deletes the line (SetNull on sm.visit_line_item_id), and an
		-- INNER JOIN on it would drop both the original and its reversal so the
		-- group no longer netted to zero. Every consumption movement carries visit_id.
		JOIN job_visit jv ON jv.id = sm.visit_id
		JOIN job j ON j.id = jv.job_id
		JOIN client c ON c.id = j.client_id
		WHERE sm.inventory_item_id = ${itemId}
			AND sm.organization_id = ${organizationId}
			AND ${CONSUMPTION_MOVEMENT_PREDICATE}
			AND sm.created_at >= COALESCE(${parsed.created_after ?? null}::timestamptz, '-infinity'::timestamptz)
		GROUP BY j.id, j.job_number, j.name, c.id, c.name
		-- A job whose usage fully reversed (added, then removed) is not usage.
		HAVING SUM(${CONSUMPTION_SIGNED_QTY}) <> 0
		ORDER BY MAX(sm.created_at) DESC
		LIMIT ${take + 1} OFFSET ${offset}
	`;

	const hasMore = rows.length > take;
	const page = hasMore ? rows.slice(0, take) : rows;

	// Per-row basis withholds that row's total; the page-level union flags the column
	// itself as mixed even when every individual row is single-unit.
	const usage = page.map((r) => {
		const basis = unitBasis(r.units);
		return {
			jobId: r.jobId,
			jobNumber: r.jobNumber,
			jobName: r.jobName,
			clientId: r.clientId,
			clientName: r.clientName,
			qtyConsumed: basis.mixed ? null : Number(r.qtyConsumed),
			unitBasis: basis,
			lastConsumedAt: r.lastConsumedAt.toISOString(),
		};
	});

	return {
		err: "",
		usage,
		unitBasis: mergeUnitBases(usage.map((u) => u.unitBasis)),
		hasMore,
	};
};

// Per-bucket default/hard-cap for `range`. Zod only enforces a shared outer ceiling
// (104) since it can't see which bucket was requested; the tighter cap is applied
// here once `bucket` is resolved.
const TREND_BUCKET_DEFAULTS: Record<TrendBucket, { defaultRange: number; maxRange: number }> = {
	week: { defaultRange: 26, maxRange: 104 }, // ~6 months default, 2 years cap
	month: { defaultRange: 12, maxRange: 36 }, // 1 year default, 3 years cap
};

// The date_trunc grain's matching generate_series step.
const TREND_BUCKET_INTERVAL: Record<TrendBucket, string> = {
	week: "1 week",
	month: "1 month",
};

/** Resolves bucket, clamped range, cap, and SQL interval — shared by both bucketed series. */
const resolveTrendBucket = (parsed: { bucket?: TrendBucket; range?: number }) => {
	const bucket = parsed.bucket ?? "week";
	const { defaultRange, maxRange } = TREND_BUCKET_DEFAULTS[bucket];
	return {
		bucket,
		range: Math.min(Math.max(parsed.range ?? defaultRange, 1), maxRange),
		maxRange,
		interval: TREND_BUCKET_INTERVAL[bucket],
	};
};

/** Start of a window `buckets` wide, ending at date_trunc(bucket, now()). Weeks
 * subtract fixed-length milliseconds; months walk back from the 1st (UTC) since
 * month length varies. */
const bucketCutoff = (bucket: TrendBucket, buckets: number): Date => {
	if (bucket === "week") return new Date(Date.now() - (buckets - 1) * 7 * 24 * 60 * 60 * 1000);
	const d = new Date();
	d.setUTCDate(1);
	d.setUTCMonth(d.getUTCMonth() - (buckets - 1));
	return d;
};

// GET /inventory/:id/consumption-trend — bucketed CONSUMPTION totals for the
// History-tab trend chart. Zero-filled via generate_series so a bucket with no
// consumption is a real 0, not a missing point.
export const getItemConsumptionTrend = async (
	itemId: string,
	organizationId: string,
	query: unknown = {},
) => {
	const sdb = getScopedDb(organizationId);

	const existing = await sdb.inventory_item.findFirst({
		where: { id: itemId },
		select: { id: true },
	});
	if (!existing) return { err: "Inventory item not found" as const };

	const q = parseInput(consumptionTrendQuerySchema, query);
	if (!q.ok) return { err: q.err };
	const parsed = q.data;

	const { bucket, range, interval: intervalStr } = resolveTrendBucket(parsed);
	const cutoff = bucketCutoff(bucket, range);

	const rows = await sdb.$queryRaw<{ periodStart: Date; qtyConsumed: number; units: string[] | null }[]>`
		WITH bucket_range AS (
			SELECT
				date_trunc(${bucket}, ${cutoff}::timestamptz) AS start_period,
				date_trunc(${bucket}, now()) AS end_period
		),
		buckets AS (
			SELECT generate_series(start_period, end_period, ${intervalStr}::interval) AS period_start
			FROM bucket_range
		),
		consumption AS (
			SELECT
				date_trunc(${bucket}, sm.created_at) AS period_start,
				-- Net of reversals (lib/inventory.ts CONSUMPTION_*), same as the forecast.
				SUM(${CONSUMPTION_SIGNED_QTY}) AS qty
			FROM stock_movement sm
			WHERE sm.inventory_item_id = ${itemId}
				AND sm.organization_id = ${organizationId}
				AND ${CONSUMPTION_MOVEMENT_PREDICATE}
				AND sm.created_at >= (SELECT start_period FROM bucket_range)
			GROUP BY 1
		),
		-- Stamped units over the WHOLE window, not per bucket — a per-bucket basis
		-- would still plot "each" bars beside "box" bars on one y-axis. CROSS JOINed
		-- rather than a correlated subquery so this can't drift from consumption's filter.
		series_units AS (
			SELECT array_agg(DISTINCT sm.unit) AS units
			FROM stock_movement sm
			WHERE sm.inventory_item_id = ${itemId}
				AND sm.organization_id = ${organizationId}
				AND ${CONSUMPTION_MOVEMENT_PREDICATE}
				AND sm.created_at >= (SELECT start_period FROM bucket_range)
		)
		SELECT
			b.period_start AS "periodStart",
			COALESCE(c.qty, 0)::float AS "qtyConsumed",
			su.units AS "units"
		FROM buckets b
		CROSS JOIN series_units su
		LEFT JOIN consumption c ON c.period_start = b.period_start
		ORDER BY b.period_start ASC
	`;

	// Every row carries the same series-wide array (CROSS JOIN), so one row is enough;
	// a bucket series is never empty — generate_series always emits at least one.
	const basis = unitBasis(rows[0]?.units);

	return {
		err: "",
		bucket,
		unitBasis: basis,
		points: rows.map((r) => ({
			periodStart: r.periodStart.toISOString(),
			// Withheld (null), not zeroed — 0 already means "nothing consumed" on this
			// zero-filled series, so it can't also mean "cannot be totalled".
			qtyConsumed: basis.mixed ? null : Number(r.qtyConsumed),
		})),
	};
};

// GET /inventory/:id/forecast — delegates to reportsController's shared
// buildReorderForecast so this stays in lockstep with the fleet-wide report.
// `reason` distinguishes "inactive" from "active but no forecastable row" so the
// UI doesn't conflate the two empty states; either way it's not a 404.
export const getItemForecast = async (
	itemId: string,
	organizationId: string,
	opts: { lookbackDays?: number } = {},
) => {
	const sdb = getScopedDb(organizationId);

	const existing = await sdb.inventory_item.findFirst({
		where: { id: itemId },
		// is_active distinguishes "inactive" from "no forecastable row" below.
		select: { id: true, is_active: true },
	});
	if (!existing) return { err: "Inventory item not found" as const };

	const lookbackDays = opts.lookbackDays != null && opts.lookbackDays > 0 ? opts.lookbackDays : 90;
	const forecast = await getItemReorderForecast(organizationId, itemId, { lookbackDays });

	const reason: "inactive" | "no_forecast_row" | null =
		forecast != null ? null : existing.is_active ? "no_forecast_row" : "inactive";

	return { err: "", forecast, reason };
};

// Hard cap on movements replayed for the value-history time series — a single
// item's full ledger should never realistically approach this, but caps it
// the same way REPORT_ROW_CAP does for the reports module.
const VALUE_HISTORY_ROW_CAP = 2000;

// GET /inventory/:id/value-history — running warehouse quantity over time, priced
// at the weighted-average PAID cost when receipts recorded one (costBasis "paid"),
// falling back to the item's current configured cost otherwise (costBasis
// "configured") — a directional trend, not a realized-COGS ledger.
//
// Replay is a NEWEST-N window; `openingQuantity` recovers the level before it via
// one aggregate over everything older. A NEGATIVE series (`hasNegative`) means the
// ledger predates full stock-movement coverage — left unclamped rather than
// fabricating stock that was never recorded.
export const getItemValueHistory = async (
	itemId: string,
	organizationId: string,
	query: unknown = {},
) => {
	const sdb = getScopedDb(organizationId);

	const item = await sdb.inventory_item.findFirst({
		where: { id: itemId },
		select: { id: true, cost: true },
	});
	if (!item) return { err: "Inventory item not found" as const };

	const q = parseInput(valueHistoryQuerySchema, query);
	if (!q.ok) return { err: q.err };
	const parsed = q.data;

	const where: Prisma.stock_movementWhereInput = {
		inventory_item_id: itemId,
		...(parsed.created_after ? { created_at: { gte: parsed.created_after } } : {}),
	};

	// take cap + 1 so a full page tells us rows were cut. Same (created_at, id)
	// tie-break as getInventoryMovements — a non-unique sort key would make the
	// window boundary unstable.
	const newestFirst = await sdb.stock_movement.findMany({
		where,
		select: {
			id: true,
			qty: true,
			from_location_type: true,
			to_location_type: true,
			created_at: true,
		},
		orderBy: [{ created_at: "desc" }, { id: "desc" }],
		take: VALUE_HISTORY_ROW_CAP + 1,
	});

	const truncated = newestFirst.length > VALUE_HISTORY_ROW_CAP;
	const movements = (truncated ? newestFirst.slice(0, VALUE_HISTORY_ROW_CAP) : newestFirst).reverse();

	const first = movements[0] ?? null;
	const windowStart = first ? first.created_at.toISOString() : null;

	// Only runs when the series doesn't start at the item's first movement. Row-tuple
	// comparison keeps created_at ties from being counted on both sides of the seam.
	const needsOpening = first != null && (truncated || parsed.created_after != null);

	// ONE aggregate serving two needs (one round-trip instead of two): openingQuantity
	// (stock before the window's first row) and paidQty/paidSpend (weighted-average
	// paid cost, over the WHOLE ledger regardless of window).
	const [agg] = first
		? await sdb.$queryRaw<{
				openingQuantity: number | null;
				paidQty: number | null;
				paidSpend: number | null;
				units: string[] | null;
			}[]>`
			SELECT
				-- Basis over the WHOLE ledger, wider than the displayed window: a window
				-- holding one unit is still contaminated if the ledger behind it isn't.
				array_agg(DISTINCT sm.unit) AS "units",
				COALESCE(SUM(
					CASE WHEN (sm.created_at, sm.id) < (${first.created_at}::timestamptz, ${first.id}) THEN
						CASE WHEN sm.to_location_type = 'warehouse' THEN sm.qty ELSE 0 END
						- CASE WHEN sm.from_location_type = 'warehouse' THEN sm.qty ELSE 0 END
					ELSE 0 END
				), 0)::float AS "openingQuantity",
				SUM(
					CASE WHEN sm.reason IN ('receive', 'supplier_purchase') AND sm.unit_cost IS NOT NULL
						THEN sm.qty END
				)::float AS "paidQty",
				SUM(
					CASE WHEN sm.reason IN ('receive', 'supplier_purchase') AND sm.unit_cost IS NOT NULL
						THEN sm.qty * sm.unit_cost END
				)::float AS "paidSpend"
			FROM stock_movement sm
			WHERE sm.inventory_item_id = ${itemId}
				AND sm.organization_id = ${organizationId}
		`
		: [];

	const currentCost = item.cost != null ? Number(item.cost) : null;

	// Unit break: no honest running balance to draw (it's a cumulative sum, so points
	// in one unit still depend on rows in the other) — return no points + basis so the
	// chart shows an explained state instead of a false "No history yet".
	const basis = unitBasis(agg?.units);
	if (basis.mixed) {
		return {
			err: "",
			currentCost,
			costUsed: null,
			costBasis: null,
			unitBasis: basis,
			points: [],
			truncated,
			openingQuantity: null,
			windowStart,
			hasNegative: false,
		};
	}

	const openingQuantity = needsOpening ? Number(agg?.openingQuantity ?? 0) : 0;

	// Weighted average of what was actually PAID beats the current configured cost.
	// Falls back to configured cost when no receipt recorded one; `costBasis` tells
	// the UI which reading it's looking at.
	const paidQty = Number(agg?.paidQty ?? 0);
	const wacCost =
		paidQty > 0 && agg?.paidSpend != null ? Number(agg.paidSpend) / paidQty : null;
	const costUsed = wacCost ?? currentCost;
	const costBasis: "paid" | "configured" | null =
		wacCost != null ? "paid" : currentCost != null ? "configured" : null;

	let runningQty = openingQuantity;
	let hasNegative = false;
	const points = movements.map((m) => {
		const qty = Number(m.qty);
		if (m.from_location_type === "warehouse") runningQty -= qty;
		if (m.to_location_type === "warehouse") runningQty += qty;
		if (runningQty < 0) hasNegative = true;
		return {
			date: m.created_at.toISOString(),
			quantity: runningQty,
			value: costUsed != null ? costUsed * runningQty : null,
		};
	});

	return {
		err: "",
		currentCost,
		costUsed,
		costBasis,
		unitBasis: basis,
		points,
		truncated,
		openingQuantity,
		windowStart,
		hasNegative,
	};
};

// ── Cost & pricing history ────────────────────────────────────────────────────

// Hard cap on audit-log rows replayed for the price step series. A single item's
// edit history is realistically a handful of rows; this caps it the same way
// VALUE_HISTORY_ROW_CAP does for the ledger replay.
const PRICE_HISTORY_LOG_CAP = 1000;

export interface PriceStepPoint {
	at: string;
	value: number | null;
}

// log.changes is untyped Json; a Prisma Decimal round-trips through it as either a
// number or a string. number = real amount, null = explicitly cleared, undefined =
// unusable — caller must drop the entry rather than plot 0 or NaN.
const coerceLoggedAmount = (raw: unknown): number | null | undefined => {
	if (raw === null) return null;
	if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed === "") return undefined;
		const n = Number(trimmed);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
};

// Reconstructs a STEP function (cost/price holds until edited) from audit-log diffs:
// anchored at created_at using the first change's `old` value, and tailed at `now`
// pinned to the LIVE column so log drift can't disagree with the item page.
const buildPriceStepSeries = (
	entries: { timestamp: Date; changes: Prisma.JsonValue | null }[],
	field: "cost" | "unit_price",
	itemCreatedAt: Date,
	current: number | null,
	nowIso: string,
): PriceStepPoint[] => {
	const points: PriceStepPoint[] = [];

	for (const entry of entries) {
		const changes = entry.changes as Record<string, unknown> | null;
		const diff = changes?.[field];
		if (!diff || typeof diff !== "object") continue;

		const { old: before, new: after } = diff as { old?: unknown; new?: unknown };
		const next = coerceLoggedAmount(after);
		if (next === undefined) continue;

		// Anchor only from a real prior amount. A `null` predecessor means the
		// field was unset before this change, and there's nothing to draw from
		// created_at up to it.
		if (points.length === 0) {
			const previous = coerceLoggedAmount(before);
			if (previous != null) {
				points.push({ at: itemCreatedAt.toISOString(), value: previous });
			}
		}

		points.push({ at: entry.timestamp.toISOString(), value: next });
	}

	// Never edited (or every entry was unusable): a flat line from creation to now
	// still communicates "this has always been X", which is the truth.
	if (points.length === 0) {
		if (current == null) return [];
		return [
			{ at: itemCreatedAt.toISOString(), value: current },
			{ at: nowIso, value: current },
		];
	}

	points.push({ at: nowIso, value: current });
	return points;
};

// Trims a step series to the range window, keeping the last point BEFORE the window
// and re-stamping it at the window start — otherwise the chart's first visible
// segment is missing (same reasoning as getItemValueHistory's openingQuantity).
// Generic over point shape since the paid-cost average is windowed the same way.
const windowStepSeries = <T extends { at: string }>(points: T[], from: Date | undefined): T[] => {
	if (!from) return points;
	const fromMs = from.getTime();
	const inside: T[] = [];
	let carryIn: T | null = null;

	for (const p of points) {
		if (new Date(p.at).getTime() < fromMs) carryIn = p;
		else inside.push(p);
	}

	return carryIn ? [{ ...carryIn, at: from.toISOString() }, ...inside] : inside;
};

// GET /inventory/:id/price-history — four distinct series, not conflated: set cost
// and list price (step, from the audit log — the only path that mutates them), charged
// (actually billed, bucketed), and paid cost (per-receipt + running weighted average).
// `coverageStart` reports that the log only covers changes made after audit logging began.
export const getItemPriceHistory = async (
	itemId: string,
	organizationId: string,
	query: unknown = {},
) => {
	const sdb = getScopedDb(organizationId);

	const item = await sdb.inventory_item.findFirst({
		where: { id: itemId },
		select: { id: true, cost: true, unit_price: true, created_at: true },
	});
	if (!item) return { err: "Inventory item not found" as const };

	const q = parseInput(priceHistoryQuerySchema, query);
	if (!q.ok) return { err: q.err };
	const parsed = q.data;

	const { bucket, range, maxRange, interval: intervalStr } = resolveTrendBucket(parsed);

	// The charged series must span the same window as the step series, or the chart
	// draws a list price reaching back years beside a charged price that silently stops.
	// Clamped to the bucket's cap; chargedTruncated reports that clamp rather than
	// hiding it.
	const capCutoff = bucketCutoff(bucket, maxRange);
	const desiredCutoff =
		parsed.created_after ??
		(parsed.range != null ? bucketCutoff(bucket, range) : item.created_at);
	const chargedTruncated = desiredCutoff.getTime() < capCutoff.getTime();
	const cutoff = chargedTruncated ? capCutoff : desiredCutoff;

	const [logEntries, chargedRows, chargedExtremes, allChargedSaleRows, recentSaleRows, receiptRows, supplierItems] =
		await Promise.all([
		// Ascending: the series is built forward, and the FIRST entry's `old`
		// value is what anchors it at created_at.
		sdb.log.findMany({
			where: {
				entity_type: "inventory_item",
				entity_id: itemId,
				event_type: { in: ["inventory_item.created", "inventory_item.updated"] },
			},
			select: { timestamp: true, changes: true },
			orderBy: { timestamp: "asc" },
			take: PRICE_HISTORY_LOG_CAP,
		}),
		// Realized price actually billed, zero-filled like getItemConsumptionTrend.
		// Visit line items only — invoice_line_item is generated FROM visits, so
		// counting both would double every sale. Bucketed by when the work happened
		// (actual_end_at, falling back to scheduled/created), not row-insertion time.
		// Cancelled visits/jobs excluded — never billed.
		sdb.$queryRaw<
			{
				periodStart: Date;
				qty: number;
				revenue: number;
				low: number | null;
				high: number | null;
				median: number | null;
				sales: number;
			}[]
		>`
			WITH bucket_range AS (
				SELECT
					date_trunc(${bucket}, ${cutoff}::timestamptz) AS start_period,
					date_trunc(${bucket}, now()) AS end_period
			),
			buckets AS (
				SELECT generate_series(start_period, end_period, ${intervalStr}::interval) AS period_start
				FROM bucket_range
			),
			charged AS (
				SELECT
					date_trunc(${bucket}, COALESCE(jv.actual_end_at, jv.scheduled_start_at, jli.created_at)) AS period_start,
					SUM(jli.quantity) AS qty,
					SUM(jli.quantity * jli.unit_price) AS revenue,
					-- Dispersion within the bucket. The average above is the
					-- money-true figure and stays the plotted line; these expose
					-- that the same month held a $560 wholesale and a $660 retail
					-- sale, which one averaged point erases.
					--
					-- Per SALE, unweighted: one 1-unit sale at $900 counts as much
					-- as a 50-unit one. That's the intended read of "what did this
					-- item go out at", not a confidence interval.
					MIN(jli.unit_price) AS low,
					MAX(jli.unit_price) AS high,
					percentile_cont(0.5) WITHIN GROUP (ORDER BY jli.unit_price) AS median,
					COUNT(*) AS sales
				FROM job_visit_line_item jli
				JOIN job_visit jv ON jv.id = jli.visit_id
				JOIN job j ON j.id = jv.job_id
				WHERE jli.inventory_item_id = ${itemId}
					AND j.organization_id = ${organizationId}
					AND jv.status <> 'Cancelled'::visit_status
					AND j.status <> 'Cancelled'::job_status
					AND COALESCE(jv.actual_end_at, jv.scheduled_start_at, jli.created_at)
						>= (SELECT start_period FROM bucket_range)
				GROUP BY 1
			)
			SELECT
				b.period_start AS "periodStart",
				COALESCE(c.qty, 0)::float AS "qty",
				COALESCE(c.revenue, 0)::float AS "revenue",
				-- Left NULL on an empty bucket rather than zero-filled like qty:
				-- a month with no sales has no realized price, and a $0 band would
				-- draw one straight through the floor of the chart.
				c.low::float AS "low",
				c.high::float AS "high",
				c.median::float AS "median",
				COALESCE(c.sales, 0)::int AS "sales"
			FROM buckets b
			LEFT JOIN charged c ON c.period_start = b.period_start
			ORDER BY b.period_start ASC
		`,
		// Who was behind each bucket's cheapest and dearest sale. Separate query
		// because the aggregate above can't carry a row-level attribute out of a
		// GROUP BY, and window functions can't live inside it.
		//
		// EVERY filter and the bucket expression are duplicated verbatim from the
		// aggregate — a divergence here (a different clock, a missing cancellation
		// filter) would name a client for a price that isn't in the bucket.
		sdb.$queryRaw<{ periodStart: Date; lowClient: string | null; highClient: string | null }[]>`
			WITH sales AS (
				SELECT
					date_trunc(${bucket}, COALESCE(jv.actual_end_at, jv.scheduled_start_at, jli.created_at)) AS period_start,
					jli.unit_price AS unit_price,
					cl.name AS client_name
				FROM job_visit_line_item jli
				JOIN job_visit jv ON jv.id = jli.visit_id
				JOIN job j ON j.id = jv.job_id
				JOIN client cl ON cl.id = j.client_id
				WHERE jli.inventory_item_id = ${itemId}
					AND j.organization_id = ${organizationId}
					AND jv.status <> 'Cancelled'::visit_status
					AND j.status <> 'Cancelled'::job_status
					AND COALESCE(jv.actual_end_at, jv.scheduled_start_at, jli.created_at)
						>= (SELECT date_trunc(${bucket}, ${cutoff}::timestamptz))
			),
			ranked AS (
				SELECT
					period_start,
					client_name,
					-- Name breaks ties so two clients at the same low price don't
					-- swap places between requests.
					row_number() OVER (PARTITION BY period_start ORDER BY unit_price ASC, client_name ASC) AS lo_rank,
					row_number() OVER (PARTITION BY period_start ORDER BY unit_price DESC, client_name ASC) AS hi_rank
				FROM sales
			)
			SELECT
				period_start AS "periodStart",
				MAX(client_name) FILTER (WHERE lo_rank = 1) AS "lowClient",
				MAX(client_name) FILTER (WHERE hi_rank = 1) AS "highClient"
			FROM ranked
			WHERE lo_rank = 1 OR hi_rank = 1
			GROUP BY period_start
		`,
		// EVERY sale in the window, unaggregated — the per-bucket hard numbers the
		// chart tooltip lists (price · client · date) instead of just the bucket's
		// average and its two extremes. Same filters/clock/window as the aggregate
		// above, boundary included, so a sale that's in one is in the other.
		sdb.$queryRaw<{ at: Date; unitPrice: number; clientName: string | null }[]>`
			SELECT
				COALESCE(jv.actual_end_at, jv.scheduled_start_at, jli.created_at) AS "at",
				jli.unit_price AS "unitPrice",
				cl.name AS "clientName"
			FROM job_visit_line_item jli
			JOIN job_visit jv ON jv.id = jli.visit_id
			JOIN job j ON j.id = jv.job_id
			JOIN client cl ON cl.id = j.client_id
			WHERE jli.inventory_item_id = ${itemId}
				AND j.organization_id = ${organizationId}
				AND jv.status <> 'Cancelled'::visit_status
				AND j.status <> 'Cancelled'::job_status
				AND COALESCE(jv.actual_end_at, jv.scheduled_start_at, jli.created_at)
					>= date_trunc(${bucket}, ${cutoff}::timestamptz)
			ORDER BY "at" ASC
		`,
		// The two most recent individual sales, unaggregated — the "what did we
		// actually just charge" fact a manager wants, not a bucket average. Same
		// filters/clock as the aggregate above so it can't disagree with the chart
		// about which sales count.
		sdb.$queryRaw<{ at: Date; unitPrice: number; clientName: string | null }[]>`
			SELECT
				COALESCE(jv.actual_end_at, jv.scheduled_start_at, jli.created_at) AS "at",
				jli.unit_price AS "unitPrice",
				cl.name AS "clientName"
			FROM job_visit_line_item jli
			JOIN job_visit jv ON jv.id = jli.visit_id
			JOIN job j ON j.id = jv.job_id
			JOIN client cl ON cl.id = j.client_id
			WHERE jli.inventory_item_id = ${itemId}
				AND j.organization_id = ${organizationId}
				AND jv.status <> 'Cancelled'::visit_status
				AND j.status <> 'Cancelled'::job_status
				AND COALESCE(jv.actual_end_at, jv.scheduled_start_at, jli.created_at) >= ${cutoff}::timestamptz
			ORDER BY "at" DESC
			LIMIT 2
		`,
		// Per-receipt purchase cost. Includes `supplier_purchase` (field purchase, never
		// touches the warehouse) alongside `receive`. Rows with no unit_cost are still
		// returned so their count can inform the coverage figure.
		//
		// Deliberately NOT filtered by created_after — the weighted average is a running
		// total over everything bought to date; windowing is applied to the OUTPUT below.
		sdb.stock_movement.findMany({
			where: {
				inventory_item_id: itemId,
				reason: { in: ["receive", "supplier_purchase"] },
			},
			select: {
				created_at: true,
				qty: true,
				unit: true,
				unit_cost: true,
				supplier: { select: { id: true, name: true } },
				movement_batches: {
					select: {
						batch: {
							select: {
								batch_number: true,
								// Both the entity and the legacy free-text column:
								// pre-migration lots only ever had the text, and the
								// backfill can't resolve a blank or unparseable one.
								supplier: true,
								supplier_ref: { select: { id: true, name: true } },
							},
						},
					},
					take: 1,
				},
			},
			orderBy: [{ created_at: "asc" }, { id: "asc" }],
			take: PRICE_HISTORY_LOG_CAP,
		}),
		// The vendor price list, unwindowed like the WAC average above — "last
		// paid" and "contract" are facts about the vendor relationship, not about
		// this chart's date range.
		sdb.supplier_item.findMany({
			where: { organization_id: organizationId, inventory_item_id: itemId },
			select: { supplier_id: true, contract_price: true, last_price: true, is_preferred: true },
		}),
	]);

	// Keyed by supplier id: only entity-linked receipts (never the unattributed
	// or legacy free-text rows) can join a price-list row, since supplier_item
	// itself requires a supplier entity.
	const priceListBySupplier = new Map(supplierItems.map((s) => [s.supplier_id, s]));

	// Newest first, guarded against a malformed row rather than trusting the
	// query — this is the fact the headline stat anchors on, so a bad row
	// should drop out silently rather than crash the whole endpoint.
	const recentSales = (recentSaleRows ?? [])
		.filter((r) => r?.at != null && r?.unitPrice != null)
		.map((r) => ({
			at: new Date(r.at).toISOString(),
			unitPrice: Number(r.unitPrice),
			clientName: r.clientName ?? null,
		}));

	// Same guard, same shape, for the full per-bucket breakdown the tooltip
	// lists — every sale in the window, not just the last two.
	const chargedSales = (allChargedSaleRows ?? [])
		.filter((r) => r?.at != null && r?.unitPrice != null)
		.map((r) => ({
			at: new Date(r.at).toISOString(),
			unitPrice: Number(r.unitPrice),
			clientName: r.clientName ?? null,
		}));

	// Keyed on the same ISO stamp the points below emit, so the join can't drift
	// from the aggregate's bucket boundaries.
	const extremesByPeriod = new Map(
		chargedExtremes.map((e) => [
			e.periodStart.toISOString(),
			{ lowClient: e.lowClient, highClient: e.highClient },
		]),
	);

	const nowIso = new Date().toISOString();
	const currentCost = item.cost != null ? Number(item.cost) : null;
	const currentPrice = item.unit_price != null ? Number(item.unit_price) : null;

	const costPoints = windowStepSeries(
		buildPriceStepSeries(logEntries, "cost", item.created_at, currentCost, nowIso),
		parsed.created_after,
	);
	const pricePoints = windowStepSeries(
		buildPriceStepSeries(logEntries, "unit_price", item.created_at, currentPrice, nowIso),
		parsed.created_after,
	);

	// Running weighted average over every receipt with a cost, skipping ones without
	// (not treated as $0) and counting them in costCoverage. Basis matches the
	// unwindowed query above, since the average carries in from outside the window.
	const receiptBasis = unitBasis(receiptRows.map((r) => r.unit));

	let wacQty = 0;
	let wacSpend = 0;
	const allReceipts: {
		at: string;
		unitCost: number;
		qty: number;
		unit: string;
		batchNumber: string | null;
		supplierId: string | null;
		supplierName: string | null;
	}[] = [];
	const allWac: { at: string; value: number }[] = [];

	const fromMs = parsed.created_after?.getTime();

	// Origin of one receipt, in the order the data became trustworthy: the
	// movement's own supplier (recorded from this release on), then the lot's
	// entity, then the lot's legacy free text. A legacy name has no id, so it
	// groups under its name below — dropping it would report vendors the org DID
	// record, just not as entities, as if nobody had written them down.
	const receiptOrigin = (r: (typeof receiptRows)[number]) => {
		const batch = r.movement_batches[0]?.batch;
		return {
			supplierId: r.supplier?.id ?? batch?.supplier_ref?.id ?? null,
			supplierName:
				r.supplier?.name ?? batch?.supplier_ref?.name ?? batch?.supplier ?? null,
		};
	};

	// Counted over EVERY windowed receipt, not just the priced ones, so the
	// coverage line compares against the same denominator as `receipts` below.
	let windowWithSupplier = 0;

	for (const r of receiptRows) {
		const origin = receiptOrigin(r);
		if (
			(fromMs == null || r.created_at.getTime() >= fromMs) &&
			(origin.supplierId != null || origin.supplierName != null)
		) {
			windowWithSupplier++;
		}

		if (r.unit_cost == null) continue;
		const unitCost = Number(r.unit_cost);
		const qty = Number(r.qty);
		if (!Number.isFinite(unitCost) || !Number.isFinite(qty) || qty <= 0) continue;

		allReceipts.push({
			at: r.created_at.toISOString(),
			unitCost,
			qty,
			// Per-receipt, stamped. A receipt is a single fact ("$18 per box on this
			// date") and stays truthful across a unit break, so the markers survive
			// where the average can't — but only because each one now names its own
			// denomination instead of borrowing the item's.
			unit: r.unit,
			batchNumber: r.movement_batches[0]?.batch?.batch_number ?? null,
			...origin,
		});

		// Skipped entirely (not emitted-and-flagged) on a unit break — a plotted
		// line invites reading a trend off it regardless of any note underneath.
		if (receiptBasis.mixed) continue;
		wacQty += qty;
		wacSpend += qty * unitCost;
		allWac.push({ at: r.created_at.toISOString(), value: wacSpend / wacQty });
	}

	// The average carries in at the window start (same contract as the step series);
	// individual receipt markers do NOT — re-stamping one would invent a purchase.
	const wac = windowStepSeries(allWac, parsed.created_after);
	const receipts =
		fromMs == null
			? allReceipts
			: allReceipts.filter((r) => new Date(r.at).getTime() >= fromMs);
	const windowReceiptRows =
		fromMs == null
			? receiptRows.length
			: receiptRows.filter((r) => r.created_at.getTime() >= fromMs).length;

	// Per-vendor rollup over the windowed, priced receipts. Unattributed ones
	// collapse into a single explicit row rather than being dropped — a chart
	// claiming three suppliers when a third of the spend has no origin recorded
	// is the exact overstatement this feature exists to remove.
	const supplierGroups = new Map<
		string,
		{
			supplierId: string | null;
			supplierName: string;
			unattributed: boolean;
			receipts: number;
			qty: number;
			spend: number;
			minUnitCost: number;
			maxUnitCost: number;
			firstAt: string;
			lastAt: string;
		}
	>();

	for (const r of receipts) {
		// Match the same normalization resolveSupplier/mergeSuppliers use for
		// dedupe, so two legacy free-text spellings that differ only by
		// whitespace don't fragment into separate rows here.
		const key =
			r.supplierId ?? (r.supplierName ? `name:${normalizeSupplierName(r.supplierName)}` : "");
		const existing = supplierGroups.get(key);
		if (existing) {
			existing.receipts++;
			existing.qty += r.qty;
			existing.spend += r.qty * r.unitCost;
			existing.minUnitCost = Math.min(existing.minUnitCost, r.unitCost);
			existing.maxUnitCost = Math.max(existing.maxUnitCost, r.unitCost);
			// receiptRows is ordered by created_at asc, so first/last need no comparison.
			existing.lastAt = r.at;
			continue;
		}
		supplierGroups.set(key, {
			supplierId: r.supplierId,
			supplierName: r.supplierName ?? "Unrecorded",
			unattributed: key === "",
			receipts: 1,
			qty: r.qty,
			spend: r.qty * r.unitCost,
			minUnitCost: r.unitCost,
			maxUnitCost: r.unitCost,
			firstAt: r.at,
			lastAt: r.at,
		});
	}

	const bySupplier = [...supplierGroups.values()]
		.map((g) => {
			// Null for the unattributed row and any legacy free-text vendor — both
			// lack a supplierId, and supplier_item requires a real entity to key on.
			const priceList = g.supplierId != null ? priceListBySupplier.get(g.supplierId) : undefined;
			const { price: lastPaid, priceSource } = resolveVendorPrice(
				priceList?.contract_price,
				priceList?.last_price,
			);
			return {
				supplierId: g.supplierId,
				supplierName: g.supplierName,
				unattributed: g.unattributed,
				receipts: g.receipts,
				spend: g.spend,
				firstAt: g.firstAt,
				lastAt: g.lastAt,
				// Money sums across a unit break; per-unit figures do not. 10 boxes at
				// $18 and 4 units at $3 have a real combined spend and no real average.
				...(receiptBasis.mixed
					? { qty: null, avgUnitCost: null, minUnitCost: null, maxUnitCost: null }
					: {
							qty: g.qty,
							avgUnitCost: g.qty > 0 ? g.spend / g.qty : null,
							minUnitCost: g.minUnitCost,
							maxUnitCost: g.maxUnitCost,
						}),
				// From the self-maintaining vendor price list, not from receipts in
				// this window — resolveVendorPrice is the same rule attachPreferredVendors
				// uses for the reorder forecast, so the two never disagree.
				lastPaid,
				priceSource,
				isPreferred: priceList?.is_preferred ?? false,
			};
		})
		.sort((a, b) => {
			// Unrecorded sits last regardless of spend — it's a gap in the data,
			// not a vendor competing for the top of the list.
			if (a.unattributed !== b.unattributed) return a.unattributed ? 1 : -1;
			return b.spend - a.spend;
		});

	return {
		err: "",
		cost: { current: currentCost, points: costPoints },
		price: { current: currentPrice, points: pricePoints },
		charged: {
			bucket,
			points: chargedRows.map((r) => {
				const qty = Number(r.qty);
				const revenue = Number(r.revenue);
				const periodStart = r.periodStart.toISOString();
				const sales = Number(r.sales);
				const low = r.low != null ? Number(r.low) : null;
				const high = r.high != null ? Number(r.high) : null;
				// A band needs two prices that actually differ. One sale, or many
				// at one price, would otherwise draw a zero-height ribbon that
				// reads as "we measured a spread" when there was none.
				const hasBand = sales > 1 && low != null && high != null && low !== high;
				const extremes = extremesByPeriod.get(periodStart);
				return {
					periodStart,
					qty,
					revenue,
					avgUnitPrice: qty > 0 ? revenue / qty : null,
					sales,
					low: hasBand ? low : null,
					high: hasBand ? high : null,
					median: r.median != null ? Number(r.median) : null,
					lowClient: hasBand ? (extremes?.lowClient ?? null) : null,
					highClient: hasBand ? (extremes?.highClient ?? null) : null,
				};
			}),
			// Every sale in the window, unaggregated — what the chart tooltip lists
			// per bucket (price · client · date) instead of just `points`' average
			// and two extremes. The frontend buckets these itself against the
			// `periodStart` values above.
			sales: chargedSales,
		},
		// The last 1-2 individual sales, unaveraged — what the "(latest)" headline
		// stat actually reads. `charged.points` stays a bucketed average; this is
		// the real last invoice line.
		recentSales,
		receipts,
		bySupplier,
		wac,
		// Denomination of the two MOVEMENT-derived series only — set-cost/list-price are
		// configured amounts off the item, unaffected by a unit break.
		unitBasis: receiptBasis,
		// receipts/withCost describe THIS window; wacBasisReceipts is the evidence behind
		// the average overall. All three are counts, so they stay truthful across a unit break.
		costCoverage: {
			receipts: windowReceiptRows,
			withCost: receipts.length,
			wacBasisReceipts: allReceipts.length,
			// Attribution is its own gap: a receipt can carry a cost and still
			// name nobody. Stated so the chart reads "12 of 18 name a supplier"
			// instead of implying the rollup covers every purchase.
			withSupplier: windowWithSupplier,
		},
		// Where the charged series actually starts, and whether older sales were
		// cut off by the bucket cap. Never inferred from the first bucket — a
		// zero-filled leading bucket looks identical to a truncated one.
		chargedWindowStart: cutoff.toISOString(),
		chargedTruncated,
		// Null when the item has no audit history at all — the UI must not claim
		// coverage "since" a date that doesn't exist.
		coverageStart: logEntries[0]?.timestamp.toISOString() ?? null,
		itemCreatedAt: item.created_at.toISOString(),
	};
};

// ── Serial/batch listings ─────────────────────────────────────────────────────
// Cursor pagination follows the same convention as getInventoryMovements/
// getVehicleMovements: limit defaults to 25 and is clamped to 100, cursor is
// the id of the last row from the previous page, take+1 detects a next page.

export const listItemSerials = async (
	itemId: string,
	query: unknown,
	organizationId: string,
) => {
	const sdb = getScopedDb(organizationId);

	const existing = await sdb.inventory_item.findFirst({ where: { id: itemId } });
	if (!existing) return { err: "Inventory item not found" as const };

	const q = parseInput(listSerialsQuerySchema, query);
	if (!q.ok) return { err: q.err };
	const parsed = q.data;

	const take = Math.min(Math.max(parsed.limit ?? 25, 1), 100);

	const serials = await sdb.serial_unit.findMany({
		where: {
			inventory_item_id: itemId,
			...(parsed.status ? { status: parsed.status } : {}),
			...(parsed.vehicle_id ? { current_vehicle_id: parsed.vehicle_id } : {}),
			...(parsed.batch_id ? { batch_id: parsed.batch_id } : {}),
			...(parsed.search
				? {
						OR: [
							{ serial_number: { contains: parsed.search, mode: "insensitive" } },
							{ code: { contains: parsed.search, mode: "insensitive" } },
						],
					}
				: {}),
		},
		// id tiebreaker — serials from one receive share an exact received_at
		// (single createMany), so a non-unique sort key alone makes cursor
		// pagination skip/duplicate rows across pages (matches getInventoryMovements).
		orderBy: [{ received_at: "desc" }, { id: "desc" }],
		take: take + 1,
		...(parsed.cursor ? { cursor: { id: parsed.cursor }, skip: 1 } : {}),
	});

	const hasNext = serials.length > take;
	const page = hasNext ? serials.slice(0, take) : serials;
	const nextCursor = hasNext ? page[page.length - 1].id : null;

	return { err: "", serials: page, nextCursor };
};

export const listItemBatches = async (itemId: string, organizationId: string, query: unknown = {}) => {
	const sdb = getScopedDb(organizationId);

	const existing = await sdb.inventory_item.findFirst({ where: { id: itemId } });
	if (!existing) return { err: "Inventory item not found" as const };

	const q = parseInput(listBatchesQuerySchema, query);
	if (!q.ok) return { err: q.err };
	const parsed = q.data;

	const batches = await sdb.stock_batch.findMany({
		where: {
			inventory_item_id: itemId,
			...(parsed.search
				? {
						OR: [
							{ batch_number: { contains: parsed.search, mode: "insensitive" } },
							{ code: { contains: parsed.search, mode: "insensitive" } },
						],
					}
				: {}),
		},
		orderBy: { received_at: "asc" }, // FIFO order, matches how batches are consumed
		include: {
			vehicle_batches: { include: { vehicle: { select: { id: true, name: true } } } },
		},
	});

	const mapped = batches.map((b) => ({
		id: b.id,
		code: b.code,
		batch_number: b.batch_number,
		expires_at: b.expires_at ? b.expires_at.toISOString() : null,
		supplier: b.supplier,
		recalled_at: b.recalled_at ? b.recalled_at.toISOString() : null,
		qty_received: Number(b.qty_received),
		qty_in_warehouse: Number(b.qty_in_warehouse),
		vehicles: b.vehicle_batches.map((vb) => ({
			vehicle_id: vb.vehicle_id,
			vehicle_name: vb.vehicle.name,
			qty_on_hand: Number(vb.qty_on_hand),
		})),
	}));

	return { err: "", batches: mapped };
};

// GET /inventory/:itemId/tracking-summary — per-item rollups for the Serials/
// Batches page header: serial_unit counts bucketed by status, plus batch lot
// count and summed warehouse/vehicle quantities. Aggregated with groupBy/count/
// aggregate (no per-row fetch — not N+1). serial_unit.groupBy is NOT auto-scoped
// by getScopedDb (the query extension only covers findMany/count/aggregate), so
// the org filter is pinned explicitly; stock_batch/vehicle_stock_batch aggregate
// calls ARE scoped by the extension.
export const getItemTrackingSummary = async (itemId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);

	const existing = await sdb.inventory_item.findFirst({ where: { id: itemId } });
	if (!existing) return { err: "Inventory item not found" as const };

	const [serialGroups, lots, warehouseAgg, vehicleAgg] = await Promise.all([
		sdb.serial_unit.groupBy({
			by: ["status"],
			where: { inventory_item_id: itemId, organization_id: organizationId },
			_count: { _all: true },
		}),
		sdb.stock_batch.count({ where: { inventory_item_id: itemId } }),
		sdb.stock_batch.aggregate({
			where: { inventory_item_id: itemId },
			_sum: { qty_in_warehouse: true },
		}),
		sdb.vehicle_stock_batch.aggregate({
			where: { batch: { inventory_item_id: itemId } },
			_sum: { qty_on_hand: true },
		}),
	]);

	const serials = { in_warehouse: 0, on_vehicle: 0, consumed: 0, lost: 0, returned: 0 };
	for (const g of serialGroups) {
		const status = g.status as keyof typeof serials;
		if (status in serials) serials[status] = g._count._all;
	}

	return {
		err: "",
		summary: {
			serials,
			batches: {
				lots,
				qty_in_warehouse: Number(warehouseAgg._sum.qty_in_warehouse ?? 0),
				qty_on_vehicles: Number(vehicleAgg._sum.qty_on_hand ?? 0),
			},
		},
	};
};

// GET /inventory/:itemId/vehicle-stock — per-vehicle qty for the Overview tab's
// "on vehicles" drill-in. vehicle_stock_item.qty_on_hand is the ONE cache
// recordMovements() upserts on every movement regardless of tracking mode
// (services/stockMovements.ts, step 7) — serialized, batch-tracked, dual, and
// untracked items all net through it identically, so this single query covers
// every StockPlacementCard variant instead of re-deriving the split three
// different ways (serial_unit groupBy, vehicle_stock_batch aggregate, etc).
export const getItemVehicleStock = async (itemId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);

	const existing = await sdb.inventory_item.findFirst({ where: { id: itemId } });
	if (!existing) return { err: "Inventory item not found" as const };

	const rows = await sdb.vehicle_stock_item.findMany({
		where: { inventory_item_id: itemId, qty_on_hand: { gt: 0 } },
		include: {
			vehicle: {
				select: {
					id: true,
					name: true,
					status: true,
					current_technicians: { select: { name: true }, take: 1 },
				},
			},
		},
		orderBy: { qty_on_hand: "desc" },
	});

	return {
		err: "",
		rows: rows.map((r) => ({
			vehicle_id: r.vehicle.id,
			vehicle_name: r.vehicle.name,
			vehicle_status: r.vehicle.status,
			technician_name: r.vehicle.current_technicians[0]?.name ?? null,
			qty_on_hand: Number(r.qty_on_hand),
		})),
	};
};

// GET /inventory/:itemId/tracking-eligibility — the exact facts PATCH
// /inventory/:id/tracking gates on, so the edit form can explain a block BEFORE
// the user saves. `blockers` comes from trackingLivenessBlockers, the same
// function the PATCH gate throws from.
export const getTrackingEligibility = async (itemId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);

	const item = await sdb.inventory_item.findFirst({ where: { id: itemId } });
	if (!item) return { err: "Inventory item not found" as const };

	const [vehicleAgg, vehiclesHolding, live] = await Promise.all([
		sdb.vehicle_stock_item.aggregate({
			where: { inventory_item_id: itemId },
			_sum: { qty_on_hand: true },
		}),
		sdb.vehicle_stock_item.count({
			where: { inventory_item_id: itemId, qty_on_hand: { gt: 0 } },
		}),
		countTrackingLiveness(sdb as unknown as Prisma.TransactionClient, itemId, organizationId),
	]);

	const qtyWarehouse = Number(item.quantity ?? 0);
	const qtyOnVehicles = Number(vehicleAgg._sum.qty_on_hand ?? 0);

	const blockers: string[] = [];
	if (item.provisional) {
		blockers.push("Provisional items can't be tracked — approve this item first");
	}
	const totalOnHand = qtyWarehouse + qtyOnVehicles;
	if (totalOnHand !== 0) {
		blockers.push(
			`${totalOnHand} unit(s) on hand (${qtyWarehouse} in the warehouse, ${qtyOnVehicles} on ${vehiclesHolding} vehicle(s)) — reduce to zero first`,
		);
	}

	// Enabling only ever hits the on-hand/provisional gate; the liveness checks
	// apply to a disable or a serialized↔batch switch.
	const canEnable = blockers.length === 0;

	const disableBlockers = [...blockers, ...trackingLivenessBlockers(live)];

	return {
		err: "",
		eligibility: {
			provisional: item.provisional,
			is_serialized: item.is_serialized,
			is_batch_tracked: item.is_batch_tracked,
			qty_warehouse: qtyWarehouse,
			qty_on_vehicles: qtyOnVehicles,
			vehicle_count: vehiclesHolding,
			live_serials: live.liveSerials,
			live_lots: live.liveLots,
			history_serials: live.totalSerials,
			history_lots: live.totalLots,
			can_enable: canEnable,
			can_disable: disableBlockers.length === 0,
			blockers: disableBlockers,
		},
	};
};

// ── Batch edit (metadata + recall flag) ───────────────────────────────────────
// batch_number carries a per-item unique index ([organization_id,
// inventory_item_id, batch_number]); a rename collision surfaces as a P2002.
// Same house idiom as isSerialNumberConflict / uniqueConflictField above.
const isBatchNumberConflict = (e: unknown): boolean => p2002TargetHits(e, "batch_number");

// PATCH /inventory/batches/:batchId — edit lot METADATA only (batch_number,
// expires_at, supplier, note) plus the recall flag. Touches NO stock quantities,
// so a direct prisma update is correct (mirrors how serial `note` is a direct
// update). qty_received / qty_in_warehouse remain the exclusive domain of
// recordMovements.
export async function updateBatch(
	batchId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
): Promise<{ err?: string; batch?: object }> {
	const sdb = getScopedDb(organizationId);

	const existing = await sdb.stock_batch.findFirst({ where: { id: batchId } });
	if (!existing) return { err: "Batch not found" };

	const q = parseInput(updateBatchSchema, data);
	if (!q.ok) return { err: q.err };
	const parsed = q.data;

	const wasRecalled = existing.recalled_at !== null;
	let updated;
	try {
		updated = await sdb.stock_batch.update({
			where: { id: batchId },
			data: {
				...(parsed.batch_number !== undefined ? { batch_number: parsed.batch_number } : {}),
				...(parsed.expires_at !== undefined ? { expires_at: parsed.expires_at ? new Date(parsed.expires_at) : null } : {}),
				...(parsed.supplier !== undefined ? { supplier: parsed.supplier } : {}),
				...(parsed.note !== undefined ? { note: parsed.note } : {}),
				...(parsed.recalled !== undefined
					? { recalled_at: parsed.recalled ? (existing.recalled_at ?? new Date()) : null }
					: {}),
			},
		});
	} catch (e) {
		if (isBatchNumberConflict(e)) return { err: "Batch number already in use for this item" };
		throw e;
	}

	// Audit the metadata edit (recall toggle keeps its own dedicated event below).
	const metaChanges: Record<string, { old: unknown; new: unknown }> = {};
	if (parsed.batch_number !== undefined && parsed.batch_number !== existing.batch_number)
		metaChanges.batch_number = { old: existing.batch_number, new: updated.batch_number };
	if (parsed.supplier !== undefined && parsed.supplier !== existing.supplier)
		metaChanges.supplier = { old: existing.supplier, new: updated.supplier };
	if (parsed.expires_at !== undefined) {
		const oldIso = existing.expires_at ? existing.expires_at.toISOString() : null;
		const newIso = updated.expires_at ? updated.expires_at.toISOString() : null;
		if (oldIso !== newIso) metaChanges.expires_at = { old: oldIso, new: newIso };
	}
	if (Object.keys(metaChanges).length > 0) {
		await logActivity({
			event_type: "stock_batch.updated",
			action: "updated",
			entity_type: "stock_batch",
			entity_id: batchId,
			organization_id: organizationId,
			...getActorInfo(context),
			changes: metaChanges,
		});
	}

	if (parsed.recalled !== undefined && parsed.recalled !== wasRecalled) {
		await logActivity({
			event_type: "stock_batch.recall_toggled",
			action: "updated",
			entity_type: "stock_batch",
			entity_id: batchId,
			organization_id: organizationId,
			...getActorInfo(context),
			changes: { recalled_at: { old: existing.recalled_at, new: updated.recalled_at } },
		});
	}

	emitInventoryUpdated(organizationId, { itemId: existing.inventory_item_id });

	return {
		batch: {
			id: updated.id,
			code: updated.code,
			batch_number: updated.batch_number,
			expires_at: updated.expires_at ? updated.expires_at.toISOString() : null,
			supplier: updated.supplier,
			note: updated.note,
			recalled_at: updated.recalled_at ? updated.recalled_at.toISOString() : null,
			qty_received: Number(updated.qty_received),
			qty_in_warehouse: Number(updated.qty_in_warehouse),
		},
	};
}

// DELETE /inventory/batches/:batchId — hard-delete an EMPTY lot record. Mirrors
// deleteSerial's conservative stance: reject anything that isn't safe rather than
// forcing. A batch is deletable ONLY when it holds zero stock everywhere and has
// no downstream references that the FK graph would corrupt on delete:
//   • qty_in_warehouse must be 0                       (else 4xx — reduce first)
//   • every vehicle's qty_on_hand must be 0            (else 4xx — remove first)
//   • no serial_unit references it (FK is SET NULL)    (else 4xx — would silently
//     drop per-unit recall linkage)
//   • never moved: no stock_movement_batch join at all (STRICT — any movement
//     history, not just "consumed", blocks the delete; that join IS the recall/
//     audit trail, symmetric with the serial "never-moved" rule)
// All guards re-run INSIDE the tx against a locked row (SELECT … FOR UPDATE) so a
// concurrent bump between the pre-tx existence check and the delete can't slip past.
// Because the batch is already zero everywhere, NO compensating movement is needed
// (unlike deleteSerial, which zeroes a still-held unit) — deletion writes no stock
// quantity at all. Residual zero-qty vehicle_stock_batch rows persist after a
// return-to-warehouse (they are decremented, never deleted) and would block the
// delete via the RESTRICT FK, so they are cleared inside the transaction; all are
// zero (guarded above) so removing those cache rows changes no quantity.
class BatchNotDeletableError extends Error {}

export const deleteBatch = async (
	batchId: string,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		// Cheap existence + org-scope check for the not-found fast path (and to
		// carry inventory_item_id out for the socket emit). All deletability guards
		// are re-run INSIDE the tx against the locked row — see below.
		const exists = await sdb.stock_batch.findFirst({
			where: { id: batchId },
			select: { id: true, inventory_item_id: true },
		});
		if (!exists) return { err: "Batch not found" };

		await sdb.$transaction(async (tx) => {
			// TOCTOU: lock the batch row FIRST, then re-read + re-run every guard
			// against that locked snapshot so a concurrent stock bump / movement
			// insert between the pre-tx check and the delete cannot slip through.
			await lockBatchRows(tx as unknown as Prisma.TransactionClient, [batchId]);

			const batch = await tx.stock_batch.findFirst({
				where: { id: batchId },
				include: {
					vehicle_batches: { select: { id: true, qty_on_hand: true } },
					_count: { select: { serial_units: true } },
				},
			});
			if (!batch) throw new BatchNotDeletableError("Batch not found");

			const warehouseQty = Number(batch.qty_in_warehouse);
			if (warehouseQty !== 0)
				throw new BatchNotDeletableError(
					`Cannot delete a batch with ${warehouseQty} unit(s) still in the warehouse — reduce to zero first`,
				);

			const vehicleQty = batch.vehicle_batches.reduce((s, vb) => s + Number(vb.qty_on_hand), 0);
			if (vehicleQty !== 0)
				throw new BatchNotDeletableError(
					`Cannot delete a batch still held on a vehicle (${vehicleQty} unit(s)) — remove from vehicles first`,
				);

			if (batch._count.serial_units > 0)
				throw new BatchNotDeletableError(
					"Cannot delete a batch with associated serial units — delete or reassign them first",
				);

			// STRICT policy: ANY movement-history join blocks the delete (not just
			// "consumed"). That join IS the recall/audit trail — symmetric with the
			// serial "never-moved" rule.
			const movementJoins = await tx.stock_movement_batch.count({ where: { batch_id: batchId } });
			if (movementJoins > 0)
				throw new BatchNotDeletableError(
					"Cannot delete a batch with movement history — it is needed for recall reporting",
				);

			if (batch.vehicle_batches.length > 0) {
				await tx.vehicle_stock_batch.deleteMany({ where: { batch_id: batchId } });
			}

			await tx.stock_batch.delete({ where: { id: batchId } });

			await logActivity({
				event_type: "stock_batch.deleted",
				action: "deleted",
				entity_type: "stock_batch",
				entity_id: batchId,
				organization_id: organizationId,
				...getActorInfo(context),
				changes: {
					batch_number: { old: batch.batch_number, new: null },
				},
			});
		});

		emitInventoryUpdated(organizationId, { itemId: exists.inventory_item_id });

		return { err: "" };
	} catch (e) {
		if (e instanceof BatchNotDeletableError) return { err: e.message };
		console.error("Delete batch error:", e);
		return { err: "Internal server error" };
	}
};

// ── Recall report ──────────────────────────────────────────────────────────────
// Serial-level consumption reads serial_unit.status directly (a reversal already
// clears the consumption snapshot in place — see applyTracking's isReversal
// branch — so no netting is needed there). Qty-only batch allocations have no
// per-unit row, so consumption vs. reversal is netted by visit_line_item_id
// (movements carry no back-reference to the movement they reverse).

export async function getBatchImpact(batchId: string, organizationId: string) {
	const sdb = getScopedDb(organizationId);

	const batch = await sdb.stock_batch.findFirst({
		where: { id: batchId },
		include: {
			inventory_item: { select: { id: true, name: true, is_serialized: true } },
			vehicle_batches: { include: { vehicle: { select: { id: true, name: true } } } },
		},
	});
	if (!batch) return { err: "Batch not found" as const };

	const remaining_vehicles = batch.vehicle_batches.map((vb) => ({
		vehicle_id: vb.vehicle_id,
		vehicle_name: vb.vehicle.name,
		qty_on_hand: Number(vb.qty_on_hand),
	}));
	const remaining_warehouse = Number(batch.qty_in_warehouse);
	const remaining_total = remaining_warehouse + remaining_vehicles.reduce((s, v) => s + v.qty_on_hand, 0);

	const consumedSerials = batch.inventory_item.is_serialized
		? await sdb.serial_unit.findMany({
				where: { batch_id: batchId, status: "consumed" },
				select: {
					id: true,
					code: true,
					serial_number: true,
					consumed_at: true,
					client: { select: { id: true, name: true } },
					consumed_visit: {
						select: { id: true, name: true, job: { select: { id: true, job_number: true, name: true } } },
					},
				},
			})
		: [];

	const allocs = await sdb.stock_movement_batch.findMany({
		where: { batch_id: batchId },
		include: {
			movement: {
				select: {
					reason: true,
					to_location_type: true,
					visit_line_item: { select: { id: true, name: true } },
					visit: {
						select: {
							id: true,
							name: true,
							job: {
								select: {
									id: true,
									job_number: true,
									name: true,
									client: { select: { id: true, name: true } },
								},
							},
						},
					},
				},
			},
		},
	});

	interface LineItemImpact {
		visit_line_item_id: string;
		line_item_name: string;
		visit_id: string;
		visit_name: string | null;
		job_id: string;
		job_number: string;
		job_name: string;
		client_id: string;
		client_name: string;
		consumed_qty: number;
		reversed_qty: number;
	}
	const byLineItem = new Map<string, LineItemImpact>();

	for (const alloc of allocs) {
		const mv = alloc.movement;
		const lineItemId = mv.visit_line_item?.id;
		if (!lineItemId || !mv.visit) continue; // only line-item-attributed consumption is recall-relevant
		if (mv.to_location_type !== "consumed" && mv.reason !== "reversal") continue;

		let entry = byLineItem.get(lineItemId);
		if (!entry) {
			entry = {
				visit_line_item_id: lineItemId,
				line_item_name: mv.visit_line_item?.name ?? "Line item",
				visit_id: mv.visit.id,
				visit_name: mv.visit.name,
				job_id: mv.visit.job.id,
				job_number: mv.visit.job.job_number,
				job_name: mv.visit.job.name,
				client_id: mv.visit.job.client.id,
				client_name: mv.visit.job.client.name,
				consumed_qty: 0,
				reversed_qty: 0,
			};
			byLineItem.set(lineItemId, entry);
		}
		const qty = Number(alloc.qty);
		if (mv.to_location_type === "consumed") entry.consumed_qty += qty;
		else entry.reversed_qty += qty;
	}

	const affected_jobs = [...byLineItem.values()].map((e) => ({
		...e,
		net_qty: e.consumed_qty - e.reversed_qty,
		fully_reversed: e.consumed_qty - e.reversed_qty <= 0,
	}));

	const affected_serials = consumedSerials.map((s) => ({
		id: s.id,
		code: s.code,
		serial_number: s.serial_number,
		consumed_at: s.consumed_at ? s.consumed_at.toISOString() : null,
		client: s.client,
		visit: s.consumed_visit
			? { id: s.consumed_visit.id, name: s.consumed_visit.name, job: s.consumed_visit.job }
			: null,
	}));

	return {
		err: "" as const,
		batch: {
			id: batch.id,
			code: batch.code,
			batch_number: batch.batch_number,
			item_id: batch.inventory_item.id,
			item_name: batch.inventory_item.name,
			// Carried here so the batch detail page can render and seed the
			// supplier field from this one report, instead of fetching the
			// item's entire batch list to read a single string off one row.
			supplier: batch.supplier ?? null,
			expires_at: batch.expires_at ? batch.expires_at.toISOString() : null,
			recalled_at: batch.recalled_at ? batch.recalled_at.toISOString() : null,
		},
		remaining: { warehouse: remaining_warehouse, vehicles: remaining_vehicles, total: remaining_total },
		affected_serials,
		affected_jobs,
	};
}

export async function exportBatchImpactToXlsx(
	batchId: string,
	organizationId: string,
): Promise<{ err?: string; buffer?: Buffer }> {
	const result = await getBatchImpact(batchId, organizationId);
	if (result.err) return { err: result.err };

	const rows = [
		...result.affected_jobs!.map((j) => ({
			Type: "Job/Visit",
			Client: j.client_name,
			Job: `${j.job_number} — ${j.job_name}`,
			"Visit/Line Item": j.line_item_name,
			"Qty Consumed": j.consumed_qty,
			"Qty Reversed": j.reversed_qty,
			"Net Qty": j.net_qty,
			Status: j.fully_reversed ? "Reversed" : "Active",
		})),
		...result.affected_serials!.map((s) => ({
			Type: "Serial",
			Client: s.client?.name ?? "",
			Job: s.visit?.job ? `${s.visit.job.job_number} — ${s.visit.job.name}` : "",
			"Visit/Line Item": s.serial_number,
			"Qty Consumed": 1,
			"Qty Reversed": 0,
			"Net Qty": 1,
			Status: "Active",
		})),
	];

	const ws = XLSX.utils.json_to_sheet(rows);
	ws["!cols"] = [12, 20, 30, 24, 12, 12, 10, 10].map((wch) => ({ wch }));
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, ws, "Batch Recall Report");

	return { buffer: Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })) };
}

// ── Serial lifecycle ────────────────────────────────────────────────────────────

export async function getSerialHistory(serialId: string, organizationId: string) {
	const sdb = getScopedDb(organizationId);

	const serial = await sdb.serial_unit.findFirst({
		where: { id: serialId },
		include: {
			inventory_item: { select: { id: true, name: true } },
			current_vehicle: { select: { id: true, name: true } },
			client: { select: { id: true, name: true } },
			consumed_visit: {
				select: { id: true, name: true, job: { select: { id: true, job_number: true, name: true } } },
			},
			batch: { select: { id: true, batch_number: true, code: true } },
		},
	});
	if (!serial) return { err: "Serial unit not found" as const };

	const joins = await sdb.stock_movement_serial.findMany({
		where: { serial_unit_id: serialId },
		include: {
			movement: {
				select: {
					id: true,
					reason: true,
					from_location_type: true,
					from_vehicle: { select: { id: true, name: true } },
					to_location_type: true,
					to_vehicle: { select: { id: true, name: true } },
					note: true,
					actor_type: true,
					created_at: true,
					visit: { select: { id: true, name: true, job: { select: { id: true, job_number: true, name: true } } } },
				},
			},
		},
	});

	const timeline = joins
		.map((j) => j.movement)
		.sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
		.map((m) => ({
			id: m.id,
			reason: m.reason,
			from_location_type: m.from_location_type,
			from_vehicle: m.from_vehicle,
			to_location_type: m.to_location_type,
			to_vehicle: m.to_vehicle,
			note: m.note,
			actor_type: m.actor_type,
			created_at: m.created_at.toISOString(),
			visit: m.visit ? { id: m.visit.id, name: m.visit.name, job: m.visit.job } : null,
		}));

	return {
		err: "" as const,
		serial: {
			id: serial.id,
			code: serial.code,
			serial_number: serial.serial_number,
			status: serial.status,
			item: serial.inventory_item,
			current_vehicle: serial.current_vehicle,
			batch: serial.batch,
			received_at: serial.received_at.toISOString(),
			consumed_at: serial.consumed_at ? serial.consumed_at.toISOString() : null,
			client: serial.client,
			consumed_visit: serial.consumed_visit
				? { id: serial.consumed_visit.id, name: serial.consumed_visit.name, job: serial.consumed_visit.job }
				: null,
			note: serial.note,
		},
		timeline,
	};
}

// ── Serial edit (status change / note) ────────────────────────────────────────
// Business-rule failure raised inside the serial-edit/delete transactions.
// Thrown from inside $transaction so nothing commits, then mapped to a
// 400-style { err } result in the outer catch (same house convention as
// TrackingStockNotZeroError above).
class SerialNotDeletableError extends Error {}

// PATCH /inventory/serials/:serialId — mark an in-warehouse unit lost/returned
// and/or edit its note. Status changes go through recordMovements so
// inventory_item.quantity (written ONLY there) stays truthful: "lost" is a
// warehouse→adjustment loss; "returned" is a warehouse→external audit_correction
// (the reason enum has no return-to-supplier reason — audit_correction is the
// agreed choice). Only in-warehouse units can change status.
export const updateSerial = async (
	serialId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const serial = await sdb.serial_unit.findFirst({ where: { id: serialId } });

		if (!serial) {
			return { err: "Serial unit not found" };
		}

		const parsed = updateSerialSchema.parse(data);
		const actor = toActorInfo(context);

		const updated = await sdb.$transaction(async (tx) => {
			if (parsed.status !== undefined) {
				if (serial.status !== "in_warehouse") {
					throw new TrackingValidationError(
						"Only in-warehouse units can be marked lost or returned",
					);
				}
				const movement: MovementInput =
					parsed.status === "lost"
						? {
								inventory_item_id: serial.inventory_item_id,
								qty: 1,
								from_location_type: "warehouse",
								to_location_type: "adjustment",
								reason: "loss",
								serial: { unit_ids: [serialId] },
							}
						: {
								inventory_item_id: serial.inventory_item_id,
								qty: 1,
								from_location_type: "warehouse",
								to_location_type: "external",
								reason: "audit_correction",
								serial: { unit_ids: [serialId] },
							};
				await recordMovements(
					tx as unknown as Prisma.TransactionClient,
					organizationId,
					actor,
					[movement],
				);
			}

			if (parsed.note !== undefined) {
				await tx.serial_unit.update({
					where: { id: serialId },
					data: { note: parsed.note },
				});
			}

			const after = await tx.serial_unit.findFirst({ where: { id: serialId } });

			await logActivity({
				event_type: "serial_unit.updated",
				action: "updated",
				entity_type: "serial_unit",
				entity_id: serialId,
				organization_id: organizationId,
				...getActorInfo(context),
				changes: {
					...(parsed.status !== undefined
						? { status: { old: serial.status, new: after?.status } }
						: {}),
					...(parsed.note !== undefined
						? { note: { old: serial.note, new: parsed.note } }
						: {}),
				},
			});

			return after!;
		});

		emitInventoryUpdated(organizationId, { itemId: serial.inventory_item_id });

		return { err: "", serial: updated };
	} catch (e) {
		if (e instanceof ZodError) {
			return { err: zodMessage(e) };
		}
		if (e instanceof InsufficientBatchStockError || e instanceof TrackingValidationError) {
			return { err: e.message };
		}
		console.error("Update serial error:", e);
		return { err: "Internal server error" };
	}
};

// DELETE /inventory/serials/:serialId — hard-delete a serial ONLY when it has
// never moved beyond its initial receive. A compensating warehouse-out movement
// runs first so inventory_item.quantity (written ONLY by recordMovements) stays
// truthful; the stock_movement_serial join rows cascade on the delete itself
// (schema onDelete: Cascade).
export const deleteSerial = async (
	serialId: string,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		// Cheap existence + org-scope check for the not-found fast path (and to
		// carry inventory_item_id out for the socket emit). Eligibility itself is
		// computed INSIDE the tx from the locked re-read — see below.
		const exists = await sdb.serial_unit.findFirst({
			where: { id: serialId },
			select: { id: true, inventory_item_id: true },
		});

		if (!exists) {
			return { err: "Serial unit not found" };
		}

		const actor = toActorInfo(context);

		await sdb.$transaction(async (tx) => {
			// TOCTOU: lock the serial row FIRST, then re-fetch it + its movement
			// joins and compute eligibility from THAT locked read. Using the pre-tx
			// snapshot would let a concurrent move (e.g. a restock) between read and
			// tx slip past the "never-moved" guard.
			await lockSerialRows(tx as unknown as Prisma.TransactionClient, [serialId]);

			const serial = await tx.serial_unit.findFirst({
				where: { id: serialId },
				include: {
					movement_serials: { include: { movement: { select: { reason: true } } } },
				},
			});
			if (!serial) throw new SerialNotDeletableError("Serial unit not found");

			const initialReasons = new Set(["receive", "initial", "supplier_purchase"]);
			const eligible =
				serial.status === "in_warehouse" &&
				serial.consumed_at == null &&
				serial.current_vehicle_id == null &&
				serial.movement_serials.every((ms) => initialReasons.has(ms.movement.reason));

			if (!eligible) {
				throw new SerialNotDeletableError(
					"Only never-moved, in-warehouse units can be deleted.",
				);
			}

			const movement: MovementInput = {
				inventory_item_id: serial.inventory_item_id,
				qty: 1,
				from_location_type: "warehouse",
				to_location_type: "adjustment",
				reason: "audit_correction",
				serial: { unit_ids: [serialId] },
			};
			await recordMovements(
				tx as unknown as Prisma.TransactionClient,
				organizationId,
				actor,
				[movement],
			);

			await tx.serial_unit.delete({ where: { id: serialId } });

			await logActivity({
				event_type: "serial_unit.deleted",
				action: "deleted",
				entity_type: "serial_unit",
				entity_id: serialId,
				organization_id: organizationId,
				...getActorInfo(context),
				changes: {
					serial_number: { old: serial.serial_number, new: null },
				},
			});
		});

		emitInventoryUpdated(organizationId, { itemId: exists.inventory_item_id });

		return { err: "" };
	} catch (e) {
		if (e instanceof SerialNotDeletableError) {
			return { err: e.message };
		}
		console.error("Delete serial error:", e);
		return { err: "Internal server error" };
	}
};

// ── Tracking reconciliation ──────────────────────────────────────────────────────
// Safety-net report, not a hot path: per-item cache-vs-truth drift + a feed of
// [TRACKING_GAP] movements (visit completions that skipped serial/batch capture,
// see services/inventoryTracking.ts's allowUntracked branch).

export async function getTrackingReconciliation(organizationId: string) {
	const sdb = getScopedDb(organizationId);

	const items = await sdb.inventory_item.findMany({
		where: { is_active: true, OR: [{ is_serialized: true }, { is_batch_tracked: true }] },
		select: {
			id: true,
			name: true,
			quantity: true,
			is_serialized: true,
			is_batch_tracked: true,
			vehicle_stocks: { select: { vehicle_id: true, qty_on_hand: true, vehicle: { select: { name: true } } } },
		},
	});

	interface Drift {
		item_id: string;
		item_name: string;
		scope: "warehouse" | "vehicle";
		vehicle_id?: string;
		vehicle_name?: string;
		expected: number;
		actual: number;
	}
	const drifts: Drift[] = [];

	const serializedItemIds = items.filter((i) => i.is_serialized).map((i) => i.id);
	const batchTrackedItemIds = items.filter((i) => i.is_batch_tracked).map((i) => i.id);

	// Bulk serial warehouse+vehicle counts: one groupBy for every tracked item,
	// diffed against the items+vehicle_stocks in memory below. NOTE: groupBy is
	// not covered by getScopedDb's org-scoping extension, so organization_id is
	// added to the where clause explicitly (matches reportsController's usage).
	const serialCountMap = new Map<string, number>();
	if (serializedItemIds.length > 0) {
		const serialGroups = await sdb.serial_unit.groupBy({
			by: ["inventory_item_id", "status", "current_vehicle_id"],
			where: {
				organization_id: organizationId,
				inventory_item_id: { in: serializedItemIds },
				status: { in: ["in_warehouse", "on_vehicle"] },
			},
			_count: { id: true },
		});
		for (const g of serialGroups) {
			const key = `${g.inventory_item_id}|${g.status}|${g.current_vehicle_id ?? ""}`;
			serialCountMap.set(key, g._count.id);
		}
	}

	// Bulk batch quantities: one findMany for every batch-tracked item, grouped
	// in memory into warehouse sums + per-vehicle sums.
	const batchWarehouseByItem = new Map<string, number>();
	const batchVehicleByItem = new Map<string, Map<string, number>>();
	if (batchTrackedItemIds.length > 0) {
		const batches = await sdb.stock_batch.findMany({
			where: { inventory_item_id: { in: batchTrackedItemIds } },
			select: {
				inventory_item_id: true,
				qty_in_warehouse: true,
				vehicle_batches: { select: { vehicle_id: true, qty_on_hand: true } },
			},
		});
		for (const b of batches) {
			batchWarehouseByItem.set(
				b.inventory_item_id,
				(batchWarehouseByItem.get(b.inventory_item_id) ?? 0) + Number(b.qty_in_warehouse),
			);
			let vehicleSums = batchVehicleByItem.get(b.inventory_item_id);
			if (!vehicleSums) {
				vehicleSums = new Map<string, number>();
				batchVehicleByItem.set(b.inventory_item_id, vehicleSums);
			}
			for (const vb of b.vehicle_batches) {
				vehicleSums.set(vb.vehicle_id, (vehicleSums.get(vb.vehicle_id) ?? 0) + Number(vb.qty_on_hand));
			}
		}
	}

	for (const item of items) {
		if (item.is_serialized) {
			const warehouseCount = serialCountMap.get(`${item.id}|in_warehouse|`) ?? 0;
			// Coerced: item.quantity is a Decimal object, so `!==` against a counted
			// number is always true and every serialized item would report drift.
			if (warehouseCount !== Number(item.quantity)) {
				drifts.push({
					item_id: item.id,
					item_name: item.name,
					scope: "warehouse",
					expected: Number(item.quantity),
					actual: warehouseCount,
				});
			}
			for (const vs of item.vehicle_stocks) {
				const vehicleCount = serialCountMap.get(`${item.id}|on_vehicle|${vs.vehicle_id}`) ?? 0;
				if (vehicleCount !== Number(vs.qty_on_hand)) {
					drifts.push({
						item_id: item.id,
						item_name: item.name,
						scope: "vehicle",
						vehicle_id: vs.vehicle_id,
						vehicle_name: vs.vehicle.name,
						expected: Number(vs.qty_on_hand),
						actual: vehicleCount,
					});
				}
			}
		}

		if (item.is_batch_tracked) {
			const batchWarehouseSum = batchWarehouseByItem.get(item.id) ?? 0;
			// Same Decimal-vs-number coercion as the serialized branch above.
			if (batchWarehouseSum !== Number(item.quantity)) {
				drifts.push({
					item_id: item.id,
					item_name: item.name,
					scope: "warehouse",
					expected: Number(item.quantity),
					actual: batchWarehouseSum,
				});
			}
			const vehicleBatchSums = batchVehicleByItem.get(item.id);
			for (const vs of item.vehicle_stocks) {
				const batchSum = vehicleBatchSums?.get(vs.vehicle_id) ?? 0;
				if (batchSum !== Number(vs.qty_on_hand)) {
					drifts.push({
						item_id: item.id,
						item_name: item.name,
						scope: "vehicle",
						vehicle_id: vs.vehicle_id,
						vehicle_name: vs.vehicle.name,
						expected: Number(vs.qty_on_hand),
						actual: batchSum,
					});
				}
			}
		}
	}

	const gaps = await sdb.stock_movement.findMany({
		where: { note: { contains: "[TRACKING_GAP]" } },
		orderBy: { created_at: "desc" },
		take: 50,
		include: {
			inventory_item: { select: { id: true, name: true } },
			visit: { select: { id: true, name: true, job: { select: { id: true, job_number: true, name: true } } } },
		},
	});

	return {
		err: "" as const,
		drifts,
		gaps: gaps.map((g) => ({
			id: g.id,
			item: g.inventory_item,
			qty: Number(g.qty),
			reason: g.reason,
			note: g.note,
			created_at: g.created_at.toISOString(),
			visit: g.visit ? { id: g.visit.id, name: g.visit.name, job: g.visit.job } : null,
		})),
	};
}

// ── Import template ───────────────────────────────────────────────────────────

// ── Line item ↔ catalog linkage audit ─────────────────────────────────────────

/** One of the five tables that can hold a billable line. */
export type LinkageEntity = "quote" | "job" | "job_visit" | "recurring_plan" | "invoice";

/** How confident a name → catalog guess is: exact beats fold beats code. */
export type LinkageMatchTier = "exact" | "case_insensitive" | "code";

export interface LinkageEntityCounts {
	entity: LinkageEntity;
	linked: number;
	/** Lines naming a part with no catalog link. */
	unmapped: number;
	total: number;
}

export interface LinkageCandidate {
	name: string;
	/** Every table holding this name unmapped — applyLinkageMatch fixes all of them at once. */
	entities: LinkageEntity[];
	lines: number;
	/**
	 * Summed line value, which the queue ranks on. Count-ranked puts a $4
	 * grommet billed nine times above a $2,400 compressor billed once.
	 */
	value: number;
	match: {
		inventory_item_id: string;
		name: string;
		sku: string | null;
		tier: LinkageMatchTier;
	} | null;
	/** Populated by the queue, not by the audit — see fieldPurchaseOrigins. */
	field_purchases?: ReconcilePurchaseOrigin[];
}

interface LinkageSource {
	entity: LinkageEntity;
	from: Prisma.Sql;
	alive: Prisma.Sql;
	/**
	 * Per-source because recurring_plan_line_item is a pricing template with no
	 * `total` column, and a union branch naming a missing column fails.
	 */
	value: Prisma.Sql;
	/** Where a reader goes to see the line: its own document, plus the parent when the route nests. */
	doc_id: Prisma.Sql;
	parent_id: Prisma.Sql;
	doc_number: Prisma.Sql;
	doc_title: Prisma.Sql;
	doc_date: Prisma.Sql;
}

/**
 * Every table holding billable lines, with the join reaching its org. Each
 * reaches organization_id through a different parent, which is why this
 * isn't a Prisma groupBy.
 */
const LINKAGE_SOURCES: LinkageSource[] = [
	{
		entity: "quote",
		doc_id: Prisma.sql`p.id`,
		parent_id: Prisma.sql`NULL::text`,
		doc_number: Prisma.sql`p.quote_number`,
		doc_title: Prisma.sql`NULL::text`,
		doc_date: Prisma.sql`COALESCE(p.issued_at, p.created_at)`,
		from: Prisma.sql`quote_line_item li JOIN quote p ON p.id = li.quote_id`,
		alive: Prisma.sql`AND p.status::text NOT IN ('Rejected', 'Expired', 'Cancelled')`,
		value: Prisma.sql`li.total`,
	},
	{
		entity: "job",
		doc_id: Prisma.sql`p.id`,
		parent_id: Prisma.sql`NULL::text`,
		doc_number: Prisma.sql`p.job_number`,
		doc_title: Prisma.sql`p.name`,
		doc_date: Prisma.sql`p.created_at`,
		from: Prisma.sql`job_line_item li JOIN job p ON p.id = li.job_id`,
		alive: Prisma.sql`AND p.status::text <> 'Cancelled'`,
		value: Prisma.sql`li.total`,
	},
	{
		entity: "job_visit",
		doc_id: Prisma.sql`v.id`,
		// The visit route nests under its job, so the job id travels with the row.
		parent_id: Prisma.sql`p.id`,
		doc_number: Prisma.sql`p.job_number`,
		doc_title: Prisma.sql`v.name`,
		doc_date: Prisma.sql`v.scheduled_start_at`,
		from: Prisma.sql`job_visit_line_item li
			JOIN job_visit v ON v.id = li.visit_id
			JOIN job p ON p.id = v.job_id`,
		// Completed visits stay in — that is where consumption happened.
		alive: Prisma.sql`AND v.status::text <> 'Cancelled' AND p.status::text <> 'Cancelled'`,
		value: Prisma.sql`li.total`,
	},
	{
		entity: "recurring_plan",
		doc_id: Prisma.sql`p.id`,
		parent_id: Prisma.sql`NULL::text`,
		doc_number: Prisma.sql`NULL::text`,
		doc_title: Prisma.sql`p.name`,
		doc_date: Prisma.sql`p.created_at`,
		from: Prisma.sql`recurring_plan_line_item li
			JOIN recurring_plan p ON p.id = li.recurring_plan_id`,
		alive: Prisma.sql`AND p.status::text NOT IN ('Completed', 'Cancelled')`,
		value: Prisma.sql`(li.quantity * li.unit_price)`,
	},
	{
		// No status filter: even a voided invoice describes money that moved.
		entity: "invoice",
		doc_id: Prisma.sql`p.id`,
		parent_id: Prisma.sql`NULL::text`,
		doc_number: Prisma.sql`p.invoice_number`,
		doc_title: Prisma.sql`NULL::text`,
		doc_date: Prisma.sql`COALESCE(p.issued_at, p.created_at)`,
		from: Prisma.sql`invoice_line_item li JOIN invoice p ON p.id = li.invoice_id`,
		alive: Prisma.empty,
		value: Prisma.sql`li.total`,
	},
];

/**
 * Labor and `other` are legitimately freetext (permits, trip charges,
 * disposal, subcontractor pass-through); counting them drowns the signal.
 */
const LINKABLE_ITEM_TYPES = ["material", "equipment"] as const;

/** The same set as raw SQL, so the audit query and the backfill can never drift. */
const LINKABLE_LINE_TYPES = Prisma.sql`li.item_type::text IN (${Prisma.join(
	LINKABLE_ITEM_TYPES.map((t) => Prisma.sql`${t}`),
	", ",
)})`;

/** Review-queue depth. */
const CANDIDATE_LIMIT = 200;

/** Folds a line name to its unmapped_part_decision key. */
const FOLDED_LINE_NAME = Prisma.sql`lower(trim(li.name))`;

/**
 * Applied to counts and coverage too, so a dismissed name stops dragging
 * coverage down over a gap that is not a gap.
 */
function notDismissed(orgId: string): Prisma.Sql {
	return Prisma.sql`AND NOT EXISTS (
		SELECT 1 FROM unmapped_part_decision d
		WHERE d.organization_id = ${orgId}
			AND d.folded_name = ${FOLDED_LINE_NAME}
	)`;
}

/**
 * One SELECT per table, unioned, so each half of the audit is one round
 * trip. `select` is a callback because the value expression differs per table.
 */
function linkageUnion(
	orgId: string,
	select: (source: LinkageSource) => Prisma.Sql,
	extraWhere: Prisma.Sql = Prisma.empty,
): Prisma.Sql {
	return Prisma.join(
		LINKAGE_SOURCES.map(
			(source) => Prisma.sql`
				SELECT ${select(source)}
				FROM ${source.from}
				WHERE p.organization_id = ${orgId}
					AND ${LINKABLE_LINE_TYPES}
					${source.alive}
					${extraWhere}
			`,
		),
		" UNION ALL ",
	);
}

/** How the unmapped half can be ordered. Named for the question, not the column. */
export const RECONCILE_SORTS = ["value_desc", "value_asc", "lines_desc", "name_asc"] as const;
export type ReconcileSort = (typeof RECONCILE_SORTS)[number];

const RECONCILE_ORDER: Record<ReconcileSort, Prisma.Sql> = {
	value_desc: Prisma.sql`SUM(value) DESC NULLS LAST, COUNT(*) DESC`,
	value_asc: Prisma.sql`SUM(value) ASC NULLS FIRST, COUNT(*) DESC`,
	lines_desc: Prisma.sql`COUNT(*) DESC, SUM(value) DESC NULLS LAST`,
	name_asc: Prisma.sql`lower(name) ASC`,
};

export interface ReconcileListOpts {
	search?: string;
	sort?: ReconcileSort;
	/** Paging past CANDIDATE_LIMIT. The window totals are computed before it, so they stay whole-backlog. */
	offset?: number;
	limit?: number;
}

/**
 * How much of the org's material/equipment billing points at the catalog,
 * and how much of the rest could. The gate policy depends on the answer: if
 * unmapped lines mostly name-match, the picker can require a link; if the
 * catalog is thin, requiring one teaches dispatchers to invent junk items.
 *
 * Scoped to live documents (LINKAGE_SOURCES.alive) — a rejected quote will
 * never be billed, so its lines are not a gap anyone can act on.
 */
export async function getLinkageAudit(
	orgId: string,
	list: ReconcileListOpts = {},
): Promise<{
	err?: string;
	counts?: LinkageEntityCounts[];
	candidates?: LinkageCandidate[];
	/** Distinct unmapped names in total — candidates is capped at CANDIDATE_LIMIT. */
	candidate_total?: number;
	/** Summed value of EVERY unmapped name, including the ones past the cap. */
	candidate_value_total?: number;
}> {
	try {
		const search = list.search?.trim() || undefined;
		// The cap is the server's promise about queue depth; a caller cannot raise it.
		const limit = Math.min(Math.max(list.limit ?? CANDIDATE_LIMIT, 1), CANDIDATE_LIMIT);
		const offset = Math.max(list.offset ?? 0, 0);

		const countRows = await db.$queryRaw<
			{ entity: LinkageEntity; linked: bigint; unmapped: bigint }[]
		>(
			linkageUnion(
				orgId,
				(s) => Prisma.sql`
					${s.entity}::text AS entity,
					COUNT(*) FILTER (WHERE li.inventory_item_id IS NOT NULL) AS linked,
					COUNT(*) FILTER (WHERE li.inventory_item_id IS NULL) AS unmapped`,
				// A dismissal is a decision, not a gap; counting it holds coverage below
				// 100% forever.
				notDismissed(orgId),
			),
		);

		const counts: LinkageEntityCounts[] = countRows.map((r) => ({
			entity: r.entity,
			linked: Number(r.linked),
			unmapped: Number(r.unmapped),
			total: Number(r.linked) + Number(r.unmapped),
		}));

		// Grouped by name alone because the backfill is name-scoped; a per-entity
		// row would promise less than its own button delivers. The window columns
		// describe the whole backlog, not the capped list the queue displays.
		const nameRows = await db.$queryRaw<
			{
				name: string;
				lines: bigint;
				value: Prisma.Decimal | null;
				entities: LinkageEntity[];
				name_total: bigint;
				value_total: Prisma.Decimal | null;
			}[]
		>(Prisma.sql`
			SELECT name,
				COUNT(*) AS lines,
				SUM(value) AS value,
				ARRAY_AGG(DISTINCT entity) AS entities,
				COUNT(*) OVER () AS name_total,
				SUM(SUM(value)) OVER () AS value_total
			FROM (${linkageUnion(
				orgId,
				(s) => Prisma.sql`${s.entity}::text AS entity, li.name AS name, ${s.value} AS value`,
				Prisma.sql`AND li.inventory_item_id IS NULL ${notDismissed(orgId)} ${search
					? Prisma.sql`AND li.name ILIKE ${"%" + search + "%"}`
					: Prisma.empty}`,
			)}) unmapped
			GROUP BY name
			ORDER BY ${RECONCILE_ORDER[list.sort ?? "value_desc"]}
			LIMIT ${limit} OFFSET ${offset}
		`);

		const catalog = await db.inventory_item.findMany({
			where: { organization_id: orgId, is_active: true, provisional: false },
			select: { id: true, name: true, sku: true, alt_ids: true },
		});

		const byExact = new Map(catalog.map((c) => [c.name, c]));
		const byFold = new Map(catalog.map((c) => [c.name.trim().toLowerCase(), c]));
		const byCode = new Map<string, (typeof catalog)[number]>();
		for (const c of catalog) {
			if (c.sku) byCode.set(c.sku.trim().toLowerCase(), c);
			for (const alt of c.alt_ids) byCode.set(alt.trim().toLowerCase(), c);
		}

		const candidates: LinkageCandidate[] = nameRows.map((row) => {
			const fold = row.name.trim().toLowerCase();
			const exact = byExact.get(row.name);
			const folded = byFold.get(fold);
			const code = byCode.get(fold);
			const hit = exact ?? folded ?? code;
			return {
				name: row.name,
				entities: row.entities,
				lines: Number(row.lines),
				value: Number(row.value ?? 0),
				match: hit
					? {
							inventory_item_id: hit.id,
							name: hit.name,
							sku: hit.sku,
							tier: exact ? "exact" : folded ? "case_insensitive" : "code",
						}
					: null,
			};
		});

		return {
			counts,
			candidates,
			candidate_total: Number(nameRows[0]?.name_total ?? 0),
			candidate_value_total: Number(nameRows[0]?.value_total ?? 0),
		};
	} catch (e: unknown) {
		log.error({ err: e }, "Failed to build inventory linkage audit");
		return { err: "Failed to build inventory linkage audit" };
	}
}

const applyLinkageSchema = z.object({
	name: z.string().min(1),
	inventory_item_id: z.string().uuid(),
});

/**
 * Point every unmapped material/equipment line with this name at a catalog
 * item.
 *
 * Lines on an already-COMPLETED visit are stamped `used`, not `planned`:
 * that stock left the warehouse before the link existed and no movement was
 * written, but deductInventoryForVisit skips only `used`, so a bare backfill
 * would arm those rows to consume the stock again on re-completion. Every
 * other status, cancelled included, gets `planned`.
 *
 * qty_planned stays null — nobody planned these lines, and a fabricated
 * quantity shows up as phantom variance.
 */
export async function applyLinkageMatch(
	data: unknown,
	orgId: string,
	context?: UserContext,
): Promise<{ err?: string; updated?: Record<LinkageEntity, number> }> {
	try {
		const parsed = applyLinkageSchema.parse(data);
		const item = await db.inventory_item.findFirst({
			where: { id: parsed.inventory_item_id, organization_id: orgId },
			select: { id: true },
		});
		if (!item) return { err: "Inventory item not found" };

		// `inventory_item_id: null` is load-bearing: an existing link is
		// somebody's deliberate choice and a backfill never overwrites it.
		const base = {
			name: parsed.name,
			inventory_item_id: null,
			item_type: { in: [...LINKABLE_ITEM_TYPES] },
		};

		const updated = await db.$transaction(async (tx) => {
			const [quote, job, recurringPlan, invoice] = await Promise.all([
				tx.quote_line_item.updateMany({
					where: { ...base, quote: { organization_id: orgId } },
					data: { inventory_item_id: item.id },
				}),
				tx.job_line_item.updateMany({
					where: { ...base, job: { organization_id: orgId } },
					data: { inventory_item_id: item.id },
				}),
				tx.recurring_plan_line_item.updateMany({
					where: { ...base, recurring_plan: { organization_id: orgId } },
					data: { inventory_item_id: item.id },
				}),
				tx.invoice_line_item.updateMany({
					where: { ...base, invoice: { organization_id: orgId } },
					data: { inventory_item_id: item.id },
				}),
			]);

			// Visits split by whether the work already happened — see above.
			const visitBuckets = [
				{ status: { equals: "Completed" as const }, stamp: "used" as const },
				{ status: { not: "Completed" as const }, stamp: "planned" as const },
			];
			let visitLines = 0;
			for (const bucket of visitBuckets) {
				const result = await tx.job_visit_line_item.updateMany({
					where: {
						...base,
						visit: {
							status: bucket.status,
							job: { organization_id: orgId },
						},
					},
					data: { inventory_item_id: item.id, fulfillment_status: bucket.stamp },
				});
				visitLines += result.count;
			}

			return {
				quote: quote.count,
				job: job.count,
				job_visit: visitLines,
				recurring_plan: recurringPlan.count,
				invoice: invoice.count,
			} satisfies Record<LinkageEntity, number>;
		});

		const linesLinked = Object.values(updated).reduce((a, b) => a + b, 0);
		await logActivity({
			event_type: "inventory_item.updated",
			action: "updated",
			entity_type: "inventory_item",
			entity_id: item.id,
			organization_id: orgId,
			...getActorInfo(context),
			changes: {
				reason: {
					old: null,
					new: `Backfilled catalog link for line items named "${parsed.name}"`,
				},
				lines_linked: { old: null, new: linesLinked },
			},
		});

		// Linking historical lines changes that item's usage, cost and charged-price
		// reads, and clears the name out of the reconcile queue for everyone.
		emitInventoryUpdated(orgId, { itemId: parsed.inventory_item_id });
		return { updated };
	} catch (e: unknown) {
		if (e instanceof ZodError) {
			return { err: `Validation failed: ${e.issues.map((i) => i.message).join(", ")}` };
		}
		log.error({ err: e }, "Failed to apply linkage match");
		return { err: "Failed to apply linkage match" };
	}
}

// ── Reconcile queue ───────────────────────────────────────────────────────────

/** The origin enum as a runtime list, for query validation and UI filters. */
export const ITEM_ORIGINS = [
	"tech_submission",
	"dispatch_quick_add",
	"field_purchase",
	"import",
] as const satisfies readonly inventory_item_origin[];

const dismissSchema = z.object({
	name: z.string().trim().min(1).max(200),
	reason: z.string().trim().max(500).optional(),
});

/** Same fold the SQL uses, so a TS-side decision and a SQL-side lookup agree. */
const foldName = (name: string): string => name.trim().toLowerCase();

/**
 * The queue's terminal state, and the reason it can ever reach empty: a
 * one-off gasket or a subcontractor's own material does not belong in the
 * catalog. Idempotent on the folded name.
 */
export async function dismissUnmappedName(
	data: unknown,
	orgId: string,
	context?: UserContext,
): Promise<{ err?: string; decision?: object }> {
	try {
		const parsed = dismissSchema.parse(data);
		const folded = foldName(parsed.name);
		const decision = await db.unmapped_part_decision.upsert({
			where: { organization_id_folded_name: { organization_id: orgId, folded_name: folded } },
			create: {
				organization_id: orgId,
				folded_name: folded,
				decided_by_id: context?.dispatcherId ?? null,
				reason: parsed.reason ?? null,
			},
			update: {
				decided_by_id: context?.dispatcherId ?? null,
				decided_at: new Date(),
				reason: parsed.reason ?? null,
			},
		});

		await logActivity({
			event_type: "unmapped_part.dismissed",
			action: "created",
			entity_type: "unmapped_part_decision",
			entity_id: decision.id,
			organization_id: orgId,
			...getActorInfo(context),
			changes: {
				folded_name: { old: null, new: folded },
				reason: { old: null, new: parsed.reason ?? null },
			},
		});

		// The reconcile queue moved for everyone, not just the dispatcher who acted.
		// No itemId: a decision is about a name, so the broad branch is the right one.
		emitInventoryUpdated(orgId);
		return { decision };
	} catch (e: unknown) {
		if (e instanceof ZodError) return { err: zodMessage(e) };
		log.error({ err: e }, "Failed to dismiss unmapped part name");
		return { err: "Failed to dismiss unmapped part name" };
	}
}

export async function restoreUnmappedName(
	data: unknown,
	orgId: string,
	context?: UserContext,
): Promise<{ err?: string }> {
	try {
		const parsed = dismissSchema.parse(data);
		const folded = foldName(parsed.name);
		const removed = await db.unmapped_part_decision.deleteMany({
			where: { organization_id: orgId, folded_name: folded },
		});
		if (removed.count === 0) return { err: "Decision not found" };

		await logActivity({
			event_type: "unmapped_part.restored",
			action: "deleted",
			entity_type: "unmapped_part_decision",
			entity_id: folded,
			organization_id: orgId,
			...getActorInfo(context),
			changes: { folded_name: { old: folded, new: null } },
		});
		emitInventoryUpdated(orgId);
		return {};
	} catch (e: unknown) {
		if (e instanceof ZodError) return { err: zodMessage(e) };
		log.error({ err: e }, "Failed to restore unmapped part name");
		return { err: "Failed to restore unmapped part name" };
	}
}

/** An item row that exists but is under-specified. */
export interface ReconcileProvisionalRow {
	item_id: string;
	name: string;
	origin: inventory_item_origin;
	cost: number | null;
	unit_price: number | null;
	unit: string;
	low_stock_threshold: number | null;
	created_at: Date;
	submitted_by: { id: string; name: string } | null;
	vehicle_stocks: { qty_on_hand: number; vehicle: { id: string; name: string } }[];
	lines: number;
	value: number;
	/** Populated by the queue, not by the audit — see fieldPurchaseOrigins. */
	field_purchases?: ReconcilePurchaseOrigin[];
}

export interface ReconcileDismissedRow {
	folded_name: string;
	decided_at: Date;
	decided_by: { id: string; name: string } | null;
	reason: string | null;
}

/** Enough of a field purchase to name it in a queue row and open the receipt. */
export interface ReconcilePurchaseOrigin {
	id: string;
	status: field_purchase_status;
	vendor_name: string | null;
	technician_name: string;
	purchased_at: Date | null;
}

/**
 * Which field purchases put these parts in the queue - settling a part without being
 * able to read the receipt it came off is guesswork.
 *
 * Two lookups, because the halves are keyed differently: the provisional half by the
 * item the line points at, the unmapped half by the description, which is what
 * `syncBilling` copies onto the visit line when there is no item.
 */
async function fieldPurchaseOrigins(
	orgId: string,
	itemIds: string[],
	names: string[],
): Promise<{
	byItem: Map<string, ReconcilePurchaseOrigin[]>;
	byName: Map<string, ReconcilePurchaseOrigin[]>;
}> {
	const byItem = new Map<string, ReconcilePurchaseOrigin[]>();
	const byName = new Map<string, ReconcilePurchaseOrigin[]>();
	if (itemIds.length === 0 && names.length === 0) return { byItem, byName };

	const sdb = getScopedDb(orgId);
	const lines = await sdb.field_purchase_line.findMany({
		where: {
			OR: [
				...(itemIds.length > 0 ? [{ inventory_item_id: { in: itemIds } }] : []),
				...(names.length > 0
					? [{ inventory_item_id: null, description: { in: names } }]
					: []),
			],
			// A draft has billed nothing and taken nothing in, so it did not create
			// this row — naming it would send the dispatcher to an unfinished sheet.
			field_purchase: { status: { not: "draft" } },
		},
		select: {
			inventory_item_id: true,
			description: true,
			field_purchase: {
				select: {
					id: true,
					status: true,
					vendor_name: true,
					purchased_at: true,
					technician: { select: { name: true } },
				},
			},
		},
		orderBy: { field_purchase: { created_at: "desc" } },
	});

	// Several lines of one receipt can name the same part; the row wants the
	// receipt once.
	const push = (
		map: Map<string, ReconcilePurchaseOrigin[]>,
		key: string,
		o: ReconcilePurchaseOrigin,
	) => {
		const list = map.get(key) ?? [];
		if (!list.some((existing) => existing.id === o.id)) list.push(o);
		map.set(key, list);
	};

	for (const line of lines) {
		const origin: ReconcilePurchaseOrigin = {
			id: line.field_purchase.id,
			status: line.field_purchase.status,
			vendor_name: line.field_purchase.vendor_name,
			technician_name: line.field_purchase.technician.name,
			purchased_at: line.field_purchase.purchased_at,
		};
		if (line.inventory_item_id) push(byItem, line.inventory_item_id, origin);
		else push(byName, line.description, origin);
	}
	return { byItem, byName };
}

/**
 * So both row kinds rank on one scale. Without it a half-defined $2,400
 * compressor sorts below a $12 unmapped grommet.
 */
async function provisionalLineTotals(
	orgId: string,
	itemIds: string[],
): Promise<Map<string, { lines: number; value: number }>> {
	const totals = new Map<string, { lines: number; value: number }>();
	if (itemIds.length === 0) return totals;

	const rows = await db.$queryRaw<{ item_id: string; lines: bigint; value: Prisma.Decimal | null }[]>(
		Prisma.sql`
			SELECT item_id, COUNT(*) AS lines, SUM(value) AS value
			FROM (${linkageUnion(
				orgId,
				(s) => Prisma.sql`li.inventory_item_id AS item_id, ${s.value} AS value`,
				Prisma.sql`AND li.inventory_item_id = ANY(${itemIds}::text[])`,
			)}) linked
			GROUP BY item_id
		`,
	);
	for (const r of rows) {
		totals.set(r.item_id, { lines: Number(r.lines), value: Number(r.value ?? 0) });
	}
	return totals;
}

/**
 * Both kinds of "somebody named a part the catalog doesn't know", ranked
 * together by money. They fail differently — a provisional row has an item
 * to complete, an unmapped name has a line to point somewhere — but which
 * one a problem lands in depends only on whether an item row got created.
 */
export async function getReconcileQueue(
	orgId: string,
	opts: { includeDismissed?: boolean; origin?: string } & ReconcileListOpts = {},
): Promise<{
	err?: string;
	queue?: {
		counts: LinkageEntityCounts[];
		coverage: { linked: number; unmapped: number; total: number; pct: number };
		unmapped: LinkageCandidate[];
		unmapped_total: number;
		unmapped_value: number;
		provisional: ReconcileProvisionalRow[];
		/** The whole provisional backlog behind the page, and its summed line value. */
		provisional_total: number;
		provisional_value: number;
		dismissed: ReconcileDismissedRow[];
	};
}> {
	try {
		if (opts.origin && !(ITEM_ORIGINS as readonly string[]).includes(opts.origin)) {
			return { err: `Validation failed: unknown origin ${opts.origin}` };
		}
		if (opts.sort && !(RECONCILE_SORTS as readonly string[]).includes(opts.sort)) {
			return { err: `Validation failed: unknown sort ${opts.sort}` };
		}
		const search = opts.search?.trim() || undefined;

		const audit = await getLinkageAudit(orgId, {
			search,
			sort: opts.sort,
			offset: opts.offset,
			limit: opts.limit,
		});
		if (audit.err) return { err: audit.err };

		// One filter, used three times: to size the backlog, to rank it, and to
		// hydrate the page. Duplicating it is how a count and its list drift.
		const provisionalWhere = {
			organization_id: orgId,
			provisional: true,
			...(opts.origin ? { origin: opts.origin as inventory_item_origin } : {}),
			...(search ? { name: { contains: search, mode: "insensitive" as const } } : {}),
		};
		// The same clamp getLinkageAudit applies, so one page cannot be 50 rows
		// deep on one half and 5,000 on the other.
		const limit = Math.min(Math.max(opts.limit ?? CANDIDATE_LIMIT, 1), CANDIDATE_LIMIT);
		const offset = Math.max(opts.offset ?? 0, 0);

		// `value` comes from a separate query, so a page taken before the ranking
		// is the wrong page - and the total is money, which stays whole however
		// few rows are on screen.
		const allIds = await db.inventory_item.findMany({
			where: provisionalWhere,
			select: { id: true, name: true, created_at: true },
		});

		const totals = await provisionalLineTotals(
			orgId,
			allIds.map((i) => i.id),
		);
		const provisionalTotal = allIds.length;
		const provisionalValue = allIds.reduce((n, i) => n + (totals.get(i.id)?.value ?? 0), 0);

		const sortKey = opts.sort ?? "value_desc";
		const ranked = [...allIds]
			// Same ranking as the unmapped half, under whichever order was asked
			// for; id settles the rest so two otherwise equal rows cannot swap
			// pages between requests.
			.sort((a, b) => {
				const av = totals.get(a.id) ?? { lines: 0, value: 0 };
				const bv = totals.get(b.id) ?? { lines: 0, value: 0 };
				switch (sortKey) {
					case "value_asc":
						return (
							av.value - bv.value ||
							b.created_at.getTime() - a.created_at.getTime() ||
							a.id.localeCompare(b.id)
						);
					case "lines_desc":
						return (
							bv.lines - av.lines ||
							bv.value - av.value ||
							a.id.localeCompare(b.id)
						);
					case "name_asc":
						return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
					default:
						return (
							bv.value - av.value ||
							b.created_at.getTime() - a.created_at.getTime() ||
							a.id.localeCompare(b.id)
						);
				}
			})
			.slice(offset, offset + limit);

		// Carries the whole filter rather than the ids alone: the ids are already
		// org-scoped, but a row adopted between the two reads must not come back
		// still wearing the provisional badge.
		const pageItems = await db.inventory_item.findMany({
			where: { ...provisionalWhere, id: { in: ranked.map((r) => r.id) } },
			select: {
				id: true,
				name: true,
				origin: true,
				cost: true,
				unit_price: true,
				unit: true,
				low_stock_threshold: true,
				created_at: true,
				created_by_tech: { select: { id: true, name: true } },
				vehicle_stocks: {
					select: { qty_on_hand: true, vehicle: { select: { id: true, name: true } } },
				},
			},
		});
		const byId = new Map(pageItems.map((i) => [i.id, i]));

		// Walked in ranked order, because an SQL `IN` promises nothing about the
		// order it answers in; a row that left the queue between the two reads is
		// simply absent from the second.
		const provisional: ReconcileProvisionalRow[] = ranked.flatMap((r) => {
			const i = byId.get(r.id);
			if (!i) return [];
			return [
				{
					item_id: i.id,
					name: i.name,
					origin: i.origin,
					cost: i.cost === null ? null : Number(i.cost),
					unit_price: i.unit_price === null ? null : Number(i.unit_price),
					unit: i.unit,
					low_stock_threshold:
						i.low_stock_threshold === null
							? null
							: Number(i.low_stock_threshold),
					created_at: i.created_at,
					submitted_by: i.created_by_tech,
					vehicle_stocks: i.vehicle_stocks.map((vs) => ({
						qty_on_hand: Number(vs.qty_on_hand),
						vehicle: vs.vehicle,
					})),
					...(totals.get(i.id) ?? { lines: 0, value: 0 }),
				},
			];
		});

		const dismissed: ReconcileDismissedRow[] = opts.includeDismissed
			? (
					await db.unmapped_part_decision.findMany({
						where: {
							organization_id: orgId,
							...(search
								? { folded_name: { contains: search.toLowerCase() } }
								: {}),
						},
						select: {
							folded_name: true,
							decided_at: true,
							reason: true,
							decided_by: { select: { id: true, name: true } },
						},
						orderBy: { decided_at: "desc" },
						take: CANDIDATE_LIMIT,
					})
				).map((d) => ({
					folded_name: d.folded_name,
					decided_at: d.decided_at,
					decided_by: d.decided_by,
					reason: d.reason,
				}))
			: [];

		// One round trip for both halves of the page, after both are narrowed and
		// capped — never per row.
		const unmapped = audit.candidates ?? [];
		const origins = await fieldPurchaseOrigins(
			orgId,
			provisional.map((p) => p.item_id),
			unmapped.map((u) => u.name),
		);
		for (const row of provisional) row.field_purchases = origins.byItem.get(row.item_id) ?? [];
		for (const row of unmapped) row.field_purchases = origins.byName.get(row.name) ?? [];

		const counts = audit.counts ?? [];
		const linked = counts.reduce((n, c) => n + c.linked, 0);
		const unmappedLines = counts.reduce((n, c) => n + c.unmapped, 0);
		const total = linked + unmappedLines;

		return {
			queue: {
				counts,
				coverage: {
					linked,
					unmapped: unmappedLines,
					total,
					pct: total === 0 ? 100 : Math.round((linked / total) * 100),
				},
				unmapped,
				unmapped_total: audit.candidate_total ?? 0,
				unmapped_value: audit.candidate_value_total ?? 0,
				provisional,
				provisional_total: provisionalTotal,
				provisional_value: provisionalValue,
				dismissed,
			},
		};
	} catch (e: unknown) {
		log.error({ err: e }, "Failed to build reconcile queue");
		return { err: "Failed to build reconcile queue" };
	}
}


/** One billable line behind a queue row, with enough to open the document it sits on. */
export interface ReconcileLineRow {
	entity: LinkageEntity;
	line_id: string;
	document_id: string;
	/** Set only where the route nests — a visit is reached through its job. */
	parent_id: string | null;
	document_number: string | null;
	document_title: string | null;
	client_name: string | null;
	occurred_at: Date | null;
	name: string;
	quantity: number;
	unit_price: number;
	value: number;
}

const RECONCILE_LINE_LIMIT = 100;

/**
 * The documents behind one queue row. Ranking says which name to deal with, this
 * says what the name is: $2,400 on one invoice and forty $6 lines are the same money
 * and not the same decision. Same live-document scope as the audit
 * (LINKAGE_SOURCES.alive), so the two counts agree.
 */
export async function getReconcileLines(
	orgId: string,
	opts: { name?: string; itemId?: string; foldedName?: string },
): Promise<{ err?: string; lines?: ReconcileLineRow[]; total?: number }> {
	try {
		if (!opts.name && !opts.itemId && !opts.foldedName) {
			return { err: "Validation failed: name, folded_name or item_id is required" };
		}
		// Exact for a queue row, because exact is what Map will rewrite. Folded for
		// a dismissal, which is stored folded and covers every casing of the name.
		const filter = opts.itemId
			? Prisma.sql`AND li.inventory_item_id = ${opts.itemId}`
			: opts.foldedName
				? Prisma.sql`AND ${FOLDED_LINE_NAME} = ${foldName(opts.foldedName)} AND li.inventory_item_id IS NULL`
				: Prisma.sql`AND li.name = ${opts.name} AND li.inventory_item_id IS NULL`;

		const rows = await db.$queryRaw<
			{
				entity: LinkageEntity;
				line_id: string;
				document_id: string;
				parent_id: string | null;
				document_number: string | null;
				document_title: string | null;
				client_name: string | null;
				occurred_at: Date | null;
				name: string;
				quantity: Prisma.Decimal | null;
				unit_price: Prisma.Decimal | null;
				value: Prisma.Decimal | null;
				row_total: bigint;
			}[]
		>(Prisma.sql`
			SELECT lines.*, COUNT(*) OVER () AS row_total
			FROM (${Prisma.join(
				LINKAGE_SOURCES.map(
					(s) => Prisma.sql`
						SELECT ${s.entity}::text AS entity,
							li.id AS line_id,
							${s.doc_id} AS document_id,
							${s.parent_id} AS parent_id,
							${s.doc_number} AS document_number,
							${s.doc_title} AS document_title,
							c.name AS client_name,
							${s.doc_date} AS occurred_at,
							li.name AS name,
							li.quantity AS quantity,
							li.unit_price AS unit_price,
							${s.value} AS value
						FROM ${s.from}
						LEFT JOIN client c ON c.id = p.client_id
						WHERE p.organization_id = ${orgId}
							AND ${LINKABLE_LINE_TYPES}
							${s.alive}
							${filter}
					`,
				),
				" UNION ALL ",
			)}) lines
			ORDER BY value DESC NULLS LAST, occurred_at DESC NULLS LAST
			LIMIT ${RECONCILE_LINE_LIMIT}
		`);

		return {
			lines: rows.map((r) => ({
				entity: r.entity,
				line_id: r.line_id,
				document_id: r.document_id,
				parent_id: r.parent_id,
				document_number: r.document_number,
				document_title: r.document_title,
				client_name: r.client_name,
				occurred_at: r.occurred_at,
				name: r.name,
				quantity: Number(r.quantity ?? 0),
				unit_price: Number(r.unit_price ?? 0),
				value: Number(r.value ?? 0),
			})),
			total: Number(rows[0]?.row_total ?? 0),
		};
	} catch (e: unknown) {
		log.error({ err: e }, "Failed to load reconcile lines");
		return { err: "Failed to load reconcile lines" };
	}
}

export interface ReconcileTarget {
	id: string;
	name: string;
	sku: string | null;
	unit: string;
	cost: number | null;
	provisional: boolean;
}

const TARGET_LIMIT = 25;

/**
 * Map targets, searched server-side rather than shipping the catalog to the client.
 *
 * Provisional rows are included on purpose: a tech-submitted "R410A" is what six
 * quote lines naming "R-410A refrigerant" should point at, and hiding it forces a
 * near-duplicate into the catalog. They sort last, so a complete item still wins.
 */
export async function getReconcileTargets(
	orgId: string,
	opts: { search?: string; excludeId?: string; limit?: number } = {},
): Promise<{ err?: string; targets?: ReconcileTarget[] }> {
	try {
		const search = opts.search?.trim();
		const items = await db.inventory_item.findMany({
			where: {
				organization_id: orgId,
				is_active: true,
				...(opts.excludeId ? { id: { not: opts.excludeId } } : {}),
				...(search
					? {
							OR: [
								{ name: { contains: search, mode: "insensitive" as const } },
								{ sku: { contains: search, mode: "insensitive" as const } },
								{ alt_ids: { has: search } },
							],
						}
					: {}),
			},
			select: {
				id: true,
				name: true,
				sku: true,
				unit: true,
				cost: true,
				provisional: true,
			},
			orderBy: [{ provisional: "asc" }, { name: "asc" }],
			take: Math.min(Math.max(opts.limit ?? TARGET_LIMIT, 1), 50),
		});

		return {
			targets: items.map((i) => ({
				id: i.id,
				name: i.name,
				sku: i.sku,
				unit: i.unit,
				cost: i.cost === null ? null : Number(i.cost),
				provisional: i.provisional,
			})),
		};
	} catch (e: unknown) {
		log.error({ err: e }, "Failed to load reconcile targets");
		return { err: "Failed to load reconcile targets" };
	}
}

const bulkApplySchema = z.object({
	pairs: z
		.array(z.object({ name: z.string().min(1), inventory_item_id: z.string().uuid() }))
		.min(1)
		.max(CANDIDATE_LIMIT),
});

export interface BulkLinkageResult {
	name: string;
	lines: number;
	err?: string;
}

/**
 * One decision for a screenful of suggestions the dispatcher already agrees with.
 *
 * Each pair goes through applyLinkageMatch rather than one wide UPDATE, because the
 * completed-visit `used` stamp is why that function is not an updateMany. Serial,
 * not Promise.all: concurrent transactions on the same line tables deadlock. Partial
 * success is reported per name - 40 of 41 links landing beats none.
 */
export async function applyLinkageMatchBulk(
	data: unknown,
	orgId: string,
	context?: UserContext,
): Promise<{ err?: string; results?: BulkLinkageResult[]; linked?: number }> {
	try {
		const parsed = bulkApplySchema.parse(data);
		const results: BulkLinkageResult[] = [];
		for (const pair of parsed.pairs) {
			const one = await applyLinkageMatch(pair, orgId, context);
			results.push({
				name: pair.name,
				lines: one.updated ? Object.values(one.updated).reduce((a, b) => a + b, 0) : 0,
				...(one.err ? { err: one.err } : {}),
			});
		}
		// A bulk run touches an unknown set of items, so the broad branch applies.
		emitInventoryUpdated(orgId);
		return { results, linked: results.reduce((n, r) => n + r.lines, 0) };
	} catch (e: unknown) {
		if (e instanceof ZodError) return { err: zodMessage(e) };
		log.error({ err: e }, "Failed to bulk-apply linkage matches");
		return { err: "Failed to bulk-apply linkage matches" };
	}
}

// ── Provisional items ─────────────────────────────────────────────────────────

const createProvisionalSchema = z.object({
	name: z.string().trim().min(1).max(200),
	unit: z.string().trim().max(40).optional(),
	unit_price: z.number().min(0).optional(),
	cost: z.number().min(0).optional(),
});

/**
 * Quick-add from a line-item form, for a part not in the catalog yet.
 *
 * Provisional because a dispatcher pricing a job on the phone knows the
 * name and the charge, not the cost basis, supplier, unit or reorder
 * threshold — and blocking the quote until they do is what makes people
 * invent junk SKUs. Reuses the technician provisional lifecycle rather than
 * adding a second half-item concept; `created_by_tech_id: null` is what
 * marks it dispatch-origin.
 */
export async function createProvisionalItemForLine(
	data: unknown,
	orgId: string,
	context?: UserContext,
): Promise<{ err?: string; item?: object }> {
	try {
		const parsed = createProvisionalSchema.parse(data);

		// Idempotent on the folded name: the picker can't see provisional rows, so
		// nothing else would stop a duplicate. Only provisional rows match — a
		// rejected item must stay rejected.
		const existing = await db.inventory_item.findFirst({
			where: {
				organization_id: orgId,
				provisional: true,
				name: { equals: parsed.name, mode: "insensitive" },
			},
		});
		if (existing) return { item: existing };

		const item = await db.inventory_item.create({
			data: {
				organization_id: orgId,
				name: parsed.name,
				description: "",
				quantity: 0,
				unit: normalizeUnitCode(parsed.unit) ?? DEFAULT_UNIT_CODE,
				unit_price: parsed.unit_price ?? null,
				cost: parsed.cost ?? null,
				provisional: true,
				origin: "dispatch_quick_add",
				created_by_tech_id: null,
			},
		});

		await logActivity({
			event_type: "inventory_item.created",
			action: "created",
			entity_type: "inventory_item",
			entity_id: item.id,
			organization_id: orgId,
			...getActorInfo(context),
			changes: {
				name: { old: null, new: item.name },
				provisional: { old: null, new: true },
				reason: { old: null, new: "Quick-added from a line item form" },
			},
		});

		return { item };
	} catch (e: unknown) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues.map((i) => i.message).join(", ")}`,
			};
		}
		log.error({ err: e }, "Failed to create provisional item");
		return { err: "Failed to create provisional item" };
	}
}

export async function listProvisionalItems(orgId: string): Promise<{ err?: string; items?: object[] }> {
	try {
		const items = await db.inventory_item.findMany({
			where: { organization_id: orgId, provisional: true },
			include: {
				created_by_tech: { select: { id: true, name: true } },
				vehicle_stocks: {
					select: { qty_on_hand: true, vehicle: { select: { id: true, name: true } } },
				},
			},
			orderBy: { created_at: "desc" },
			take: 200,
		});
		return { items };
	} catch (e: unknown) {
		log.error({ err: e }, "Failed to list provisional items");
		return { err: "Failed to list provisional items" };
	}
}

// Thrown inside the adopt transaction so nothing commits; the outer catch
// maps it to a 400, as with TrackingStockNotZeroError above.
class AdoptWithoutCostError extends Error {
	constructor() {
		super("Validation failed: cost is required to adopt an item into the catalog");
	}
}

const approveProvisionalSchema = z.object({
	initial_warehouse_qty: z.number().int().min(0).optional(),
	// Optional because a tech-submitted part usually arrives with a cost; the
	// transaction refuses the adopt if neither row nor payload has one.
	cost: z.number().min(0).optional(),
	unit: z.string().trim().max(40).optional(),
	low_stock_threshold: z.number().min(0).nullable().optional(),
	// Adoption is the first moment anyone knows what the item actually is, so
	// it is a natural place to give it a home. Still optional — plenty of orgs
	// never assign one.
	location: locationField,
});

/**
 * Adopt a provisional row into the real catalog.
 *
 * Cost is mandatory, from the payload or already on the row. Adopted with
 * no cost basis an item reads as free everywhere: weighted average cost
 * takes it as a zero-cost receipt and every margin on it shows 100%.
 */
export async function approveProvisionalItem(
	itemId: string,
	orgId: string,
	data: unknown,
	context?: UserContext,
): Promise<{ err?: string; item?: object }> {
	try {
		const parsed = approveProvisionalSchema.parse(data ?? {});
		const item = await db.$transaction(async (tx) => {
			const existing = await tx.inventory_item.findFirst({
				where: { id: itemId, organization_id: orgId, provisional: true },
				select: { cost: true },
			});
			if (!existing) throw new Error("Provisional item not found");
			if (parsed.cost === undefined && existing.cost === null) {
				throw new AdoptWithoutCostError();
			}

			const claimed = await tx.inventory_item.updateMany({
				where: { id: itemId, organization_id: orgId, provisional: true },
				data: {
					provisional: false,
					approved_at: new Date(),
					approved_by_id: context?.dispatcherId ?? null,
					...(parsed.cost !== undefined ? { cost: parsed.cost } : {}),
					...(parsed.unit !== undefined
						? { unit: normalizeUnitCode(parsed.unit) ?? DEFAULT_UNIT_CODE }
						: {}),
					...(parsed.low_stock_threshold !== undefined
						? { low_stock_threshold: parsed.low_stock_threshold }
						: {}),
					...(parsed.location !== undefined ? { location: parsed.location } : {}),
				},
			});
			if (claimed.count === 0) throw new Error("Provisional item not found");

			if (parsed.initial_warehouse_qty && parsed.initial_warehouse_qty > 0) {
				await recordMovements(
					tx,
					orgId,
					{ actor_type: context?.dispatcherId ? "dispatcher" : "system", actor_id: context?.dispatcherId },
					[{
						inventory_item_id:  itemId,
						qty:                parsed.initial_warehouse_qty,
						from_location_type: "external",
						to_location_type:   "warehouse",
						reason:             "receive",
						note:               "Initial warehouse stock set at approval",
					}],
				);
			}

			return tx.inventory_item.findFirst({ where: { id: itemId } });
		});

		await logActivity({
			event_type: "inventory_item.approved",
			action: "updated",
			entity_type: "inventory_item",
			entity_id: itemId,
			organization_id: orgId,
			...getActorInfo(context),
			changes: {
				provisional: { old: true, new: false },
				...(parsed.cost !== undefined ? { cost: { old: null, new: parsed.cost } } : {}),
				...(parsed.unit !== undefined ? { unit: { old: null, new: parsed.unit } } : {}),
				...(parsed.low_stock_threshold !== undefined
					? { low_stock_threshold: { old: null, new: parsed.low_stock_threshold } }
					: {}),
				...(parsed.initial_warehouse_qty ? { initial_warehouse_qty: { old: 0, new: parsed.initial_warehouse_qty } } : {}),
			},
		});
		return { item: item! };
	} catch (e: unknown) {
		if (e instanceof AdoptWithoutCostError) return { err: e.message };
		if (e instanceof Error && e.message === "Provisional item not found") return { err: e.message };
		if (e instanceof ZodError) return { err: zodMessage(e) };
		log.error({ err: e }, "Failed to approve provisional item");
		return { err: "Failed to approve provisional item" };
	}
}

export async function rejectProvisionalItem(
	itemId: string,
	orgId: string,
	context?: UserContext,
): Promise<{ err?: string }> {
	try {
		const claimed = await db.inventory_item.updateMany({
			where: { id: itemId, organization_id: orgId, provisional: true },
			data: { provisional: false, is_active: false, approved_at: new Date(), approved_by_id: context?.dispatcherId ?? null },
		});
		if (claimed.count === 0) return { err: "Provisional item not found" };
		await logActivity({
			event_type: "inventory_item.rejected",
			action: "updated",
			entity_type: "inventory_item",
			entity_id: itemId,
			organization_id: orgId,
			...getActorInfo(context),
			changes: { is_active: { old: true, new: false }, provisional: { old: true, new: false } },
		});
		return {};
	} catch (e: unknown) {
		log.error({ err: e }, "Failed to reject provisional item");
		return { err: "Failed to reject provisional item" };
	}
}

const mergeSchema = z.object({ target_inventory_item_id: z.string().uuid() });

export async function mergeProvisionalItem(
	itemId: string,
	data: unknown,
	orgId: string,
	context?: UserContext,
): Promise<{ err?: string }> {
	try {
		const parsed = mergeSchema.parse(data);
		if (parsed.target_inventory_item_id === itemId) return { err: "Target must be a different item" };
		await db.$transaction(async (tx) => {
			const prov = await tx.inventory_item.findFirst({
				where: { id: itemId, organization_id: orgId, provisional: true },
			});
			if (!prov) throw new Error("Provisional item not found");

			const target = await tx.inventory_item.findFirst({
				where: { id: parsed.target_inventory_item_id, organization_id: orgId, provisional: false },
			});
			if (!target) throw new Error("Target item not found");

			const provStocks = await tx.vehicle_stock_item.findMany({ where: { inventory_item_id: itemId } });
			for (const ps of provStocks) {
				const existing = await tx.vehicle_stock_item.findFirst({
					where: { vehicle_id: ps.vehicle_id, inventory_item_id: target.id },
				});
				if (existing) {
					await tx.vehicle_stock_item.update({
						where: { id: existing.id },
						data: { qty_on_hand: { increment: ps.qty_on_hand } },
					});
					await tx.vehicle_stock_usage.updateMany({
						where: { stock_item_id: ps.id },
						data: { stock_item_id: existing.id },
					});
					await tx.vehicle_restock_request.updateMany({
						where: { stock_item_id: ps.id },
						data: { stock_item_id: existing.id },
					});
					await tx.vehicle_stock_item.delete({ where: { id: ps.id } });
				} else {
					await tx.vehicle_stock_item.update({
						where: { id: ps.id },
						data: { inventory_item_id: target.id },
					});
				}
			}
			await tx.stock_movement.updateMany({
				where: { inventory_item_id: itemId },
				data: { inventory_item_id: target.id },
			});

			// Every table pointing at an inventory item must be repointed before the
			// delete. These FKs are ON DELETE SET NULL, so a missed table does not
			// error — it silently NULLs the link and drops those lines back into the
			// backlog this merge exists to clear. One call each because Prisma's
			// per-model updateMany generics can't be unioned into one callable.
			const repoint = {
				where: { inventory_item_id: itemId },
				data: { inventory_item_id: target.id },
			};
			await Promise.all([
				tx.job_visit_line_item.updateMany(repoint),
				tx.quote_line_item.updateMany(repoint),
				tx.job_line_item.updateMany(repoint),
				tx.recurring_plan_line_item.updateMany(repoint),
				tx.invoice_line_item.updateMany(repoint),
			]);

			await tx.inventory_item.delete({ where: { id: itemId } });
		});
		await logActivity({
			event_type: "inventory_item.merged",
			action: "deleted",
			entity_type: "inventory_item",
			entity_id: itemId,
			organization_id: orgId,
			...getActorInfo(context),
			changes: { merged_into: { old: null, new: parsed.target_inventory_item_id } },
		});
		return {};
	} catch (e: unknown) {
		if (e instanceof ZodError) return { err: zodMessage(e) };
		if (
			e instanceof Error &&
			(e.message.includes("not found") || e.message.includes("Target"))
		)
			return { err: e.message };
		log.error({ err: e }, "Failed to merge provisional item");
		return { err: "Failed to merge provisional item" };
	}
}

export const getInventoryImportTemplate = (): Buffer => {
	const headers = [
		"name*", "sku", "description", "location",
		"quantity", "unit_price", "cost", "low_stock_threshold", "alert_email", "tags",
	];
	const example = [
		"HVAC Filter 20x20", "FLT-2020", "Standard 20x20 air filter", "Warehouse A",
		"50", "12.99", "8.00", "10", "alerts@company.com", "filters, warehouse",
	];

	const ws = XLSX.utils.aoa_to_sheet([headers, example]);
	ws["!cols"] = [20, 12, 28, 16, 10, 12, 10, 18, 26, 22].map((wch) => ({ wch }));
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, ws, "Inventory Import Template");

	return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
};
