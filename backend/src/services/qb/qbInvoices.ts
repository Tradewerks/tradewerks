import { isModuleOn } from "../entitlementService.js";
import { getScopedDb } from "../../lib/context.js";
import { db } from "../../db.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { qbQueryAll } from "./qbQuery.js";
import { qbFetch, getOrgRealmId, isQBConnected } from "../quickbooksService.js";
import { log } from "../appLogger.js";
import { findOrCreateQBCustomer } from "./qbCustomers.js";
import { ErrorCodes, httpError } from "../../types/responses.js";
import { getQBTaxPrefs } from "./qbTax.js";
import {
	ensureTaxableItem,
	linesUseItem,
	withTaxableItemRecovery,
	type TaxableItemRef,
} from "./qbTaxableItem.js";
import { isCreditAdjustment, pushCreditMemo } from "./qbCreditMemos.js";
import {
	buildInvoicePayload,
	classifyTaxReadback,
	invoiceForQBInclude,
	pickTxnTaxCode,
	qbPushFingerprint,
	qbTotalTaxCents,
} from "./qbInvoiceTax.js";

export { invoiceForQBInclude };

interface QBImportInvoice {
	Id: string;
	DocNumber?: string;
	TxnDate?: string;
	DueDate?: string;
	TotalAmt?: number | string;
	CustomerRef?: { value?: string; name?: string };
	CustomerMemo?: { value?: string };
	PrivateNote?: string;
	TxnTaxDetail?: { TotalTax?: number | string };
	Line?: Array<{
			Amount?: number | string;
			DetailType?: string;
			Description?: string;
			LineNum?: number;
			SalesItemLineDetail?: {
					Qty?: number | string;
					UnitPrice?: number | string;
					ItemRef?: { value?: string; name?: string };
					TaxCodeRef?: { value?: string };
			};
	}>;
}

export interface QBImportableInvoice {
	Id: string;
	DocNumber: string | null;
	TxnDate: string | null;
	DueDate: string | null;
	TotalAmt: number;
	customerId: string | null;
	customerName: string | null;
	lineCount: number;
	alreadyImported: boolean;
}

export interface QBInvoicePrefill {
	qbInvoiceId: string;
	docNumber: string | null;
	txnDate: string | null;
	dueDate: string | null;
	memo: string | null;
	customerId: string | null;
	customerName: string | null;
	clientId: string | null;
	alreadyImported: boolean;
	lineItems: Array<{
		name: string;
		description: string | null;
		quantity: number;
		unit_price: number;
		inventory_item_id: string | null;
	}>;
}

const inFlightPushes = new Map<string, Promise<void>>();

const createOneImportedInvoice = async (
	orgId: string,
	clientId: string,
	qbInvoice: QBImportInvoice,
	itemMap: Map<string, string>,
) => {
	const base = `QB-${qbInvoice.DocNumber ?? qbInvoice.Id}`;
	const lines = (qbInvoice.Line ?? []).filter(
		(l) => l.DetailType === "SalesItemLineDetail",
	);
	const subtotal = lines.reduce((s, l) => s + Number(l.Amount ?? 0), 0);
	const total = Number(qbInvoice.TotalAmt ?? subtotal);
	const accountId = await getOrgRealmId(orgId);
	for (let attempt = 0; attempt < 5; attempt++) {
		// First try the bare QB number; on collision append -2, -3, …
		const invoice_number = attempt === 0 ? base : `${base}-${attempt + 1}`;
		try {
			await db.$transaction(async (tx) => {
				const invoice = await tx.invoice.create({
					data: {
						organization_id: orgId,
						client_id: clientId,
						invoice_number,
						status: "Draft",
						qb_invoice_id: qbInvoice.Id,
						qb_sync_status: "synced",
						issue_date: qbInvoice.TxnDate ? new Date(qbInvoice.TxnDate) : new Date(),
						due_date: qbInvoice.DueDate ? new Date(qbInvoice.DueDate) : null,
						subtotal,
						tax_rate: 0, // legacy field — actual tax is per-line
						tax_amount: Number(qbInvoice.TxnTaxDetail?.TotalTax ?? 0),
						discount_type: null,
						discount_value: null,
						discount_amount: 0,
						total,
						amount_paid: 0,
						balance_due: total,
						account_id: accountId,
					},
				});

				if (lines.length > 0) {
					await tx.invoice_line_item.createMany({
						data: lines.map((l, idx) => {
							const qty = Number(l.SalesItemLineDetail?.Qty ?? 1);
							const amount = Number(l.Amount ?? 0);
							const refId = l.SalesItemLineDetail?.ItemRef?.value;
							return {
								invoice_id: invoice.id,
								name:
									l.Description ??
									l.SalesItemLineDetail?.ItemRef?.name ??
									"Imported item",
								description: l.Description ?? null,
								quantity: qty,
								unit_price: Number(
									l.SalesItemLineDetail?.UnitPrice ?? (qty ? amount / qty : amount),
								),
								total: amount,
								taxable: l.SalesItemLineDetail?.TaxCodeRef?.value !== "NON",
								tax_group_id: null,
								inventory_item_id: (refId && itemMap.get(refId)) ?? null,
								item_type: null,
								sort_order: l.LineNum ?? idx,
							};
						}),
					});
				}
			});
			return; 
		} catch (e) {
			// Retry only on invoice_number unique collision
			if (
				attempt < 4 &&
				e instanceof Prisma.PrismaClientKnownRequestError &&
				e.code === "P2002" &&
				(e.meta?.target as string[] | undefined)?.includes("invoice_number")
			) {
				continue;
			}
			throw e;
		}
	}
};

