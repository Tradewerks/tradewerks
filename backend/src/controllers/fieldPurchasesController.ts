import { isModuleOn } from "../services/entitlementService.js";
import { createHash } from "node:crypto";
import { ZodError } from "zod";
import { Prisma, type line_item_disposition } from "../../generated/prisma/client.js";
import { db } from "../db.js";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { logActivity } from "../services/logger.js";
import { log } from "../services/appLogger.js";
import { recordMovements } from "../services/stockMovements.js";
import { getBuffer, isOwnBucketUrl, signImageUrl, uploadFile } from "../services/wasabiService.js";
import {
	getReceiptOcrProvider,
	OCR_MAX_BYTES,
	type ExtractedLine,
	type OcrFile,
	type ReceiptExtraction,
} from "../services/receiptOcr/index.js";
import { remapHeader, type ExtractedHeader } from "../services/receiptOcr/remap.js";
import type { field_purchase_ocr_status } from "../../generated/prisma/client.js";
import { consumeQuota } from "../lib/entitlements/quota.js";

export const SCANS_USED_UP =
	"This month's receipt scans are used up. Enter the lines by hand; scanning resumes on the 1st (UTC).";

// Charged before the vendor call, so a read that then fails still counts: the vendor bills it.
const claimScan = async (orgId: string) =>
	(await consumeQuota(orgId, "receipt_scans_month")).allowed;

/** One extracted line plus whether it was written onto the purchase. */
type ExtractedSnapshot = ExtractedLine & { applied: boolean };

/** What the technician's sheet needs to offer a reading it has not applied yet. */
interface PurchaseExtraction {
	status: field_purchase_ocr_status;
	provider: string | null;
	completed_at: Date | null;
	field_confidence: Record<string, number>;
	lines: ExtractedSnapshot[];
	header: ExtractedHeader | null;
}
import { emitInventoryUpdated, emitToOrg } from "../services/socketService.js";
import { createNotification, notifyDispatchers } from "./notificationsController.js";
import { assertInventoryItemsInOrg, assertDispositionVehiclesInOrg } from "../lib/inventory.js";
import { recomputeVisitTotals } from "../lib/recomputeDocumentTotals.js";
import { formatCurrency } from "../lib/money.js";
import {
	checkLimits,
	COUNTED_SPEND_STATUSES,
	countOcrCorrections,
	deriveAllocationAmounts,
	evaluateFlags,
	findDuplicate,
	normalizePhone,
	normalizeVendor,
	spendWindows,
	spreadEstimate,
	sumDecimal,
	isTechEditable,
	toDecimal,
	type LimitVerdict,
	type Money,
	type OcrLineSnapshot,
	type PurchaseFlag,
	velocityFlags,
} from "../lib/fieldPurchase.js";
import {
	assignLineJobSchema,
	captureMetaSchema,
	createPurchaseSchema,
	limitCheckSchema,
	listPurchasesQuerySchema,
	preauthDecisionSchema,
	preauthRequestSchema,
	replaceLinesSchema,
	reviewDecisionSchema,
	submitPurchaseSchema,
	createRefundSchema,
	secondSignoffSchema,
	revokeGrantSchema,
	updatePurchaseSchema,
	upsertGrantSchema,
	linkSupplierSchema,
} from "../lib/validate/fieldPurchases.js";

/**
 * Emergency field procurement: a technician buys a part at a counter mid-job, pays
 * out of pocket, and submits the receipt for dispatcher review.
 *
 * Purchaser is never approver. A limit breach routes to pre-authorization rather
 * than refusing, because the dispatcher's yes IS the control. Every state change
 * appends a field_purchase_event and nothing ever updates or deletes one.
 */

type Result<T> = { err?: string } & Partial<T>;

/**
 * CAS loser. Every status change that moves stock or money claims its row first, so
 * the loser refuses instead of writing the same effect twice.
 */
const DECIDED_ELSEWHERE = "This purchase was decided by somebody else — reload the queue";

const GRANT_SELECT = {
	id: true,
	technician_id: true,
	per_transaction_limit: true,
	daily_limit: true,
	weekly_limit: true,
	per_job_limit: true,
	is_active: true,
	granted_at: true,
	revoked_at: true,
	notes: true,
	technician: { select: { id: true, name: true, email: true } },
	granted_by: { select: { id: true, name: true } },
	revoked_by: { select: { id: true, name: true } },
} as const;

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
	verified_at: true,
	ocr_confidence: true,
	sort_order: true,
	visit_line_item_id: true,
	// Which job's share the line is, so the sheet and the review panel can say so
	// without reading the amounts backwards.
	allocation_id: true,
	// `provisional` travels because a line mapped to a placeholder row still owes
	// the reconcile queue a decision — mapped and settled are not the same thing.
	inventory_item: { select: { id: true, name: true, sku: true, unit: true, provisional: true } },
	disposition_vehicle: { select: { id: true, name: true } },
} as const;

