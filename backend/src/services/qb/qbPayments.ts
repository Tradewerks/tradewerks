import { createHash } from "node:crypto";
import { isModuleOn } from "../entitlementService.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { getScopedDb } from "../../lib/context.js";
import { qbFetch, getOrgRealmId } from "../quickbooksService.js";
import { httpError, ErrorCodes } from "../../types/responses.js";
import { pushInvoice } from "./qbInvoices.js"
import { ensureQBCustomerForClient } from "./qbCustomers.js"
import { syncInvoicePaymentTotals } from "../invoiceService.js"
import { countPaymentPushHttpFailures, logExternalSync } from "./qbSyncLog.js"
import { QbHttpError } from "./qbHttpError.js"


/** QuickBooks reference object, e.g. CustomerRef / AccountRef. */
export interface QBRef {
    value: string;
    name?: string;
}

export interface QBMetaData {
    CreateTime: string;
    LastUpdatedTime: string;
}

/** A linked transaction on a payment line (e.g. the invoice the payment
 is applied to). */
export interface QBLinkedTxn {
    TxnId: string;
    TxnType: string; // "Invoice", "CreditMemo", etc.
}

export interface QBPaymentLine {
    Amount: number;
    LinkedTxn: QBLinkedTxn[];
}

export interface QBPayment {
    Id: string;
    SyncToken: string;
    domain: string; 
    sparse: boolean;
    TxnDate: string;
    TotalAmt: number;
    UnappliedAmt: number;
    ProcessPayment: boolean;
    CustomerRef: QBRef;
    DepositToAccountRef?: QBRef;
    ProjectRef?: QBRef;
    Line: QBPaymentLine[];
    MetaData: QBMetaData;
    PrivateNote?: string;
}

/** Response wrapper returned by GET/POST on the QB Payment entity. */
export interface QBPaymentResponse {
    Payment: QBPayment;
    time: string;
}

const PAYMENT_NOTE_PREFIX = "hvac:payment:";

/** Marker stamped on every payment we push, so the webhook echo can be linked back to our row. */
export function paymentPrivateNote(paymentId: string): string {
    return PAYMENT_NOTE_PREFIX + paymentId;
}

// Anywhere in the note: users edit the QB memo around the marker.
const PAYMENT_NOTE_RE = /hvac:payment:([0-9a-fA-F-]{36})/;

export function parsePaymentPrivateNote(note?: string): string | null {
    return note?.match(PAYMENT_NOTE_RE)?.[1] ?? null;
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (value && typeof value === "object") {
        const entries = Object.keys(value as Record<string, unknown>)
            .sort()
            .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
            .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
        return `{${entries.join(",")}}`;
    }
    return JSON.stringify(value);
}

// Same payment + same payload reuses the id, so a crash/timeout retry gets QB's cached result
// instead of a second payment. QB also caches an error under the id, so a changed payload or a prior
// definitive rejection (fixable on the QB side: inactive customer, closed period) must yield a fresh
// id. Ambiguous failures (5xx, 401, 408, 429) keep the id: the edge can fail after QB committed the
// POST, and a fresh id would then create a second payment.
// paymentId is a uuid (36) + "pay-" + "-" + 8 = 49, inside QB's 50-char limit.
function paymentRequestId(paymentId: string, payload: unknown, rejections: number): string {
    const digest = createHash("sha1")
        .update(`${stableStringify(payload)}:${rejections}`)
        .digest("hex");
    return `pay-${paymentId}-${digest.slice(0, 8)}`;
}

function isDefinitiveRejection(error: unknown): error is QbHttpError {
    if (!(error instanceof QbHttpError)) return false;
    const { status } = error;
    return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
}

const inFlightPushes = new Map<string, Promise<void>>();

export async function pushPaymentToQB(paymentId: string, organizationId: string) {
	if (!(await isModuleOn(organizationId, "quickbooks"))) return;
    const prior = inFlightPushes.get(paymentId) ?? Promise.resolve();
	const run = prior.catch(() => {}).then(() => doPushPaymentToQB(paymentId, organizationId));
	inFlightPushes.set(paymentId, run);
	run.catch(() => {}).finally(() => {
		if (inFlightPushes.get(paymentId) === run) {
			inFlightPushes.delete(paymentId);
		}
	});
	return run;
}

