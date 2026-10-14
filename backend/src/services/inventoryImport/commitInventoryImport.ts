import { Prisma } from "../../../generated/prisma/client.js";
import { db } from "../../db.js";
import { recordMovements, getOrCreateBatch, type ActorInfo, type MovementInput } from "../stockMovements.js";
import { inventoryImportDuration, inventoryImportEvents } from "../metricsService.js";
import { InventoryImportError, type InventoryProposal } from "./types.js";

const ITEM_SELECT = {
	id: true,
	organization_id: true,
	name: true,
	description: true,
	location: true,
	quantity: true,
	unit: true,
	unit_price: true,
	cost: true,
	sku: true,
	barcode: true,
	category: true,
	low_stock_threshold: true,
	image_urls: true,
	alt_ids: true,
	is_active: true,
	is_serialized: true,
	is_batch_tracked: true,
	variant_group_id: true,
	variant_attributes: true,
	updated_at: true,
	tags: { select: { id: true, label: true } },
} as const;

type Tx = Prisma.TransactionClient;

function plain(value: unknown): Prisma.InputJsonValue {
	return JSON.parse(JSON.stringify(value, (_key, item) => {
		if (item instanceof Prisma.Decimal) return Number(item);
		if (item instanceof Date) return item.toISOString();
		return item;
	})) as Prisma.InputJsonValue;
}

function object(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function issues(value: Prisma.JsonValue): unknown[] {
	return Array.isArray(value) ? value : [];
}

function snapshot(item: Record<string, unknown>): Record<string, unknown> {
	const tags = Array.isArray(item.tags)
		? item.tags.map((tag) => (tag as { id: string }).id).sort()
		: [];
	return {
		name: item.name,
		description: item.description,
		location: item.location,
		quantity: Number(item.quantity ?? 0),
		unit: item.unit,
		unit_price: item.unit_price == null ? null : Number(item.unit_price),
		cost: item.cost == null ? null : Number(item.cost),
		sku: item.sku,
		barcode: item.barcode,
		category: item.category,
		low_stock_threshold: item.low_stock_threshold == null ? null : Number(item.low_stock_threshold),
		image_urls: item.image_urls,
		alt_ids: item.alt_ids,
		is_active: item.is_active,
		variant_group_id: item.variant_group_id,
		variant_attributes: item.variant_attributes,
		tag_ids: tags,
	};
}

function proposalFor(candidate: { normalized_proposal: Prisma.JsonValue; user_overrides: Prisma.JsonValue }): InventoryProposal & Record<string, unknown> {
	const proposal = {
		...object(candidate.normalized_proposal),
		...object(candidate.user_overrides),
	} as InventoryProposal & Record<string, unknown>;
	// null is the persisted override sentinel for "clear the imported target".
	// A cleared quantity means no ledger adjustment, never an implicit target of zero.
	if (proposal.quantity === null) delete proposal.quantity;
	return proposal;
}

function actor(dispatcherId?: string): ActorInfo {
	return { actor_type: dispatcherId ? "dispatcher" : "system", ...(dispatcherId ? { actor_id: dispatcherId } : {}) };
}

function editableFields(proposal: InventoryProposal): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	for (const field of [
		"name", "description", "location", "unit", "unit_price", "cost", "sku", "barcode",
		"category", "low_stock_threshold", "image_urls", "alt_ids", "variant_attributes",
	] as const) {
		if (proposal[field] !== undefined) data[field] = proposal[field];
	}
	return data;
}

async function resolveTags(tx: Tx, organizationId: string, labels: string[] | undefined): Promise<string[] | undefined> {
	if (labels === undefined) return undefined;
	const ids: string[] = [];
	for (const raw of labels) {
		const label = raw.trim();
		if (!label) continue;
		let tag = await tx.inventory_tag.findFirst({
			where: { organization_id: organizationId, label: { equals: label, mode: "insensitive" } },
			select: { id: true },
		});
		if (!tag) tag = await tx.inventory_tag.create({ data: { organization_id: organizationId, label }, select: { id: true } });
		ids.push(tag.id);
	}
	return ids;
}

