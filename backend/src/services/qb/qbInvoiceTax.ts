import { createHash } from "node:crypto";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { QBAddress } from "./qbPurchases.js";
import { invoiceServiceLocation, readCoords, splitUSAddress } from "../tax/address.js";
import { roundHalfUpSymmetric } from "../tax/rounding.js";
import { qbLineItemRef, type ItemRefLine, type TaxableItemRef } from "./qbTaxableItem.js";

/**
 * QuickBooks AST taxes the transaction at its shipping address, so the service address has to
 * arrive as structured fields; an address that does not split goes as Line1 + coords.
 */
export function toQBShipAddr(
	address: string | null | undefined,
	coords: unknown,
): QBAddress | undefined {
	const raw = address?.trim();
	if (!raw) return undefined;
	const ll = readCoords(coords);
	const geo = ll ? { Lat: String(ll.lat), Long: String(ll.lng) } : {};
	const parts = splitUSAddress(raw);
	if (!parts) return { Line1: raw, ...geo };
	return {
		Line1: parts.line1,
		City: parts.city,
		CountrySubDivisionCode: parts.state,
		PostalCode: parts.zip,
		Country: "USA",
		...geo,
	};
}

/**
 * US QBO lines take only TAX / NON; the rate-bearing code goes on TxnTaxDetail. Mirrors the tax
 * engine: a taxable line with no tax group carries no tax here, so QuickBooks must not see it as taxable.
 */
export function qbLineTaxCode(
	taxable: boolean | null | undefined,
	hasTaxGroup: boolean,
	clientExempt: boolean,
): "TAX" | "NON" {
	return clientExempt || taxable === false || !hasTaxGroup ? "NON" : "TAX";
}

/**
 * groupCodes: the QB tax code linked to each tax group that carried tax (null = unlinked).
 * One shared code is used as-is; anything else needs the org's pass-through code.
 */
export function pickTxnTaxCode(
	groupCodes: (string | null)[],
	passthrough: string | null,
): string | null {
	const distinct = new Set(groupCodes.map((c) => c || null));
	if (distinct.size === 1 && !distinct.has(null)) return groupCodes[0];
	return passthrough;
}

/** QuickBooks' TotalTax in cents; null when it is missing or unreadable. */
export function qbTotalTaxCents(qbTotalTax: unknown): number | null {
	const qb = qbTotalTax == null ? NaN : Number(qbTotalTax);
	return Number.isFinite(qb) ? roundHalfUpSymmetric(qb * 100) : null;
}

export function classifyTaxReadback(
	ourTax: number,
	qbTotalTax: unknown,
): { qbTaxAmount: number; mismatch: boolean } {
	const qbCents = qbTotalTax == null ? 0 : qbTotalTaxCents(qbTotalTax);
	// An unreadable readback can't be trusted to match.
	if (qbCents == null) return { qbTaxAmount: 0, mismatch: true };
	const ourCents = roundHalfUpSymmetric(ourTax * 100);
	return { qbTaxAmount: qbCents / 100, mismatch: Math.abs(qbCents - ourCents) > 1 };
}

