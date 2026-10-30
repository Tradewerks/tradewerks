import { db } from "../../db.js";
import { getScopedDb } from "../../lib/context.js";
import { isModuleOn } from "../entitlementService.js";
import { getOrgRealmId, isQBConnected } from "../quickbooksService.js";
import { pushInvoice } from "./qbInvoices.js";
import { pushPurchase, pushFieldPurchase } from "./qbPurchases.js";
import { pushPaymentToQB } from "./qbPayments.js";
import { qbFaultDetail } from "./qbCreditMemos.js";

const UNSYNCED = { in: ["not_synced", "failed"] as ("not_synced" | "failed")[] };
// Synced to a previously connected company counts as unsynced in this one.
const STALE = (accountId: string) => ({
	OR: [
		{ qb_sync_status: UNSYNCED },
		{
			qb_sync_status: { in: ["synced", "tax_mismatch"] as ("synced" | "tax_mismatch")[] },
			account_id: { not: accountId },
		},
	],
});
const shownStatus = (s: string) => (s === "failed" ? s : ("not_synced" as const));

// Each filter is the set of documents its push function accepts; anything else
// would only fail on Sync now and sit in the list for good.
export async function listUnsynced(orgId: string) {
	if (!(await isQBConnected(orgId))) return [];
	const sdb = getScopedDb(orgId);
	const accountId = await getOrgRealmId(orgId);
	const [invoices, purchases, fieldPurchases, payments] = await Promise.all([
		sdb.invoice.findMany({
			where: { ...STALE(accountId), status: { not: "Void" } },
			select: { id: true, invoice_number: true, qb_sync_status: true, updated_at: true },
		}),
		// Modules the org cannot use are left out: their push routes are closed too.
		(await isModuleOn(orgId, "purchasing"))
			? sdb.purchase.findMany({
					where: {
						kind: "purchase",
						AND: [
							STALE(accountId),
							{
								OR: [
									{ status: { in: ["ordered", "partially_received", "received"] } },
									{ status: "cancelled", submitted_at: { not: null } },
								],
							},
						],
					},
					select: {
						id: true,
						purchase_number: true,
						qb_sync_status: true,
						updated_at: true,
					},
				})
			: [],
		(await isModuleOn(orgId, "field_purchases"))
			? sdb.field_purchase.findMany({
					where: { ...STALE(accountId), kind: "purchase", status: "approved" },
					select: { id: true, qb_sync_status: true, updated_at: true },
				})
			: [],
		// Payments carry no sync status; one without a QuickBooks id in this company
		// was never pushed here. Refunds are negative rows and are never pushed. The
		// model has no org column, so the org is pinned through the invoice.
		db.invoice_payment.findMany({
			where: {
				OR: [{ qb_payment_id: null }, { account_id: { not: accountId } }],
				amount: { gt: 0 },
				invoice: { organization_id: orgId, status: { not: "Void" } },
			},
			select: {
				id: true,
				created_at: true,
				invoice: { select: { invoice_number: true } },
			},
		}),
	]);
	return [
		...invoices.map((d) => ({
			type: "invoice" as const,
			id: d.id,
			label: d.invoice_number,
			status: shownStatus(d.qb_sync_status),
			updated_at: d.updated_at,
		})),
		...purchases.map((d) => ({
			type: "purchase" as const,
			id: d.id,
			label: d.purchase_number,
			status: shownStatus(d.qb_sync_status),
			updated_at: d.updated_at,
		})),
		...fieldPurchases.map((d) => ({
			type: "field_purchase" as const,
			id: d.id,
			label: `Field purchase ${d.id.slice(0, 8)}`,
			status: shownStatus(d.qb_sync_status),
			updated_at: d.updated_at,
		})),
		...payments.map((d) => ({
			type: "payment" as const,
			id: d.id,
			label: `payment on ${d.invoice.invoice_number}`,
			status: "not_synced" as const,
			updated_at: d.created_at,
		})),
	].sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
}

// Explicit and sequential: re-enabling QuickBooks must never start a burst on its
// own, and QuickBooks rate-limits parallel writes.
export async function syncUnsynced(orgId: string) {
	const failed: { type: string; id: string; label: string; message: string }[] = [];
	let synced = 0;
	const all = await listUnsynced(orgId);
	// Payments last: each one links to its invoice in QuickBooks.
	const docs = [
		...all.filter((d) => d.type !== "payment"),
		...all.filter((d) => d.type === "payment"),
	];
	const sdb = getScopedDb(orgId);
	for (const doc of docs) {
		try {
			if (doc.type === "invoice") await pushInvoice(doc.id, orgId);
			else if (doc.type === "purchase") await pushPurchase(doc.id, orgId);
			else if (doc.type === "payment") await pushPaymentToQB(doc.id, orgId);
			else await pushFieldPurchase(doc.id, orgId);
			synced++;
		} catch (err) {
			// Same mark the single-document routes leave, so the list shows it as failed.
			const where = { where: { id: doc.id }, data: { qb_sync_status: "failed" as const } };
			if (doc.type !== "payment")
				await (
					doc.type === "invoice"
						? sdb.invoice.updateMany(where)
						: doc.type === "purchase"
							? sdb.purchase.updateMany(where)
							: sdb.field_purchase.updateMany(where)
				).catch(() => {});
			failed.push({
				type: doc.type,
				id: doc.id,
				label: doc.label,
				// A raw QuickBooks fault folds a JSON body into the message; its Detail is the readable part.
				message: qbFaultDetail(err) ?? (err instanceof Error ? err.message : "Sync failed"),
			});
		}
	}
	return { synced, failed };
}