async function doPushPaymentToQB(paymentId: string, organizationId: string) {
    const sdb = getScopedDb(organizationId);
    const accountId = await getOrgRealmId(organizationId);
    let payment = await sdb.invoice_payment.findFirst({
        where: { id: paymentId },
        include: {
            invoice: {
                include: {
                    client: {
                        include: { client_external_mapping: { where: { provider: "quickbooks", account_id: accountId } } }
                    }
                }
            }
        },
    });

    if (!payment) {
        throw httpError(404, ErrorCodes.NOT_FOUND, "Payment not found");
    }
    if (payment.qb_payment_id && payment.account_id === accountId) {
        return;
    }
    if (!payment.invoice) {
        throw httpError(400, ErrorCodes.BAD_REQUEST, "Invoice not found");
    }
    if (!payment.invoice.qb_invoice_id || payment.invoice.account_id !== accountId) {
        await pushInvoice(payment.invoice.id, organizationId);
        const updatedPayment = await sdb.invoice_payment.findFirst({
            where: { id: paymentId },
            include: {
                invoice: {
                    include: {
                        client: {
                            include: { client_external_mapping: { where: { provider: "quickbooks", account_id: accountId } } }
                        }
                    }
                }
            },
        });
        if (!updatedPayment) {
            throw httpError(400, ErrorCodes.VALIDATION_ERROR, "Invoice could not be synced to QuickBooks");
        }
        payment = updatedPayment;
    }

    const { client } = payment.invoice;
    const mapping = client.client_external_mapping.find(m => m.provider === "quickbooks");
    const qbCustomerId =
        mapping?.external_id ??
        (await ensureQBCustomerForClient(
            organizationId,
            { id: client.id, name: client.name },
            accountId,
        ));

    const payload = {
        CustomerRef: {
            value: qbCustomerId
        },
        TotalAmt: Number(payment.amount),
        TxnDate: payment.paid_at.toISOString().split("T")[0],
        PrivateNote: paymentPrivateNote(paymentId),
        Line: [{
            Amount: Number(payment.amount),
            LinkedTxn: [{
                TxnId: payment.invoice.qb_invoice_id,
                TxnType: "Invoice"
            }]
        }]
    };
    const rejections = await countPaymentPushHttpFailures(paymentId, organizationId);
    const requestId = paymentRequestId(paymentId, payload, rejections);
    let result: QBPaymentResponse;
    try {
        result = await qbFetch(organizationId, "POST", "/payment", payload, {
            requestId,
        }) as QBPaymentResponse;
    } catch (error) {
        if (isDefinitiveRejection(error)) {
            await logExternalSync({
                provider: "quickbooks",
                external_id: paymentId,
                entity_type: "payment",
                action: "push_http_failed",
                payload: { status: error.status, requestId, message: error.message },
                organization_id: organizationId,
            });
        }
        throw error;
    }

    if (!result) {
        throw httpError(400, ErrorCodes.VALIDATION_ERROR, "Payment could not be pushed to QuickBooks");
    }

    await sdb.invoice_payment.update({
        where: { id: paymentId },
        data: { qb_payment_id: result.Payment.Id, account_id: accountId }
    });

    await logExternalSync({
        provider: "quickbooks",
        external_id: result.Payment.Id,
        entity_type: "payment",
        action: "create",
        payload: result.Payment,
        organization_id: organizationId
    });
}

export async function deleteQBPayment(qbPaymentId: string, organizationId: string) {
	if (!(await isModuleOn(organizationId, "quickbooks"))) return;
    try {
        const existing = (await qbFetch(organizationId, "GET", `/payment/${qbPaymentId}`)) as QBPaymentResponse;
        await qbFetch(organizationId, "POST", "/payment?operation=delete", {
            Id: qbPaymentId,
            SyncToken: existing.Payment.SyncToken,
        });

        await logExternalSync({
            provider: "quickbooks",
            external_id: qbPaymentId,
            entity_type: "payment",
            action: "delete",
            payload: { qbPaymentId },
            organization_id: organizationId,
        });
    } catch (error) {
        // If QB says the payment is already gone, treat as success
        if (/not\s*found|ObjectNotFound|object not found/i.test(String(error))) {
            return;
        }
        throw error; // real failure — let the caller log delete_failed
    }
}