export const getImportableQBInvoices = async (
	orgId: string,
	clientId?: string,
): Promise<QBImportableInvoice[]> => {
	const sdb = getScopedDb(orgId);
	const accountId = await getOrgRealmId(orgId);
	// Map our EpicIT client id to its linked QB customer (numeric CustomerRef — a raw UUID 400s); 
	// if unlinked, fall back to the org-wide invoice list.
	let where: string | undefined;
	if (clientId) {
		const mapping = await sdb.client_external_mapping.findFirst({
			where: {
				provider: "quickbooks",
				client_id: clientId,
				client: { organization_id: orgId },
				account_id: accountId
			},
			select: { external_id: true },
		});
		if (mapping) where = `CustomerRef = '${mapping.external_id}'`;
	}

	const invoices = await qbQueryAll<QBImportInvoice>(orgId, "Invoice", where);

	const qbIds = invoices.map((i) => i.Id);
	const existing = await sdb.invoice.findMany({
		where: { qb_invoice_id: { in: qbIds }, account_id: accountId },
		select: { qb_invoice_id: true },
	});
	const seen = new Set(existing.map((i) => i.qb_invoice_id));

	return invoices.map((i) => ({
		Id: i.Id,
		DocNumber: i.DocNumber ?? null,
		TxnDate: i.TxnDate ?? null,
		DueDate: i.DueDate ?? null,
		TotalAmt: Number(i.TotalAmt ?? 0),
		customerId: i.CustomerRef?.value ?? null,
		customerName: i.CustomerRef?.name ?? null,
		lineCount: (i.Line ?? []).filter((l) => l.DetailType === "SalesItemLineDetail").length,
		alreadyImported: seen.has(i.Id),
	}));
};

