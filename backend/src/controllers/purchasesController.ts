import { isModuleOn } from "../services/entitlementService.js";
import { ZodError } from "zod";
import { db, generatePurchaseNumber } from "../db.js";
import { getScopedDb, getUserContext, type UserContext } from "../lib/context.js";
import {
	createPurchaseSchema,
	updatePurchaseSchema,
	replaceLinesSchema,
	cancelPurchaseSchema,
	listPurchasesQuerySchema,
	receivePurchaseSchema,
} from "../lib/validate/purchases.js";
import { Prisma, type line_item_disposition } from "../../generated/prisma/client.js";
import { logActivity } from "../services/logger.js";
import { assertInventoryItemsInOrg, assertDispositionVehiclesInOrg } from "../lib/inventory.js";
import { toDecimal, sumDecimal, deriveAllocationAmounts } from "../lib/fieldPurchase.js";
import { recordMovements } from "../services/stockMovements.js";
import { recomputeVisitTotals } from "../lib/recomputeDocumentTotals.js";
import { applyInventoryTaxable } from "../lib/inventoryTaxable.js";

/**
 * Planned vendor procurement: a dispatcher orders stock (or a job-specific part)
 * ahead of time, from a known vendor, before any job needs it. Distinct from
 * fieldPurchasesController.ts's emergency counter-buy flow - no OCR, no receipt
 * capture, no technician spend authority.
 */

type Result<T> = { err?: string } & Partial<T>;

const LINE_SELECT = {
	id: true,
	description: true,
	quantity: true,
	unit_price: true,
	line_total: true,
	inventory_item_id: true,
	disposition: true,
	disposition_location: true,
	disposition_vehicle_id: true,
	quantity_recieved: true,
	received_at: true,
	allocation_id: true,
	sort_order: true,
	inventory_item: {
		select: { id: true, name: true, sku: true, unit: true, barcode: true, location: true },
	},
	disposition_vehicle: { select: { id: true, name: true } },
} as const;

const PURCHASE_SELECT = {
	id: true,
	status: true,
	kind: true,
	purchase_number: true,
	vendor_name: true,
	supplier_id: true,
	purchased_at: true,
	subtotal: true,
	tax_group_id: true,
	tax_amount: true,
	total: true,
	submitted_at: true,
	cancelled_at: true,
	cancellation_reason: true,
	flags: true,
	created_at: true,
	updated_at: true,
	qb_purchase_id: true,
	qb_sync_status: true,
	supplier: { select: { id: true, name: true } },
	tax_group: { select: { id: true, name: true } },
	lines: { select: LINE_SELECT, orderBy: { sort_order: "asc" } },
	allocations: {
		select: {
			id: true,
			job_id: true,
			job_visit_id: true,
			amount: true,
			job: { select: { id: true, job_number: true, name: true } },
			job_visit: { select: { id: true, name: true, scheduled_start_at: true } },
		},
	},
} as const;

type ApprovalLine = {
	id: string;
	description: string;
	quantity: Prisma.Decimal;
	unit_price: Prisma.Decimal;
	inventory_item_id: string | null;
	disposition: string | null;
	disposition_vehicle_id: string | null;
	visit_line_item_id: string | null;
	allocation: { job_visit_id: string | null } | null;
};

function actorOf(context?: UserContext) {
	return {
		actor_type: context?.techId ? "technician" : context?.dispatcherId ? "dispatcher" : "system",
		actor_id: context?.techId ?? context?.dispatcherId ?? null,
	};
}

function logPurchaseActivity(
	orgId: string,
	entity = "purchase",
	entityId: string,
	event: string,
	action: "created" | "updated",
	context?: UserContext,
	reason?: string,
) {
	return logActivity({
		event_type: `${entity}.${event}`,
		action,
		entity_type: entity,
		entity_id: entityId,
		organization_id: orgId,
		...(reason ? { reason } : {}),
		...actorOf(context),
	});
}