async function resolveVariantGroup(
	tx: Tx,
	organizationId: string,
	proposal: InventoryProposal & Record<string, unknown>,
	cache: Map<string, { id: string; created: boolean }>,
): Promise<{ id?: string; createdId?: string }> {
	if (proposal.variant_group_id) {
		const existing = await tx.inventory_variant_group.findFirst({
			where: { id: proposal.variant_group_id, organization_id: organizationId },
			select: { id: true },
		});
		if (!existing) throw new InventoryImportError("Selected variant group was not found", "VARIANT_GROUP_NOT_FOUND", 409);
		if (proposal.variant_group_approved !== true) {
			throw new InventoryImportError("Variant group changes require explicit approval", "VARIANT_APPROVAL_REQUIRED", 409);
		}
		return { id: existing.id };
	}
	if (!proposal.variant_group_name) return {};
	if (proposal.variant_group_approved !== true) {
		throw new InventoryImportError("Variant group changes require explicit approval", "VARIANT_APPROVAL_REQUIRED", 409);
	}
	const key = proposal.variant_group_name.trim().toLowerCase();
	const cached = cache.get(key);
	if (cached) return { id: cached.id, ...(cached.created ? { createdId: cached.id } : {}) };
	const existing = await tx.inventory_variant_group.findFirst({
		where: { organization_id: organizationId, display_name: { equals: proposal.variant_group_name, mode: "insensitive" } },
		select: { id: true },
	});
	if (existing) {
		cache.set(key, { id: existing.id, created: false });
		return { id: existing.id };
	}
	const created = await tx.inventory_variant_group.create({
		data: { organization_id: organizationId, display_name: proposal.variant_group_name, attributes: proposal.variant_attributes ? plain(proposal.variant_attributes) : undefined },
		select: { id: true },
	});
	cache.set(key, { id: created.id, created: true });
	return { id: created.id, createdId: created.id };
}

async function applyQuantity(
	tx: Tx,
	organizationId: string,
	dispatcherId: string | undefined,
	item: { id: string; quantity: Prisma.Decimal; is_serialized: boolean; is_batch_tracked: boolean },
	proposal: InventoryProposal,
	importId: string,
): Promise<string[]> {
	if (proposal.quantity === undefined) return [];
	const current = Number(item.quantity);
	const delta = proposal.quantity - current;
	if (delta === 0) return [];
	const incoming = delta > 0;
	const movement: MovementInput = {
		inventory_item_id: item.id,
		qty: Math.abs(delta),
		from_location_type: incoming ? "external" : "warehouse",
		to_location_type: incoming ? "warehouse" : "adjustment",
		reason: incoming ? "initial" : "audit_correction",
		note: `Inventory import ${importId}`,
	};
	if (incoming && proposal.cost_at_receipt != null) movement.unit_cost = proposal.cost_at_receipt;
	if (item.is_serialized) {
		if (incoming) {
			if ((proposal.serial_numbers?.length ?? 0) !== Math.abs(delta)) {
				throw new InventoryImportError("Serialized quantity requires one serial number per unit", "TRACKING_REQUIRED", 409);
			}
			movement.serial = { create: proposal.serial_numbers!.map((serial_number) => ({ serial_number })) };
		} else {
			throw new InventoryImportError("Reducing serialized stock requires selecting serial units", "TRACKING_REQUIRED", 409);
		}
	}
	if (item.is_batch_tracked && !item.is_serialized) {
		if (!incoming || !proposal.lot_number) {
			throw new InventoryImportError("Batch-tracked quantity changes require an approved lot", "TRACKING_REQUIRED", 409);
		}
		const batch = await getOrCreateBatch(tx, organizationId, {
			inventory_item_id: item.id,
			batch_number: proposal.lot_number,
			unit_cost: proposal.cost_at_receipt ?? null,
			note: `Inventory import ${importId}`,
		});
		movement.batch_allocations = [{ batch_id: batch.id, qty: Math.abs(delta) }];
	}
	return (await recordMovements(tx, organizationId, actor(dispatcherId), [movement])).movementIds;
}

export interface CommitInventoryImportInput {
	importId: string;
	organizationId: string;
	revision: number;
	dispatcherId?: string;
}