// Full detail of a single QB invoice, mapped to the create-invoice form shape.
// Used to auto-fill the form when a user picks an invoice in the import dropdown.
export const getQBInvoicePrefill = async (
	orgId: string,
	qbInvoiceId: string,
): Promise<QBInvoicePrefill> => {
	const sdb = getScopedDb(orgId);
	const accountId = await getOrgRealmId(orgId);
	const invoices = await qbQueryAll<QBImportInvoice>(orgId, "Invoice", `Id = '${qbInvoiceId}'`);
	const qb = invoices[0];
	if (!qb) throw httpError(404, "NOT_FOUND", "QuickBooks invoice not found");

	const lines = (qb.Line ?? []).filter((l) => l.DetailType === "SalesItemLineDetail");

	// Resolve QB customer → local client (only if this customer is linked)
	let clientId: string | null = null;
	if (qb.CustomerRef?.value) {
		const mapping = await sdb.client_external_mapping.findFirst({
			where: {
				provider: "quickbooks",
				external_id: qb.CustomerRef.value,
				account_id: accountId,
				client: { organization_id: orgId },
			},
			select: { client_id: true },
		});
		clientId = mapping?.client_id ?? null;
	}

	// Resolve QB items → local inventory items (only those that are linked)
	const itemRefIds = [...new Set(
		lines.map((l) => l.SalesItemLineDetail?.ItemRef?.value).filter(Boolean) as string[],
	)];
	const itemMaps = itemRefIds.length
		? await sdb.item_external_mapping.findMany({
				where: {
					provider: "quickbooks",
					external_id: { in: itemRefIds },
					account_id: accountId,
					inventory_item: { organization_id: orgId },
				},
				select: { external_id: true, inventory_item_id: true },
			})
		: [];
	const itemMap = new Map(itemMaps.map((m) => [m.external_id, m.inventory_item_id]));

	const alreadyImported = !!(await sdb.invoice.findFirst({
		where: { qb_invoice_id: qb.Id, account_id: accountId },
		select: { id: true },
	}));

	return {
		qbInvoiceId: qb.Id,
		docNumber: qb.DocNumber ?? null,
		txnDate: qb.TxnDate ?? null,
		dueDate: qb.DueDate ?? null,
		memo: qb.CustomerMemo?.value ?? qb.PrivateNote ?? null,
		customerId: qb.CustomerRef?.value ?? null,
		customerName: qb.CustomerRef?.name ?? null,
		clientId,
		alreadyImported,
		lineItems: lines.map((l) => {
			const refId = l.SalesItemLineDetail?.ItemRef?.value;
			return {
				name:
					l.Description ??
					l.SalesItemLineDetail?.ItemRef?.name ??
					"Imported item",
				description: l.Description ?? null,
				quantity: Number(l.SalesItemLineDetail?.Qty ?? 1),
				unit_price: Number(l.SalesItemLineDetail?.UnitPrice ?? l.Amount ?? 0),
				inventory_item_id: refId ? itemMap.get(refId) ?? null : null,
			};
		}),
	};
};

export const importQBInvoices = async (orgId: string, qbInvoiceIds: string[]) => {
	let imported = 0;
	let skipped = 0;
	const errors: string[] = [];
	if (qbInvoiceIds.length === 0) return { imported, skipped, errors };
	const accountId = await getOrgRealmId(orgId);
	const sdb = getScopedDb(orgId);
	const idList = qbInvoiceIds.map((id) => `'${id}'`).join(",");
	const invoices = await qbQueryAll<QBImportInvoice>(orgId, "Invoice", `Id IN (${idList})`);

	const existing = await sdb.invoice.findMany({
		where: { qb_invoice_id: { in: qbInvoiceIds }, account_id: accountId },
		select: { qb_invoice_id: true },
	});
	const seen = new Set(existing.map((i) => i.qb_invoice_id));

	const custRefs = [...new Set(invoices.map((i) => i.CustomerRef?.value).filter(Boolean) as string[])];
	const clientMaps = await sdb.client_external_mapping.findMany({
		where: { provider: "quickbooks", external_id: { in: custRefs }, account_id: accountId, client: { organization_id: orgId } },
		select: { external_id: true, client_id: true },
	});
	const clientMap = new Map(clientMaps.map((m) => [m.external_id, m.client_id]));

	const itemRefIds = [...new Set(
		invoices
			.flatMap((i) => i.Line ?? [])
			.filter((l) => l.DetailType === "SalesItemLineDetail")
			.map((l) => l.SalesItemLineDetail?.ItemRef?.value)
			.filter(Boolean) as string[],
	)];
	const itemMaps = await sdb.item_external_mapping.findMany({
		where: { 
			provider: "quickbooks", 
			external_id: { in: itemRefIds }, 
			inventory_item: { organization_id: orgId },
			account_id: accountId,
		},
		select: { external_id: true, inventory_item_id: true },
	});
	const itemMap = new Map(itemMaps.map((m) => [m.external_id, m.inventory_item_id]));

	for (const qb of invoices) {
		if (seen.has(qb.Id)) {
			skipped++;
			continue;
		}
		const clientId = qb.CustomerRef?.value ? clientMap.get(qb.CustomerRef.value) : undefined;
		if (!clientId) {
			errors.push(`Invoice ${qb.DocNumber ?? qb.Id}: customer not mapped to a client`);
			continue;
		}
		try {
			await createOneImportedInvoice(orgId, clientId, qb, itemMap);
			imported++;
		} catch (error) {
			errors.push(`Invoice ${qb.DocNumber ?? qb.Id}: ${error}`);
		}
	}

	return { imported, skipped, errors };
};

/** What QuickBooks made of a push. qbTaxCents is null when its TotalTax could not be read. */
export interface QBInvoicePushResult {
	qbTaxCents: number | null;
	fingerprint: string;
	automatedSalesTax: boolean;
	mismatch: boolean;
}