async function applyRecieveStockEffect(
	tx: Prisma.TransactionClient,
	orgId: string,
	purchase: { id: string; supplier_id: string | null; lines: ApprovalLine[] },
	dispatcherId: string,
): Promise<string[]> {
	const toReceive = purchase.lines.filter((l) => l.disposition === "receive");
	const warnings = toReceive
		.filter((l) => !l.inventory_item_id)
		.map(
			(l) =>
				`Line "${l.description}" is marked to receive into stock but has no catalog item linked — no stock was moved for it.`,
		);

	const intake = toReceive.filter((l) => l.inventory_item_id);
	if (intake.length === 0) return warnings;
	// With Vehicle Stock off the truck is not a stock location, so intake lands in the warehouse.
	const vehicleStockOn = await isModuleOn(orgId, "vehicle_stock");

	await recordMovements(
		tx,
		orgId,
		{ actor_type: "dispatcher", actor_id: dispatcherId },
		intake.map((l) => ({
			inventory_item_id: l.inventory_item_id!,
			qty: Number(l.quantity),
			from_location_type: "external" as const,
			to_location_type:
				vehicleStockOn && l.disposition_vehicle_id ? ("vehicle" as const) : ("warehouse" as const),
			to_vehicle_id: vehicleStockOn ? (l.disposition_vehicle_id ?? undefined) : undefined,
			// The same physical event as a tech buying at a counter, which this reason already names.
			reason: "supplier_purchase" as const,
			unit_cost: Number(l.unit_price),
			supplier_id: purchase.supplier_id ?? undefined,
			purchase_line_id: l.id,
			note: "Purchase order received",
		})),
		// A serial/batch tracked item would otherwise need per-unit input a receipt does not carry; the gap is recorded and reported.
		{ allowUntracked: true },
	);
	return warnings;
}

async function applyRecieveJobCost(
	tx: Prisma.TransactionClient,
	orgId: string,
	purchase: { id: string; lines: ApprovalLine[] },
	dispatcherId: string,
): Promise<string[]> {
	const billable = purchase.lines.filter((l) => l.disposition === "non_stock");
	if (billable.length === 0) return [];

	const warnings: string[] = [];
	const touchedVisits = new Set<string>();

	for (const line of billable) {
		const visitId = line.allocation?.job_visit_id;
		if (!visitId) {
			warnings.push(
				`Line "${line.description}" is job-costed but its allocation has no job visit. Its cost was not added to any invoice.`,
			);
			continue;
		}

		const total = line.quantity.times(line.unit_price);

		if (line.visit_line_item_id) {
			await tx.job_visit_line_item.update({
				where: { id: line.visit_line_item_id },
				data: { quantity: { increment: line.quantity }, total: { increment: total } },
			});
		} else {
			const [data] = await applyInventoryTaxable(tx, orgId, [
				{
					visit_id: visitId,
					name: line.description,
					quantity: line.quantity,
					unit_price: line.unit_price,
					total,
					source: "manual" as const,
					item_type: "material" as const,
					disposition: "non_stock" as const,
					inventory_item_id: line.inventory_item_id,
					fulfillment_status: line.inventory_item_id ? ("used" as const) : null,
				},
			]);
			const created = await tx.job_visit_line_item.create({ data });
			await tx.purchase_line.update({
				where: { id: line.id },
				data: { visit_line_item_id: created.id },
			});
		}

		touchedVisits.add(visitId);
	}

	for (const visitId of touchedVisits) {
		await recomputeVisitTotals(visitId, orgId, tx);
	}

	return warnings;
}

/** Message-shaped errors reach the route as 400/404; anything else rethrows. */
function toErr(err: unknown): { err: string } {
	if (err instanceof ZodError) {
		return { err: `Validation failed: ${err.issues.map((i) => i.message).join(", ")}` };
	}
	if (err instanceof Error) return { err: err.message };
	throw err;
}

type EventClient = {
	purchase_event: { create(args: unknown): Promise<unknown> };
};

async function appendEvent(
	client: EventClient,
	orgId: string,
	type: string,
	context: UserContext | undefined,
	refs: { purchase_id?: string; },
	detail: Record<string, unknown> = {},
) {
	const actor = actorOf(context);
	await client.purchase_event.create({
		data: {
			organization_id: orgId,
			purchase_id: refs.purchase_id ?? null,
			type,
			actor_type: actor.actor_type,
			actor_id: actor.actor_id,
			detail: detail as Prisma.InputJsonValue,
		},
	});
}

interface AllocationInput {
	job_id: string;
	job_visit_id?: string | null;
}

/**
 * A named visit has to belong to the job it is allocated against — billing a
 * receipt to some other job's visit would put the charge on the wrong invoice,
 * and the id arrives from a client.
 */
async function assertAllocationsInOrg(orgId: string, allocations: AllocationInput[]) {
	const sdb = getScopedDb(orgId);
	const jobIds = allocations.map((a) => a.job_id);
	const found = await sdb.job.findMany({
		where: { id: { in: jobIds }, },
		select: { id: true },
	});
	const ok = new Set(found.map((j) => j.id));
	const missing = jobIds.filter((id) => !ok.has(id));
	if (missing.length > 0) throw new Error(`Validation failed: unknown job ${missing.join(", ")}`);

	const visitIds = allocations.map((a) => a.job_visit_id).filter((v): v is string => !!v);
	if (visitIds.length === 0) return;
	const visits = await sdb.job_visit.findMany({
		where: { id: { in: visitIds } },
		select: { id: true, job_id: true },
	});
	const jobOfVisit = new Map(visits.map((v) => [v.id, v.job_id]));
	for (const a of allocations) {
		if (!a.job_visit_id) continue;
		if (jobOfVisit.get(a.job_visit_id) !== a.job_id) {
			throw new Error("Validation failed: that visit does not belong to the allocated job");
		}
	}
}

