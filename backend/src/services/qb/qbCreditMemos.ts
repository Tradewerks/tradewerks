import type { Prisma } from "../../../generated/prisma/client.js";
import { getScopedDb } from "../../lib/context.js";
import { log } from "../appLogger.js";
import { qbFetch } from "../quickbooksService.js";
import { parseQbFault } from "./qbFault.js";
import { qbQueryAll } from "./qbQuery.js";
import { getQBTaxPrefs } from "./qbTax.js";
import {
	ensureTaxableItem,
	linesUseItem,
	withTaxableItemRecovery,
	type TaxableItemRef,
} from "./qbTaxableItem.js";
import {
	buildInvoicePayload,
	classifyTaxReadback,
	qbPushFingerprint,
	qbTotalTaxCents,
} from "./qbInvoiceTax.js";
import {
	logTaxMismatch,
	nonAstTaxDetail,
	pushInvoice,
	resolveQBCustomerId,
	type InvoiceForQB,
	type QBInvoicePushResult,
} from "./qbInvoices.js";

export function qbFaultDetail(err: unknown): string | null {
	const detail = parseQbFault(err)[0]?.Detail;
	return typeof detail === "string" && detail ? detail : null;
}

export function isCreditAdjustment(inv: {
	adjusts_invoice_id: string | null;
	total: Prisma.Decimal | number;
}): boolean {
	return inv.adjusts_invoice_id != null && Number(inv.total) < 0;
}

// QuickBooks credit lines are positive; a credit line here arrives as a negative
// qty x price or a negative price, so flip whichever keeps Qty x UnitPrice = Amount.
export function buildCreditMemoLines(lines: any[]): any[] {
	return lines
		.filter((l) => l.DetailType !== "DiscountLineDetail")
		.map((l) => {
			const detail = l.SalesItemLineDetail;
			if (!detail) return { ...l, Amount: -l.Amount };
			const qty = Number(detail.Qty);
			const next = { ...detail, Qty: Math.abs(qty) };
			if (!(qty < 0)) next.UnitPrice = -detail.UnitPrice;
			return { ...l, Amount: -l.Amount, SalesItemLineDetail: next };
		});
}

// Bookkeeping only: the CreditMemo already exists, so a failure here is logged and the
// credit stays as customer credit for the user to apply in QuickBooks.
async function applyCreditToOriginal(
	adjustment: InvoiceForQB,
	creditMemoId: string,
	creditTotal: number,
	creditRemaining: number,
	orgId: string,
	accountId: string,
): Promise<void> {
	try {
		const sdb = getScopedDb(orgId);
		const readOriginal = () =>
			sdb.invoice.findFirst({
				where: { id: adjustment.adjusts_invoice_id as string },
				select: { id: true, qb_invoice_id: true, account_id: true },
			});
		const inRealm = (o: { qb_invoice_id: string | null; account_id: string } | null) =>
			o?.qb_invoice_id != null && o.account_id === accountId;

		let original = await readOriginal();
		if (!original) return;
		if (!inRealm(original)) {
			await pushInvoice(original.id, orgId).catch(() => {});
			original = await readOriginal();
		}
		if (!original || !inRealm(original)) {
			log.warn(
				{ invoiceId: adjustment.id, originalId: adjustment.adjusts_invoice_id, orgId },
				"QuickBooks credit pushed unapplied: the original invoice is not in QuickBooks",
			);
			return;
		}
		const qbInvoiceId = original.qb_invoice_id as string;

		const qbInvoice = (await qbFetch(orgId, "GET", `/invoice/${qbInvoiceId}`)) as any;
		const balance = Number(qbInvoice?.Invoice?.Balance ?? 0);
		const amount = Math.round(Math.min(creditTotal, creditRemaining, balance) * 100) / 100;
		if (!(amount > 0)) return;

		const customerId = await resolveQBCustomerId(adjustment, orgId, accountId);
		const result = (await qbFetch(orgId, "POST", "/payment", {
			CustomerRef: { value: customerId },
			TotalAmt: 0,
			PrivateNote: `Applies credit ${adjustment.invoice_number}`,
			Line: [
				{ Amount: amount, LinkedTxn: [{ TxnId: qbInvoiceId, TxnType: "Invoice" }] },
				{ Amount: amount, LinkedTxn: [{ TxnId: creditMemoId, TxnType: "CreditMemo" }] },
			],
		})) as { Payment: { Id: string } };
		await sdb.invoice.update({
			where: { id: adjustment.id },
			data: { qb_credit_applied_payment_id: result.Payment.Id },
		});
	} catch (err) {
		log.error(
			{ err, invoiceId: adjustment.id, orgId },
			"Could not apply the QuickBooks credit to the original invoice",
		);
	}
}