export interface PushInvoiceOptions {
	/** The finalize confirm, which pushes the draft to read QuickBooks' tax before it locks. */
	finalizing?: boolean;
}

export async function pushInvoice(
	invoiceId: string,
	orgId: string,
	options: PushInvoiceOptions = {},
): Promise<QBInvoicePushResult | undefined> {
	if (!(await isModuleOn(orgId, "quickbooks"))) return;
	const prior = inFlightPushes.get(invoiceId) ?? Promise.resolve();
	const run = prior.then(() => doPushInvoice(invoiceId, orgId, options));
	// The caller handles run's rejection; a promise derived from it and parked
	// in the map would reject with nobody listening, and with no
	// unhandledRejection handler that takes the process down on any failed
	// push. So the map holds a tail that cannot reject, cleared by identity.
	const tail: Promise<void> = run
		.then(
			() => {},
			() => {},
		)
		.finally(() => {
			if (inFlightPushes.get(invoiceId) === tail) {
				inFlightPushes.delete(invoiceId);
			}
		});
	inFlightPushes.set(invoiceId, tail);
	return run;
};

export type InvoiceForQB = Prisma.invoiceGetPayload<{
	include: ReturnType<typeof invoiceForQBInclude>;
}>;

export async function resolveQBCustomerId(
	invoice: InvoiceForQB,
	orgId: string,
	accountId: string,
): Promise<string> {
	const existingQBId = invoice.client.client_external_mapping?.[0]?.external_id ?? null;
	const customerId = existingQBId ?? (await findOrCreateQBCustomer(orgId, invoice.client.name));

	// Cache the QB customer ID so this client is excluded from the import dropdown
	if (!existingQBId) {
		await getScopedDb(orgId).client_external_mapping.upsert({
			where: { provider_account_id_external_id: { provider: "quickbooks", account_id: accountId, external_id: customerId } },
			create: { client_id: invoice.client_id, provider: "quickbooks", external_id: customerId, account_id: accountId },
			update: {},
		}).catch(() => {});
	}
	return customerId;
}

/** Non-AST only. Rewrites `lines` to NON when nothing is taxed. */
export async function nonAstTaxDetail(
	invoice: InvoiceForQB,
	orgId: string,
	lines: ReturnType<typeof buildInvoicePayload>["lines"],
	totalTax: number = Number(invoice.tax_amount),
): Promise<{ TxnTaxCodeRef: { value: string }; TotalTax: number } | undefined> {
	const sdb = getScopedDb(orgId);
	// Prisma types the column as JsonValue; only groups is read here.
	const snapshot = invoice.tax_snapshot as unknown as {
		groups?: { id: string; tax_amount_cents: number }[];
	} | null;
	let txnTaxDetail: { TxnTaxCodeRef: { value: string }; TotalTax: number } | undefined;
	const org = await db.organization.findUnique({
		where: { id: orgId },
		select: { qb_passthrough_tax_code_id: true },
	});
	const passthrough = org?.qb_passthrough_tax_code_id ?? null;
	// Decided from the groups that carried tax on this invoice, not the org's current mode, so a
	// re-push after a mode switch keeps the code the invoice was charged under. A
	// resolved rate-set id or "legacy" matches no tax_group row and falls to the pass-through.
	// Pre-snapshot invoices fall back to the taxable lines' own groups.
	const taxedGroupIds = snapshot?.groups
		? snapshot.groups.filter((g) => g.tax_amount_cents !== 0).map((g) => g.id)
		: [
				...new Set(
					invoice.line_items
						.filter((l) => l.taxable !== false && l.tax_group_id)
						.map((l) => l.tax_group_id as string),
				),
			];
	const linked = taxedGroupIds.length
		? await sdb.tax_group.findMany({
				where: { id: { in: taxedGroupIds } },
				select: { id: true, qb_tax_code_id: true },
			})
		: [];
	const codeById = new Map(linked.map((g) => [g.id, g.qb_tax_code_id]));
	const code = pickTxnTaxCode(
		taxedGroupIds.map((id) => codeById.get(id) ?? null),
		passthrough,
	);
	if (code) {
		txnTaxDetail = { TxnTaxCodeRef: { value: code }, TotalTax: totalTax };
	} else if (totalTax === 0) {
		// Nothing taxed, so no code to override with; NON lines stop QB inventing tax of its own.
		for (const l of lines) {
			if (l.SalesItemLineDetail) l.SalesItemLineDetail.TaxCodeRef = { value: "NON" };
		}
	} else {
		log.warn(
			{ invoiceId: invoice.id, orgId },
			"Pushing invoice with no QuickBooks tax code; QuickBooks will compute its own tax",
		);
	}
	return txnTaxDetail;
}