/** Subtotal/total are derived from the lines, never supplied — each is the sum, by definition. */
async function recomputeTotals(tx: Prisma.TransactionClient, purchaseId: string) {
	const [lines, existing] = await Promise.all([
		tx.purchase_line.findMany({ where: { purchase_id: purchaseId }, select: { line_total: true } }),
		tx.purchase.findUniqueOrThrow({ where: { id: purchaseId }, select: { tax_amount: true } }),
	]);
	const subtotal = sumDecimal(lines.map((l) => l.line_total));
	await tx.purchase.update({
		where: { id: purchaseId },
		data: { subtotal, total: subtotal.plus(toDecimal(existing.tax_amount)) },
	});
}

/**
 * Tax moved, or a job left the purchase: either way the allocations' derived
 * `amount` shares no longer answer for the lines underneath them.
 */
async function settleAllocations(tx: Prisma.TransactionClient, purchaseId: string) {
	const sole = await tx.purchase_job_allocation.findMany({
		where: { purchase_id: purchaseId },
		select: { id: true },
		take: 2,
	});

	if (sole.length === 1) {
		await tx.purchase_line.updateMany({
			where: { purchase_id: purchaseId, allocation_id: null, disposition: "non_stock" },
			data: { allocation_id: sole[0]!.id },
		});
	}

	const purchase = await tx.purchase.findUniqueOrThrow({
		where: { id: purchaseId },
		select: {
			tax_amount: true,
			allocations: { select: { id: true, lines: { select: { line_total: true } } } },
		},
	});
	for (const { id, amount } of deriveAllocationAmounts(purchase.allocations, purchase.tax_amount)) {
		await tx.purchase_job_allocation.update({ where: { id }, data: { amount } });
	}
}

/** Only a draft is still being assembled - once ordered it's a commitment already sent to the vendor. */
async function loadDraftPurchase(orgId: string, purchaseId: string) {
	const sdb = getScopedDb(orgId);
	const purchase = await sdb.purchase.findFirst({
		where: { id: purchaseId },
		select: { id: true, status: true },
	});
	if (!purchase) return { err: "Purchase not found" as const };
	if (purchase.status !== "draft") {
		return { err: `A purchase in status ${purchase.status} can no longer be edited` as const };
	}
	return { purchase };
}

/** Locks the lines being received so a concurrent receive can't race the over-receipt check. */
async function lockPurchaseLines(tx: Prisma.TransactionClient, lineIds: string[]): Promise<void> {
	if (lineIds.length === 0) return;
	await tx.$queryRaw`
		SELECT id FROM purchase_line
		WHERE id = ANY(${lineIds}::text[])
		FOR UPDATE
	`;
}

async function loadReceivablePurchase(orgId: string, purchaseId: string) {
	const sdb = getScopedDb(orgId);
	const purchase = await sdb.purchase.findFirst({
		where: { id: purchaseId },
		include: { lines: true, allocations: true },
	});
	if (!purchase) return { err: "Purchase not found" as const };
	if (purchase.status !== "ordered" && purchase.status !== "partially_received") {
		return { err: `A purchase in status ${purchase.status} can not receive items` as const };
	}
	return { purchase };
}


