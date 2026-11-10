import { Prisma } from "../../../generated/prisma/client.js";
import { getScopedDb } from "../../lib/context.js";
import { isModuleOn } from "../entitlementService.js";
import { getOrgRealmId, isQBConnected } from "../quickbooksService.js";
import { log } from "../appLogger.js";
import { readTaxSnapshot } from "../tax/snapshot.js";
import { getQBTaxPrefs } from "./qbTax.js";
import { invoiceForQBInclude, pushInvoice } from "./qbInvoices.js";
import { buildInvoicePayload, qbPushFingerprint } from "./qbInvoiceTax.js";
import {
	loadTaxableItem,
	qbLineItemRef,
	type ItemRefLine,
	type TaxableItemRef,
} from "./qbTaxableItem.js";
import { applyQbAdoption, asV2, QB_UNAVAILABLE_REASON, resetsAck } from "./qbAdoption.js";

export { applyQbAdoption, QB_UNAVAILABLE_REASON, type QbAdoptionResult } from "./qbAdoption.js";

export type QbConfirmStatus = "adopted" | "needs_ack" | "skipped" | "unavailable" | "zero_blocked";

export interface QbConfirmResult {
	status: QbConfirmStatus;
	qbTaxCents?: number;
	oursCents?: number;
	reason?: string;
	/** zero_blocked: QuickBooks item names of the lines we hold taxable. */
	items?: string[];
	lineIds?: string[];
}

type ZeroBlock = { kind: "zero"; oursCents: number; items: string[]; lineIds: string[] };

type ConfirmLine = ItemRefLine & { id?: string; tax_amount?: unknown };

/**
 * QuickBooks answering $0 where we tax a line usually means its item has no sales tax category
 * ("Out of scope"), so adopting it would silently drop the tax.
 */
function zeroTaxBlock(
	inv: { tax_snapshot: unknown; line_items: ConfirmLine[] },
	qbTaxCents: number,
	taxableItem: TaxableItemRef,
): ZeroBlock | null {
	const oursCents = readTaxSnapshot(inv.tax_snapshot)?.total_tax_cents ?? 0;
	if (qbTaxCents !== 0 || oursCents <= 0) return null;
	const taxed = inv.line_items.filter(
		(l) => l.taxable !== false && Number(l.tax_amount ?? 0) !== 0,
	);
	return {
		kind: "zero",
		oursCents,
		items: [...new Set(taxed.map((l) => qbLineItemRef(l, taxableItem).name))],
		lineIds: taxed.flatMap((l) => (l.id ? [l.id] : [])),
	};
}

async function markUnavailable(invoiceId: string, orgId: string, err: unknown): Promise<void> {
	log.warn({ err, invoiceId, orgId }, "QuickBooks tax confirmation failed; keeping our estimate");
	try {
		const sdb = getScopedDb(orgId);
		await sdb.$transaction(async (tx) => {
			// An adoption committing as the deadline fires would otherwise be overwritten with the
			// snapshot read here before it, leaving QuickBooks' totals beside our estimate's snapshot.
			await (tx as unknown as Prisma.TransactionClient)
				.$queryRaw`SELECT id FROM invoice WHERE id = ${invoiceId} AND organization_id = ${orgId} FOR UPDATE`;
			const inv = await tx.invoice.findFirst({
				where: { id: invoiceId, organization_id: orgId },
				select: { tax_snapshot: true, tax_needs_review: true },
			});
			if (!inv) return;
			const stored = readTaxSnapshot(inv.tax_snapshot);
			if (stored && stored.locked_at !== "draft") {
				await tx.invoice.update({
					where: { id: invoiceId },
					data: { qb_sync_status: "failed" },
				});
				return;
			}
			const snap = stored ? asV2(stored) : null;
			const reset = resetsAck(
				inv.tax_needs_review,
				snap?.review_reason ?? null,
				QB_UNAVAILABLE_REASON,
			);
			await tx.invoice.update({
				where: { id: invoiceId },
				data: {
					qb_sync_status: "failed",
					tax_needs_review: true,
					...(reset ? { tax_review_ack_by: null, tax_review_ack_at: null } : {}),
					...(snap
						? {
								tax_snapshot: {
									...snap,
									review_reason: QB_UNAVAILABLE_REASON,
									qb_review: true,
								} as unknown as Prisma.InputJsonValue,
							}
						: {}),
				},
			});
		});
	} catch (markErr) {
		log.error(
			{ err: markErr, invoiceId, orgId },
			"Could not flag the invoice after a failed QuickBooks tax confirmation",
		);
	}
}

/**
 * In an AST realm the draft's tax becomes QuickBooks' figure before it is finalized.
 * Never throws; "unavailable" means finalize proceeds on our estimate, flagged for review.
 */