/** Shared by the push and the AST adoption checks so each loads the invoice exactly as the push does. */
export function invoiceForQBInclude(accountId: string) {
	return {
		line_items: {
			orderBy: [{ sort_order: "asc" as const }, { id: "asc" as const }],
			include: {
				inventory_item: {
					include: {
						external_mappings: {
							where: {
								provider: "quickbooks",
								account_id: accountId,
							},
							take: 1,
						},
					},
				},
				tax_group: {
					select: { qb_tax_code_id: true },
				},
			},
		},
		adjusts_invoice: { select: { invoice_number: true } },
		jobs: {
			take: 1,
			orderBy: { job: { created_at: "asc" } },
			include: { job: { select: { address: true, coords: true } } },
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
	} satisfies Prisma.invoiceInclude;
}

type InvoicePayloadSource = {
	tax_snapshot: unknown;
	discount_amount: unknown;
	client: { is_tax_exempt?: boolean | null; address: string | null; coords: unknown };
	jobs: { job?: { address: string | null; coords: unknown } | null }[];
	line_items: (ItemRefLine & {
		id?: string;
		total: unknown;
		quantity: unknown;
		unit_price: unknown;
		description?: string | null;
		name: string;
		tax_group_id?: string | null;
		tax_amount?: unknown;
	})[];
};

/**
 * The DB-only half of an invoice push: what QuickBooks taxes on. Kept free of QB calls so the
 * fingerprint can be recomputed from the database alone.
 */
export function buildInvoicePayload(
	invoice: InvoicePayloadSource,
	taxableItem: TaxableItemRef,
): {
	lines: any[];
	shipAddr: QBAddress | undefined;
	clientExempt: boolean;
} {
	const snapshot = invoice.tax_snapshot as { client_exempt?: boolean } | null;
	// The locked snapshot is what the customer was charged under; the live flag may have changed since.
	const clientExempt = snapshot
		? snapshot.client_exempt === true
		: invoice.client.is_tax_exempt === true;

	const lines: any[] = invoice.line_items.map((item) => {
		return {
			Amount: Number(item.total),
			DetailType: "SalesItemLineDetail",
			Description: item.description ?? item.name,
			SalesItemLineDetail: {
				Qty: Number(item.quantity),
				UnitPrice: Number(item.unit_price),
				ItemRef: qbLineItemRef(item, taxableItem),
				// Auto-mode lines carry no tax_group_id; the tax the line actually bore is the signal.
				TaxCodeRef: {
					value: qbLineTaxCode(
						item.taxable,
						item.tax_group_id != null || Number(item.tax_amount ?? 0) !== 0,
						clientExempt,
					),
				},
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

	const serviceLocation = invoiceServiceLocation(invoice.jobs[0]?.job, invoice.client);
	const shipAddr = toQBShipAddr(serviceLocation.address, serviceLocation.coords);
	return { lines, shipAddr, clientExempt };
}

/**
 * Hash of only what changes QuickBooks' tax: amounts, quantities, tax codes, items, ship-to and
 * exemption. Descriptions, customer, memo and dates are excluded so cosmetic edits keep an adopted
 * QB figure. Object keys are emitted in a fixed order; line order is significant.
 */
export function qbPushFingerprint(
	lines: any[],
	shipAddr: QBAddress | undefined,
	clientExempt: boolean,
): string {
	const canonical = {
		lines: lines.map((l) =>
			l.SalesItemLineDetail
				? [
						"S",
						l.Amount ?? null,
						l.SalesItemLineDetail.Qty ?? null,
						l.SalesItemLineDetail.UnitPrice ?? null,
						l.SalesItemLineDetail.TaxCodeRef?.value ?? null,
						l.SalesItemLineDetail.ItemRef?.value ?? null,
					]
				: // Tagged so figures adopted before ApplyTaxAfterDiscount was sent re-confirm.
					["D-after", l.Amount ?? null],
		),
		ship: shipAddr
			? [
					shipAddr.Line1 ?? null,
					shipAddr.City ?? null,
					shipAddr.CountrySubDivisionCode ?? null,
					shipAddr.PostalCode ?? null,
					shipAddr.Lat ?? null,
					shipAddr.Long ?? null,
				]
			: null,
		exempt: clientExempt,
	};
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function fmtUsd(cents: number): string {
	const abs = Math.abs(cents);
	const dollars = (abs / 100).toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
	return `${cents < 0 ? "-" : ""}$${dollars}`;
}

/** Null when QuickBooks agrees with our estimate within a cent; otherwise the review reason. */
export function qbTaxDeltaReason(
	qbCents: number,
	oursCents: number,
	mixedGroups: boolean,
): string | null {
	if (Math.abs(qbCents - oursCents) <= 1) return null;
	const base = `QuickBooks calculated ${fmtUsd(qbCents)} (you estimated ${fmtUsd(oursCents)})`;
	return mixedGroups
		? `${base}; QuickBooks applies one rate — line tax groups were not used`
		: base;
}