export async function createPurchase(
	orgId: string,
	data: unknown,
	context?: UserContext,
): Promise<Result<{ purchase: unknown }>> {
	try {
		const parsed = createPurchaseSchema.parse(data);
		const sdb = getScopedDb(orgId);

		const jobIds = parsed.allocations?.map((a) => a.job_id) ?? [];
		if (new Set(jobIds).size !== jobIds.length) {
			return { err: "Validation failed: duplicate job in allocations" };
		}
		if (parsed.allocations) await assertAllocationsInOrg(orgId, parsed.allocations);

		const lines = parsed.lines ?? [];
		await assertInventoryItemsInOrg(
			db,
			orgId,
			lines.map((l) => l.inventory_item_id),
		);
		await assertDispositionVehiclesInOrg(
			db,
			orgId,
			lines.map((l) => l.disposition_vehicle_id),
		);
		for (const line of lines) {
			if (line.disposition !== "receive" && line.disposition_vehicle_id) {
				return { err: "Validation failed: only a `receive` line takes a destination vehicle" };
			}
			if (line.job_id && !jobIds.includes(line.job_id)) {
				return { err: "Validation failed: a line names a job this purchase does not cover" };
			}
		}

		const purchase = await sdb.$transaction(async (tx) => {
			const purchaseNumber = await generatePurchaseNumber(tx, orgId);
			const created = await tx.purchase.create({
				data: {
					organization_id: orgId,
					status: "draft",
					purchase_number: purchaseNumber,
					vendor_name: parsed.vendor_name,
					supplier_id: parsed.supplier_id,
					purchased_at: parsed.purchased_at,
					tax_group_id: parsed.tax_group_id,
					tax_amount: parsed.tax_amount,
					allocations: {
						create: parsed.allocations?.map((a) => ({
							job_id: a.job_id,
							job_visit_id: a.job_visit_id ?? null,
							amount: 0,
						})),
					},
				},
				select: { id: true, allocations: { select: { id: true, job_id: true } } },
			});

			// Resolves each line's `job_id` to the allocation just created for that
			// job — `purchase_line` has no `job_id` column of its own, only
			// `allocation_id`.
			const allocOfJob = new Map(created.allocations.map((a) => [a.job_id, a.id]));
			for (const [i, line] of lines.entries()) {
				const lineTotal =
					line.line_total ?? toDecimal(line.quantity).times(toDecimal(line.unit_price)).toNumber();
				await tx.purchase_line.create({
					data: {
						purchase_id: created.id,
						description: line.description,
						quantity: line.quantity,
						unit_price: line.unit_price,
						line_total: lineTotal,
						inventory_item_id: line.inventory_item_id ?? null,
						disposition: line.disposition ?? null,
						disposition_location:
							line.disposition === "receive"
								? line.disposition_vehicle_id
									? "vehicle"
									: "warehouse"
								: null,
						disposition_vehicle_id:
							line.disposition === "receive" ? (line.disposition_vehicle_id ?? null) : null,
						allocation_id: line.job_id ? (allocOfJob.get(line.job_id) ?? null) : null,
						sort_order: line.sort_order ?? i,
					},
				});
			}

			if (lines.length > 0) {
				await recomputeTotals(tx as unknown as Prisma.TransactionClient, created.id);
			}

			await appendEvent(tx, orgId, "purchase.created", context, {
				purchase_id: created.id,
			});

			return tx.purchase.findUniqueOrThrow({ where: { id: created.id }, select: PURCHASE_SELECT });
		});

		await logPurchaseActivity(orgId, "purchase", purchase.id, "created", "created", context);

		return { purchase };
	} catch (err) {
		return toErr(err);
	}
}

/**
 * Ordering and date filtering need one clock: a purchase enters the reviewer's world
 * at submit, and before that only its creation time exists.
 */
function submittedRange(from?: Date, to?: Date) {
	if (!from && !to) return {};
	const range = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
	return {
		OR: [{ submitted_at: range }, { AND: [{ submitted_at: null }, { created_at: range }] }],
	};
}

const OPEN_PURCHASE_STATUSES = ["draft", "ordered", "partially_received"] as const;

export async function listPurchases(
	orgId: string,
	query?: unknown,
): Promise<Result<{ purchases: unknown[]; total: number; offset: number }>> {
	try {
		const parsed = listPurchasesQuerySchema.parse(query);
		const sdb = getScopedDb(orgId);

		const statusWhere = parsed.status === "all"
			? {}
			: parsed.status === "open"
				? { status: { in: [...OPEN_PURCHASE_STATUSES] } }
				: { status: parsed.status };

		const searchWhere = parsed.search
			? {
				OR: [
					{ vendor_name: { contains: parsed.search, mode: "insensitive" as const } },
					{
						lines: {
							some: {
								description: { contains: parsed.search, mode: "insensitive" as const },
							},
						},
					},
				],
			}
			: {};

		const where = {
			...statusWhere,
			...(parsed.kind === "all" ? {} : { kind: parsed.kind }),
			...(parsed.supplier_id ? { supplier_id: parsed.supplier_id } : {}),
			...(parsed.job_id ? { allocations: { some: { job_id: parsed.job_id } } } : {}),
			// Two independent OR groups cannot share one object literal.
			AND: [searchWhere, submittedRange(parsed.date_from, parsed.date_to)],
		};

		const orderBy =
			parsed.sort === "amount_desc"
				? [{ total: "desc" as const }]
				: parsed.sort === "amount_asc"
					? [{ total: "asc" as const }]
					: parsed.sort === "oldest"
						? [
							{ submitted_at: { sort: "asc" as const, nulls: "last" as const } },
							{ created_at: "asc" as const },
						]
						: [
							{ submitted_at: { sort: "desc" as const, nulls: "last" as const } },
							{ created_at: "desc" as const },
						];
		
		const [purchases, total] = await Promise.all([
			sdb.purchase.findMany({
				where,
				select: PURCHASE_SELECT,
				orderBy,
				skip: parsed.offset,
				take: parsed.limit,
			}),
			sdb.purchase.count({ where }),
		]);

		return { purchases, total, offset: parsed.offset };
	} catch (err) {
		return toErr(err);
	}
}