export async function confirmQuickBooksTax(
	invoiceId: string,
	orgId: string,
): Promise<QbConfirmResult> {
	const skipped: QbConfirmResult = { status: "skipped" };
	try {
		if (!(await isModuleOn(orgId, "quickbooks"))) return skipped;
		if (!(await isQBConnected(orgId))) return skipped;
		const sdb = getScopedDb(orgId);
		const draft = await sdb.invoice.findFirst({
			where: { id: invoiceId },
			select: { status: true, tax_snapshot: true },
		});
		if (!isAdoptable(draft)) return skipped;
	} catch (err) {
		log.warn({ err, invoiceId, orgId }, "QuickBooks tax confirmation skipped");
		return skipped;
	}

	const abandon = { cancelled: false };
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			abandon.cancelled = true;
			reject(new Error(`QuickBooks tax confirmation exceeded ${QB_CONFIRM_DEADLINE_MS} ms`));
		}, QB_CONFIRM_DEADLINE_MS);
	});
	try {
		return await Promise.race([confirmWithQuickBooks(invoiceId, orgId, abandon), deadline]);
	} catch (err) {
		await markUnavailable(invoiceId, orgId, err);
		return { status: "unavailable", reason: QB_UNAVAILABLE_REASON };
	} finally {
		clearTimeout(timer);
	}
}

/** qbFetch has no timeout; a hung QuickBooks call would otherwise hold Issue/Send open. */
export const QB_CONFIRM_DEADLINE_MS = 15_000;

/**
 * Work past the deadline keeps running (fetch has no abort here), so every write below checks
 * `abandon` first: by then the caller has marked the invoice unavailable and may have finalized it.
 * Throws for the caller to mark unavailable.
 */
async function confirmWithQuickBooks(
	invoiceId: string,
	orgId: string,
	abandon: { cancelled: boolean },
): Promise<QbConfirmResult> {
	const skipped: QbConfirmResult = { status: "skipped" };
	if (!(await getQBTaxPrefs(orgId)).automatedSalesTax) return skipped;
	const accountId = await getOrgRealmId(orgId);
	// A draft edit landing mid-push makes the read-back stale; one retry covers the usual race.
	for (let attempt = 0; attempt < 2; attempt++) {
		if (abandon.cancelled) return skipped;
		const pushed = await pushInvoice(invoiceId, orgId, { finalizing: true });
		if (!pushed || !pushed.automatedSalesTax) return skipped;
		if (pushed.qbTaxCents == null) throw new Error("Unreadable QuickBooks TotalTax");
		const qbTaxCents = pushed.qbTaxCents;
		if (abandon.cancelled) return skipped;
		const outcome = await getScopedDb(orgId).$transaction(async (tx) => {
			const txc = tx as unknown as Prisma.TransactionClient;
			// Without the lock, an edit committing between the fingerprint read and the write
			// would be overwritten with the old estimate's totals. Raw SQL bypasses getScopedDb.
			await txc.$queryRaw`SELECT id FROM invoice WHERE id = ${invoiceId} AND organization_id = ${orgId} FOR UPDATE`;
			// Re-checked under the lock: the deadline may have passed while waiting for it.
			if (abandon.cancelled) return "skipped" as const;
			const inv = await tx.invoice.findFirst({
				where: { id: invoiceId, organization_id: orgId },
				include: invoiceForQBInclude(accountId),
			});
			if (!isAdoptable(inv)) return "skipped" as const;
			const taxableItem = await loadTaxableItem(txc, orgId, accountId);
			const { lines, shipAddr, clientExempt } = buildInvoicePayload(inv!, taxableItem);
			if (qbPushFingerprint(lines, shipAddr, clientExempt) !== pushed.fingerprint) {
				return "stale" as const;
			}
			const zero = zeroTaxBlock(inv!, qbTaxCents, taxableItem);
			if (zero) return zero;
			const adopted = await applyQbAdoption(
				txc,
				invoiceId,
				orgId,
				{ qbTaxCents, fingerprint: pushed.fingerprint },
			);
			// The push compared QuickBooks against the pre-adoption estimate; now they agree.
			if (adopted && pushed.mismatch) {
				await tx.invoice.update({
					where: { id: invoiceId },
					data: { qb_sync_status: "synced" },
				});
			}
			return adopted;
		});
		if (outcome === "stale") continue;
		if (outcome === "skipped" || outcome == null) return skipped;
		if ("kind" in outcome) {
			return {
				status: "zero_blocked",
				qbTaxCents: 0,
				oursCents: outcome.oursCents,
				items: outcome.items,
				lineIds: outcome.lineIds,
			};
		}
		return {
			status: outcome.status,
			qbTaxCents: outcome.qbTaxCents,
			oursCents: outcome.oursCents,
			...(outcome.reason ? { reason: outcome.reason } : {}),
		};
	}
	throw new Error("Invoice kept changing during QuickBooks tax confirmation");
}

function isAdoptable(inv: { status: string; tax_snapshot: unknown } | null): boolean {
	if (!inv || inv.status !== "Draft") return false;
	const snap = inv.tax_snapshot as { locked_at?: unknown } | null;
	return snap != null && snap.locked_at === "draft";
}
