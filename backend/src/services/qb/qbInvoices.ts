import { isModuleOn } from "../entitlementService.js";
import { getScopedDb } from "../../lib/context.js";
import { db } from "../../db.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { qbQueryAll } from "./qbQuery.js";
import { qbFetch, getOrgRealmId, isQBConnected } from "../quickbooksService.js";
import { log } from "../appLogger.js";
import { findOrCreateQBCustomer } from "./qbCustomers.js";
import { findOrCreateQBItem } from "./qbItems.js";
import { getQBTaxPrefs } from "./qbTax.js";
import { ErrorCodes, httpError } from "../../types/responses.js";

// QB takes one tax code per invoice, and only non-AST companies honour it; AST
// computes its own tax (often $0), which left a tax-sized balance after QB
// payments. Anything else goes over as this item's line.
const SALES_TAX_ITEM = "Sales Tax";

// The shared QB tax code of every taxable line, when the company will apply it.
const mappedQBTaxCode = async (
	orgId: string,
	items: { taxable: boolean | null; tax_group: { qb_tax_code_id: string | null } | null }[],
): Promise<string | null> => {
	const codes = new Set(
		items.filter((i) => i.taxable !== false).map((i) => i.tax_group?.qb_tax_code_id ?? null),
	);
	const [code] = codes;
	if (codes.size !== 1 || !code) return null;
	return (await getQBTaxPrefs(orgId)).automatedSalesTax ? null : code;
};

// A QB rate that differs from ours would leave a balance again; surface it.
const warnOnTotalDrift = (
	res: { Invoice?: { TotalAmt?: number | string } } | undefined,
	invoice: { id: string; total: unknown },
	orgId: string,
) => {
	const qbTotal = Number(res?.Invoice?.TotalAmt);
	if (Number.isFinite(qbTotal) && Math.abs(qbTotal - Number(invoice.total)) > 0.005)
		log.warn({ invoiceId: invoice.id, orgId, qbTotal, total: Number(invoice.total) }, "QuickBooks invoice total differs");
};

type QBLine = NonNullable<QBImportInvoice["Line"]>[number];
const isSalesTaxLine = (l: QBLine) => l.SalesItemLineDetail?.ItemRef?.name === SALES_TAX_ITEM;
const itemLines = (lines: QBLine[] = []) =>
	lines.filter((l) => l.DetailType === "SalesItemLineDetail" && !isSalesTaxLine(l));
const salesTaxTotal = (lines: QBLine[] = []) =>
	lines.filter(isSalesTaxLine).reduce((s, l) => s + Number(l.Amount ?? 0), 0);

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
	const lines = itemLines(qbInvoice.Line);
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
						tax_amount: Number(qbInvoice.TxnTaxDetail?.TotalTax ?? 0) + salesTaxTotal(qbInvoice.Line),
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
		lineCount: itemLines(i.Line).length,
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

	const lines = itemLines(qb.Line);

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

export async function pushInvoice(invoiceId: string, orgId: string): Promise<void> {
	if (!(await isModuleOn(orgId, "quickbooks"))) return;
	const prior = inFlightPushes.get(invoiceId) ?? Promise.resolve();
	const run = prior.then(() => doPushInvoice(invoiceId, orgId));
	// The caller handles run's rejection; a promise derived from it and parked
	// in the map would reject with nobody listening, and with no
	// unhandledRejection handler that takes the process down on any failed
	// push. So the map holds a tail that cannot reject, cleared by identity.
	const tail: Promise<void> = run
		.catch(() => {})
		.finally(() => {
			if (inFlightPushes.get(invoiceId) === tail) {
				inFlightPushes.delete(invoiceId);
			}
		});
	inFlightPushes.set(invoiceId, tail);
	return run;
};