export async function getPurchase(
	orgId: string,
	purchaseId: string,
): Promise<Result<{ purchase: unknown; events: unknown[] }>> {
	try {
		const sdb = getScopedDb(orgId);
		const purchase = await sdb.purchase.findFirst({
			where: { id: purchaseId },
			select: { ...PURCHASE_SELECT, events: { orderBy: { at: "asc" } } },
		});
		if (!purchase) {
			return { err: "Purchase not found" };
		}

		return { purchase, events: purchase.events };
	} catch (err) {
		return toErr(err);
	}
}

export async function updatePurchase(
	orgId: string,
	purchaseId: string,
	data: unknown,
	context?: UserContext,
): Promise<Result<{ purchase: unknown }>> {
	try {
		const parsed = updatePurchaseSchema.parse(data);
		const sdb = getScopedDb(orgId);

		const loaded = await loadDraftPurchase(orgId, purchaseId);
		if (loaded.err) return { err: loaded.err };

		if (parsed.supplier_id) {
			const supplier = await sdb.supplier.findFirst({
				where: { id: parsed.supplier_id },
				select: { id: true },
			});
			if (!supplier) return { err: "Validation failed: unknown supplier" };
		}
		if (parsed.allocations) {
			const jobIds = parsed.allocations.map((a) => a.job_id);
			if (new Set(jobIds).size !== jobIds.length) {
				return { err: "Validation failed: duplicate job in allocations" };
			}
			await assertAllocationsInOrg(orgId, parsed.allocations);
		}

		const purchase = await sdb.$transaction(async (tx) => {
			if (parsed.allocations) {
				const keep = parsed.allocations.map((a) => a.job_id);
				await tx.purchase_job_allocation.deleteMany({
					where: {
						purchase_id: purchaseId,
						...(keep.length > 0 ? { job_id: { notIn: keep } } : {}),
					},
				});
				// Matched by job rather than replaced wholesale: the lines point at
				// the allocation row, so recreating it would silently strip every
				// line of the job it was bought for.
				for (const a of parsed.allocations) {
					await tx.purchase_job_allocation.upsert({
						where: {
							purchase_id_job_id: {
								purchase_id: purchaseId,
								job_id: a.job_id,
							},
						},
						create: {
							purchase_id: purchaseId,
							job_id: a.job_id,
							job_visit_id: a.job_visit_id ?? null,
							amount: 0,
						},
						update: {
							...(a.job_visit_id !== undefined && { job_visit_id: a.job_visit_id }),
						},
					});
				}
			}

			await tx.purchase.update({
				where: { id: purchaseId },
				data: {
					...(parsed.vendor_name !== undefined && { vendor_name: parsed.vendor_name }),
					...(parsed.supplier_id !== undefined && { supplier_id: parsed.supplier_id }),
					...(parsed.purchased_at !== undefined && { purchased_at: parsed.purchased_at }),
					...(parsed.tax_group_id !== undefined && { tax_group_id: parsed.tax_group_id }),
					...(parsed.tax_amount !== undefined && { tax_amount: parsed.tax_amount }),
				},
			});
			await recomputeTotals(tx as unknown as Prisma.TransactionClient, purchaseId);
			// Tax moved, or a job left the receipt: either way the shares no longer
			// answer for the lines underneath them.
			await settleAllocations(tx as unknown as Prisma.TransactionClient, purchaseId);
			await appendEvent(
				tx,
				orgId,
				"purchase.updated",
				context,
				{ purchase_id: purchaseId },
				{ fields: Object.keys(parsed) },
			);
			return tx.purchase.findUniqueOrThrow({
				where: { id: purchaseId },
				select: PURCHASE_SELECT,
			});
		});

		return { purchase };
	} catch (err) {
		return toErr(err);
	}
}