async function doPushInvoice(
	invoiceId: string,
	orgId: string,
	options: PushInvoiceOptions,
): Promise<QBInvoicePushResult | undefined> {
	const sdb = getScopedDb(orgId);
	const accountId = await getOrgRealmId(orgId);
	const invoice = await sdb.invoice.findFirst({
		where: { id: invoiceId },
		include: invoiceForQBInclude(accountId),
	});
	if (!invoice) throw new Error("Invoice not found");
	// Pushed as a document, a Void invoice would create or reopen a live,
	// collectible one in QuickBooks. Voids reach QuickBooks only through
	// mirrorInvoiceVoidToQuickBooks.
	if (invoice.status === "Void") {
		throw httpError(422, ErrorCodes.VALIDATION_ERROR, "A void invoice can't be pushed to QuickBooks.");
	}
	// QuickBooks has no draft state: a pushed draft reads there as money owed. It goes over when
	// it leaves Draft (the status write pushes, and the AST confirm pushes just before the lock).
	if (invoice.status === "Draft" && !options.finalizing) return undefined;

	if (isCreditAdjustment(invoice)) return pushCreditMemo(invoice, orgId, accountId);

	const primaryEmail = invoice.client.contacts?.[0]?.contact?.email ?? null;
	const customerId = await resolveQBCustomerId(invoice, orgId, accountId);

	// One tax authority per invoice, decided at push time — AST can be toggled in QB at any
	// moment, so a cached value is never trusted here.
	const { automatedSalesTax } = await getQBTaxPrefs(orgId);
	const taxableItem = automatedSalesTax ? await ensureTaxableItem(orgId, accountId) : null;

	// Only reuse the stored QB id if it belongs to the currently-connected company.
	// A stale-company id is ignored → DocNumber lookup / create-new in the current company.
	let qbInvoiceId: string | null =
		(invoice.qb_invoice_id && invoice.account_id === accountId) ? invoice.qb_invoice_id : null;
	if (!qbInvoiceId) {
		const existingByDoc = await qbQueryAll<{ Id: string }>(
				orgId,
				"Invoice",
				`DocNumber = '${invoice.invoice_number}'`,
		);
		if (existingByDoc.length > 0) qbInvoiceId = existingByDoc[0].Id;
	}

	const send = async (item: TaxableItemRef) => {
		const { lines, shipAddr, clientExempt } = buildInvoicePayload(invoice, item);
		// Before the zero-tax branch below rewrites lines to NON: the hash must match what a
		// recompute rebuilds from the database.
		const fingerprint = qbPushFingerprint(lines, shipAddr, clientExempt);

		const txnTaxDetail = automatedSalesTax
			? undefined
			: await nonAstTaxDetail(invoice, orgId, lines);
		const taxFields = {
			// Our engine taxes the discounted amount; QuickBooks defaults to taxing before it.
			ApplyTaxAfterDiscount: true,
			...(shipAddr && { ShipAddr: shipAddr }),
			...(txnTaxDetail && { TxnTaxDetail: txnTaxDetail }),
		};

		if (qbInvoiceId) {
			const existing = (await qbFetch(orgId, "GET", `/invoice/${qbInvoiceId}`)) as any;
			// A sparse update keeps the stored TxnTaxCodeRef + TotalTax override, and QuickBooks
			// rejects that against changed lines (400, code 6000). Restate it under its own code:
			// zero when nothing is taxed, otherwise without TotalTax so QuickBooks recalculates
			// (the read-back flags the difference, as on create).
			const heldCode = existing.Invoice?.TxnTaxDetail?.TxnTaxCodeRef?.value;
			const clearOverride =
				!automatedSalesTax && !txnTaxDetail && heldCode
					? {
							TxnTaxDetail: {
								TxnTaxCodeRef: { value: heldCode },
								...(Number(invoice.tax_amount) === 0 && { TotalTax: 0 }),
							},
						}
					: {};
			const saved = (await qbFetch(orgId, "POST", "/invoice", {
				sparse: true,
				Id: qbInvoiceId,
				SyncToken: existing.Invoice.SyncToken,
				CustomerRef: { value: customerId },
				Line: lines,
				...taxFields,
				...clearOverride,
				...(invoice.due_date && { DueDate: invoice.due_date.toISOString().split("T")[0] }),
				...(invoice.memo && { CustomerMemo: { value: invoice.memo } }),
				...(primaryEmail && { BillEmail: { Address: primaryEmail } }),
			})) as any;
			return { saved, fingerprint };
		}
		const saved = (await qbFetch(orgId, "POST", "/invoice", {
			CustomerRef: { value: customerId },
			Line: lines,
			...taxFields,
			DocNumber: invoice.invoice_number,
			...(invoice.due_date && { DueDate: invoice.due_date.toISOString().split("T")[0] }),
			...(invoice.memo && { CustomerMemo: { value: invoice.memo } }),
			...(primaryEmail && { BillEmail: { Address: primaryEmail } }),
		})) as any;
		qbInvoiceId = saved.Invoice.Id as string;
		return { saved, fingerprint };
	};
	const { saved, fingerprint } = await withTaxableItemRecovery(
		orgId,
		accountId,
		taxableItem,
		(item) => linesUseItem(buildInvoicePayload(invoice, item).lines, item.id),
		send,
	);

	const qbTotalTax = saved?.Invoice?.TxnTaxDetail?.TotalTax;
	const readback = classifyTaxReadback(Number(invoice.tax_amount), qbTotalTax);
	await sdb.invoice.update({
		where: { id: invoiceId },
		// persist the id + the company it belongs to (in case we resolved it via the Doc)
		data: {
			qb_invoice_id: qbInvoiceId,
			account_id: accountId,
			qb_sync_status: readback.mismatch ? "tax_mismatch" : "synced",
			qb_tax_amount: readback.qbTaxAmount,
		},
	});
	if (readback.mismatch) logTaxMismatch(invoiceId, orgId, invoice.tax_amount, readback.qbTaxAmount);
	return {
		// Unlike the readback, a missing TotalTax is not 0 here: an adopter would bill $0 tax.
		qbTaxCents: qbTotalTaxCents(qbTotalTax),
		fingerprint,
		automatedSalesTax,
		mismatch: readback.mismatch,
	};
}