export async function handleInboundPaymentEvent(
    orgId: string, 
    accountId: string, 
    qbPaymentId: string,
    operation: string
) {
    const sdb = getScopedDb(orgId);
    try {
        const existing = await sdb.invoice_payment.findFirst({
            where: { qb_payment_id: qbPaymentId, account_id: accountId },
        });

        if (operation === "Delete" || operation === "Void") {
            if (!existing) {
                await logExternalSync({
                    provider: "quickbooks",
                    external_id: qbPaymentId,
                    entity_type: "payment",
                    action: "webhook_skipped_not_found",
                    payload: { qbPaymentId },
                    organization_id: orgId,
                });
                return;
            }
            await sdb.$transaction(async (tx) => {
                await tx.invoice_payment.delete({
                    where: { id: existing.id },
                });
                await syncInvoicePaymentTotals(existing.invoice_id, tx as Prisma.TransactionClient);
            });
            await logExternalSync({
                provider: "quickbooks",
                external_id: qbPaymentId,
                entity_type: "payment",
                action: "webhook_deleted",
                payload: { qbPaymentId },
                organization_id: orgId,
            });
            return;
        }

        // already exists, logging skip
        if (existing && operation === "Create") {
            await logExternalSync({
                provider: "quickbooks",
                external_id: qbPaymentId,
                entity_type: "payment",
                action: "webhook_echo_skipped",
                payload: { qbPaymentId },
                organization_id: orgId,
            });
            return;
        }

        const qb = await qbFetch(orgId, "GET", `/payment/${qbPaymentId}`) as QBPaymentResponse;
        const payment = qb.Payment;

        if (existing){
            await sdb.$transaction(async (tx)=>{
                await tx.invoice_payment.update({
                    where: { id: existing.id },
                    data: { amount: payment.TotalAmt, paid_at: new Date(payment.TxnDate) }
                });
                await syncInvoicePaymentTotals(existing.invoice_id, tx as Prisma.TransactionClient);
            });
            await logExternalSync({
                provider: "quickbooks",
                external_id: qbPaymentId,
                entity_type: "payment",
                action: "webhook_updated",
                payload: { qbPaymentId },
                organization_id: orgId,
            });
            return;
        } 

        // Create
        // The payment we post to apply a credit is always $0; a mixed cash + credit payment has
        // TotalAmt > 0 and must still be recorded.
        const linked = payment.Line?.flatMap(l => l.LinkedTxn ?? []) ?? [];
        if (payment.TotalAmt === 0) {
            await logExternalSync({
                provider: "quickbooks",
                external_id: qbPaymentId,
                entity_type: "payment",
                action: "webhook_skipped_credit_application",
                payload: { message: "Payment applies a credit memo" },
                organization_id: orgId,
            });
            return;
        }

        const linkedInvoiceId = linked.find(t => t.TxnType === "Invoice")?.TxnId;
        if (!linkedInvoiceId) {
            await logExternalSync({
                provider: "quickbooks",
                external_id: qbPaymentId,
                entity_type: "payment",
                action: "webhook_skipped_no_invoice",
                payload: { message: "No linked invoice found" },
                organization_id: orgId,
            });
            return;
        }
        
        const invoice = await sdb.invoice.findFirst({
            where: { qb_invoice_id: linkedInvoiceId, account_id: accountId }
        });
        if (!invoice) {
            await logExternalSync({
                provider: "quickbooks",
                external_id: qbPaymentId,
                entity_type: "payment",
                action: "webhook_skipped_no_invoice",
                payload: { message: "Invoice not found" },
                organization_id: orgId,
            });
            return;
        }
        await sdb.$transaction(async (tx) => {
            await tx.invoice_payment.create({
                data: {
                    invoice_id: invoice.id,
                    amount: payment.TotalAmt,
                    paid_at: new Date(payment.TxnDate),
                    method: "QuickBooks",
                    qb_payment_id: qbPaymentId,
                    account_id: accountId
                }
            });
            await syncInvoicePaymentTotals(invoice.id, tx as Prisma.TransactionClient);
        })
        await logExternalSync({
            provider: "quickbooks",
            external_id: qbPaymentId,
            entity_type: "payment",
            action: "webhook_created",
            payload: { qbPaymentId },
            organization_id: orgId,
        })
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            await logExternalSync({
                provider: "quickbooks",
                external_id: qbPaymentId,
                entity_type: "payment",
                action: "webhook_duplicate_ignored",
                payload: { message: "Duplicate entry found" },
                organization_id: orgId,
            });
            return;
        }
        await logExternalSync({
            provider: "quickbooks",
            external_id: qbPaymentId,
            entity_type: "payment",
            action: "webhook_failed",
            payload: { message: String(error) },
            organization_id: orgId,
        });
    }
}