export async function replacePurchaseLines(
	orgId: string,
	purchaseId: string,
	data: unknown,
	context?: UserContext,
): Promise<Result<{ purchase: unknown }>> {
	try {
		const parsed = replaceLinesSchema.parse(data);
		const sdb = getScopedDb(orgId);

		const loaded = await loadDraftPurchase(orgId, purchaseId);
		if (loaded.err) return { err: loaded.err };

		await assertInventoryItemsInOrg(
			sdb,
			orgId,
			parsed.lines.map((l) => l.inventory_item_id),
		);
		await assertDispositionVehiclesInOrg(
			sdb,
			orgId,
			parsed.lines.map((l) => l.disposition_vehicle_id),
		);

		for (const line of parsed.lines) {
			if (line.disposition !== "receive" && line.disposition_vehicle_id) {
				return { err: "Validation failed: only a `receive` line takes a destination vehicle" };
			}
		}

		// A line pointing at some other purchase's allocation would job-cost a job this purchase was never ordered for.
		const allocations = await sdb.purchase_job_allocation.findMany({
			where: { purchase_id: purchaseId },
			select: { id: true, job_id: true },
		});
		const allocOfJob = new Map(allocations.map((a) => [a.job_id, a.id]));
		if (parsed.lines.some((l) => l.job_id && !allocOfJob.has(l.job_id))) {
			return { err: "Validation failed: a line names a job this purchase does not cover" };
		}

		const purchase = await sdb.$transaction(async (tx) => {
			// Replaced wholesale - a line whose numbers changed has nothing to stay consistent with, so the whole set goes rather than being patched.
			await tx.purchase_line.deleteMany({ where: { purchase_id: purchaseId } });
			for (const [i, line] of parsed.lines.entries()) {
				const lineTotal =
					line.line_total ?? toDecimal(line.quantity).times(toDecimal(line.unit_price)).toNumber();
				await tx.purchase_line.create({
					data: {
						purchase_id: purchaseId,
						description: line.description,
						quantity: line.quantity,
						unit_price: line.unit_price,
						line_total: lineTotal,
						inventory_item_id: line.inventory_item_id ?? null,
						disposition: line.disposition ?? null,
						disposition_location:
							line.disposition === "receive"
								? line.disposition_vehicle_id
									? "vehicle"
									: "warehouse"
								: null,
						disposition_vehicle_id:
							line.disposition === "receive" ? (line.disposition_vehicle_id ?? null) : null,
						// Null on a single-job purchase, where `settleAllocations` fills it in below rather than asking which job.
						allocation_id: line.job_id ? (allocOfJob.get(line.job_id) ?? null) : null,
						sort_order: line.sort_order ?? i,
					},
				});
			}
			await recomputeTotals(tx as unknown as Prisma.TransactionClient, purchaseId);
			await settleAllocations(tx as unknown as Prisma.TransactionClient, purchaseId);
			await appendEvent(
				tx,
				orgId,
				"purchase.lines_replaced",
				context,
				{ purchase_id: purchaseId },
				{ line_count: parsed.lines.length },
			);
			return tx.purchase.findUniqueOrThrow({ where: { id: purchaseId }, select: PURCHASE_SELECT });
		});

		return { purchase };
	} catch (err) {
		return toErr(err);
	}
}

export async function orderPurchase(
	orgId: string,
	purchaseId: string,
	context?: UserContext,
): Promise<Result<{ purchase: unknown }>> {
	try {
		const sdb = getScopedDb(orgId);
		const loaded = await loadDraftPurchase(orgId, purchaseId);
		if (loaded.err) return { err: loaded.err };

		const lineCount = await sdb.purchase_line.count({ where: { purchase_id: purchaseId } });
		if (lineCount === 0) {
			return { err: "Validation failed: a purchase needs at least one line to be ordered" };
		}

		const purchase = await sdb.$transaction(async (tx) => {
			await tx.purchase.update({
				where: { id: purchaseId },
				data: { status: "ordered", submitted_at: new Date() },
			});
			await appendEvent(tx, orgId, "purchase.ordered", context, { purchase_id: purchaseId });
			return tx.purchase.findUniqueOrThrow({ where: { id: purchaseId }, select: PURCHASE_SELECT });
		});

		await logPurchaseActivity(orgId, "purchase", purchase.id, "ordered", "updated", context);

		return { purchase };
	} catch (err) {
		return toErr(err);
	}
}

export async function cancelPurchase(
	orgId: string,
	purchaseId: string,
	data: unknown,
	context?: UserContext,
): Promise<Result<{ purchase: unknown }>> {
	try {
		const parsed = cancelPurchaseSchema.parse(data);
		const sdb = getScopedDb(orgId);

		const existing = await sdb.purchase.findFirst({
			where: { id: purchaseId },
			select: { id: true, status: true },
		});
		if (!existing) {
			return { err: "Purchase not found" };
		}
		// Only something still open can be called off; a fully received purchase has nothing left pending, and an already-cancelled one isn't cancelled twice.
		if (!(OPEN_PURCHASE_STATUSES as readonly string[]).includes(existing.status)) {
			return { err: `A purchase in status ${existing.status} can no longer be cancelled` };
		}

		const purchase = await sdb.$transaction(async (tx) => {
			await tx.purchase.update({
				where: { id: purchaseId },
				data: {
					status: "cancelled",
					cancelled_at: new Date(),
					cancellation_reason: parsed.cancellation_reason ?? null,
				},
			});
			await appendEvent(tx, orgId, "purchase.cancelled", context, {
				purchase_id: purchaseId,
			}, { cancellation_reason: parsed.cancellation_reason ?? null });
			return tx.purchase.findUniqueOrThrow({ where: { id: purchaseId }, select: PURCHASE_SELECT });
		});

		await logPurchaseActivity(orgId, "purchase", purchase.id, "cancelled", "updated", context);

		return { purchase };
	} catch (err) {
		return toErr(err);
	}
}