const PURCHASE_SELECT = {
	id: true,
	status: true,
	technician_id: true,
	reason: true,
	estimated_amount: true,
	vendor_name: true,
	supplier_id: true,
	receipt_number: true,
	purchased_at: true,
	subtotal: true,
	tax_amount: true,
	total: true,
	receipt_image_url: true,
	captured_at: true,
	// Selected to derive `has_geo` in `shapePurchase`, which then drops it. The
	// coordinates themselves are precise geolocation - sensitive personal
	// information - and no list or detail screen reads them, so they leave only
	// through `GET /:id/capture-location` and its own permission.
	capture_lat: true,
	submitted_at: true,
	preauth_requested_at: true,
	preauth_decided_at: true,
	preauth_note: true,
	reviewed_at: true,
	review_note: true,
	second_signoff_at: true,
	second_signoff_note: true,
	kind: true,
	parent_purchase_id: true,
	refund_settled_at: true,
	flags: true,
	ocr_status: true,
	ocr_provider: true,
	ocr_field_confidence: true,
	ocr_completed_at: true,
	ocr_error: true,
	ocr_line_count: true,
	ocr_corrections: true,
	created_at: true,
	updated_at: true,
	qb_purchase_id: true,
	qb_sync_status: true,
	technician: { select: { id: true, name: true } },
	supplier: { select: { id: true, name: true } },
	preauth_by: { select: { id: true, name: true } },
	reviewed_by: { select: { id: true, name: true } },
	second_signoff_by: { select: { id: true, name: true } },
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

type Shapeable = { receipt_image_url: string | null; capture_lat: Prisma.Decimal | null };
type Shaped<T> = Omit<T, "capture_lat"> & { has_geo: boolean };

/**
 * The two things every purchase response needs and no caller should have to
 * remember.
 *
 * The stored URL is unsigned — the bucket is private, so a raw one 403s in the
 * browser. Signed at response time only, never persisted.
 *
 * The coordinates collapse to a boolean. Every screen that reads them only asks
 * whether a position was captured (`geo_missing` is raised on the absence, so the
 * absence has to be visible); the coordinates answer no question a list or detail
 * view puts, and they are sensitive personal information under CCPA's precise-
 * geolocation test. `getCaptureLocation` is the one path that returns them.
 */
async function shapePurchase<T extends Shapeable>(row: T): Promise<Shaped<T>> {
	const { capture_lat, ...rest } = row;
	const shaped = { ...rest, has_geo: capture_lat != null } as Shaped<T>;
	const url = row.receipt_image_url;
	// Seed fixtures carry inline data: URLs, and only our own bucket has a key.
	if (!url || !url.startsWith("http") || !isOwnBucketUrl(url)) return shaped;
	try {
		return { ...shaped, receipt_image_url: (await signImageUrl(url)) ?? url };
	} catch (err) {
		// A signer that is down must not take the review queue with it.
		log.warn({ err }, "signing a field purchase receipt failed");
		return shaped;
	}
}

const shapePurchases = <T extends Shapeable>(rows: T[]): Promise<Shaped<T>[]> =>
	Promise.all(rows.map(shapePurchase));

/**
 * A refund's claim on its parent. Second sign-off is not in COUNTED_SPEND_STATUSES
 * (that list is about a technician's limits), but a refund waiting on it has still
 * been submitted, so its credit is spoken for.
 */
const REFUND_CLAIM_STATUSES = [...COUNTED_SPEND_STATUSES, "pending_second_signoff"] as const;

/** Submitted and not yet decided — what the technician reads as "pending". */
const REFUND_IN_PROGRESS_STATUSES = ["pending_review", "queried", "pending_second_signoff"];

/**
 * What a refund claims back. `total` is client-editable on the submit sheet, so
 * whichever of total or lines-plus-tax is larger — neither number can
 * under-report the claim.
 */
function refundClaim(p: { total: Money; tax_amount: Money; lines: { line_total: Money }[] }) {
	return Prisma.Decimal.max(
		toDecimal(p.total),
		sumDecimal(p.lines.map((l) => l.line_total)).plus(toDecimal(p.tax_amount)),
	);
}

const REFUND_ROW_SELECT = {
	id: true,
	status: true,
	total: true,
	tax_amount: true,
	refund_settled_at: true,
	created_at: true,
	purchased_at: true,
	lines: {
		select: { line_total: true, inventory_item_id: true, quantity: true, description: true },
		orderBy: { sort_order: "asc" },
	},
} as const;

const clampZero = (v: Prisma.Decimal) => Prisma.Decimal.max(v, 0);

/**
 * Every refund raised against an approved purchase, read the way its technician
 * asks: is one already open, how much is waiting on dispatch, how much is left.
 */
async function refundSummaryOf(
	sdb: ReturnType<typeof getScopedDb>,
	parent: { id: string; total: Money },
) {
	const rows = await sdb.field_purchase.findMany({
		where: { parent_purchase_id: parent.id, kind: "refund" },
		select: REFUND_ROW_SELECT,
		orderBy: { created_at: "desc" },
	});
	const claimOf = (statuses: readonly string[]) =>
		sumDecimal(rows.filter((r) => statuses.includes(r.status)).map(refundClaim));
	const inProgress = rows.filter((r) => REFUND_IN_PROGRESS_STATUSES.includes(r.status));
	const approved = rows.filter((r) => r.status === "approved");
	return {
		draft_id: rows.find((r) => r.status === "draft")?.id ?? null,
		in_progress_count: inProgress.length,
		in_progress_value: sumDecimal(inProgress.map(refundClaim)).toString(),
		approved_value: sumDecimal(
			approved.filter((r) => !r.refund_settled_at).map(refundClaim),
		).toString(),
		settled_value: sumDecimal(
			approved.filter((r) => r.refund_settled_at).map(refundClaim),
		).toString(),
		remaining: clampZero(
			toDecimal(parent.total).minus(claimOf(REFUND_CLAIM_STATUSES)),
		).toString(),
		refunds: rows.map((r) => ({
			id: r.id,
			status: r.status,
			amount: refundClaim(r).toString(),
			refund_settled_at: r.refund_settled_at,
			created_at: r.created_at,
			returned_at: r.purchased_at,
			parts: r.lines.map((l) => ({
				description: l.description,
				quantity: toDecimal(l.quantity).toString(),
			})),
		})),
	};
}

/**
 * The purchase a refund reverses, with what is still returnable on each line.
 * Mirrors `applyRefundReversal`: quantities are drawn per item across the
 * parent's lines in order, net of every other refund that has a claim on them.
 */
async function refundParentOf(
	sdb: ReturnType<typeof getScopedDb>,
	refund: { id: string; parent_purchase_id: string | null },
) {
	if (!refund.parent_purchase_id) return null;
	const parent = await sdb.field_purchase.findFirst({
		where: { id: refund.parent_purchase_id },
		select: {
			id: true,
			vendor_name: true,
			total: true,
			purchased_at: true,
			lines: {
				select: {
					id: true,
					description: true,
					inventory_item_id: true,
					unit_price: true,
					quantity: true,
					disposition: true,
					disposition_vehicle: { select: { name: true } },
				},
				orderBy: { sort_order: "asc" },
			},
		},
	});
	if (!parent) return null;
	const others = await sdb.field_purchase.findMany({
		where: {
			parent_purchase_id: parent.id,
			kind: "refund",
			id: { not: refund.id },
			status: { in: [...REFUND_CLAIM_STATUSES] },
		},
		select: REFUND_ROW_SELECT,
	});
	const taken = new Map<string, Prisma.Decimal>();
	for (const r of others) {
		for (const l of r.lines) {
			if (!l.inventory_item_id) continue;
			taken.set(
				l.inventory_item_id,
				(taken.get(l.inventory_item_id) ?? toDecimal(0)).plus(toDecimal(l.quantity)),
			);
		}
	}
	return {
		id: parent.id,
		vendor_name: parent.vendor_name,
		total: toDecimal(parent.total).toString(),
		purchased_at: parent.purchased_at,
		remaining: clampZero(
			toDecimal(parent.total).minus(sumDecimal(others.map(refundClaim))),
		).toString(),
		lines: parent.lines.map((l) => {
			let returnable = toDecimal(l.quantity);
			if (l.inventory_item_id) {
				const owed = taken.get(l.inventory_item_id) ?? toDecimal(0);
				const draw = Prisma.Decimal.min(owed, returnable);
				taken.set(l.inventory_item_id, owed.minus(draw));
				returnable = returnable.minus(draw);
			}
			return {
				id: l.id,
				description: l.description,
				inventory_item_id: l.inventory_item_id,
				unit_price: toDecimal(l.unit_price).toString(),
				quantity: toDecimal(l.quantity).toString(),
				returnable_qty: returnable.toString(),
				// Where stock comes back off, which is the parent's destination —
				// `applyRefundReversal` ignores the refund line's own.
				disposition: l.disposition,
				vehicle_name: l.disposition_vehicle?.name ?? null,
			};
		}),
	};
}

function actorOf(context?: UserContext) {
	return {
		actor_type: context?.techId ? "technician" : context?.dispatcherId ? "dispatcher" : "system",
		actor_id: context?.techId ?? context?.dispatcherId ?? null,
	};
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
	field_purchase_event: { create(args: unknown): Promise<unknown> };
};

async function appendEvent(
	client: EventClient,
	orgId: string,
	type: string,
	context: UserContext | undefined,
	refs: { field_purchase_id?: string; grant_id?: string },
	detail: Record<string, unknown> = {},
) {
	const actor = actorOf(context);
	await client.field_purchase_event.create({
		data: {
			organization_id: orgId,
			field_purchase_id: refs.field_purchase_id ?? null,
			grant_id: refs.grant_id ?? null,
			type,
			actor_type: actor.actor_type,
			actor_id: actor.actor_id,
			detail: detail as Prisma.InputJsonValue,
		},
	});
}

/** The activity feed's copy of a state change; the event trail above is the record of it. */
function logPurchaseActivity(
	orgId: string,
	entity: "field_purchase" | "field_purchase_grant",
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

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export async function listGrants(orgId: string): Promise<Result<{ grants: unknown[] }>> {
	const sdb = getScopedDb(orgId);
	const grants = await sdb.field_purchase_grant.findMany({
		select: GRANT_SELECT,
		orderBy: [{ is_active: "desc" }, { granted_at: "desc" }],
	});
	return { grants };
}

export async function upsertGrant(
	orgId: string,
	data: unknown,
	context?: UserContext,
): Promise<Result<{ grant: unknown }>> {
	try {
		const parsed = upsertGrantSchema.parse(data);
		const sdb = getScopedDb(orgId);

		const tech = await sdb.technician.findFirst({
			where: { id: parsed.technician_id },
			select: { id: true, name: true },
		});
		if (!tech) return { err: "Technician not found" };

		const existing = await sdb.field_purchase_grant.findFirst({
			where: { technician_id: parsed.technician_id },
			select: {
				id: true,
				per_transaction_limit: true,
				daily_limit: true,
				weekly_limit: true,
				per_job_limit: true,
				is_active: true,
			},
		});

		const limits = {
			per_transaction_limit: parsed.per_transaction_limit,
			daily_limit: parsed.daily_limit ?? null,
			weekly_limit: parsed.weekly_limit ?? null,
			per_job_limit: parsed.per_job_limit ?? null,
			notes: parsed.notes ?? null,
		};

		const grant = await sdb.$transaction(async (tx) => {
			const row = existing
				? await tx.field_purchase_grant.update({
						where: { id: existing.id },
						// Re-granting a revoked authority clears the revocation rather
						// than leaving a row that is both active and revoked.
						data: {
							...limits,
							is_active: true,
							revoked_at: null,
							revoked_by_id: null,
							granted_by_id: context?.dispatcherId ?? null,
						},
						select: GRANT_SELECT,
					})
				: await tx.field_purchase_grant.create({
						data: {
							organization_id: orgId,
							technician_id: parsed.technician_id,
							...limits,
							granted_by_id: context?.dispatcherId ?? null,
						},
						select: GRANT_SELECT,
					});

			await appendEvent(
				tx,
				orgId,
				existing ? "grant.updated" : "grant.granted",
				context,
				{ grant_id: row.id },
				{ limits, previous: existing ?? null },
			);
			return row;
		});

		await logPurchaseActivity(
			orgId,
			"field_purchase_grant",
			grant.id,
			existing ? "updated" : "created",
			existing ? "updated" : "created",
			context,
		);

		return { grant };
	} catch (err) {
		return toErr(err);
	}
}

export async function revokeGrant(
	orgId: string,
	grantId: string,
	data: unknown,
	context?: UserContext,
): Promise<Result<{ grant: unknown }>> {
	try {
		const parsed = revokeGrantSchema.parse(data);
		const sdb = getScopedDb(orgId);
		const existing = await sdb.field_purchase_grant.findFirst({
			where: { id: grantId },
			select: { id: true, is_active: true },
		});
		if (!existing) return { err: "Grant not found" };
		if (!existing.is_active) return { err: "Grant is already revoked" };

		const grant = await sdb.$transaction(async (tx) => {
			const row = await tx.field_purchase_grant.update({
				where: { id: grantId },
				data: {
					is_active: false,
					revoked_at: new Date(),
					revoked_by_id: context?.dispatcherId ?? null,
				},
				select: GRANT_SELECT,
			});
			await appendEvent(
				tx,
				orgId,
				"grant.revoked",
				context,
				{ grant_id: grantId },
				{ reason: parsed.reason ?? null },
			);
			return row;
		});

		await logPurchaseActivity(
			orgId,
			"field_purchase_grant",
			grantId,
			"revoked",
			"updated",
			context,
			parsed.reason ?? undefined,
		);

		return { grant };
	} catch (err) {
		return toErr(err);
	}
}

/** Counted spend for one tech across the day and week containing `at`. */
async function spentSoFar(
	orgId: string,
	techId: string,
	at: Date,
	excludePurchaseId?: string,
	timezone?: string | null,
) {
	const tz =
		timezone !== undefined
			? timezone
			: (
					await db.organization.findFirst({
						where: { id: orgId },
						select: { timezone: true },
					})
				)?.timezone;
	const win = spendWindows(at, tz ?? undefined);
	const sdb = getScopedDb(orgId);

	// `purchased_at` is only stamped at submit, so a pre-authorized purchase has
	// none yet — and filtering on it alone dropped exactly the rows a ceiling is
	// supposed to hold back. Falls back to `created_at`, the same clock the queue
	// orders and filters by.
	const inWindow = { gte: win.weekStart, lt: win.weekEnd };
	const rows = await sdb.field_purchase.findMany({
		where: {
			technician_id: techId,
			status: { in: [...COUNTED_SPEND_STATUSES] },
			OR: [
				{ purchased_at: inWindow },
				{ AND: [{ purchased_at: null }, { created_at: inWindow }] },
			],
			...(excludePurchaseId ? { id: { not: excludePurchaseId } } : {}),
		},
		select: {
			total: true,
			kind: true,
			refund_settled_at: true,
			purchased_at: true,
			created_at: true,
			allocations: { select: { job_id: true, amount: true } },
		},
	});

	// Amounts are stored positive on both kinds, so a settled refund has to be
	// subtracted — returning a part gives the technician their ceiling back. An
	// UNSETTLED refund contributes nothing: it is a claim the technician made about
	// their own purchase, and netting it would free counter spend before anybody
	// confirmed the credit arrived.
	const signed = (v: Money, row: { kind: string; refund_settled_at: Date | null }) =>
		row.kind !== "refund"
			? toDecimal(v)
			: row.refund_settled_at
				? toDecimal(v).negated()
				: toDecimal(0);

	const today = sumDecimal(
		rows
			.filter((r) => (r.purchased_at ?? r.created_at) >= win.dayStart)
			.map((r) => signed(r.total, r)),
	);
	const week = sumDecimal(rows.map((r) => signed(r.total, r)));
	const perJob = new Map<string, Prisma.Decimal>();
	for (const r of rows) {
		for (const a of r.allocations) {
			const running = perJob.get(a.job_id) ?? new Prisma.Decimal(0);
			perJob.set(a.job_id, running.plus(signed(a.amount, r)));
		}
	}
	return { today, week, perJob };
}

/**
 * The wider duplicate sweep: the image hash already refuses a byte-identical file,
 * this catches a re-photographed or re-compressed one. Deliberately not scoped to
 * the submitting technician - reusing somebody else's receipt is the case to catch.
 */
async function similarPurchases(orgId: string, at: Date, excludePurchaseId: string) {
	const sdb = getScopedDb(orgId);
	const window = 2 * 86_400_000;
	return sdb.field_purchase.findMany({
		where: {
			id: { not: excludePurchaseId },
			kind: "purchase",
			status: { in: [...COUNTED_SPEND_STATUSES] },
			purchased_at: { gte: new Date(at.getTime() - window), lte: new Date(at.getTime() + window) },
		},
		select: {
			id: true,
			status: true,
			vendor_name: true,
			purchased_at: true,
			total: true,
			technician_id: true,
			technician: { select: { name: true } },
			receipt_number: true,
		},
	});
}

async function activeGrant(orgId: string, techId: string) {
	const sdb = getScopedDb(orgId);
	return sdb.field_purchase_grant.findFirst({
		where: { technician_id: techId },
		select: {
			id: true,
			is_active: true,
			per_transaction_limit: true,
			daily_limit: true,
			weekly_limit: true,
			per_job_limit: true,
		},
	});
}

/**
 * A technician who just found out they cannot buy, asking dispatch to enable it.
 * Lands in the dispatch activity feed because there is no dispatcher-side
 * notification table. Idempotent by intent, not by lock: asking twice is a
 * technician asking twice.
 */
export async function requestGrant(
	orgId: string,
	techId: string,
	context?: UserContext,
): Promise<Result<{ requested: true }>> {
	try {
		const sdb = getScopedDb(orgId);
		const existing = await sdb.field_purchase_grant.findFirst({
			where: { technician_id: techId },
			select: { id: true, is_active: true },
		});
		if (existing?.is_active) return { err: "You already have purchasing authority" };

		const tech = await sdb.technician.findFirst({
			where: { id: techId },
			select: { name: true },
		});
		await logPurchaseActivity(
			orgId,
			"field_purchase_grant",
			existing?.id ?? techId,
			"requested",
			"created",
			context,
			`${tech?.name ?? "A technician"} asked to be allowed to buy parts in the field`,
		);
		emitToOrg(orgId, "field_purchase:grant_requested", { technicianId: techId });
		notifyDispatchers({
			type: "field_purchase_grant_requested",
			title: `${tech?.name ?? "A technician"} asked for purchasing authority`,
			body: "They want to be allowed to buy parts in the field.",
			actionUrl: "/dispatch/purchases",
		}, orgId).catch(() => {});
		return { requested: true };
	} catch (err) {
		return toErr(err);
	}
}

/**
 * Same maths the submit path runs for a purchase, so the answer before buying
 * matches the one after. This preflight never runs for a refund.
 */
export async function checkPurchaseLimit(
	orgId: string,
	techId: string,
	body: unknown,
): Promise<Result<{ verdict: LimitVerdict; spent: { today: string; week: string } }>> {
	try {
		const parsed = limitCheckSchema.parse(body);
		const grant = await activeGrant(orgId, techId);
		// A client-supplied id excludes spend, so it is only honoured for the
		// caller's own purchase — otherwise it would hide somebody else's.
		const own = parsed.purchase_id
			? await getScopedDb(orgId).field_purchase.findFirst({
					where: { id: parsed.purchase_id, technician_id: techId },
					select: { id: true },
				})
			: null;
		const org = await db.organization.findFirst({
			where: { id: orgId },
			select: { timezone: true },
		});
		const spent = await spentSoFar(orgId, techId, new Date(), own?.id, org?.timezone);
		// The whole receipt and every job's share in one verdict. Asked one job at
		// a time, the windowed ceilings came back measured against a single share.
		const jobAmounts = parsed.jobs?.length
			? new Map(parsed.jobs.map((j) => [j.job_id, j.amount]))
			: undefined;
		const verdict = checkLimits(grant, parsed.amount, spent, jobAmounts);
		return {
			verdict,
			spent: { today: spent.today.toFixed(2), week: spent.week.toFixed(2) },
		};
	} catch (err) {
		return toErr(err);
	}
}

export async function getMyGrant(
	orgId: string,
	techId: string,
): Promise<Result<{ grant: unknown; spent: { today: string; week: string } }>> {
	const sdb = getScopedDb(orgId);
	const grant = await sdb.field_purchase_grant.findFirst({
		where: { technician_id: techId },
		select: GRANT_SELECT,
	});
	const spent = await spentSoFar(orgId, techId, new Date());
	return { grant, spent: { today: spent.today.toFixed(2), week: spent.week.toFixed(2) } };
}

// ---------------------------------------------------------------------------
// Purchases — technician side
// ---------------------------------------------------------------------------

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
	const jobIds = allocations.map((a) => a.job_id);
	const found = await db.job.findMany({
		where: { id: { in: jobIds }, organization_id: orgId },
		select: { id: true },
	});
	const ok = new Set(found.map((j) => j.id));
	const missing = jobIds.filter((id) => !ok.has(id));
	if (missing.length > 0) throw new Error(`Validation failed: unknown job ${missing.join(", ")}`);

	const visitIds = allocations.map((a) => a.job_visit_id).filter((v): v is string => !!v);
	if (visitIds.length === 0) return;
	const visits = await db.job_visit.findMany({
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

export async function createPurchase(
	orgId: string,
	techId: string,
	data: unknown,
	context?: UserContext,
): Promise<Result<{ purchase: unknown }>> {
	try {
		const parsed = createPurchaseSchema.parse(data);
		const sdb = getScopedDb(orgId);

		// Authority is checked at creation as well as at submit, so a revoked tech
		// never starts a flow that cannot end.
		const grant = await activeGrant(orgId, techId);
		if (!grant || !grant.is_active) {
			return { err: "You do not have an active field purchase authorization" };
		}

		const jobIds = parsed.allocations.map((a) => a.job_id);
		if (new Set(jobIds).size !== jobIds.length) {
			return { err: "Validation failed: duplicate job in allocations" };
		}
		await assertAllocationsInOrg(orgId, parsed.allocations);

		const purchase = await sdb.$transaction(async (tx) => {
			const created = await tx.field_purchase.create({
				data: {
					organization_id: orgId,
					technician_id: techId,
					status: "draft",
					reason: parsed.reason ?? null,
					estimated_amount: parsed.estimated_amount ?? null,
					// Until the receipt exists the estimate is the only money on this
					// row; the captured receipt overwrites it. Shares stay at zero
					// because there is not yet a line to derive one from.
					total: parsed.estimated_amount ?? 0,
					allocations: {
						create: parsed.allocations.map((a) => ({
							job_id: a.job_id,
							job_visit_id: a.job_visit_id ?? null,
							amount: 0,
						})),
					},
				},
				select: PURCHASE_SELECT,
			});
			await appendEvent(tx, orgId, "purchase.created", context, {
				field_purchase_id: created.id,
			});
			return created;
		});

		await logPurchaseActivity(orgId, "field_purchase", purchase.id, "created", "created", context);

		return { purchase: await shapePurchase(purchase) };
	} catch (err) {
		return toErr(err);
	}
}

/** A technician sees only their own purchases; a dispatcher sees the org's. */
function visibilityWhere(context?: UserContext) {
	return context?.techId ? { technician_id: context.techId } : {};
}

/** The three statuses a reviewer still owes an answer on. */
const OPEN_STATUSES = ["pending_preauth", "pending_review", "pending_second_signoff"] as const;

/**
 * Answered by dispatch, now sitting with the technician. Neither status belonged to
 * a group before, so both left every dispatch surface the moment dispatch acted.
 */
const WITH_TECH_STATUSES = ["preauth_approved", "queried"] as const;

/** Answered, whichever way it went. */
const DECIDED_STATUSES = ["approved", "rejected", "preauth_denied"] as const;

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

export async function listPurchases(
	orgId: string,
	query: unknown,
	context?: UserContext,
): Promise<Result<{ purchases: unknown[]; total: number; offset: number }>> {
	try {
		const parsed = listPurchasesQuerySchema.parse(query);
		const sdb = getScopedDb(orgId);

		const statusWhere =
			parsed.status === "all"
				? {}
				: parsed.status === "open"
					? { status: { in: [...OPEN_STATUSES] } }
					: parsed.status === "with_tech"
						? { status: { in: [...WITH_TECH_STATUSES] } }
						: parsed.status === "decided"
							? { status: { in: [...DECIDED_STATUSES] } }
							: { status: parsed.status };

		// `flags` defaults to an empty array, never null, so exact-value comparison
		// is the whole predicate. Doing it in SQL rather than over the fetched page
		// is what lets the row count and the offset mean anything.
		const flagWhere =
			parsed.flagged === undefined
				? {}
				: parsed.flagged === "true"
					? { flags: { not: [] } }
					: { flags: { equals: [] } };

		const searchWhere = parsed.search
			? {
					OR: [
						{ vendor_name: { contains: parsed.search, mode: "insensitive" as const } },
						{ technician: { name: { contains: parsed.search, mode: "insensitive" as const } } },
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
			...visibilityWhere(context),
			...statusWhere,
			...flagWhere,
			...(parsed.kind === "all" ? {} : { kind: parsed.kind }),
			...(parsed.technician_id ? { technician_id: parsed.technician_id } : {}),
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
			sdb.field_purchase.findMany({
				where,
				select: PURCHASE_SELECT,
				orderBy,
				skip: parsed.offset,
				take: parsed.limit,
			}),
			sdb.field_purchase.count({ where }),
		]);

		return { purchases: await shapePurchases(purchases), total, offset: parsed.offset };
	} catch (err) {
		return toErr(err);
	}
}

export interface FieldPurchaseSummary {
	open_count: number;
	open_value: string;
	/** `with_tech` is counted apart from `open_count`: it waits on the technician. */
	pending_preauth_count: number;
	pending_review_count: number;
	pending_signoff_count: number;
	with_tech_count: number;
	/** Null when nothing is waiting — not zero, which would read as "just now". */
	oldest_open_at: string | null;
	flagged_count: number;
	unsettled_refund_count: number;
	unsettled_refund_value: string;
}

/**
 * The numbers that decide whether today's queue is under control. Scoped the
 * same way the list is, so a technician calling it sees only their own.
 */
export async function getPurchasesSummary(
	orgId: string,
	context?: UserContext,
): Promise<Result<{ summary: FieldPurchaseSummary }>> {
	try {
		const sdb = getScopedDb(orgId);
		const openWhere = { ...visibilityWhere(context), status: { in: [...OPEN_STATUSES] } };

		// One pass over the open rows answers both the totals and the per-stage
		// breakdown; four separate counts asked the same index the same question.
		const [byStage, withTech, oldest, flagged, refunds] = await Promise.all([
			sdb.field_purchase.groupBy({
				by: ["status"],
				// groupBy is not one of the operations getScopedDb intercepts, so the
				// org filter is spelled out — same as every other groupBy caller.
				where: { ...openWhere, organization_id: orgId },
				_count: { _all: true },
				_sum: { total: true },
			}),
			sdb.field_purchase.count({
				where: { ...visibilityWhere(context), status: { in: [...WITH_TECH_STATUSES] } },
			}),
			sdb.field_purchase.findFirst({
				where: openWhere,
				orderBy: [{ submitted_at: { sort: "asc", nulls: "last" } }, { created_at: "asc" }],
				select: { submitted_at: true, created_at: true },
			}),
			sdb.field_purchase.count({ where: { ...openWhere, flags: { not: [] } } }),
			sdb.field_purchase.aggregate({
				where: {
					...visibilityWhere(context),
					kind: "refund",
					status: "approved",
					refund_settled_at: null,
				},
				_count: { _all: true },
				_sum: { total: true },
			}),
		]);

		const stageCount = (status: (typeof OPEN_STATUSES)[number]) =>
			byStage.find((g) => g.status === status)?._count._all ?? 0;

		return {
			summary: {
				open_count: byStage.reduce((n, g) => n + g._count._all, 0),
				open_value: sumDecimal(byStage.map((g) => g._sum.total)).toString(),
				pending_preauth_count: stageCount("pending_preauth"),
				pending_review_count: stageCount("pending_review"),
				pending_signoff_count: stageCount("pending_second_signoff"),
				with_tech_count: withTech,
				oldest_open_at: (oldest?.submitted_at ?? oldest?.created_at)?.toISOString() ?? null,
				flagged_count: flagged,
				unsettled_refund_count: refunds._count._all,
				unsettled_refund_value: (refunds._sum.total ?? 0).toString(),
			},
		};
	} catch (err) {
		return toErr(err);
	}
}

export async function getPurchase(
	orgId: string,
	purchaseId: string,
	context?: UserContext,
): Promise<Result<{ purchase: unknown; events: unknown[] }>> {
	const sdb = getScopedDb(orgId);
	const purchase = await sdb.field_purchase.findFirst({
		where: { id: purchaseId, ...visibilityWhere(context) },
		select: PURCHASE_SELECT,
	});
	if (!purchase) return { err: "Field purchase not found" };

	const events = await sdb.field_purchase_event.findMany({
		where: { field_purchase_id: purchaseId },
		orderBy: { at: "asc" },
		select: { id: true, type: true, actor_type: true, actor_id: true, detail: true, at: true },
	});
	// Detail only: the list never needs either, and each costs a query.
	const refundContext =
		purchase.kind === "refund"
			? { parent: await refundParentOf(sdb, purchase) }
			: purchase.kind === "purchase" && purchase.status === "approved"
				? { refund_summary: await refundSummaryOf(sdb, purchase) }
				: {};
	return { purchase: { ...(await shapePurchase(purchase)), ...refundContext }, events };
}

/**
 * What the receipt itself read, for a sheet that has to offer it. Deliberately its
 * own request rather than fields on PURCHASE_SELECT: the snapshot and the provider
 * payload are large, that projection also serves the list, and only the one screen
 * editing a purchase ever needs them.
 */
export async function getPurchaseExtraction(
	orgId: string,
	purchaseId: string,
	context?: UserContext,
): Promise<Result<{ extraction: PurchaseExtraction }>> {
	const sdb = getScopedDb(orgId);
	const row = await sdb.field_purchase.findFirst({
		where: { id: purchaseId, ...visibilityWhere(context) },
		select: {
			ocr_status: true,
			ocr_provider: true,
			ocr_raw: true,
			ocr_lines: true,
			ocr_field_confidence: true,
			ocr_completed_at: true,
		},
	});
	if (!row) return { err: "Field purchase not found" };

	return {
		extraction: {
			status: row.ocr_status,
			provider: row.ocr_provider,
			completed_at: row.ocr_completed_at,
			field_confidence: (row.ocr_field_confidence ?? {}) as Record<string, number>,
			lines: Array.isArray(row.ocr_lines) ? (row.ocr_lines as unknown as ExtractedSnapshot[]) : [],
			header: remapHeader(row.ocr_provider, row.ocr_raw),
		},
	};
}

/** Where the photo was taken, for the one reader who is entitled to ask. */
interface PurchaseCaptureLocation {
	capture_lat: Prisma.Decimal | null;
	capture_lng: Prisma.Decimal | null;
	capture_accuracy_m: number | null;
	captured_at: Date | null;
}

/**
 * The coordinates, on request rather than on every read. They are the anti-fraud
 * cross-check against the vendor the receipt names, and they are also precise
 * geolocation about an employee, which is sensitive personal information - so the
 * reviewer who needs to compare them asks for them, and everyone else never
 * receives them. `shapePurchase` gives every other response `has_geo` instead.
 */
export async function getCaptureLocation(
	orgId: string,
	purchaseId: string,
	context?: UserContext,
): Promise<Result<{ location: PurchaseCaptureLocation }>> {
	const sdb = getScopedDb(orgId);
	const row = await sdb.field_purchase.findFirst({
		where: { id: purchaseId, ...visibilityWhere(context) },
		select: {
			capture_lat: true,
			capture_lng: true,
			capture_accuracy_m: true,
			captured_at: true,
		},
	});
	if (!row) return { err: "Field purchase not found" };
	return { location: row };
}

/** The owning technician, in a status they may still edit. */
async function loadEditable(orgId: string, purchaseId: string, context?: UserContext) {
	const sdb = getScopedDb(orgId);
	const purchase = await sdb.field_purchase.findFirst({
		where: { id: purchaseId },
		select: {
			id: true,
			status: true,
			kind: true,
			technician_id: true,
			total: true,
			tax_amount: true,
			estimated_amount: true,
			receipt_image_url: true,
			receipt_image_hash: true,
			ocr_status: true,
		},
	});
	if (!purchase) return { err: "Field purchase not found" as const };
	if (context?.techId && purchase.technician_id !== context.techId) {
		return { err: "You can only edit your own field purchases" as const };
	}
	if (!isTechEditable(purchase.status)) {
		return { err: `A purchase in status ${purchase.status} can no longer be edited` as const };
	}
	return { purchase };
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
		const loaded = await loadEditable(orgId, purchaseId, context);
		if (loaded.err) return { err: loaded.err };

		if (parsed.supplier_id) {
			const supplier = await db.supplier.findFirst({
				where: { id: parsed.supplier_id, organization_id: orgId },
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
				await tx.field_purchase_job_allocation.deleteMany({
					where: {
						field_purchase_id: purchaseId,
						...(keep.length > 0 ? { job_id: { notIn: keep } } : {}),
					},
				});
				// Matched by job rather than replaced wholesale: the lines point at
				// the allocation row, so recreating it would silently strip every
				// line of the job it was bought for.
				for (const a of parsed.allocations) {
					await tx.field_purchase_job_allocation.upsert({
						where: {
							field_purchase_id_job_id: {
								field_purchase_id: purchaseId,
								job_id: a.job_id,
							},
						},
						create: {
							field_purchase_id: purchaseId,
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

			await tx.field_purchase.update({
				where: { id: purchaseId },
				data: {
					...(parsed.reason !== undefined && { reason: parsed.reason }),
					...(parsed.vendor_name !== undefined && { vendor_name: parsed.vendor_name }),
					...(parsed.supplier_id !== undefined && { supplier_id: parsed.supplier_id }),
					...(parsed.receipt_number !== undefined && { receipt_number: parsed.receipt_number }),
					...(parsed.purchased_at !== undefined && { purchased_at: parsed.purchased_at }),
					...(parsed.tax_amount !== undefined && { tax_amount: parsed.tax_amount }),
					...(parsed.total !== undefined && { total: parsed.total }),
				},
			});
			await recomputeSubtotal(tx as unknown as Prisma.TransactionClient, purchaseId);
			// Tax moved, or a job left the receipt: either way the shares no longer
			// answer for the lines underneath them.
			await settleAllocations(tx as unknown as Prisma.TransactionClient, purchaseId);
			await appendEvent(
				tx,
				orgId,
				"purchase.updated",
				context,
				{ field_purchase_id: purchaseId },
				{ fields: Object.keys(parsed) },
			);
			return tx.field_purchase.findUniqueOrThrow({
				where: { id: purchaseId },
				select: PURCHASE_SELECT,
			});
		});

		return { purchase: await shapePurchase(purchase) };
	} catch (err) {
		return toErr(err);
	}
}

/**
 * A provisional catalog row for a part named but never mapped, so "onto the truck"
 * does not quietly require the optional step first. Matched by name before creating:
 * `replaceLines` runs on every save, and creating per save would litter the catalog.
 */
async function provisionalItemFor(
	tx: Prisma.TransactionClient,
	orgId: string,
	description: string,
	cost: number,
	context?: UserContext,
): Promise<string> {
	const name = description.trim();
	const existing = await tx.inventory_item.findFirst({
		where: { organization_id: orgId, provisional: true, name },
		select: { id: true },
	});
	if (existing) return existing.id;

	const created = await tx.inventory_item.create({
		data: {
			organization_id: orgId,
			name,
			description: "",
			quantity: 0,
			cost,
			unit_price: cost,
			provisional: true,
			// Not `tech_submission`: the enum carries a value for this path, the
			// reconcile origin filter offers it, and attributing a receipt line to a
			// parts-request form sends the dispatcher to the wrong document.
			origin: "field_purchase",
			created_by_tech_id: context?.techId ?? null,
		},
		select: { id: true },
	});
	return created.id;
}

/**
 * The single writer of `allocation.amount`, and of a line's job where it was never
 * in doubt. Called inside the same transaction as every line write and every tax
 * change, because a share is an answer about the lines and goes stale the moment
 * they move.
 */
async function settleAllocations(tx: Prisma.TransactionClient, purchaseId: string) {
	const sole = await tx.field_purchase_job_allocation.findMany({
		where: { field_purchase_id: purchaseId },
		select: { id: true },
		take: 2,
	});
	// One job takes every line by definition, so the technician is never asked
	// which and the payload never says. Also what rescues a receipt that became
	// single-job again after a job was dropped from it.
	if (sole.length === 1) {
		await tx.field_purchase_line.updateMany({
			where: { field_purchase_id: purchaseId, allocation_id: null },
			data: { allocation_id: sole[0]!.id },
		});
	}

	const purchase = await tx.field_purchase.findUniqueOrThrow({
		where: { id: purchaseId },
		select: {
			tax_amount: true,
			allocations: { select: { id: true, lines: { select: { line_total: true } } } },
		},
	});
	for (const { id, amount } of deriveAllocationAmounts(
		purchase.allocations,
		purchase.tax_amount,
	)) {
		await tx.field_purchase_job_allocation.update({ where: { id }, data: { amount } });
	}
}

/** Subtotal is derived from the lines, never supplied — it is the sum, by definition. */
async function recomputeSubtotal(tx: Prisma.TransactionClient, purchaseId: string) {
	const lines = await tx.field_purchase_line.findMany({
		where: { field_purchase_id: purchaseId },
		select: { line_total: true },
	});
	await tx.field_purchase.update({
		where: { id: purchaseId },
		data: { subtotal: sumDecimal(lines.map((l) => l.line_total)) },
	});
}

export async function replaceLines(
	orgId: string,
	purchaseId: string,
	data: unknown,
	context?: UserContext,
): Promise<Result<{ lines: unknown[] }>> {
	try {
		const parsed = replaceLinesSchema.parse(data);
		const sdb = getScopedDb(orgId);
		const loaded = await loadEditable(orgId, purchaseId, context);
		if (loaded.err) return { err: loaded.err };

		await assertInventoryItemsInOrg(
			db,
			orgId,
			parsed.lines.map((l) => l.inventory_item_id),
		);
		await assertDispositionVehiclesInOrg(
			db,
			orgId,
			parsed.lines.map((l) => l.disposition_vehicle_id),
		);

		for (const line of parsed.lines) {
			if (line.disposition !== "receive" && line.disposition_vehicle_id) {
				return { err: "Validation failed: only a `receive` line takes a destination vehicle" };
			}
		}

		// A technician stocks the truck they are standing at, and nothing else: the
		// org-wide check above would let one crew's receipt move stock onto another
		// crew's van, which writes an inventory ledger nobody there can account for.
		// Warehouse (a null vehicle) stays open to everyone, and a dispatcher acting
		// through this endpoint has no current truck to compare against.
		const namedVehicles = parsed.lines
			.map((l) => l.disposition_vehicle_id)
			.filter((v): v is string => !!v);
		if (context?.techId && namedVehicles.length > 0) {
			const tech = await sdb.technician.findFirst({
				where: { id: context.techId },
				select: { current_vehicle_id: true },
			});
			const own = tech?.current_vehicle_id ?? null;
			if (namedVehicles.some((v) => v !== own)) {
				return {
					err: own
						? "Validation failed: a line names a vehicle that is not your current truck"
						: "Validation failed: you have no truck assigned - stocked lines go to the warehouse",
				};
			}
		}

		// The job arrives from a client, and a line pointing at some other receipt's
		// allocation would bill a customer who was never at this counter.
		const allocations = await sdb.field_purchase_job_allocation.findMany({
			where: { field_purchase_id: purchaseId },
			select: { id: true, job_id: true },
		});
		const allocOfJob = new Map(allocations.map((a) => [a.job_id, a.id]));
		if (parsed.lines.some((l) => l.job_id && !allocOfJob.has(l.job_id))) {
			return { err: "Validation failed: a line names a job this receipt does not cover" };
		}

		const lines = await sdb.$transaction(async (tx) => {
			// Replaced wholesale, which drops every verified stamp. That is the
			// point: a line whose numbers changed has not been verified.
			// Anything an earlier submit billed goes with them, or the customer is
			// left holding a charge for a line that no longer exists.
			await unbillLines(tx as unknown as Prisma.TransactionClient, orgId, purchaseId);
			await tx.field_purchase_line.deleteMany({ where: { field_purchase_id: purchaseId } });
			for (const [i, line] of parsed.lines.entries()) {
				const lineTotal =
					line.line_total ??
					toDecimal(line.quantity).times(toDecimal(line.unit_price)).toNumber();
				// Stock has to move a catalog row, so an unmapped line that says it
				// went onto the truck gets one rather than being refused for skipping
				// a step the spec calls optional.
				const itemId =
					line.inventory_item_id ??
					(line.disposition === "receive"
						? await provisionalItemFor(
								tx as unknown as Prisma.TransactionClient,
								orgId,
								line.description,
								line.unit_price,
								context,
							)
						: null);
				await tx.field_purchase_line.create({
					data: {
						field_purchase_id: purchaseId,
						description: line.description,
						quantity: line.quantity,
						unit_price: line.unit_price,
						line_total: lineTotal,
						inventory_item_id: itemId,
						disposition: line.disposition ?? null,
						disposition_location:
							line.disposition === "receive"
								? line.disposition_vehicle_id
									? "vehicle"
									: "warehouse"
								: null,
						disposition_vehicle_id:
							line.disposition === "receive" ? (line.disposition_vehicle_id ?? null) : null,
						// Null on a single-job receipt, where `settleAllocations` fills
						// it in below rather than asking the technician the obvious.
						allocation_id: line.job_id ? (allocOfJob.get(line.job_id) ?? null) : null,
						// Confirmed as part of writing the line, when the caller says the
						// technician confirmed it. Otherwise null, which is what a
						// replaced line has always been until somebody looks at it.
						verified_at: line.acknowledged ? new Date() : null,
						ocr_confidence: line.ocr_confidence ?? null,
						sort_order: line.sort_order ?? i,
					},
				});
			}
			await recomputeSubtotal(tx as unknown as Prisma.TransactionClient, purchaseId);
			await settleAllocations(tx as unknown as Prisma.TransactionClient, purchaseId);
			await appendEvent(
				tx,
				orgId,
				"purchase.lines_replaced",
				context,
				{ field_purchase_id: purchaseId },
				{ line_count: parsed.lines.length },
			);
			return tx.field_purchase_line.findMany({
				where: { field_purchase_id: purchaseId },
				select: LINE_SELECT,
				orderBy: { sort_order: "asc" },
			});
		});

		return { lines };
	} catch (err) {
		return toErr(err);
	}
}

/**
 * A reviewer correcting which job a line was for. The technician says it at the
 * counter; a dispatcher who knows better says so here, and the charge moves with
 * it rather than being left for somebody to fix on the invoice by hand.
 */
export async function assignLineJob(
	orgId: string,
	purchaseId: string,
	lineId: string,
	data: unknown,
	context?: UserContext,
): Promise<Result<{ purchase: unknown }>> {
	try {
		const parsed = assignLineJobSchema.parse(data);
		if (!context?.dispatcherId) {
			return { err: "Only a dispatcher can reassign a field purchase line" };
		}
		const sdb = getScopedDb(orgId);
		const existing = await sdb.field_purchase.findFirst({
			where: { id: purchaseId },
			select: {
				status: true,
				lines: { select: { id: true } },
				allocations: { select: { id: true, job_id: true, job_visit_id: true } },
			},
		});
		if (!existing) return { err: "Field purchase not found" };
		// Review is the moment for this. Once decided the money is settled, and a
		// reviewer who wants a different answer has a query and a re-submit.
		if (existing.status !== "pending_review") {
			return { err: "Lines can only be reassigned while the purchase is under review" };
		}
		if (!existing.lines.some((l) => l.id === lineId)) {
			return { err: "That line does not belong to this purchase" };
		}
		const allocation = existing.allocations.find((a) => a.job_id === parsed.job_id);
		if (!allocation) return { err: "Validation failed: this receipt does not cover that job" };

		const purchase = await sdb.$transaction(async (tx) => {
			const txc = tx as unknown as Prisma.TransactionClient;
			await tx.field_purchase_line.update({
				where: { id: lineId },
				data: { allocation_id: allocation.id },
			});
			// Both, and in this order: the shares follow the line, and so does the
			// charge it already raised on somebody else's visit.
			await settleAllocations(txc, purchaseId);
			await syncBilledLines(txc, orgId, purchaseId);
			await appendEvent(
				tx,
				orgId,
				"purchase.line_reassigned",
				context,
				{ field_purchase_id: purchaseId },
				{ line_id: lineId, job_id: parsed.job_id },
			);
			return tx.field_purchase.findUniqueOrThrow({
				where: { id: purchaseId },
				select: PURCHASE_SELECT,
			});
		});

		await logPurchaseActivity(
			orgId,
			"field_purchase",
			purchaseId,
			"line_reassigned",
			"updated",
			context,
		);
		for (const visitId of billedVisitIds(existing.allocations)) {
			emitToOrg(orgId, "job_visit:updated", { visitId, organizationId: orgId });
		}

		return { purchase: await shapePurchase(purchase) };
	} catch (err) {
		return toErr(err);
	}
}

/** Links/corrects the supplier on a purchase of any status. not gated by isTechEditable */
export async function linkSupplier(
	orgId: string,
	purchaseId: string,
	data: unknown,
	context?: UserContext,
): Promise<Result<{ purchase: unknown }>> {
	try {
		const parsed = linkSupplierSchema.parse(data);
		if (!context?.dispatcherId) {
			return { err: "Only a dispatcher can link a supplier" };
		}
		const sdb = getScopedDb(orgId);
		const existing = await sdb.field_purchase.findFirst({
			where: { id: purchaseId },
			select: { id: true, supplier_id: true, qb_sync_status: true },
		});
		if (!existing) return { err: "Field purchase not found" };

		const supplier = await db.supplier.findFirst({
			where: { id: parsed.supplier_id, organization_id: orgId },
			select: { id: true },
		});
		if (!supplier) return { err: "Validation failed: unknown supplier" };

		// The QB PurchaseOrder already pushed still names the old vendor - flag it
		// stale so the push button re-enables instead of silently no-op'ing.
		const supplierChanged = existing.supplier_id !== parsed.supplier_id;

		const purchase = await sdb.$transaction(async (tx) => {
			await tx.field_purchase.update({
				where: { id: purchaseId },
				data: {
					supplier_id: parsed.supplier_id,
					...(supplierChanged && existing.qb_sync_status === "synced"
						? { qb_sync_status: "not_synced" }
						: {}),
				},
			});
			await appendEvent(
				tx,
				orgId,
				"purchase.supplier_linked",
				context,
				{ field_purchase_id: purchaseId },
				{ supplier_id: parsed.supplier_id },
			);
			return tx.field_purchase.findUniqueOrThrow({
				where: { id: purchaseId },
				select: PURCHASE_SELECT,
			});
		});

		await logPurchaseActivity(
			orgId,
			"field_purchase",
			purchaseId,
			"supplier_linked",
			"updated",
			context,
		);

		return { purchase: await shapePurchase(purchase) };
	} catch (err) {
		return toErr(err);
	}
}

/**
 * The receipt is the only proof a reimbursement has, so the same image can never
 * back two purchases. The hash is of the bytes we store; re-compressing the same
 * photo produces different bytes and defeats it, which is what the fuzzy
 * (vendor, date, total) match in a later stage is for.
 */
export async function uploadReceipt(
	orgId: string,
	purchaseId: string,
	file: { buffer: Buffer; mimetype: string; originalname: string } | undefined,
	meta: unknown,
	context?: UserContext,
): Promise<Result<{ purchase: unknown }>> {
	try {
		if (!file) return { err: "Validation failed: a receipt image is required" };
		const parsed = captureMetaSchema.parse(meta);
		const loaded = await loadEditable(orgId, purchaseId, context);
		if (loaded.err) return { err: loaded.err };

		const provider = getReceiptOcrProvider();
		const hash = createHash("sha256").update(file.buffer).digest("hex");
		const sdb = getScopedDb(orgId);
		const clash = await sdb.field_purchase.findFirst({
			where: { receipt_image_hash: hash, id: { not: purchaseId } },
			select: { id: true, technician: { select: { name: true } } },
		});
		if (clash) {
			return { err: `This receipt image has already been submitted (${clash.technician.name})` };
		}

		// Same bytes on the same purchase that already read successfully is a
		// retry of the upload, not a new receipt to bill Mindee for again.
		const alreadyRead =
			loaded.purchase.receipt_image_hash === hash && loaded.purchase.ocr_status === "succeeded";

		const url = await uploadFile(file.buffer, file.mimetype, file.originalname, "receipts");

		// An oversized image is refused by runReceiptOcr before any vendor call, so it is not charged.
		const wantsRead = !!provider && !alreadyRead && file.buffer.byteLength <= OCR_MAX_BYTES;
		const usedUp = wantsRead && !(await claimScan(orgId));
		const reads = !!provider && !alreadyRead && !usedUp;

		const purchase = await sdb.$transaction(async (tx) => {
			const row = await tx.field_purchase.update({
				where: { id: purchaseId },
				data: {
					receipt_image_url: url,
					receipt_image_hash: hash,
					captured_at: parsed.captured_at ?? new Date(),
					capture_lat: parsed.capture_lat ?? null,
					capture_lng: parsed.capture_lng ?? null,
					capture_accuracy_m: parsed.capture_accuracy_m ?? null,
					ocr_status:
						!provider || usedUp
							? "skipped"
							: alreadyRead
								? loaded.purchase.ocr_status
								: "pending",
					ocr_provider: provider?.name ?? null,
					ocr_error: usedUp ? SCANS_USED_UP : null,
				},
				select: PURCHASE_SELECT,
			});
			await appendEvent(
				tx,
				orgId,
				"purchase.receipt_captured",
				context,
				{ field_purchase_id: purchaseId },
				{ hash, has_geo: parsed.capture_lat != null },
			);
			return row;
		});

		// Not awaited: a technician on a field connection should not hold the upload
		// response open for a vendor round-trip, and a failed extraction still leaves
		// them the manual entry they would have used anyway.
		if (reads) {
			void runReceiptOcr(orgId, purchaseId, {
				buffer: file.buffer,
				mimetype: file.mimetype,
				filename: file.originalname,
			});
		}

		return { purchase: await shapePurchase(purchase) };
	} catch (err) {
		return toErr(err);
	}
}

// ---------------------------------------------------------------------------
// OCR extraction
// ---------------------------------------------------------------------------

/** One definition of what a failed extraction leaves behind, for all three ways `runReceiptOcr` can fail. */
async function failExtraction(orgId: string, purchaseId: string, message: string) {
	await getScopedDb(orgId)
		.field_purchase.update({
			where: { id: purchaseId },
			data: {
				ocr_status: "failed",
				ocr_error: message.slice(0, 500),
				ocr_completed_at: new Date(),
			},
		})
		.catch(() => undefined);
	emitToOrg(orgId, "field_purchase:ocr", { id: purchaseId, status: "failed" });
}

/**
 * Phone-only, and only when it names exactly one supplier: the schema comment on
 * `supplier` warns that folding vendors by name is wrong, and an address string
 * comparison is unreliable enough that a wrong link is worse than no link. A
 * lookup that fails or finds nothing must not break the extraction it decorates.
 */
async function resolveSupplierByPhone(orgId: string, vendorPhone: string | null): Promise<string | null> {
	const digits = normalizePhone(vendorPhone);
	if (!digits) return null;
	try {
		const suppliers = await getScopedDb(orgId).supplier.findMany({ select: { id: true, phone: true } });
		const matches = suppliers.filter((s) => normalizePhone(s.phone) === digits);
		return matches.length === 1 ? matches[0]!.id : null;
	} catch (err) {
		log.warn({ err, orgId }, "supplier lookup by phone failed - leaving supplier_id unset");
		return null;
	}
}

/**
 * Never overwrites what the technician already entered - header fields only while
 * empty, lines only while there are none, because the tech is the verifier of record.
 * Never throws, and every exit stamps `ocr_status`: `pending` reads as "still
 * working" forever.
 */
export async function runReceiptOcr(orgId: string, purchaseId: string, file: OcrFile) {
	const provider = getReceiptOcrProvider();
	if (!provider) return;

	if (file.buffer.byteLength > OCR_MAX_BYTES) {
		await failExtraction(
			orgId,
			purchaseId,
			`Receipt image is too large to read (${Math.ceil(file.buffer.byteLength / 1024 / 1024)} MB) - enter the lines by hand`,
		);
		return;
	}

	const sdb = getScopedDb(orgId);

	let extraction: ReceiptExtraction;
	try {
		extraction = await provider.extract(file);
	} catch (err) {
		log.warn({ err, purchaseId }, "receipt OCR failed");
		await failExtraction(
			orgId,
			purchaseId,
			err instanceof Error ? err.message : "Extraction failed",
		);
		return;
	}

	// A provider that grades nothing is indistinguishable from a healthy one until a
	// technician is never asked to check a field. Mindee needs `confidence=true` per
	// call and may gate it by plan, so this is a configuration fault, not a bad receipt.
	if (Object.keys(extraction.field_confidence).length === 0) {
		log.warn(
			{ provider: provider.name, purchaseId },
			"extraction returned no field confidence - the low-confidence flags cannot fire",
		);
	}

	// Resolved ahead of the transaction: it is its own read against a different
	// table, and a failed or empty lookup must not stop the extraction itself
	// from being applied.
	const matchedSupplierId = await resolveSupplierByPhone(orgId, extraction.vendor_phone);

	try {
		await sdb.$transaction(async (tx) => {
			const current = await tx.field_purchase.findFirst({
				where: { id: purchaseId, organization_id: orgId },
				select: {
					id: true,
					status: true,
					supplier_id: true,
					vendor_name: true,
					receipt_number: true,
					purchased_at: true,
					subtotal: true,
					tax_amount: true,
					total: true,
					flags: true,
					_count: { select: { lines: true } },
				},
			});
			if (!current) return;

			const empty = (v: unknown) => v == null;
			const zero = (v: Prisma.Decimal) => toDecimal(v).isZero();
			const writeLines =
				current._count.lines === 0 &&
				isTechEditable(current.status) &&
				extraction.lines.length > 0;

			// Advisory, like every deterministic check: a flag routes a dispatcher's
			// attention and never refuses a purchase, because the extraction is
			// evidence and the technician is still the verifier of record.
			// Recomputed from this extraction rather than accumulated, so a
			// retried read that comes back clean does not leave a stale flag behind.
			const ocrFlags = currentFlags(current.flags).filter(
				(f) => f.code !== "not_a_receipt" && f.code !== "foreign_currency",
			);
			if (extraction.document_type && extraction.document_type !== "expense_receipt") {
				ocrFlags.push({
					code: "not_a_receipt",
					message: `The image reads as a ${extraction.document_type.replace(/_/g, " ")}, not a receipt`,
				});
			}
			// Hard-coded because the org currency is not modelled anywhere today. When
			// it is, this reads from the org, not from a constant.
			if (extraction.currency && extraction.currency !== "USD") {
				ocrFlags.push({
					code: "foreign_currency",
					message: `Receipt is priced in ${extraction.currency}`,
				});
			}

			if (writeLines) {
				await tx.field_purchase_line.createMany({
					data: extraction.lines.map((l, i) => ({
						field_purchase_id: purchaseId,
						description: l.description,
						quantity: l.quantity,
						unit_price: l.unit_price,
						line_total: l.line_total,
						ocr_confidence: l.confidence,
						sort_order: i,
					})),
				});
			}

			await tx.field_purchase.update({
				where: { id: purchaseId },
				data: {
					ocr_status: "succeeded",
					ocr_provider: provider.name,
					ocr_raw: (extraction.raw ?? null) as Prisma.InputJsonValue,
					ocr_field_confidence: extraction.field_confidence as Prisma.InputJsonValue,
					// Kept whatever happened to the lines, and saying which. An
					// extraction the technician beat to the punch is the one the sheet
					// has to offer them; discarding it lost four lines because they
					// typed one.
					ocr_lines: extraction.lines.map((l) => ({
						...l,
						applied: writeLines,
					})) as unknown as Prisma.InputJsonValue,
					ocr_line_count: extraction.lines.length,
					ocr_completed_at: new Date(),
					ocr_error: null,
					flags: ocrFlags as unknown as Prisma.InputJsonValue,
					...(empty(current.vendor_name) &&
						extraction.vendor_name != null && { vendor_name: extraction.vendor_name }),
					...(empty(current.receipt_number) &&
						extraction.receipt_number != null && {
							receipt_number: extraction.receipt_number,
						}),
					...(empty(current.purchased_at) &&
						extraction.purchased_at != null && { purchased_at: extraction.purchased_at }),
					...(zero(current.subtotal) &&
						extraction.subtotal != null && { subtotal: extraction.subtotal }),
					...(zero(current.tax_amount) &&
						extraction.tax_amount != null && { tax_amount: extraction.tax_amount }),
					...(zero(current.total) && extraction.total != null && { total: extraction.total }),
					...(empty(current.supplier_id) &&
						matchedSupplierId != null && { supplier_id: matchedSupplierId }),
				},
			});

			// Lines the extraction wrote are lines like any other: the subtotal is
			// their sum and a single-job receipt owns all of them. Skipped when the
			// technician's own lines are on the row - settling those is not this
			// function's business.
			if (writeLines) {
				const txc = tx as unknown as Prisma.TransactionClient;
				await recomputeSubtotal(txc, purchaseId);
				await settleAllocations(txc, purchaseId);
			}

			await appendEvent(
				tx,
				orgId,
				"purchase.ocr_completed",
				undefined,
				{ field_purchase_id: purchaseId },
				{
					provider: provider.name,
					lines_extracted: extraction.lines.length,
					lines_applied: writeLines ? extraction.lines.length : 0,
				},
			);
		});
	} catch (err) {
		// Stamped, not just logged. `pending` reads as "still working" forever: the
		// sheet polls it every three seconds and offers its retry only on `failed`,
		// so a purchase left pending here had no way out of it.
		log.error({ err, purchaseId }, "applying receipt OCR failed");
		await failExtraction(
			orgId,
			purchaseId,
			err instanceof Error ? err.message : "Could not apply the extraction",
		);
		return;
	}

	emitToOrg(orgId, "field_purchase:ocr", { id: purchaseId, status: "succeeded" });
}

/**
 * Re-reads the stored receipt. The bytes are not kept in memory past the upload,
 * so this pulls them back out of storage rather than asking the tech to
 * photograph the same receipt again — which would also change its hash.
 */
export async function retryOcr(
	orgId: string,
	purchaseId: string,
	context?: UserContext,
): Promise<Result<{ started: true }>> {
	try {
		return await startOcrRead(orgId, purchaseId, context);
	} catch (err) {
		// Storage is the one dependency here and it fails on its own schedule. As an
		// unmapped throw it reached the technician as a 500; the receipt is already
		// attached, so the honest answer is that reading failed and typing works.
		log.warn({ err, purchaseId }, "retrying receipt OCR failed");
		return { err: "Could not read the receipt again — enter the lines by hand" };
	}
}

async function startOcrRead(
	orgId: string,
	purchaseId: string,
	context?: UserContext,
): Promise<Result<{ started: true }>> {
	const loaded = await loadEditable(orgId, purchaseId, context);
	if (loaded.err) return { err: loaded.err };

	const sdb = getScopedDb(orgId);
	const row = await sdb.field_purchase.findFirst({
		where: { id: purchaseId },
		select: { receipt_image_url: true, ocr_status: true },
	});
	if (!row?.receipt_image_url) return { err: "This purchase has no receipt image to read" };
	if (row.ocr_status === "pending") return { err: "This receipt is already being read" };

	const provider = getReceiptOcrProvider();
	if (!provider) return { err: "Receipt reading is not configured — enter the lines by hand" };

	const stored = await getBuffer(row.receipt_image_url);
	if (stored.buffer.byteLength <= OCR_MAX_BYTES && !(await claimScan(orgId)))
		return { err: SCANS_USED_UP };
	await sdb.field_purchase.update({
		where: { id: purchaseId },
		data: { ocr_status: "pending", ocr_provider: provider.name, ocr_error: null },
	});

	void runReceiptOcr(orgId, purchaseId, {
		buffer: stored.buffer,
		mimetype: stored.contentType,
		filename: "receipt",
	});
	return { started: true };
}

// ---------------------------------------------------------------------------
// Pre-authorization (over-limit path)
// ---------------------------------------------------------------------------

export async function requestPreauth(
	orgId: string,
	purchaseId: string,
	data: unknown,
	context?: UserContext,
): Promise<Result<{ purchase: unknown }>> {
	try {
		const parsed = preauthRequestSchema.parse(data);
		const sdb = getScopedDb(orgId);
		const loaded = await loadEditable(orgId, purchaseId, context);
		if (loaded.err) return { err: loaded.err };
		// A denial is not the end of the conversation: the estimate was often simply
		// wrong, and refusing the second ask left the technician holding a record
		// with no action that the server would accept and no way to discard it.
		const from = loaded.purchase!.status;
		if (from !== "draft" && from !== "preauth_denied") {
			return { err: "Pre-authorization can only be requested before the purchase is made" };
		}

		// A refund is created at `draft` and this flow accepts drafts, but every
		// word of it — the estimate, the ceilings, the dispatcher's yes — is about
		// a purchase that has not happened yet. Routing a return here stamps
		// `pending_preauth`, overwrites the amount and rewrites the shares, with no
		// exit that settles the credit.
		if (loaded.purchase!.kind === "refund") {
			return { err: "A refund does not need pre-authorization — the money is coming back" };
		}

		// The sheet arrives with the button that switches flows. Applied first so a
		// pre-approval request cannot be the one action that discards what the
		// technician typed to make it.
		const applied = await applySheet(orgId, purchaseId, parsed.sheet, context);
		if (applied.err) return { err: applied.err };

		// The whole reason this purchase needs a dispatcher is that a ceiling is in
		// the way, but flags were only ever computed at submit — so the dispatcher
		// deciding it could not see WHICH limit it crosses. Evaluated here against
		// the estimate, with the same message the submit path writes.
		const techId = loaded.purchase!.technician_id;
		const org = await db.organization.findFirst({
			where: { id: orgId },
			select: { timezone: true },
		});
		const grant = await activeGrant(orgId, techId);
		const spent = await spentSoFar(orgId, techId, new Date(), purchaseId, org?.timezone);
		const allocations = await sdb.field_purchase_job_allocation.findMany({
			where: { field_purchase_id: purchaseId },
			select: { id: true, job_id: true },
		});
		// The shares this ask implies, computed before the limits are read against
		// them: `per_job` is a ceiling on what one job is charged, so handing every
		// job the whole estimate flagged a split against a limit no single job was
		// anywhere near. Equal shares, because there is not yet a line to derive
		// a real one from — an estimate is a guess about a receipt nobody has.
		const shares = spreadEstimate(
			allocations.map((a) => a.job_id),
			parsed.estimated_amount,
		);
		const verdict = checkLimits(grant, parsed.estimated_amount, spent, shares);
		const flags: PurchaseFlag[] = verdict.breaches.map((b) => ({
			code: "limit_breach",
			message: `Exceeds the ${b.code} limit of ${b.limit} (${b.would_be})`,
		}));

		const purchase = await sdb.$transaction(async (tx) => {
			// Until the receipt exists the estimate IS the money on this row, so the
			// total and every job's share follow it. Left behind, a revised ask showed
			// the dispatcher a new estimate against the old figures everywhere else —
			// and on a split, shares that no longer added up to the total, which the
			// review panel correctly but confusingly reported as unallocated money.
			// The one place a share is written from something other than the lines,
			// because there are none yet. The first line replaces it.
			for (const a of allocations) {
				await tx.field_purchase_job_allocation.update({
					where: { id: a.id },
					data: { amount: shares.get(a.job_id) ?? 0 },
				});
			}
			const row = await tx.field_purchase.update({
				where: { id: purchaseId },
				data: {
					status: "pending_preauth",
					estimated_amount: parsed.estimated_amount,
					total: parsed.estimated_amount,
					...(parsed.reason !== undefined && { reason: parsed.reason }),
					preauth_requested_at: new Date(),
					// Replaced, not appended: a re-ask after a denial carries the
					// breaches of the NEW estimate, and the old ones are answered.
					flags: flags as unknown as Prisma.InputJsonValue,
					// The previous refusal is in the trail; leaving it on the row would
					// show a stale "no" against a question being asked again.
					...(from === "preauth_denied" && {
						preauth_note: null,
						preauth_decided_at: null,
						preauth_by_id: null,
					}),
				},
				select: PURCHASE_SELECT,
			});
			await appendEvent(
				tx,
				orgId,
				"purchase.preauth_requested",
				context,
				{ field_purchase_id: purchaseId },
				{ estimated_amount: parsed.estimated_amount, from, breaches: verdict.breaches },
			);
			return row;
		});

		emitToOrg(orgId, "field_purchase:preauth_requested", { id: purchaseId });
		notifyDispatchers({
			type: "field_purchase_preauth_requested",
			title: `${purchase.technician?.name ?? "A technician"} needs pre-approval`,
			body: `Estimated ${formatCurrency(toDecimal(purchase.estimated_amount).toNumber())}${purchase.reason ? ` — ${purchase.reason}` : ""}.`,
			actionUrl: "/dispatch/purchases",
		}, orgId).catch(() => {});
		return { purchase: await shapePurchase(purchase) };
	} catch (err) {
		return toErr(err);
	}
}

export async function decidePreauth(
	orgId: string,
	purchaseId: string,
	data: unknown,
	context?: UserContext,
): Promise<Result<{ purchase: unknown }>> {
	try {
		const parsed = preauthDecisionSchema.parse(data);
		if (!context?.dispatcherId) {
			return { err: "Only a dispatcher can decide a pre-authorization" };
		}
		const sdb = getScopedDb(orgId);
		const existing = await sdb.field_purchase.findFirst({
			where: { id: purchaseId },
			select: { id: true, status: true, technician_id: true, estimated_amount: true },
		});
		if (!existing) return { err: "Field purchase not found" };
		if (existing.status !== "pending_preauth") {
			return { err: "This purchase is not awaiting pre-authorization" };
		}
		// Purchaser is never approver, the same wall review and second sign-off
		// already stand behind. Left open here it was the one unaudited path a
		// person holding both accounts had past their own ceiling.
		if (await isSamePerson(orgId, existing.technician_id, context.dispatcherId)) {
			return { err: "You cannot approve your own pre-authorization" };
		}

		const purchase = await sdb.$transaction(async (tx) => {
			const claimed = await tx.field_purchase.updateMany({
				where: { id: purchaseId, status: "pending_preauth" },
				data: {
					status: parsed.approve ? "preauth_approved" : "preauth_denied",
					preauth_decided_at: new Date(),
					preauth_by_id: context.dispatcherId,
					preauth_note: parsed.note ?? null,
				},
			});
			if (claimed.count === 0) throw new Error(DECIDED_ELSEWHERE);

			const row = await tx.field_purchase.findUniqueOrThrow({
				where: { id: purchaseId },
				select: PURCHASE_SELECT,
			});
			await appendEvent(
				tx,
				orgId,
				parsed.approve ? "purchase.preauth_approved" : "purchase.preauth_denied",
				context,
				{ field_purchase_id: purchaseId },
				{ note: parsed.note ?? null },
			);
			return row;
		});

		await createNotification({
			technicianId: existing.technician_id,
			type: "field_purchase_preauth",
			// "Pre-approval denied" is the status label both surfaces already print for
			// this state; "not approved" was a third name for it, and the vaguer one —
			// it reads as if the purchase itself was rejected rather than the ask.
			title: parsed.approve ? "Purchase pre-approved" : "Pre-approval denied",
			body: parsed.approve
				? `Go ahead with the purchase up to ${toDecimal(existing.estimated_amount).toFixed(2)}.`
				: (parsed.note ?? "Dispatch did not approve this purchase."),
			actionUrl: `/technician/purchases/${purchaseId}`,
		}, orgId);
		// Nothing was emitted here at all, so the technician holding the answer and
		// any second dispatcher watching the queue learned of the decision only by
		// reloading.
		emitToOrg(orgId, "field_purchase:preauth_decided", {
			id: purchaseId,
			status: parsed.approve ? "preauth_approved" : "preauth_denied",
		});

		return { purchase: await shapePurchase(purchase) };
	} catch (err) {
		return toErr(err);
	}
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Billing the job
// ---------------------------------------------------------------------------

/**
 * The one disposition that bills. `non_stock` is the spec's "Consumed on job":
 * the part went onto the work and never entered our inventory, so the customer
 * received something. A `receive` line stocked the truck — nobody is owed for it
 * yet — and a line with no disposition makes no claim about the job at all.
 */
const BILLABLE_DISPOSITION: line_item_disposition = "non_stock";

/** Every visit a receipt's lines bill against, so the totals of each can be squared. */
const billedVisitIds = (allocations?: { job_visit_id: string | null }[]): string[] => [
	...new Set((allocations ?? []).map((a) => a.job_visit_id).filter((v): v is string => !!v)),
];

/** Removes whatever this purchase billed, and squares the visit totals after. */
async function unbillLines(tx: Prisma.TransactionClient, orgId: string, purchaseId: string) {
	const billed = await tx.field_purchase_line.findMany({
		where: { field_purchase_id: purchaseId, visit_line_item_id: { not: null } },
		select: {
			id: true,
			visit_line_item_id: true,
			visit_line_item: { select: { visit_id: true } },
		},
	});
	if (billed.length === 0) return;

	const visitIds = [
		...new Set(billed.map((b) => b.visit_line_item?.visit_id).filter((v): v is string => !!v)),
	];
	await tx.job_visit_line_item.deleteMany({
		where: { id: { in: billed.map((b) => b.visit_line_item_id!) } },
	});
	// The FK is SET NULL, but a row whose visit line was already gone still holds
	// a dangling stamp, and a later submit would treat it as billed.
	await tx.field_purchase_line.updateMany({
		where: { id: { in: billed.map((b) => b.id) } },
		data: { visit_line_item_id: null },
	});
	for (const visitId of visitIds) await recomputeVisitTotals(visitId, orgId, tx);
}

/**
 * Billable rows are written at SUBMIT, not approval: the visit is invoiced when the
 * technician drives away, approval can be days later. Review settles or removes it.
 *
 * Priced at the catalog's sell price when mapped; an unmapped line has nothing else
 * to go on, so it bills at what was paid.
 */
async function syncBilledLines(
	tx: Prisma.TransactionClient,
	orgId: string,
	purchaseId: string,
): Promise<{ billed: number; unbillable: boolean }> {
	const purchase = await tx.field_purchase.findUniqueOrThrow({
		where: { id: purchaseId },
		select: {
			kind: true,
			lines: {
				select: {
					id: true,
					description: true,
					quantity: true,
					unit_price: true,
					inventory_item_id: true,
					disposition: true,
					visit_line_item_id: true,
					visit_line_item: { select: { visit_id: true } },
					allocation: { select: { job_visit_id: true } },
					inventory_item: { select: { name: true, unit_price: true, taxable: true } },
				},
				orderBy: { sort_order: "asc" },
			},
		},
	});

	// A refund credits the customer, which is not this write. Until that lands,
	// an approved refund flags the dispatcher to adjust the invoice by hand.
	if (purchase.kind !== "purchase") return { billed: 0, unbillable: false };

	// Whichever visits this write touches, in either direction: a total is only
	// right once every line that left it has been taken off it.
	const touched = new Set<string>();

	// A charge that no longer belongs where it sits: the line stopped being
	// billable, or its job moved and the customer it moved away from is still
	// paying. `visit_line_item_id` is unique, so a move is delete-then-write.
	const drop = purchase.lines.filter(
		(l) =>
			l.visit_line_item_id &&
			(l.disposition !== BILLABLE_DISPOSITION ||
				l.visit_line_item?.visit_id !== l.allocation?.job_visit_id),
	);
	if (drop.length > 0) {
		for (const l of drop) if (l.visit_line_item?.visit_id) touched.add(l.visit_line_item.visit_id);
		await tx.job_visit_line_item.deleteMany({
			where: { id: { in: drop.map((l) => l.visit_line_item_id!) } },
		});
		await tx.field_purchase_line.updateMany({
			where: { id: { in: drop.map((l) => l.id) } },
			data: { visit_line_item_id: null },
		});
	}
	const dropped = new Set(drop.map((l) => l.id));

	const wanted = purchase.lines.filter((l) => l.disposition === BILLABLE_DISPOSITION);
	// Per visit, because sort order is a position on ONE invoice.
	const nextSort = new Map<string, number>();
	let billed = 0;

	for (const line of wanted) {
		// The visit the line's OWN job was bought on. A line with no job, or a job
		// with no visit, has no invoice to land on and is reported rather than guessed.
		const visitId = line.allocation?.job_visit_id;
		if (!visitId) continue;
		const sortOrder = nextSort.get(visitId) ?? 0;
		nextSort.set(visitId, sortOrder + 1);
		const unitPrice = toDecimal(line.inventory_item?.unit_price ?? line.unit_price);
		const quantity = toDecimal(line.quantity);
		const data = {
			name: line.inventory_item?.name ?? line.description,
			quantity,
			unit_price: unitPrice,
			total: quantity.times(unitPrice),
			// Billed, never in our inventory — the same thing this disposition means
			// on the receipt line, so completion settles it without moving stock.
			disposition: BILLABLE_DISPOSITION,
			inventory_item_id: line.inventory_item_id,
			// Only meaningful alongside a catalog link, and "used" here means
			// settled: a non_stock line's settlement is that no movement is owed.
			fulfillment_status: line.inventory_item_id ? ("used" as const) : null,
			sort_order: sortOrder,
		};

		touched.add(visitId);
		billed++;
		const standing = dropped.has(line.id) ? null : line.visit_line_item_id;
		if (standing) {
			await tx.job_visit_line_item.update({ where: { id: standing }, data });
			continue;
		}
		const created = await tx.job_visit_line_item.create({
			data: {
				...data,
				// New lines only: a standing line keeps whatever the dispatcher set.
				...(line.inventory_item && { taxable: line.inventory_item.taxable }),
				visit_id: visitId,
				source: "field_addition",
				item_type: "material",
			},
		});
		await tx.field_purchase_line.update({
			where: { id: line.id },
			data: { visit_line_item_id: created.id },
		});
	}

	for (const visitId of touched) await recomputeVisitTotals(visitId, orgId, tx);
	return { billed, unbillable: billed < wanted.length };
}

/**
 * Writes a sheet onto a purchase, header and lines, through the same controllers a
 * direct edit would use. Applied BEFORE the caller's checks and never rolled back
 * if a check then refuses: a technician told they are over their limit must not
 * also lose the receipt they just typed in.
 */
async function applySheet(
	orgId: string,
	purchaseId: string,
	data: unknown,
	context?: UserContext,
): Promise<{ err?: string }> {
	if (!data || Object.keys(data as object).length === 0) return {};
	const sdb = getScopedDb(orgId);
	const sheet = submitPurchaseSchema.parse(data);
	const header = {
		...(sheet.vendor_name !== undefined && { vendor_name: sheet.vendor_name }),
		...(sheet.purchased_at !== undefined && { purchased_at: sheet.purchased_at }),
		...(sheet.tax_amount !== undefined && { tax_amount: sheet.tax_amount }),
		...(sheet.total !== undefined && { total: sheet.total }),
	};
	if (Object.keys(header).length > 0 || sheet.allocations) {
		// A single-job purchase keeps its allocation equal to the total, so
		// editing the total here does not strand the split.
		const current = await sdb.field_purchase.findFirst({
			where: { id: purchaseId },
			select: { allocations: { select: { job_id: true, job_visit_id: true } } },
		});
		const single = current?.allocations.length === 1 ? current.allocations[0] : null;
		const updated = await updatePurchase(
			orgId,
			purchaseId,
			{
				...header,
				// A split the technician edited wins; otherwise a single-job
				// purchase follows its own total, so editing the total on the
				// sheet cannot strand the allocation.
				...(sheet.allocations
					? { allocations: sheet.allocations }
					: single && sheet.total !== undefined
						? {
								allocations: [
									{
										job_id: single.job_id,
										job_visit_id: single.job_visit_id,
										amount: sheet.total,
									},
								],
							}
						: {}),
			},
			context,
		);
		if (updated.err) return { err: updated.err };
	}
	if (sheet.lines) {
		const replaced = await replaceLines(orgId, purchaseId, { lines: sheet.lines }, context);
		if (replaced.err) return { err: replaced.err };
	}
	return {};
}

export async function submitPurchase(
	orgId: string,
	purchaseId: string,
	context?: UserContext,
	data?: unknown,
): Promise<Result<{ purchase: unknown; flags: PurchaseFlag[] }>> {
	try {
		const sdb = getScopedDb(orgId);

		const applied = await applySheet(orgId, purchaseId, data, context);
		if (applied.err) return { err: applied.err };
		const existing = await sdb.field_purchase.findFirst({
			where: { id: purchaseId },
			select: {
				id: true,
				status: true,
				technician_id: true,
				total: true,
				tax_amount: true,
				estimated_amount: true,
				purchased_at: true,
				receipt_image_url: true,
				capture_lat: true,
				vendor_name: true,
				receipt_number: true,
				kind: true,
				parent_purchase_id: true,
				ocr_lines: true,
				flags: true,
				lines: {
					select: {
						id: true,
						description: true,
						quantity: true,
						unit_price: true,
						line_total: true,
						verified_at: true,
						allocation_id: true,
					},
				},
				allocations: { select: { job_id: true, job_visit_id: true, amount: true } },
			},
		});
		if (!existing) return { err: "Field purchase not found" };
		if (context?.techId && existing.technician_id !== context.techId) {
			return { err: "You can only submit your own field purchases" };
		}
		if (!isTechEditable(existing.status)) {
			return { err: `A purchase in status ${existing.status} cannot be submitted` };
		}

		if (existing.kind === "refund") {
			const parent = existing.parent_purchase_id
				? await sdb.field_purchase.findFirst({
						where: { id: existing.parent_purchase_id },
						select: {
							status: true,
							total: true,
							allocations: { select: { job_id: true } },
						},
					})
				: null;
			if (!parent) return { err: "This refund is not attached to a purchase" };
			if (parent.status !== "approved") {
				return { err: "A refund can only be raised against an approved purchase" };
			}
			// The receipt is still the only proof, so a credit larger than what was
			// reimbursed is not a refund - it is a second, unexamined payment. Summed
			// across siblings: each refund alone could clear the parent's total while
			// two together returned twice it.
			const siblings = await sdb.field_purchase.findMany({
				where: {
					parent_purchase_id: existing.parent_purchase_id,
					kind: "refund",
					id: { not: purchaseId },
					status: { in: [...REFUND_CLAIM_STATUSES] },
				},
				select: { total: true, tax_amount: true, lines: { select: { line_total: true } } },
			});
			const claimed = sumDecimal([refundClaim(existing), ...siblings.map(refundClaim)]);
			if (claimed.greaterThan(toDecimal(parent.total))) {
				return {
					err: "This refund and the others against the same purchase would exceed it",
				};
			}
			// The reversal lands on the jobs that were charged. A job the purchase
			// never covered has nothing to be credited back.
			const parentJobs = new Set((parent.allocations ?? []).map((a) => a.job_id));
			if (
				parentJobs.size > 0 &&
				existing.allocations.some((a) => !parentJobs.has(a.job_id))
			) {
				return { err: "A refund can only credit jobs the original purchase was for" };
			}
		}

		// The image is mandatory even with no OCR in play: it is the only evidence
		// the purchase happened.
		if (!existing.receipt_image_url) return { err: "A receipt image is required" };
		if (existing.lines.length === 0) return { err: "At least one receipt line is required" };

		const unverified = existing.lines.filter((l) => !l.verified_at);
		if (unverified.length > 0) {
			return { err: `Verify every line before submitting (${unverified.length} left)` };
		}

		if (existing.allocations.length === 0) {
			return { err: "Validation failed: at least one job allocation is required" };
		}
		// A line nobody claimed on a split receipt bills nobody and counts towards
		// no job's share — the money is simply gone. With one job there is nothing
		// to ask, and `settleAllocations` has already answered it.
		const unassigned = existing.lines.filter((l) => !l.allocation_id).length;
		if (existing.allocations.length > 1 && unassigned > 0) {
			return { err: `Say which job each line was for (${unassigned} left)` };
		}

		const purchasedAt = existing.purchased_at ?? new Date();
		const org = await db.organization.findFirst({
			where: { id: orgId },
			select: { timezone: true },
		});
		const grant = await activeGrant(orgId, existing.technician_id);
		const spent = await spentSoFar(
			orgId,
			existing.technician_id,
			purchasedAt,
			purchaseId,
			org?.timezone,
		);
		const jobAmounts = new Map(existing.allocations.map((a) => [a.job_id, a.amount]));
		const verdict = checkLimits(grant, existing.total, spent, jobAmounts, {
			kind: existing.kind,
		});
		if (!verdict.authorized) {
			return { err: "You do not have an active field purchase authorization" };
		}
		// A breach needs a dispatcher's yes first — but only before the money is
		// spent. Two statuses are past that point: one already pre-authorized above
		// its estimate, and one the dispatcher queried, which was submitted once
		// already. Both re-flag at review instead of looping back for a second yes —
		// and a queried receipt has to be answerable, or the technician cannot reply
		// to the dispatcher's own question until somebody edits a grant.
		const spentAlready = existing.status === "preauth_approved" || existing.status === "queried";
		if (verdict.requires_preauth && !spentAlready) {
			return {
				err: `This amount exceeds your limit (${verdict.breaches.map((b) => b.code).join(", ")}) — request pre-authorization first`,
			};
		}

		const vendorDay = spendWindows(purchasedAt, org?.timezone);
		const similar = await similarPurchases(orgId, purchasedAt, purchaseId);
		// A refund mirrors its parent by construction - same vendor, same day, same
		// amount - so running it through the duplicate check would refuse every
		// return. The receipt-image hash still catches one credit slip claimed twice.
		const duplicate =
			existing.kind === "refund"
				? null
				: findDuplicate(
						{
							vendor_name: existing.vendor_name,
							purchased_at: purchasedAt,
							total: existing.total,
							receipt_number: existing.receipt_number,
						},
						similar.map((p) => ({ ...p, technician_name: p.technician.name })),
					);
		// The one refusal in this file that is not about the technician's own
		// authority: an already-reimbursed receipt is settled money, and letting it
		// through a second time is the failure the whole control model exists for.
		if (duplicate?.level === "exact") return { err: duplicate.message };

		const jobWindows = await db.job_visit.findMany({
			where: { job_id: { in: existing.allocations.map((a) => a.job_id) } },
			select: { job_id: true, scheduled_start_at: true, scheduled_end_at: true },
		});

		const flags = evaluateFlags({
			total: existing.total,
			tax_amount: existing.tax_amount,
			estimated_amount: existing.estimated_amount,
			purchased_at: purchasedAt,
			lines: existing.lines,
			jobWindows: jobWindows.map((v) => ({
				job_id: v.job_id,
				start: v.scheduled_start_at,
				end: v.scheduled_end_at,
			})),
			has_geo: existing.capture_lat != null,
		});
		for (const b of verdict.breaches) {
			flags.push({
				code: "limit_breach",
				message: `Exceeds the ${b.code} limit of ${b.limit} (${b.would_be})`,
			});
		}
		if (duplicate) {
			flags.push({ code: "duplicate_suspected", message: duplicate.message });
		}

		const sameVendorSameDay = similar.filter(
			(p) =>
				p.technician_id === existing.technician_id &&
				p.purchased_at != null &&
				p.purchased_at >= vendorDay.dayStart &&
				p.purchased_at < vendorDay.dayEnd &&
				normalizeVendor(p.vendor_name) === normalizeVendor(existing.vendor_name),
		);
		flags.push(
			...velocityFlags(
				existing.total,
				sameVendorSameDay.map((p) => ({ id: p.id, total: p.total })),
				grant?.per_transaction_limit ?? null,
				existing.vendor_name,
			),
		);

		// document_type and currency live only on the extraction, not on any column,
		// so evaluateFlags has no way to recompute these two codes - they are carried
		// forward from the stored row instead. A freshly-computed flag of the same
		// code wins, and a resubmit cannot double one already carried forward.
		const OCR_ORIGIN_CODES: PurchaseFlag["code"][] = ["not_a_receipt", "foreign_currency"];
		for (const stored of currentFlags(existing.flags)) {
			if (OCR_ORIGIN_CODES.includes(stored.code) && !flags.some((f) => f.code === stored.code)) {
				flags.push(stored);
			}
		}

		// Answers "how often did the technician have to fix what OCR read", which is
		// the only signal that says whether the provider is earning its keep.
		const snapshot = Array.isArray(existing.ocr_lines)
			? (existing.ocr_lines as unknown as OcrLineSnapshot[])
			: null;
		const corrections = snapshot ? countOcrCorrections(snapshot, existing.lines) : null;

		const purchase = await sdb.$transaction(async (tx) => {
			// Before the status write, so a split that cannot bill is flagged on the
			// same row the dispatcher is about to read.
			const billing = await syncBilledLines(
				tx as unknown as Prisma.TransactionClient,
				orgId,
				purchaseId,
			);
			const finalFlags = billing.unbillable
				? [
						...flags,
						{
							code: "not_billed" as const,
							message:
								"Some lines are not attached to a visit, so no charge was raised for them — add it to the right visit by hand",
						},
					]
				: flags;

			const row = await tx.field_purchase.update({
				where: { id: purchaseId },
				data: {
					status: "pending_review",
					submitted_at: new Date(),
					purchased_at: purchasedAt,
					flags: finalFlags as unknown as Prisma.InputJsonValue,
					...(corrections !== null && { ocr_corrections: corrections }),
				},
				select: PURCHASE_SELECT,
			});
			await appendEvent(
				tx,
				orgId,
				"purchase.submitted",
				context,
				{ field_purchase_id: purchaseId },
				{ flags: finalFlags, billed_lines: billing.billed },
			);
			return { row, finalFlags };
		});

		await logPurchaseActivity(orgId, "field_purchase", purchaseId, "submitted", "updated", context);
		emitToOrg(orgId, "field_purchase:submitted", { id: purchaseId });
		notifyDispatchers({
			type: "field_purchase_submitted",
			title: `${purchase.row.technician?.name ?? "A technician"} submitted a purchase`,
			body: `${formatCurrency(toDecimal(purchase.row.total).toNumber())}${purchase.row.vendor_name ? ` at ${purchase.row.vendor_name}` : ""} is waiting for review.`,
			actionUrl: "/dispatch/purchases",
		}, orgId).catch(() => {});
		// The customer's charge is raised at submit, not at approval, so the visit's
		// line items and totals have already moved for anyone with that job open.
		for (const visitId of billedVisitIds(existing.allocations)) {
			emitToOrg(orgId, "job_visit:updated", { visitId, organizationId: orgId });
		}

		return { purchase: await shapePurchase(purchase.row), flags: purchase.finalFlags };
	} catch (err) {
		return toErr(err);
	}
}

export async function deletePurchase(
	orgId: string,
	purchaseId: string,
	context?: UserContext,
): Promise<Result<{ deleted: true }>> {
	const sdb = getScopedDb(orgId);
	const existing = await sdb.field_purchase.findFirst({
		where: { id: purchaseId },
		select: { id: true, status: true, technician_id: true },
	});
	if (!existing) return { err: "Field purchase not found" };
	if (context?.techId && existing.technician_id !== context.techId) {
		return { err: "You can only delete your own field purchases" };
	}
	// Draft only: once submitted, the row is part of the money trail. Worded off
	// the "Only a" prefix on purpose — the route maps that prefix to 403, which is
	// the right answer for separation of duties and a false one here.
	if (existing.status !== "draft") {
		return { err: "This purchase is not a draft, so it cannot be deleted" };
	}
	await sdb.field_purchase.delete({ where: { id: purchaseId } });
	return { deleted: true };
}

// ---------------------------------------------------------------------------
// Review (dispatcher side)
// ---------------------------------------------------------------------------

/**
 * Purchaser is never approver. Technician and dispatcher are separate tables, so
 * comparing their ids can never match — one human holding both accounts is
 * precisely the case this refuses, and the login address is what ties the two
 * rows to the same person.
 */
async function isSamePerson(orgId: string, technicianId: string, dispatcherId: string) {
	const sdb = getScopedDb(orgId);
	const [tech, dispatcher] = await Promise.all([
		sdb.technician.findFirst({ where: { id: technicianId }, select: { email: true } }),
		sdb.dispatcher.findFirst({ where: { id: dispatcherId }, select: { email: true } }),
	]);
	const bought = tech?.email?.trim().toLowerCase();
	const decides = dispatcher?.email?.trim().toLowerCase();
	return !!bought && bought === decides;
}

function currentFlags(value: unknown): PurchaseFlag[] {
	return Array.isArray(value) ? (value as PurchaseFlag[]) : [];
}

type ApprovalLine = {
	id: string;
	quantity: Prisma.Decimal;
	unit_price: Prisma.Decimal;
	inventory_item_id: string | null;
	disposition: string | null;
	disposition_vehicle_id: string | null;
	visit_line_item_id: string | null;
	allocation: { job_visit_id: string | null } | null;
};

/**
 * `external` -> `consumed` moves no balance: the part was never on our shelf, but
 * what was paid still belongs on the item's history and against the visit. An
 * unmapped line has no item to hang cost on.
 */
async function applyConsumedCost(
	tx: Prisma.TransactionClient,
	orgId: string,
	purchase: { supplier_id: string | null; lines: ApprovalLine[] },
	dispatcherId: string,
) {
	const consumed = purchase.lines.filter(
		(l) => l.inventory_item_id && l.disposition === BILLABLE_DISPOSITION,
	);
	if (consumed.length === 0) return;

	await recordMovements(
		tx,
		orgId,
		{ actor_type: "dispatcher", actor_id: dispatcherId },
		consumed.map((l) => ({
			inventory_item_id: l.inventory_item_id!,
			qty: Number(l.quantity),
			from_location_type: "external" as const,
			to_location_type: "consumed" as const,
			reason: "supplier_purchase" as const,
			unit_cost: Number(l.unit_price),
			supplier_id: purchase.supplier_id ?? undefined,
			field_purchase_line_id: l.id,
			// The visit this line's own job was bought on, not the receipt's — on a
			// split they are different customers.
			...(l.allocation?.job_visit_id ? { visit_id: l.allocation.job_visit_id } : {}),
			...(l.visit_line_item_id ? { visit_line_item_id: l.visit_line_item_id } : {}),
			note: "Field purchase used on the job",
		})),
		{ allowUntracked: true },
	);
}

/**
 * The intake an approval writes: `receive` lands in stock at what was paid,
 * `non_stock` moves nothing. Lifted out of reviewPurchase because a purchase over
 * the sign-off threshold reaches it from the second signer instead, and the effect
 * must be identical either way.
 */
async function applyApprovalStockEffect(
	tx: Prisma.TransactionClient,
	orgId: string,
	purchase: { id: string; supplier_id: string | null; lines: ApprovalLine[] },
	dispatcherId: string,
) {
	const intake = purchase.lines.filter((l) => l.inventory_item_id && l.disposition === "receive");
	if (intake.length === 0) return;
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
			// The same physical event as a tech buying at a counter, which this
			// reason already names.
			reason: "supplier_purchase" as const,
			unit_cost: Number(l.unit_price),
			supplier_id: purchase.supplier_id ?? undefined,
			field_purchase_line_id: l.id,
			note: "Field purchase approved",
		})),
		// A serial/batch tracked item would otherwise need per-unit input a receipt
		// does not carry; the gap is recorded and reported.
		{ allowUntracked: true },
	);
}

/**
 * Puts back exactly what the parent purchase brought in, and only that. The
 * destination comes from the parent's own line, not the refund's: a part received
 * onto a van has to leave that van. A refund line with no matching parent intake
 * moves no stock - it credits something that never entered inventory.
 */
async function applyRefundReversal(
	tx: Prisma.TransactionClient,
	orgId: string,
	refund: { id: string; parent_purchase_id: string | null; supplier_id: string | null; lines: ApprovalLine[] },
	dispatcherId: string,
) {
	if (!refund.parent_purchase_id) return;

	const parentLines = await tx.field_purchase_line.findMany({
		where: { field_purchase_id: refund.parent_purchase_id, disposition: "receive" },
		select: { inventory_item_id: true, disposition_vehicle_id: true, quantity: true },
	});
	if (parentLines.length === 0) return;

	// Per item, what came in and where it went. The same part can arrive twice on
	// one receipt — some onto a van, some into the warehouse — so a single origin
	// per item would give the whole credit back to whichever line was read last.
	const origins = new Map<string, { vehicle: string | null; qty: Prisma.Decimal }[]>();
	for (const l of parentLines) {
		if (!l.inventory_item_id) continue;
		const buckets = origins.get(l.inventory_item_id) ?? [];
		const same = buckets.find((b) => b.vehicle === l.disposition_vehicle_id);
		if (same) same.qty = same.qty.plus(l.quantity);
		else buckets.push({ vehicle: l.disposition_vehicle_id, qty: toDecimal(l.quantity) });
		origins.set(l.inventory_item_id, buckets);
	}

	/** Draws down what is left of an item's intake, nearest bucket first. */
	const draw = (itemId: string, want: Prisma.Decimal) => {
		const taken: { vehicle: string | null; qty: Prisma.Decimal }[] = [];
		let left = want;
		for (const bucket of origins.get(itemId) ?? []) {
			if (left.lessThanOrEqualTo(0)) break;
			const qty = Prisma.Decimal.min(left, bucket.qty);
			if (qty.lessThanOrEqualTo(0)) continue;
			bucket.qty = bucket.qty.minus(qty);
			left = left.minus(qty);
			taken.push({ vehicle: bucket.vehicle, qty });
		}
		return taken;
	};

	// What earlier approved refunds against this same purchase already put back.
	// Without this each refund reverses the full intake again and invents stock.
	const alreadyReturned = await tx.field_purchase_line.findMany({
		where: {
			inventory_item_id: { not: null },
			field_purchase: {
				parent_purchase_id: refund.parent_purchase_id,
				kind: "refund",
				status: "approved",
				id: { not: refund.id },
			},
		},
		select: { inventory_item_id: true, quantity: true },
	});
	for (const l of alreadyReturned) draw(l.inventory_item_id!, toDecimal(l.quantity));

	// With Vehicle Stock off a truck holds no tracked stock, so there is nothing
	// there to take back; the refund itself still goes through.
	const vehicleStockOn = await isModuleOn(orgId, "vehicle_stock");
	const movements: Parameters<typeof recordMovements>[3] = [];
	for (const line of refund.lines) {
		if (!line.inventory_item_id) continue;
		// Never give back more than went out: a credit for three of something we
		// only received two of would invent a unit.
		for (const origin of draw(line.inventory_item_id, toDecimal(line.quantity))) {
			if (origin.vehicle && !vehicleStockOn) continue;
			movements.push({
				inventory_item_id: line.inventory_item_id,
				qty: origin.qty.toNumber(),
				from_location_type: origin.vehicle ? "vehicle" : "warehouse",
				from_vehicle_id: origin.vehicle ?? undefined,
				to_location_type: "external",
				reason: "reversal",
				unit_cost: Number(line.unit_price),
				supplier_id: refund.supplier_id ?? undefined,
				field_purchase_line_id: line.id,
				note: "Field purchase refund approved",
			});
		}
	}

	if (movements.length === 0) return;
	await recordMovements(
		tx,
		orgId,
		{ actor_type: "dispatcher", actor_id: dispatcherId },
		movements,
		{ allowUntracked: true },
	);
}

/**
 * Approve writes the in-app stock effect and nothing else. QuickBooks posting is a
 * later stage, so during a pilot finance records the reimbursement by hand against
 * this record rather than an automated entry nobody has signed off.
 */
export async function reviewPurchase(
	orgId: string,
	purchaseId: string,
	data: unknown,
	context?: UserContext,
): Promise<Result<{ purchase: unknown }>> {
	try {
		const parsed = reviewDecisionSchema.parse(data);
		if (!context?.dispatcherId) {
			return { err: "Only a dispatcher can review a field purchase" };
		}

		const sdb = getScopedDb(orgId);
		const existing = await sdb.field_purchase.findFirst({
			where: { id: purchaseId },
			select: {
				id: true,
				status: true,
				kind: true,
				parent_purchase_id: true,
				technician_id: true,
				supplier_id: true,
				total: true,
				flags: true,
				allocations: { select: { job_visit_id: true } },
				lines: {
					select: {
						id: true,
						quantity: true,
						unit_price: true,
						inventory_item_id: true,
						disposition: true,
						disposition_vehicle_id: true,
						visit_line_item_id: true,
						allocation: { select: { job_visit_id: true } },
					},
				},
			},
		});
		if (!existing) return { err: "Field purchase not found" };
		if (existing.status !== "pending_review") {
			return { err: "This purchase is not awaiting review" };
		}
		if (await isSamePerson(orgId, existing.technician_id, context.dispatcherId)) {
			return { err: "You cannot review your own purchase" };
		}

		// Both of these hand the purchase back to the technician with something they
		// have to act on, and neither is answerable without a reason. A rejection
		// also un-bills the customer's visit and cannot be undone.
		if ((parsed.decision === "query" || parsed.decision === "reject") && !parsed.note) {
			return {
				err:
					parsed.decision === "query"
						? "Validation failed: a query needs a note for the technician"
						: "Validation failed: a rejection needs a note for the technician",
			};
		}

		// Above the org threshold an approval is only the first of two: the status
		// stops short of `approved` and the stock effect waits with it, because an
		// approval that already moved stock is not really pending anything.
		const org = await db.organization.findFirst({
			where: { id: orgId },
			select: { field_purchase_second_signoff_threshold: true },
		});
		const threshold = org?.field_purchase_second_signoff_threshold ?? null;
		const needsSecondSignoff =
			parsed.decision === "approve" &&
			existing.kind === "purchase" &&
			threshold != null &&
			toDecimal(existing.total).greaterThanOrEqualTo(toDecimal(threshold));

		const status =
			parsed.decision === "approve"
				? needsSecondSignoff
					? "pending_second_signoff"
					: "approved"
				: parsed.decision === "query"
					? "queried"
					: "rejected";

		const purchase = await sdb.$transaction(async (tx) => {
			// Claim the row before anything moves. Two dispatchers can press Approve
			// on the same receipt at once, and the loser must not also write the
			// intake — that would take the stock in twice and owe the money twice.
			const claimed = await tx.field_purchase.updateMany({
				where: { id: purchaseId, status: "pending_review" },
				data: {
					status,
					reviewed_at: new Date(),
					reviewed_by_id: context.dispatcherId,
					review_note: parsed.note ?? null,
					// A credit promised at the counter is not a credit received, so an
					// approved refund carries this until somebody stamps it settled.
					...(status === "approved" &&
						existing.kind === "refund" && {
							flags: [
								...currentFlags(existing.flags),
								{
									code: "refund_unsettled" as const,
									message: "Approved — waiting on the credit to actually land",
								},
							] as unknown as Prisma.InputJsonValue,
						}),
				},
			});
			if (claimed.count === 0) throw new Error(DECIDED_ELSEWHERE);

			const txc = tx as unknown as Prisma.TransactionClient;
			if (status === "approved") {
				if (existing.kind === "refund") {
					await applyRefundReversal(txc, orgId, existing, context.dispatcherId!);
				} else {
					await applyApprovalStockEffect(txc, orgId, existing, context.dispatcherId!);
					await applyConsumedCost(txc, orgId, existing, context.dispatcherId!);
				}
			}
			// Rejected means the company is not paying for it, so the customer is not
			// being charged for it either. A query is not a refusal — the charge
			// stands while the technician answers, since the visit may already be
			// invoiced and un-billing it would silently drop revenue mid-question.
			if (status === "rejected") await unbillLines(txc, orgId, purchaseId);

			const row = await tx.field_purchase.findUniqueOrThrow({
				where: { id: purchaseId },
				select: PURCHASE_SELECT,
			});
			await appendEvent(
				tx,
				orgId,
				`purchase.${parsed.decision}`,
				context,
				{ field_purchase_id: purchaseId },
				{ note: parsed.note ?? null },
			);
			return row;
		});

		await logPurchaseActivity(
			orgId,
			"field_purchase",
			purchaseId,
			parsed.decision,
			"updated",
			context,
		);

		const titles = {
			approve: needsSecondSignoff ? "Purchase awaiting a second sign-off" : "Purchase approved",
			query: "Purchase needs a change",
			reject: "Purchase rejected",
		} as const;
		// Written for the technician who is owed the money, so it never repeats a
		// status enum at them.
		const outcome = {
			approve: needsSecondSignoff ? "approved, pending a second signature" : "approved",
			query: "sent back to you",
			reject: "rejected",
		}[parsed.decision];
		await createNotification({
			technicianId: existing.technician_id,
			type: "field_purchase_reviewed",
			title: titles[parsed.decision],
			body: parsed.note ?? `Your ${formatCurrency(toDecimal(existing.total).toNumber())} purchase was ${outcome}.`,
			actionUrl: `/technician/purchases/${purchaseId}`,
		}, orgId);
		emitToOrg(orgId, "field_purchase:reviewed", { id: purchaseId, status });
		if (needsSecondSignoff) {
			// Excludes the first approver, who can't give the second signature
			notifyDispatchers({
				type: "field_purchase_second_signoff",
				title: "Purchase needs a second sign-off",
				body: `A ${formatCurrency(toDecimal(existing.total).toNumber())} purchase was approved once and needs a second signature.`,
				actionUrl: "/dispatch/purchases",
			}, orgId, context?.dispatcherId).catch(() => {});
		}
		// Approving is the write that moves stock — warehouse, vehicles, the item
		// ledger and the vendor price list all shift, and every other stock-writing
		// controller says so. Rejecting instead takes the charge back off the visit.
		if (status === "approved") emitInventoryUpdated(orgId);
		if (status === "rejected") {
			for (const visitId of billedVisitIds(existing.allocations)) {
				emitToOrg(orgId, "job_visit:updated", { visitId, organizationId: orgId });
			}
		}

		return { purchase: await shapePurchase(purchase) };
	} catch (err) {
		log.error({ err, purchaseId }, "field purchase review failed");
		return toErr(err);
	}
}

/**
 * A refund is the purchase's own shape pointing back at it: same receipt (the
 * credit slip), same lines, same review. It starts with the parent's job split
 * so the reversal lands on the jobs that were charged; the technician adjusts
 * both once the credit amount is known.
 */
export async function createRefund(
	orgId: string,
	techId: string,
	data: unknown,
	context?: UserContext,
): Promise<Result<{ purchase: unknown }>> {
	try {
		const parsed = createRefundSchema.parse(data);
		const sdb = getScopedDb(orgId);
		const parent = await sdb.field_purchase.findFirst({
			where: { id: parsed.parent_purchase_id },
			select: {
				id: true,
				kind: true,
				status: true,
				technician_id: true,
				vendor_name: true,
				supplier_id: true,
				allocations: { select: { job_id: true, job_visit_id: true } },
			},
		});
		if (!parent) return { err: "Field purchase not found" };
		if (parent.kind !== "purchase") return { err: "A refund cannot itself be refunded" };
		if (parent.status !== "approved") {
			return { err: "A refund can only be raised against an approved purchase" };
		}
		if (parent.technician_id !== techId) {
			return { err: "You can only refund your own field purchases" };
		}

		// A second tap on "Return a part" is the technician going back to the
		// refund they started, not asking for another empty one.
		const [openDraft] = await sdb.field_purchase.findMany({
			where: {
				parent_purchase_id: parent.id,
				kind: "refund",
				status: "draft",
				technician_id: techId,
			},
			select: PURCHASE_SELECT,
			orderBy: { created_at: "desc" },
			take: 1,
		});
		if (openDraft) return { purchase: await shapePurchase(openDraft) };

		const purchase = await sdb.$transaction(async (tx) => {
			const row = await tx.field_purchase.create({
				data: {
					organization_id: orgId,
					technician_id: techId,
					kind: "refund",
					parent_purchase_id: parent.id,
					reason: parsed.reason ?? null,
					vendor_name: parent.vendor_name,
					supplier_id: parent.supplier_id,
					// The jobs, not the money: a credit is worth what its own lines
					// come to, and those are typed against the credit slip.
					allocations: {
						create: parent.allocations.map((a) => ({
							job_id: a.job_id,
							job_visit_id: a.job_visit_id,
							amount: 0,
						})),
					},
				},
				select: PURCHASE_SELECT,
			});
			await appendEvent(
				tx,
				orgId,
				"purchase.refund_started",
				context,
				{ field_purchase_id: row.id as string },
				{ parent_purchase_id: parent.id },
			);
			return row;
		});

		return { purchase: await shapePurchase(purchase) };
	} catch (err) {
		return toErr(err);
	}
}

/**
 * Stamps that the money actually came back. Separate from approving the refund
 * because the credit lands days later, and until it does the company is still
 * out the cash whatever the paperwork says.
 */
export async function settleRefund(
	orgId: string,
	purchaseId: string,
	context?: UserContext,
): Promise<Result<{ purchase: unknown }>> {
	try {
		if (!context?.dispatcherId) return { err: "Only a dispatcher can settle a refund" };
		const sdb = getScopedDb(orgId);
		const existing = await sdb.field_purchase.findFirst({
			where: { id: purchaseId },
			select: { id: true, kind: true, status: true, refund_settled_at: true, flags: true },
		});
		if (!existing) return { err: "Field purchase not found" };
		if (existing.kind !== "refund") return { err: "Only refunds can be settled" };
		if (existing.status !== "approved") return { err: "This refund has not been approved" };
		if (existing.refund_settled_at) return { err: "This refund is already settled" };

		const purchase = await sdb.$transaction(async (tx) => {
			const claimed = await tx.field_purchase.updateMany({
				where: { id: purchaseId, refund_settled_at: null },
				data: {
					refund_settled_at: new Date(),
					flags: currentFlags(existing.flags).filter(
						(f) => f.code !== "refund_unsettled",
					) as unknown as Prisma.InputJsonValue,
				},
			});
			if (claimed.count === 0) throw new Error("This refund is already settled");

			const row = await tx.field_purchase.findUniqueOrThrow({
				where: { id: purchaseId },
				select: PURCHASE_SELECT,
			});
			await appendEvent(
				tx,
				orgId,
				"purchase.refund_settled",
				context,
				{ field_purchase_id: purchaseId },
			);
			return row;
		});

		emitToOrg(orgId, "field_purchase:reviewed", { id: purchaseId, status: "approved" });
		return { purchase: await shapePurchase(purchase) };
	} catch (err) {
		return toErr(err);
	}
}

/**
 * The second half of an over-threshold approval. Three people must be distinct by
 * the time money moves: the technician who bought, the dispatcher who reviewed, and
 * whoever signs here. One dispatcher who both assigns the job and approves the
 * reimbursement is the collusion vector, so signing your own review is refused even
 * where the permission reaches it.
 */
export async function secondSignoff(
	orgId: string,
	purchaseId: string,
	data: unknown,
	context?: UserContext,
): Promise<Result<{ purchase: unknown }>> {
	try {
		const parsed = secondSignoffSchema.parse(data);
		if (!context?.dispatcherId) return { err: "Only a dispatcher can sign off a field purchase" };

		const sdb = getScopedDb(orgId);
		const existing = await sdb.field_purchase.findFirst({
			where: { id: purchaseId },
			select: {
				id: true,
				status: true,
				technician_id: true,
				supplier_id: true,
				total: true,
				reviewed_by_id: true,
				allocations: { select: { job_visit_id: true } },
				lines: {
					select: {
						id: true,
						quantity: true,
						unit_price: true,
						inventory_item_id: true,
						disposition: true,
						disposition_vehicle_id: true,
						visit_line_item_id: true,
						allocation: { select: { job_visit_id: true } },
					},
				},
			},
		});
		if (!existing) return { err: "Field purchase not found" };
		if (existing.status !== "pending_second_signoff") {
			return { err: "This purchase is not awaiting a second sign-off" };
		}
		if (await isSamePerson(orgId, existing.technician_id, context.dispatcherId)) {
			return { err: "You cannot sign off your own purchase" };
		}
		if (existing.reviewed_by_id === context.dispatcherId) {
			return { err: "You cannot sign off a purchase you approved yourself" };
		}
		if (!parsed.approve && !parsed.note) {
			return { err: "Validation failed: refusing a sign-off needs a note" };
		}

		const status = parsed.approve ? "approved" : "rejected";
		const purchase = await sdb.$transaction(async (tx) => {
			const claimed = await tx.field_purchase.updateMany({
				where: { id: purchaseId, status: "pending_second_signoff" },
				data: {
					status,
					second_signoff_at: new Date(),
					second_signoff_by_id: context.dispatcherId,
					second_signoff_note: parsed.note ?? null,
				},
			});
			if (claimed.count === 0) throw new Error(DECIDED_ELSEWHERE);

			const txc = tx as unknown as Prisma.TransactionClient;
			if (parsed.approve) {
				await applyApprovalStockEffect(txc, orgId, existing, context.dispatcherId!);
				await applyConsumedCost(txc, orgId, existing, context.dispatcherId!);
			} else {
				// Refused at the second signature is still refused: the company is not
				// paying, so the customer is not charged.
				await unbillLines(txc, orgId, purchaseId);
			}
			const row = await tx.field_purchase.findUniqueOrThrow({
				where: { id: purchaseId },
				select: PURCHASE_SELECT,
			});
			await appendEvent(
				tx,
				orgId,
				parsed.approve ? "purchase.second_signed" : "purchase.second_signoff_refused",
				context,
				{ field_purchase_id: purchaseId },
				{ note: parsed.note ?? null },
			);
			return row;
		});

		await logPurchaseActivity(
			orgId,
			"field_purchase",
			purchaseId,
			`second_signoff.${status}`,
			"updated",
			context,
		);
		await createNotification({
			technicianId: existing.technician_id,
			type: "field_purchase_reviewed",
			title: parsed.approve ? "Purchase approved" : "Purchase rejected",
			body:
				parsed.note ??
				`Your ${toDecimal(existing.total).toFixed(2)} purchase was ${status} at second sign-off.`,
			actionUrl: `/technician/purchases/${purchaseId}`,
		}, orgId);
		emitToOrg(orgId, "field_purchase:reviewed", { id: purchaseId, status });
		// The stock effect was held back for this signature, so it lands here rather
		// than at the first approval. A refusal unbills instead.
		if (parsed.approve) emitInventoryUpdated(orgId);
		else {
			for (const visitId of billedVisitIds(existing.allocations)) {
				emitToOrg(orgId, "job_visit:updated", { visitId, organizationId: orgId });
			}
		}

		return { purchase: await shapePurchase(purchase) };
	} catch (err) {
		log.error({ err, purchaseId }, "field purchase second sign-off failed");
		return toErr(err);
	}
}
