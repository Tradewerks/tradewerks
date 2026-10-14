import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import React from "react";
import type { JSXElementConstructor, ReactElement } from "react";
import { QuotePdfTemplate } from "./quotePdfTemplate.js";
import { InvoicePdfTemplate } from "./invoicePdfTemplate.js";
import { getQuoteById } from "../../controllers/quotesController.js";
import { getInvoiceById } from "../../controllers/invoicesController.js";
import { db } from "../../db.js";
import { getBuffer } from "../../services/wasabiService.js";
import type { TaxSnapshot } from "../../services/taxEngine.js";
import { log } from "../../services/appLogger.js";
import { getPurchase } from "../../controllers/purchasesController.js";
import { PurchaseOrderPdfTemplate, type PurchaseOrderPdfProps } from "./PurchaseOrderPdfTemplate.js";

type DocElement = ReactElement<DocumentProps, string | JSXElementConstructor<unknown>>;

const fallbackOrg = { name: "—", logo_url: null, phone: null, address: null, email: null, website: null };

async function fetchOrg(organizationId: string | null | undefined) {
	if (!organizationId) return fallbackOrg;
	const org = await db.organization.findUnique({
		where: { id: organizationId },
		select: { name: true, logo_url: true, phone: true, address: true, email: true, website: true },
	});
	if (!org) return fallbackOrg;

	let logo_url: string | null = null;
	if (org.logo_url) {
		try {
			const { buffer, contentType } = await getBuffer(org.logo_url);
			logo_url = `data:${contentType};base64,${buffer.toString("base64")}`;
		} catch (err) {
			log.warn({ err, organizationId, logo_url: org.logo_url }, "PDF: failed to fetch org logo — rendering without it");
			logo_url = null;
		}
	}
	return { ...org, logo_url };
}

export async function generateQuotePdf(quoteId: string, organizationId: string): Promise<Buffer> {
	const [quote, org] = await Promise.all([
		getQuoteById(quoteId, organizationId),
		fetchOrg(organizationId),
	]);
	if (!quote) throw Object.assign(new Error("Quote not found"), { status: 404 });

	const element = React.createElement(
		QuotePdfTemplate,
		{
			quote: {
				...quote,
				tax_snapshot: quote.tax_snapshot as unknown as TaxSnapshot | null,
			},
			org,
		},
	) as unknown as DocElement;
	return renderToBuffer(element) as Promise<Buffer>;
}

export async function generateInvoicePdf(invoiceId: string, organizationId: string): Promise<Buffer> {
	const [invoice, org] = await Promise.all([
		getInvoiceById(invoiceId, organizationId),
		fetchOrg(organizationId),
	]);
	if (!invoice) throw Object.assign(new Error("Invoice not found"), { status: 404 });

	const element = React.createElement(
		InvoicePdfTemplate,
		{
			invoice: {
				...invoice,
				tax_snapshot: invoice.tax_snapshot as unknown as TaxSnapshot | null,
			},
			org,
		},
	) as unknown as DocElement;
	return renderToBuffer(element) as Promise<Buffer>;
}

export async function generatePurchaseOrderPdf(purchaseId: string, organizationId: string): Promise<Buffer> {
	const [result, org] = await Promise.all([
		getPurchase(organizationId, purchaseId),
		fetchOrg(organizationId),
	]);
	// getPurchase returns a Result wrapper ({ err? } & Partial<{ purchase, events }>),
	// not the purchase itself.
	if (result.err || !result.purchase) throw Object.assign(new Error("Purchase not found"), { status: 404 });

	const element = React.createElement(
		PurchaseOrderPdfTemplate,
		{
			purchase: result.purchase as PurchaseOrderPdfProps,
			org,
		}
	) as unknown as DocElement;
	return renderToBuffer(element) as Promise<Buffer>;
}