async function doPushInvoice(invoiceId: string, orgId: string): Promise<void> {
	const sdb = getScopedDb(orgId);
	const accountId = await getOrgRealmId(orgId);
	const invoice = await sdb.invoice.findFirst({
		where: { id: invoiceId },
		include: {
			line_items: {
				include: { 
					inventory_item: { 
						include: { 
							external_mappings: { 
								where: { 
									provider: "quickbooks",
									account_id: accountId
								}, 
								take: 1,
							} 
						} 
					},
					tax_group: {
						select: { qb_tax_code_id: true }
					}
				} 
			},
			client: {
				include: {
					contacts: {
						where: { is_primary: true },
						include: { contact: { select: { email: true } } },
						take: 1,
					},
					client_external_mapping: {
						where: { provider: "quickbooks", account_id: accountId },
						take: 1,
					},
				},
			},
		},
	});
	if (!invoice) throw new Error("Invoice not found");
	// Pushed as a document, a Void invoice would create or reopen a live,
	// collectible one in QuickBooks. Voids reach QuickBooks only through
	// mirrorInvoiceVoidToQuickBooks.
	if (invoice.status === "Void") {
		throw httpError(422, ErrorCodes.VALIDATION_ERROR, "A void invoice can't be pushed to QuickBooks.");
	}

	const primaryEmail = invoice.client.contacts?.[0]?.contact?.email ?? null;
	const existingQBId = invoice.client.client_external_mapping?.[0]?.external_id ?? null;
	const customerId = existingQBId ?? (await findOrCreateQBCustomer(orgId, invoice.client.name));

	// Cache the QB customer ID so this client is excluded from the import dropdown
	if (!existingQBId) {
		await sdb.client_external_mapping.upsert({
			where: { provider_account_id_external_id: { provider: "quickbooks", account_id: accountId, external_id: customerId } },
			create: { client_id: invoice.client_id, provider: "quickbooks", external_id: customerId, account_id: accountId },
			update: {},
		}).catch(() => {});
	}

	const qbTaxCode = await mappedQBTaxCode(orgId, invoice.line_items);
	const lines: any[] = invoice.line_items.map((item) => {
		const mapping = item.inventory_item?.external_mappings?.[0];
		return {
			Amount: Number(item.total),
			DetailType: "SalesItemLineDetail",
			Description: item.description ?? item.name,
			SalesItemLineDetail: {
				Qty: Number(item.quantity),
				UnitPrice: Number(item.unit_price),
				ItemRef: mapping ? { value: mapping.external_id } : { value: "1", name: "Services" },
				TaxCodeRef: { value: qbTaxCode && item.taxable !== false ? "TAX" : "NON" },
			},

		};
	});

	// Mirror an invoice-level discount as a QB fixed-amount discount line.
	if (Number(invoice.discount_amount) > 0) {
		lines.push({
			DetailType: "DiscountLineDetail",
			Amount: Number(invoice.discount_amount),
			DiscountLineDetail: { PercentBased: false },
		});
	}
	if (!qbTaxCode && Number(invoice.tax_amount) > 0) {
		lines.push({
			Amount: Number(invoice.tax_amount),
			DetailType: "SalesItemLineDetail",
			Description: SALES_TAX_ITEM,
			SalesItemLineDetail: {
				Qty: 1,
				UnitPrice: Number(invoice.tax_amount),
				ItemRef: { value: await findOrCreateQBItem(orgId, SALES_TAX_ITEM), name: SALES_TAX_ITEM },
				TaxCodeRef: { value: "NON" },
			},
		});
	}
	const taxDetail = qbTaxCode ? { TxnTaxDetail: { TxnTaxCodeRef: { value: qbTaxCode } } } : {};

	
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

	if (qbInvoiceId) {
		const existing = (await qbFetch(orgId, "GET", `/invoice/${qbInvoiceId}`)) as any;
		const updated = (await qbFetch(orgId, "POST", "/invoice", {
			sparse: true,
			Id: qbInvoiceId,
			SyncToken: existing.Invoice.SyncToken,
			CustomerRef: { value: customerId },
			Line: lines,
			...taxDetail,
			...(invoice.due_date && { DueDate: invoice.due_date.toISOString().split("T")[0] }),
			...(invoice.memo && { CustomerMemo: { value: invoice.memo } }),
			...(primaryEmail && { BillEmail: { Address: primaryEmail } }),
		})) as any;
		warnOnTotalDrift(updated, invoice, orgId);
		await sdb.invoice.update({
			where: { id: invoiceId },
			// persist the id + the company it belongs to (in case we resolved it via the Doc)
			data: { qb_invoice_id: qbInvoiceId, account_id: accountId, qb_sync_status: "synced" },
		});
	} else {
		const created = (await qbFetch(orgId, "POST", "/invoice", {
			CustomerRef: { value: customerId },
			Line: lines,
			...taxDetail,
			DocNumber: invoice.invoice_number,
			...(invoice.due_date && { DueDate: invoice.due_date.toISOString().split("T")[0] }),
			...(invoice.memo && { CustomerMemo: { value: invoice.memo } }),
			...(primaryEmail && { BillEmail: { Address: primaryEmail } }),
		})) as any;
		warnOnTotalDrift(created, invoice, orgId);

		await sdb.invoice.update({
			where: { id: invoiceId },
			data: {
				qb_invoice_id: created.Invoice.Id,
				account_id: accountId,
				qb_sync_status: "synced",
			},
		});
	}
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


/**
 * The QuickBooks side of voiding an invoice, shared by every void door: the
 * kebab's Void, a dispute Repeal, and the original a Revise & Resend replaces
 * (D3). Called after the local void commits, and never rejects. A failure is
 * logged and marked rather than swallowed, because a silent one leaves
 * QuickBooks holding a live, collectible invoice with nothing on our side
 * saying so.
 */
export async function mirrorInvoiceVoidToQuickBooks(
	orgId: string,
	invoiceId: string,
	qbInvoiceId: string | null | undefined,
): Promise<void> {
	// Never synced, so there is nothing in QuickBooks to void.
	if (!qbInvoiceId) return;
	if (!(await isModuleOn(orgId, "quickbooks"))) return;
	try {
		if (!(await isQBConnected(orgId))) return;
		await voidQBInvoice(orgId, qbInvoiceId);
	} catch (err) {
		log.error({ err, invoiceId, orgId }, "QuickBooks void failed");
		await getScopedDb(orgId)
			.invoice.updateMany({
				where: { id: invoiceId },
				data: { qb_sync_status: "failed" },
			})
			.catch((markErr: unknown) =>
				log.error(
					{ err: markErr, invoiceId, orgId },
					"Could not mark the invoice's QuickBooks sync as failed",
				),
			);
	}
}

export async function sendInvoiceEmail(invoiceId: string, orgId: string, sendTo: string): Promise<void>{
	const invoice = await db.invoice.findFirst({
		where: { id: invoiceId, organization_id: orgId },
		select: { qb_invoice_id: true },
	});
	if (!invoice) throw new Error("Invoice not found");
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