export async function pushCreditMemo(
	invoice: InvoiceForQB,
	orgId: string,
	accountId: string,
): Promise<QBInvoicePushResult> {
	const customerId = await resolveQBCustomerId(invoice, orgId, accountId);
	// One tax authority per push, read live: AST can be toggled in QB at any moment.
	const { automatedSalesTax } = await getQBTaxPrefs(orgId);
	const taxableItem = automatedSalesTax ? await ensureTaxableItem(orgId, accountId) : null;
	// QuickBooks credits carry a positive tax.
	const tax = Math.abs(Number(invoice.tax_amount));

	// A stale-company id is ignored: DocNumber lookup, then create, in the connected company.
	let qbId: string | null =
		invoice.qb_credit_memo_id && invoice.account_id === accountId ? invoice.qb_credit_memo_id : null;
	if (!qbId) {
		const found = await qbQueryAll<{ Id: string }>(
			orgId,
			"CreditMemo",
			`DocNumber = '${invoice.invoice_number}'`,
		);
		if (found.length > 0) qbId = found[0].Id;
	}

	const send = async (item: TaxableItemRef) => {
		const { lines, shipAddr, clientExempt } = buildInvoicePayload(invoice, item);
		const fingerprint = qbPushFingerprint(lines, shipAddr, clientExempt);
		// Under AST the override is the whole detail: a TxnTaxCodeRef would pull the document
		// back under QuickBooks' own rate.
		const txnTaxDetail = automatedSalesTax
			? { TotalTax: tax }
			: await nonAstTaxDetail(invoice, orgId, lines, tax);
		const body = {
			CustomerRef: { value: customerId },
			Line: buildCreditMemoLines(lines),
			...(shipAddr && { ShipAddr: shipAddr }),
			...(txnTaxDetail && { TxnTaxDetail: txnTaxDetail }),
		};

		if (qbId) {
			const existing = (await qbFetch(orgId, "GET", `/creditmemo/${qbId}`)) as any;
			const saved: any = await qbFetch(orgId, "POST", "/creditmemo", {
				sparse: true,
				Id: qbId,
				SyncToken: existing.CreditMemo.SyncToken,
				...body,
			});
			return { saved, fingerprint };
		}
		const saved: any = await qbFetch(orgId, "POST", "/creditmemo", {
			...body,
			DocNumber: invoice.invoice_number,
			...(invoice.adjusts_invoice && {
				PrivateNote: `Adjusts ${invoice.adjusts_invoice.invoice_number}`,
			}),
		});
		qbId = saved.CreditMemo.Id as string;
		return { saved, fingerprint };
	};
	const { saved, fingerprint } = await withTaxableItemRecovery(
		orgId,
		accountId,
		taxableItem,
		(item) => linesUseItem(buildInvoicePayload(invoice, item).lines, item.id),
		send,
	);

	const qbTotalTax = saved?.CreditMemo?.TxnTaxDetail?.TotalTax;
	const readback = classifyTaxReadback(tax, qbTotalTax);
	await getScopedDb(orgId).invoice.update({
		where: { id: invoice.id },
		data: {
			qb_credit_memo_id: qbId,
			account_id: accountId,
			qb_sync_status: readback.mismatch ? "tax_mismatch" : "synced",
			qb_tax_amount: readback.qbTaxAmount,
		},
	});
	if (readback.mismatch) logTaxMismatch(invoice.id, orgId, tax, readback.qbTaxAmount);
	if (!invoice.qb_credit_applied_payment_id) {
		// A QuickBooks-side partial application leaves less credit than our total.
		const creditRemaining = Number(
			saved?.CreditMemo?.RemainingCredit ?? saved?.CreditMemo?.TotalAmt ?? Infinity,
		);
		await applyCreditToOriginal(
			invoice,
			qbId as string,
			Math.abs(Number(invoice.total)),
			creditRemaining,
			orgId,
			accountId,
		);
	}
	return {
		qbTaxCents: qbTotalTaxCents(qbTotalTax),
		fingerprint,
		automatedSalesTax,
		mismatch: readback.mismatch,
	};
}