export async function commitInventoryImport(input: CommitInventoryImportInput) {
	try {
		return await db.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT id FROM inventory_import WHERE id = ${input.importId} AND organization_id = ${input.organizationId} FOR UPDATE`;
		const record = await tx.inventory_import.findFirst({
			where: { id: input.importId, organization_id: input.organizationId },
		});
		if (!record) throw new InventoryImportError("Import not found", "NOT_FOUND", 404);
		if (record.status === "committed") {
			return { id: record.id, status: record.status, committed_at: record.committed_at, undo_expires_at: record.undo_expires_at, idempotent: true };
		}
		if (record.status !== "ready_for_review") throw new InventoryImportError("Import is not ready to commit", "INVALID_STATUS", 409);
		if (record.revision !== input.revision) throw new InventoryImportError("Import changed since it was loaded", "STALE_REVISION", 409);

		const candidates = await tx.inventory_import_candidate.findMany({
			where: { import_id: record.id, organization_id: input.organizationId, selected: true },
			orderBy: { created_at: "asc" },
			include: { source: { select: { source_type: true, storage_url: true } } },
		});
		const actionable = candidates.filter((candidate) => candidate.proposed_action !== "skip");
		if (actionable.length === 0) throw new InventoryImportError("No candidates are selected for commit", "NOTHING_TO_COMMIT", 409);
		if (actionable.some((candidate) => candidate.proposed_action === "conflict")) {
			throw new InventoryImportError("Resolve all conflicts before commit", "UNRESOLVED_CONFLICTS", 409);
		}
		if (actionable.some((candidate) => issues(candidate.validation_issues).length > 0)) {
			throw new InventoryImportError("Resolve all validation issues before commit", "VALIDATION_ISSUES", 409);
		}
		if (actionable.some((candidate) => candidate.requires_financial_approval && !candidate.financial_approved_at)) {
			throw new InventoryImportError("Financial fields require explicit approval", "FINANCIAL_APPROVAL_REQUIRED", 409);
		}

		await tx.inventory_import.update({ where: { id: record.id }, data: { status: "committing" } });
		const variantCache = new Map<string, { id: string; created: boolean }>();
		const changedItemIds: string[] = [];

		for (const candidate of actionable) {
			const proposal = proposalFor(candidate);
			const approvedPhotoUrl = candidate.source.source_type === "product_photo" && proposal.photo_attachment_approved === true
				? candidate.source.storage_url
				: undefined;
			if (approvedPhotoUrl?.startsWith("local-import://")) {
				throw new InventoryImportError(
					"Approved product photos require configured object storage before commit",
					"PHOTO_STORAGE_UNAVAILABLE",
					409,
				);
			}
			if (approvedPhotoUrl) proposal.image_urls = [...new Set([...(proposal.image_urls ?? []), approvedPhotoUrl])];
			const tagIds = await resolveTags(tx, input.organizationId, proposal.tags);
			const variant = await resolveVariantGroup(tx, input.organizationId, proposal, variantCache);
			let before: Record<string, unknown> | null = null;
			let itemId: string;
			let action: "created" | "updated";

			if (candidate.proposed_action === "create") {
				if (!proposal.name || !proposal.location) throw new InventoryImportError("Name and location are required", "VALIDATION_ISSUES", 409);
				const created = await tx.inventory_item.create({
					data: {
						organization_id: input.organizationId,
						origin: "import",
						name: proposal.name,
						description: proposal.description ?? "",
						location: proposal.location,
						quantity: 0,
						unit: proposal.unit ?? "each",
						unit_price: proposal.unit_price ?? null,
						cost: proposal.cost ?? null,
						sku: proposal.sku || null,
						barcode: proposal.barcode || null,
						category: proposal.category || null,
						low_stock_threshold: proposal.low_stock_threshold ?? null,
						image_urls: proposal.image_urls ?? [],
						alt_ids: proposal.alt_ids ?? [],
						is_serialized: proposal.is_serialized ?? false,
						is_batch_tracked: proposal.is_batch_tracked ?? false,
						variant_group_id: variant.id,
						variant_attributes: proposal.variant_attributes ? plain(proposal.variant_attributes) : undefined,
						...(tagIds ? { tags: { connect: tagIds.map((id) => ({ id })) } } : {}),
					},
					select: ITEM_SELECT,
				});
				itemId = created.id;
				action = "created";
			} else {
				if (!candidate.existing_item_id) throw new InventoryImportError("Select an existing item for every update", "MATCH_REQUIRED", 409);
				const existing = await tx.inventory_item.findFirst({
					where: { id: candidate.existing_item_id, organization_id: input.organizationId },
					select: ITEM_SELECT,
				});
				if (!existing) throw new InventoryImportError("Matched inventory item no longer exists", "MATCH_CHANGED", 409);
				if (proposal.quantity !== undefined && candidate.existing_quantity_at_review != null && Number(existing.quantity) !== Number(candidate.existing_quantity_at_review)) {
					throw new InventoryImportError(`On-hand quantity changed after review for ${existing.name}`, "STOCK_CHANGED_SINCE_REVIEW", 409);
				}
				const evidence = object(candidate.matching_evidence);
				if (typeof evidence.existing_updated_at === "string" && existing.updated_at.toISOString() !== evidence.existing_updated_at) {
					throw new InventoryImportError(`${existing.name} changed after review`, "ITEM_CHANGED_SINCE_REVIEW", 409);
				}
				if (proposal.unit !== undefined && proposal.unit !== existing.unit && Number(existing.quantity) !== 0) {
					throw new InventoryImportError(
						`Changing the unit for ${existing.name} would re-denominate stock on hand`,
						"UNIT_CHANGE_WITH_STOCK",
						409,
					);
				}
				if (approvedPhotoUrl) {
					proposal.image_urls = [...new Set([...existing.image_urls, ...(proposal.image_urls ?? [])])];
				}
				before = snapshot(existing as unknown as Record<string, unknown>);
				await tx.inventory_item.update({
					where: { id: existing.id },
					data: {
						...editableFields(proposal),
						...(variant.id ? { variant_group_id: variant.id } : {}),
						...(tagIds ? { tags: { set: tagIds.map((id) => ({ id })) } } : {}),
					},
				});
				itemId = existing.id;
				action = "updated";
			}

			const itemBeforeMovement = await tx.inventory_item.findFirst({
				where: { id: itemId, organization_id: input.organizationId },
				select: { id: true, quantity: true, is_serialized: true, is_batch_tracked: true },
			});
			if (!itemBeforeMovement) throw new InventoryImportError("Inventory item disappeared during commit", "COMMIT_CONFLICT", 409);
			const movementIds = await applyQuantity(tx, input.organizationId, input.dispatcherId, itemBeforeMovement, proposal, record.id);

			const mappingIds: string[] = [];
			if (proposal.external_id) {
				const provider = `inventory-import:${String(proposal.source_namespace ?? "default").trim().toLowerCase()}`;
				const existingMapping = await tx.item_external_mapping.findUnique({
					where: { provider_external_id_account_id: { provider, external_id: proposal.external_id, account_id: input.organizationId } },
				});
				if (existingMapping && existingMapping.inventory_item_id !== itemId) {
					throw new InventoryImportError("External identity is already mapped to another item", "EXTERNAL_IDENTITY_CONFLICT", 409);
				}
				if (!existingMapping) {
					const mapping = await tx.item_external_mapping.create({
						data: { inventory_item_id: itemId, provider, external_id: proposal.external_id, account_id: input.organizationId },
					});
					mappingIds.push(mapping.id);
				}
			}

			const afterItem = await tx.inventory_item.findFirst({ where: { id: itemId, organization_id: input.organizationId }, select: ITEM_SELECT });
			if (!afterItem) throw new InventoryImportError("Inventory item disappeared during commit", "COMMIT_CONFLICT", 409);
			await tx.inventory_import_change.create({
				data: {
					organization_id: input.organizationId,
					import_id: record.id,
					candidate_id: candidate.id,
					inventory_item_id: itemId,
					action,
					before_snapshot: before ? plain(before) : undefined,
					after_snapshot: plain(snapshot(afterItem as unknown as Record<string, unknown>)),
					created_mapping_ids: mappingIds,
					stock_movement_ids: movementIds,
					created_variant_group_id: variant.createdId,
				},
			});
			await tx.log.create({
				data: {
					organization_id: input.organizationId,
					event_type: `inventory_item.import_${action}`,
					action: action === "created" ? "created" : "updated",
					entity_type: "inventory_item",
					entity_id: itemId,
					actor_type: input.dispatcherId ? "dispatcher" : "system",
					actor_id: input.dispatcherId,
					reason: `Inventory import ${record.id}`,
				},
			});
			changedItemIds.push(itemId);
		}

		const committedAt = new Date();
		const undoMinutes = Number(process.env.INVENTORY_IMPORT_UNDO_WINDOW_MINUTES ?? 30);
		const undoExpiresAt = new Date(committedAt.getTime() + undoMinutes * 60_000);
		const committed = await tx.inventory_import.update({
			where: { id: record.id },
			data: { status: "committed", committed_at: committedAt, undo_expires_at: undoExpiresAt, revision: { increment: 1 } },
		});
		await tx.log.create({
			data: {
				organization_id: input.organizationId,
				event_type: "inventory_import.committed",
				action: "updated",
				entity_type: "inventory_import",
				entity_id: record.id,
				actor_type: input.dispatcherId ? "dispatcher" : "system",
				actor_id: input.dispatcherId,
				changes: plain({ item_count: changedItemIds.length }),
			},
		});
		inventoryImportEvents.add(1, { event: "committed" });
		inventoryImportDuration.record((committedAt.getTime() - record.created_at.getTime()) / 1000, { stage: "commit" });
		return { id: committed.id, status: committed.status, committed_at: committed.committed_at, undo_expires_at: committed.undo_expires_at, item_ids: changedItemIds, idempotent: false };
		}, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 });
	} catch (error) {
		if (error instanceof InventoryImportError) throw error;
		if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
			throw new InventoryImportError(
				"An SKU, barcode, external identity, or variant group now conflicts with existing inventory",
				"DUPLICATE_IDENTITY_CONFLICT",
				409,
			);
		}
		if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
			throw new InventoryImportError(
				"Inventory changed during commit. Refresh the review and try again.",
				"COMMIT_CONFLICT",
				409,
			);
		}
		throw error;
	}
}

function same(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export async function undoInventoryImport(input: Omit<CommitInventoryImportInput, "revision">) {
	try {
		return await db.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT id FROM inventory_import WHERE id = ${input.importId} AND organization_id = ${input.organizationId} FOR UPDATE`;
		const record = await tx.inventory_import.findFirst({
			where: { id: input.importId, organization_id: input.organizationId },
			include: { changes: { orderBy: { created_at: "desc" } } },
		});
		if (!record) throw new InventoryImportError("Import not found", "NOT_FOUND", 404);
		if (record.status === "undone") return { id: record.id, status: record.status, idempotent: true };
		if (record.status !== "committed") throw new InventoryImportError("Only committed imports can be undone", "INVALID_STATUS", 409);
		if (!record.undo_expires_at || record.undo_expires_at.getTime() < Date.now()) {
			throw new InventoryImportError("The configured undo window has expired", "UNDO_EXPIRED", 409);
		}
		const importedMovementIds = record.changes.flatMap((change) => change.stock_movement_ids);
		const laterMovement = await tx.stock_movement.findFirst({
			where: {
				organization_id: input.organizationId,
				inventory_item_id: { in: record.changes.map((change) => change.inventory_item_id) },
				created_at: { gt: record.committed_at ?? record.created_at },
				...(importedMovementIds.length ? { id: { notIn: importedMovementIds } } : {}),
			},
			select: { id: true },
		});
		if (laterMovement) throw new InventoryImportError("Inventory was used or changed after this import", "UNDO_BLOCKED_BY_ACTIVITY", 409);

		for (const change of record.changes) {
			const current = await tx.inventory_item.findFirst({ where: { id: change.inventory_item_id, organization_id: input.organizationId }, select: ITEM_SELECT });
			if (!current) throw new InventoryImportError("An affected inventory item no longer exists", "UNDO_CONFLICT", 409);
			const currentSnapshot = snapshot(current as unknown as Record<string, unknown>);
			const after = object(change.after_snapshot);
			for (const key of Object.keys(after).filter((field) => field !== "quantity")) {
				if (!same(currentSnapshot[key], after[key])) {
					throw new InventoryImportError(`${current.name} changed after the import`, "UNDO_BLOCKED_BY_ACTIVITY", 409);
				}
			}
			if (change.action === "created") {
				const dependent = await Promise.all([
					tx.job_visit_line_item.findFirst({ where: { inventory_item_id: current.id }, select: { id: true } }),
					tx.quote_line_item.findFirst({ where: { inventory_item_id: current.id }, select: { id: true } }),
					tx.job_line_item.findFirst({ where: { inventory_item_id: current.id }, select: { id: true } }),
					tx.invoice_line_item.findFirst({ where: { inventory_item_id: current.id }, select: { id: true } }),
				]);
				if (dependent.some(Boolean)) throw new InventoryImportError(`${current.name} has later dependencies`, "UNDO_BLOCKED_BY_ACTIVITY", 409);
			}
		}

		await tx.inventory_import.update({ where: { id: record.id }, data: { status: "undoing" } });
		const createdVariantGroups = new Set<string>();
		for (const change of record.changes) {
			const movements = await tx.stock_movement.findMany({
				where: { id: { in: change.stock_movement_ids }, organization_id: input.organizationId },
				include: { movement_serials: true, movement_batches: true },
				orderBy: { created_at: "desc" },
			});
			for (const movement of movements) {
				await recordMovements(tx, input.organizationId, actor(input.dispatcherId), [{
					inventory_item_id: movement.inventory_item_id,
					qty: Number(movement.qty),
					from_location_type: movement.to_location_type,
					from_vehicle_id: movement.to_vehicle_id ?? undefined,
					to_location_type: movement.from_location_type,
					to_vehicle_id: movement.from_vehicle_id ?? undefined,
					reason: "reversal",
					note: `Undo inventory import ${record.id}`,
					serial: movement.movement_serials.length ? { unit_ids: movement.movement_serials.map((row) => row.serial_unit_id) } : undefined,
					batch_allocations: movement.movement_batches.map((row) => ({ batch_id: row.batch_id, qty: Number(row.qty) })),
				}]);
			}

			if (change.created_mapping_ids.length) {
				await tx.item_external_mapping.deleteMany({ where: { id: { in: change.created_mapping_ids }, inventory_item_id: change.inventory_item_id } });
			}
			if (change.created_variant_group_id) createdVariantGroups.add(change.created_variant_group_id);
			if (change.action === "created") {
				await tx.inventory_item.update({
					where: { id: change.inventory_item_id },
					data: { is_active: false, variant_group_id: null },
				});
			} else {
				const before = object(change.before_snapshot);
				const tagIds = Array.isArray(before.tag_ids) ? before.tag_ids.filter((id): id is string => typeof id === "string") : [];
				await tx.inventory_item.update({
					where: { id: change.inventory_item_id },
					data: {
						name: String(before.name),
						description: String(before.description),
						location: String(before.location),
						unit: String(before.unit),
						unit_price: before.unit_price == null ? null : Number(before.unit_price),
						cost: before.cost == null ? null : Number(before.cost),
						sku: before.sku == null ? null : String(before.sku),
						barcode: before.barcode == null ? null : String(before.barcode),
						category: before.category == null ? null : String(before.category),
						low_stock_threshold: before.low_stock_threshold == null ? null : Number(before.low_stock_threshold),
						image_urls: Array.isArray(before.image_urls) ? before.image_urls.filter((url): url is string => typeof url === "string") : [],
						alt_ids: Array.isArray(before.alt_ids) ? before.alt_ids.filter((id): id is string => typeof id === "string") : [],
						is_active: before.is_active !== false,
						variant_group_id: before.variant_group_id == null ? null : String(before.variant_group_id),
						variant_attributes: before.variant_attributes == null ? Prisma.JsonNull : plain(before.variant_attributes),
						tags: { set: tagIds.map((id) => ({ id })) },
					},
				});
			}
		}

		for (const groupId of createdVariantGroups) {
			const member = await tx.inventory_item.findFirst({ where: { variant_group_id: groupId, is_active: true }, select: { id: true } });
			if (!member) await tx.inventory_variant_group.deleteMany({ where: { id: groupId, organization_id: input.organizationId } });
		}
		const undoneAt = new Date();
		await tx.inventory_import.update({ where: { id: record.id }, data: { status: "undone", undone_at: undoneAt, revision: { increment: 1 } } });
		await tx.log.create({
			data: {
				organization_id: input.organizationId,
				event_type: "inventory_import.undone",
				action: "updated",
				entity_type: "inventory_import",
				entity_id: record.id,
				actor_type: input.dispatcherId ? "dispatcher" : "system",
				actor_id: input.dispatcherId,
				changes: plain({ item_count: record.changes.length }),
			},
		});
		inventoryImportEvents.add(1, { event: "undone" });
		return { id: record.id, status: "undone", undone_at: undoneAt, idempotent: false };
		}, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 });
	} catch (error) {
		if (error instanceof InventoryImportError) throw error;
		if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034")) {
			throw new InventoryImportError(
				"Inventory changed during undo. Refresh the import and try again.",
				"UNDO_CONFLICT",
				409,
			);
		}
		throw error;
	}
}