export function logTaxMismatch(invoiceId: string, orgId: string, ours: unknown, qb: number) {
	log.warn({ invoiceId, orgId, ourTax: Number(ours), qbTax: qb }, "QuickBooks tax differs from invoice tax");
}

export async function voidQBInvoice(orgId: string, qbInvoiceId: string): Promise<void> {
	const existing = (await qbFetch(orgId, "GET", `/invoice/${qbInvoiceId}`)) as any;
	const syncToken = existing.Invoice.SyncToken;
	await qbFetch(orgId, "POST", `/invoice?operation=void`, {
		SyncToken: syncToken,
		Id: qbInvoiceId,
	});

	// Reflect the void locally. updateMany is org-scoped via getScopedDb.
	const sdb = getScopedDb(orgId);
	const accountId = await getOrgRealmId(orgId);
	await sdb.invoice.updateMany({
		where: { qb_invoice_id: qbInvoiceId, account_id: accountId },
		data: { qb_sync_status: "synced" },
	});
}

// QuickBooks cannot void a CreditMemo, so it is deleted. The applying Payment goes
// first: deleting it is what restores the original invoice's balance.
async function deleteQBCreditMemo(
	orgId: string,
	invoiceId: string,
	creditMemo: { id: string; appliedPaymentId: string | null },
): Promise<void> {
	const sdb = getScopedDb(orgId);
	if (creditMemo.appliedPaymentId) {
		const payment = (await qbFetch(orgId, "GET", `/payment/${creditMemo.appliedPaymentId}`)) as any;
		await qbFetch(orgId, "POST", "/payment?operation=delete", {
			Id: creditMemo.appliedPaymentId,
			SyncToken: payment.Payment.SyncToken,
		});
		await sdb.invoice.updateMany({
			where: { id: invoiceId },
			data: { qb_credit_applied_payment_id: null },
		});
	}
	const existing = (await qbFetch(orgId, "GET", `/creditmemo/${creditMemo.id}`)) as any;
	await qbFetch(orgId, "POST", "/creditmemo?operation=delete", {
		Id: creditMemo.id,
		SyncToken: existing.CreditMemo.SyncToken,
	});
	await sdb.invoice.updateMany({
		where: { id: invoiceId },
		data: { qb_credit_applied_payment_id: null, qb_credit_memo_id: null, qb_sync_status: "synced" },
	});
}