export async function deletePurchase(
	orgId: string,
	purchaseId: string,
	context?: UserContext,
): Promise<Result<{ deleted: true }>> {
	try {
		const loaded = await loadDraftPurchase(orgId, purchaseId);
		if (loaded.err) return { err: loaded.err };

		const sdb = getScopedDb(orgId);
		await sdb.purchase.delete({ where: { id: purchaseId } });

		return { deleted: true };
	} catch (err) {
		return toErr(err);
	}
}

export async function receivePurchase(
	orgId: string,
	purchaseId: string,
	data: unknown,
	context?: UserContext,
): Promise<Result<{ purchase: unknown; warnings: string[] }>> {
	try {
		const parsed = receivePurchaseSchema.parse(data);
		const sdb = getScopedDb(orgId);

		const loaded = await loadReceivablePurchase(orgId, purchaseId);
		if (loaded.err) return { err: loaded.err };

		const purchase = loaded.purchase;

		const validIds = new Set(purchase.lines.map((l) => l.id));
		const unknown = parsed.lines.filter((l) => !validIds.has(l.id)).map((l) => l.id);
		if (unknown.length > 0) {
			return { err: `Validation failed: unknown line ${unknown.join(", ")}` };
		}

		const incrementById = new Map(parsed.lines.map((l) => [l.id, l.quantity_received]));
		const vehicleOverrideById = new Map(
			parsed.lines
				.filter((l) => l.disposition_vehicle_id !== undefined)
				.map((l) => [l.id, l.disposition_vehicle_id ?? null]),
		);
		// The schema already collapsed blank to null. Null is "not supplied" rather
		// than a request to clear — the receive modal has no clearing affordance, so
		// a blank box can only mean the receiver left it alone.
		const locationById = new Map(
			parsed.lines.flatMap((l) => (l.location ? [[l.id, l.location] as const] : [])),
		);

		const notReceivable = purchase.lines
			.filter((l) => incrementById.has(l.id) && l.disposition !== "receive" && l.disposition !== "non_stock")
			.map((l) => l.description);
		if (notReceivable.length > 0) {
			return {
				err: `Validation failed: line(s) with no receivable disposition: ${notReceivable.join(", ")}`,
			};
		}

		const linesById = new Map(purchase.lines.map((l) => [l.id, l]));
		const badOverride = [...vehicleOverrideById.keys()].filter(
			(id) => linesById.get(id)!.disposition !== "receive",
		);
		if (badOverride.length > 0) {
			return { err: "Validation failed: only a `receive` line takes a destination vehicle" };
		}
		await assertDispositionVehiclesInOrg(db, orgId, [...vehicleOverrideById.values()]);

		const dispatcherId = context?.dispatcherId ?? "";
		const touchedIds = [...incrementById.keys()].sort();

		const { purchase: refreshed, warnings, assignedLocations } = await sdb.$transaction(async (tx) => {
			// Locked before re-checking the over-receipt guard: without this, two
			// concurrent receives on the same line could each read the same
			// pre-increment total, each pass their own check, and together push it
			// past what was ordered.
			await lockPurchaseLines(tx as unknown as Prisma.TransactionClient, touchedIds);
			const lockedLines = await tx.purchase_line.findMany({ where: { id: { in: touchedIds } } });
			const lockedById = new Map(lockedLines.map((l) => [l.id, l]));

			const overReceipt = touchedIds
				.map((id) => {
					const line = lockedById.get(id)!;
					const increment = incrementById.get(id)!;
					const newTotal = Number(line.quantity_recieved) + increment;
					return newTotal > Number(line.quantity)
						? `"${line.description}" — receiving ${increment} would bring the total to ${newTotal}, more than the ${Number(line.quantity)} ordered`
						: null;
				})
				.filter((m): m is string => m !== null);
			if (overReceipt.length > 0) {
				throw new Error(`Validation failed: ${overReceipt.join("; ")}`);
			}

			// Only what's arriving THIS call — an increment, not the line's full
			// ordered quantity, so a second delivery against the same line doesn't
			// re-move/re-bill what a prior call already settled.
			const receivingLines: ApprovalLine[] = touchedIds.map((id) => {
				const l = lockedById.get(id)!;
				const vehicleId = vehicleOverrideById.has(id) ? vehicleOverrideById.get(id)! : l.disposition_vehicle_id;
				return {
					id: l.id,
					description: l.description,
					quantity: new Prisma.Decimal(incrementById.get(id)!),
					unit_price: l.unit_price,
					inventory_item_id: l.inventory_item_id,
					disposition: l.disposition,
					disposition_vehicle_id: vehicleId,
					visit_line_item_id: l.visit_line_item_id,
					allocation: l.allocation_id
						? { job_visit_id: purchase.allocations.find((a) => a.id === l.allocation_id)?.job_visit_id ?? null }
						: null,
				};
			});

			// Only a line whose stock lands in the warehouse can give the item a home:
			// a truck-bound or job-costed line never touched a shelf, so a location
			// typed against it describes nothing. `location: null` lives in the WHERE,
			// not in a prior read — an item that already has a home matches zero rows
			// and keeps it, atomically with the write rather than racing another receive.
			const assignedLocations: { itemId: string; location: string }[] = [];
			for (const l of receivingLines) {
				const requested = locationById.get(l.id);
				if (!requested || !l.inventory_item_id) continue;
				if (l.disposition !== "receive" || l.disposition_vehicle_id) continue;
				const { count } = await tx.inventory_item.updateMany({
					where: { id: l.inventory_item_id, organization_id: orgId, location: null },
					data: { location: requested },
				});
				if (count > 0) assignedLocations.push({ itemId: l.inventory_item_id, location: requested });
			}

			const stockWarnings = await applyRecieveStockEffect(
				tx as unknown as Prisma.TransactionClient,
				orgId,
				{ id: purchase.id, supplier_id: purchase.supplier_id, lines: receivingLines },
				dispatcherId,
			);
			const jobCostWarnings = await applyRecieveJobCost(
				tx as unknown as Prisma.TransactionClient,
				orgId,
				{ id: purchase.id, lines: receivingLines },
				dispatcherId,
			);
			const warnings = [...stockWarnings, ...jobCostWarnings];

			for (const id of touchedIds) {
				const line = lockedById.get(id)!;
				const increment = incrementById.get(id)!;
				const newTotal = Number(line.quantity_recieved) + increment;
				const vehicleId = vehicleOverrideById.get(id);
				await tx.purchase_line.update({
					where: { id },
					data: {
						quantity_recieved: { increment },
						received_at: newTotal >= Number(line.quantity) ? new Date() : line.received_at,
						...(vehicleOverrideById.has(id)
							? {
									disposition_vehicle_id: vehicleId,
									disposition_location: vehicleId ? "vehicle" : "warehouse",
								}
							: {}),
					},
				});
			}

			// A line with no disposition was never asked to be received, so it
			// can't block the purchase from reaching "received".
			const updatedLines = await tx.purchase_line.findMany({ where: { purchase_id: purchaseId } });
			const receivable = updatedLines.filter(
				(l) => l.disposition === "receive" || l.disposition === "non_stock",
			);
			const fullyReceived =
				receivable.length > 0 && receivable.every((l) => Number(l.quantity_recieved) >= Number(l.quantity));

			await tx.purchase.update({
				where: { id: purchaseId },
				data: {
					status: fullyReceived ? "received" : "partially_received",
					...(purchase.qb_sync_status === "synced" ? { qb_sync_status: "not_synced" } : {}),
				},
			});

			await appendEvent(
				tx,
				orgId,
				"purchase.received",
				context,
				{ purchase_id: purchaseId },
				{ lines: parsed.lines, warnings },
			);

			return {
				purchase: await tx.purchase.findUniqueOrThrow({ where: { id: purchaseId }, select: PURCHASE_SELECT }),
				warnings,
				assignedLocations,
			};
		});

		await logPurchaseActivity(orgId, "purchase", purchaseId, "received", "updated", context);
		// Logged per item, after commit, so the item's own history shows where its
		// home came from — `purchase.received` only records what was requested,
		// which the null guard may have declined.
		for (const { itemId, location } of assignedLocations) {
			await logActivity({
				event_type: "inventory_item.updated",
				action: "updated",
				entity_type: "inventory_item",
				entity_id: itemId,
				organization_id: orgId,
				...actorOf(context),
				reason: `Location set on receipt of ${purchase.purchase_number}`,
				changes: { location: { old: null, new: location } },
			});
		}

		return { purchase: refreshed, warnings };
	} catch (err) {
		return toErr(err);
	}
}