/**
 * The QuickBooks side of voiding an invoice, shared by every void door: the
 * kebab's Void, a dispute Repeal, and the original a Revise & Resend replaces
 * Called after the local void commits, and never rejects. A failure is
 * logged and marked rather than swallowed, because a silent one leaves
 * QuickBooks holding a live, collectible invoice with nothing on our side
 * saying so.
 */
export async function mirrorInvoiceVoidToQuickBooks(
	orgId: string,
	invoiceId: string,
	qbInvoiceId: string | null | undefined,
	qbCreditMemo?: { id: string; appliedPaymentId: string | null },
): Promise<void> {
	// Never synced, so there is nothing in QuickBooks to void.
	if (!qbInvoiceId && !qbCreditMemo) return;
	if (!(await isModuleOn(orgId, "quickbooks"))) return;
	try {
		if (!(await isQBConnected(orgId))) return;
		if (qbCreditMemo) await deleteQBCreditMemo(orgId, invoiceId, qbCreditMemo);
		else await voidQBInvoice(orgId, qbInvoiceId as string);
	} catch (err) {
		log.error({ err, invoiceId, orgId }, "QuickBooks void failed");
		await markQbSyncFailed(invoiceId, orgId);
	}
}

/** Never rejects. */
export async function markQbSyncFailed(invoiceId: string, organizationId: string): Promise<void> {
	await getScopedDb(organizationId)
		.invoice.updateMany({ where: { id: invoiceId }, data: { qb_sync_status: "failed" } })
		.catch((markErr: unknown) =>
			log.error(
				{ err: markErr, invoiceId, organizationId },
				"Could not mark the invoice's QuickBooks sync as failed",
			),
		);
}

/** Fire-and-forget: a QuickBooks failure must never fail the local write that triggered it. */
export function pushInvoiceDetached(invoiceId: string, organizationId: string): void {
	isQBConnected(organizationId)
		.then((connected) => (connected ? pushInvoice(invoiceId, organizationId) : null))
		.catch((err: unknown) => {
			log.error({ err, invoiceId, organizationId }, "QuickBooks invoice push failed");
			return markQbSyncFailed(invoiceId, organizationId);
		});
}

export async function sendInvoiceEmail(invoiceId: string, orgId: string, sendTo: string): Promise<void>{
	const invoice = await db.invoice.findFirst({
		where: { id: invoiceId, organization_id: orgId },
		select: { status: true, qb_invoice_id: true, qb_sync_status: true },
	});
	if (!invoice) throw new Error("Invoice not found");
	// Not a finalize: a draft would skip the tax gates on Issue/Send and reach the customer unlocked.
	if (invoice.status === "Draft") {
		throw httpError(
			422,
			ErrorCodes.VALIDATION_ERROR,
			"Create or send this invoice before sending it from QuickBooks.",
		);
	}
	if (invoice.qb_sync_status === "tax_mismatch") {
		throw httpError(
			422,
			ErrorCodes.VALIDATION_ERROR,
			"QuickBooks calculated different tax for this invoice; resolve the difference before sending it from QuickBooks.",
		);
	}
	if (!invoice.qb_invoice_id){
		await pushInvoice(invoiceId, orgId);
		const refresh = await db.invoice.findFirst({
			where: { id: invoiceId, organization_id: orgId },
			select: { qb_invoice_id: true },
		});
		if (!refresh?.qb_invoice_id) throw new Error("QB sync failed");
		invoice.qb_invoice_id = refresh.qb_invoice_id;
	}

	// Set BillEmail and EmailStatus: "NeedToSend" in one sparse update.
	// QB processes this as a send request and sets EmailStatus to "EmailSent".
	// (The /invoice/{id}/send endpoint has a known NullPointerException bug in sandbox.)
	const existing = (await qbFetch(orgId, "GET", `/invoice/${invoice.qb_invoice_id}`)) as any;
	await qbFetch(orgId, "POST", "/invoice", {
		sparse: true,
		Id: invoice.qb_invoice_id,
		SyncToken: existing.Invoice.SyncToken,
		BillEmail: { Address: sendTo },
		EmailStatus: "NeedToSend",
	});
};