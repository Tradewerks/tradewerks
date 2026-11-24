import { createHash } from "node:crypto";
import { isModuleOn } from "../entitlementService.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { getScopedDb } from "../../lib/context.js";
import { qbFetch, getOrgRealmId, isQBConnected } from "../quickbooksService.js";
import { httpError, ErrorCodes } from "../../types/responses.js";
import { log } from "../appLogger.js";
import { markQbSyncFailed, pushInvoice } from "./qbInvoices.js"
import { ensureQBCustomerForClient } from "./qbCustomers.js"
import {
    invoicePaidTotalCents,
    lockInvoiceRow,
    syncInvoicePaymentTotals,
} from "../invoiceService.js"
import { centsToDollars, sumCents, toCents } from "../../lib/money.js"
import { allocateQBPaymentCash } from "./qbPaymentAllocation.js"
import { markQbDiverged } from "./qbDivergence.js"
import { countPaymentPushHttpFailures, logExternalSync } from "./qbSyncLog.js"
import { QbHttpError } from "./qbHttpError.js"
import { parseQbFault } from "./qbFault.js"


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

/**
 * Fire-and-forget. A payment carries no sync status of its own, so a failed
 * push marks the parent invoice, where Retry sync pushes the payment again.
 */
export function pushPaymentDetached(
	paymentId: string,
	invoiceId: string,
	organizationId: string,
): void {
	isQBConnected(organizationId)
		.then((connected) => (connected ? pushPaymentToQB(paymentId, organizationId) : null))
		.catch(async (err: unknown) => {
			log.error(
				{ err, paymentId, invoiceId, organizationId },
				"QuickBooks payment push failed",
			);
			await logExternalSync({
				provider: "quickbooks",
				external_id: paymentId,
				entity_type: "payment",
				action: "push_failed",
				payload: { message: String(err) },
				organization_id: organizationId,
			});
			await markQbSyncFailed(invoiceId, organizationId, "payment_push_failed");
		});
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

    try {
        await sdb.invoice_payment.update({
            where: { id: paymentId },
            data: { qb_payment_id: result.Payment.Id, account_id: accountId }
        });
    } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025")) {
            throw error;
        }
        // Deleted here while the POST was in flight: QuickBooks now holds a
        // payment with nothing behind it, which no Retry can remove.
        await logExternalSync({
            provider: "quickbooks",
            external_id: result.Payment.Id,
            entity_type: "payment",
            action: "push_orphaned",
            payload: { paymentId },
            organization_id: organizationId,
        });
        await markQbDiverged(payment.invoice.id, organizationId, "qb_payment_delete_failed");
        return;
    }

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
        // Fault 610 (Object Not Found) is QuickBooks saying it is already gone.
        // Matched on the code alone: a 404 route or an outage must not pass.
        if (
            error instanceof QbHttpError &&
            parseQbFault(error).some((f) => String(f.code) === "610")
        ) {
            log.info({ qbPaymentId, organizationId }, "QuickBooks payment already deleted");
            await logExternalSync({
                provider: "quickbooks",
                external_id: qbPaymentId,
                entity_type: "payment",
                action: "delete_already_gone",
                payload: { qbPaymentId },
                organization_id: organizationId,
            });
            return;
        }
        throw error; // real failure — let the caller log delete_failed
    }
}

// Ascending id order, so two webhooks touching overlapping invoices can't
// deadlock each other.
async function lockInvoicesInOrder(
    tx: Prisma.TransactionClient,
    invoiceIds: Iterable<string>,
    orgId: string,
    locked = new Set<string>(),
): Promise<Set<string>> {
    const ids = [...new Set(invoiceIds)].filter((id) => !locked.has(id)).sort();
    for (const id of ids) {
        await lockInvoiceRow(tx, id, orgId);
        locked.add(id);
    }
    return locked;
}

function invoiceTxnId(line: QBPaymentLine): string | undefined {
    return line.LinkedTxn?.find((t) => t.TxnType === "Invoice")?.TxnId;
}

export async function handleInboundPaymentEvent(
    orgId: string,
    accountId: string,
    qbPaymentId: string,
    operation: string
) {
    const sdb = getScopedDb(orgId);
    const record = (action: string, payload: unknown) =>
        logExternalSync({
            provider: "quickbooks",
            external_id: qbPaymentId,
            entity_type: "payment",
            action,
            payload,
            organization_id: orgId,
        });
    // Run once the write has committed; markQbDiverged never rejects.
    const flagUncoveredRefunds = async (negative: { invoiceId: string; paidCents: number }[]) => {
        for (const { invoiceId, paidCents } of negative) {
            log.warn(
                { invoiceId, orgId, qbPaymentId, paidCents },
                "QuickBooks payment change left refunds larger than payments",
            );
            await markQbDiverged(invoiceId, orgId, "refund_exceeds_payments");
        }
    };
    const ownRowsWhere = { qb_payment_id: qbPaymentId, account_id: accountId };
    try {
        // One QB payment applied to several invoices is one row per invoice.
        const existing = await sdb.invoice_payment.findMany({
            where: ownRowsWhere,
            select: { id: true, invoice_id: true },
        });

        if (operation === "Delete" || operation === "Void") {
            if (existing.length === 0) {
                await record("webhook_skipped_not_found", { qbPaymentId });
                return;
            }
            const negative = await sdb.$transaction(async (tx) => {
                const txc = tx as Prisma.TransactionClient;
                const locked = await lockInvoicesInOrder(
                    txc,
                    existing.map((r) => r.invoice_id),
                    orgId,
                );
                // A concurrent Update may have added a row on an invoice
                // read before the lock; lock it too so it is resynced safely.
                const rows = await txc.invoice_payment.findMany({
                    where: ownRowsWhere,
                    select: { id: true, invoice_id: true },
                });
                await lockInvoicesInOrder(
                    txc,
                    rows.map((r) => r.invoice_id),
                    orgId,
                    locked,
                );
                // By id, so a row on an invoice not locked here is never
                // deleted without its totals being resynced.
                await txc.invoice_payment.deleteMany({
                    where: { id: { in: rows.map((r) => r.id) } },
                });
                for (const invoiceId of locked) {
                    await syncInvoicePaymentTotals(invoiceId, txc);
                }
                return negativePaidInvoices(txc, locked);
            });
            await record("webhook_deleted", { qbPaymentId });
            await flagUncoveredRefunds(negative);
            return;
        }

        if (existing.length > 0 && operation === "Create") {
            await record("webhook_echo_skipped", { qbPaymentId });
            return;
        }

        const qb = await qbFetch(orgId, "GET", `/payment/${qbPaymentId}`) as QBPaymentResponse;
        const payment = qb.Payment;

        const lines = payment.Line ?? [];
        const qbInvoiceIds = [
            ...new Set(lines.map(invoiceTxnId).filter((id): id is string => !!id)),
        ];
        const lookupInvoices = () =>
            qbInvoiceIds.length
                ? sdb.invoice.findMany({
                      where: { qb_invoice_id: { in: qbInvoiceIds }, account_id: accountId },
                      select: { id: true, qb_invoice_id: true, status: true },
                  })
                : Promise.resolve([]);

        if (existing.length === 0) {
            const ownPaymentId = parsePaymentPrivateNote(payment.PrivateNote);
            if (ownPaymentId) {
                await linkOwnPushedPayment(ownPaymentId, lookupInvoices);
                return;
            }

            // The payment we post to apply a credit is always $0; a mixed cash + credit payment has
            // TotalAmt > 0 and must still be recorded.
            if (payment.TotalAmt === 0) {
                await record("webhook_skipped_credit_application", {
                    message: "Payment applies a credit memo",
                });
                return;
            }
        }

        if (existing.length === 0 && qbInvoiceIds.length === 0) {
            await record("webhook_skipped_no_invoice", {
                message: "No linked invoice found",
            });
            return;
        }

        const invoices = await lookupInvoices();
        const invoiceIdByQbId = new Map<string, string>();
        const voidInvoiceIds = new Set<string>();
        for (const inv of invoices) {
            if (!inv.qb_invoice_id) continue;
            // QuickBooks applied cash to an invoice void here: record nothing
            // on it, and have a person move the payment in QuickBooks.
            if (inv.status === "Void") {
                voidInvoiceIds.add(inv.id);
                continue;
            }
            if (inv.status === "Draft") {
                await record("webhook_skipped_no_invoice", {
                    message: "Invoice is a draft",
                    qbInvoiceId: inv.qb_invoice_id,
                });
                continue;
            }
            invoiceIdByQbId.set(inv.qb_invoice_id, inv.id);
        }
        const knownQbInvoiceIds = new Set(
            invoices.map((i) => i.qb_invoice_id).filter((id): id is string => !!id),
        );
        for (const qbInvoiceId of qbInvoiceIds) {
            if (!knownQbInvoiceIds.has(qbInvoiceId)) {
                await record("webhook_skipped_no_invoice", {
                    message: "Invoice not found",
                    qbInvoiceId,
                });
            }
        }
        const flagVoidInvoices = async () => {
            for (const invoiceId of voidInvoiceIds) {
                await markQbDiverged(invoiceId, orgId, "qb_payment_on_void");
            }
        };
        if (existing.length === 0 && invoiceIdByQbId.size === 0) {
            await flagVoidInvoices();
            return;
        }

        const result = await sdb.$transaction(async (tx) => {
            const txc = tx as Prisma.TransactionClient;
            const locked = await lockInvoicesInOrder(
                txc,
                [...existing.map((r) => r.invoice_id), ...invoiceIdByQbId.values()],
                orgId,
            );
            const ownRows = await txc.invoice_payment.findMany({
                where: ownRowsWhere,
                select: { id: true, invoice_id: true, amount: true },
            });
            // A concurrent Create for the same payment committed first.
            if (existing.length === 0 && ownRows.length > 0) return null;
            await lockInvoicesInOrder(
                txc,
                ownRows.map((r) => r.invoice_id),
                orgId,
                locked,
            );

            const linkedInvoiceIds = [...invoiceIdByQbId.values()];
            const totals = await txc.invoice.findMany({
                where: { id: { in: linkedInvoiceIds } },
                select: { id: true, total: true },
            });
            const totalCentsById = new Map(totals.map((t) => [t.id, toCents(t.total)]));
            // This payment's own rows are about to be rewritten, so they don't
            // count against the balance it may fill.
            const balanceCentsByQbInvoiceId = new Map<string, number>();
            for (const [qbInvoiceId, invoiceId] of invoiceIdByQbId) {
                const ownCents = sumCents(
                    ownRows.filter((r) => r.invoice_id === invoiceId).map((r) => r.amount),
                );
                const paidCents = (await invoicePaidTotalCents(invoiceId, txc)) - ownCents;
                balanceCentsByQbInvoiceId.set(
                    qbInvoiceId,
                    (totalCentsById.get(invoiceId) ?? 0) - paidCents,
                );
            }
            const { allocations, unplacedCents, overappliedQbInvoiceIds } =
                allocateQBPaymentCash({
                    totalAmt: payment.TotalAmt,
                    unappliedAmt: payment.UnappliedAmt,
                    lines,
                    balanceCentsByQbInvoiceId,
                });

            const paidAt = new Date(payment.TxnDate);
            // Rows already on a void invoice are left as they are.
            const keptRowIds = new Set<string>(
                ownRows.filter((r) => voidInvoiceIds.has(r.invoice_id)).map((r) => r.id),
            );
            for (const { qbInvoiceId, cents } of allocations) {
                const invoiceId = invoiceIdByQbId.get(qbInvoiceId)!;
                const amount = centsToDollars(cents);
                const row = ownRows.find((r) => r.invoice_id === invoiceId);
                if (row) {
                    keptRowIds.add(row.id);
                    await txc.invoice_payment.update({
                        where: { id: row.id },
                        data: { amount, paid_at: paidAt },
                    });
                } else {
                    await txc.invoice_payment.create({
                        data: {
                            invoice_id: invoiceId,
                            amount,
                            paid_at: paidAt,
                            method: "QuickBooks",
                            qb_payment_id: qbPaymentId,
                            account_id: accountId,
                        },
                    });
                }
            }
            const staleRowIds = ownRows
                .filter((r) => !keptRowIds.has(r.id))
                .map((r) => r.id);
            if (staleRowIds.length > 0) {
                await txc.invoice_payment.deleteMany({
                    where: { id: { in: staleRowIds } },
                });
            }
            for (const invoiceId of locked) {
                await syncInvoicePaymentTotals(invoiceId, txc);
            }
            return {
                rowsWritten: allocations.length,
                unplacedCents,
                overappliedInvoiceIds: overappliedQbInvoiceIds
                    .map((id) => invoiceIdByQbId.get(id))
                    .filter((id): id is string => !!id),
                negative: await negativePaidInvoices(txc, locked),
            };
        });

        await flagVoidInvoices();
        if (!result) {
            await record("webhook_echo_skipped", { qbPaymentId });
            return;
        }
        if (result.unplacedCents > 0) {
            await record("webhook_overapplied", {
                qbPaymentId,
                unplacedCents: result.unplacedCents,
            });
            for (const invoiceId of result.overappliedInvoiceIds) {
                await markQbDiverged(invoiceId, orgId, "qb_payment_overapplied");
            }
        }
        await flagUncoveredRefunds(result.negative);
        if (existing.length > 0) {
            await record("webhook_updated", { qbPaymentId });
        } else if (result.rowsWritten > 0) {
            await record("webhook_created", { qbPaymentId });
        }
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            await record("webhook_duplicate_ignored", { message: "Duplicate entry found" });
            return;
        }
        // Intuit already has its 200 and will not redeliver; this is the trace.
        log.error({ err: error, qbPaymentId, orgId }, "QuickBooks payment webhook failed");
        await record("webhook_failed", { message: String(error) });
    }

    // Our own push echoed back before pushPaymentToQB stored the QB id: link
    // the local row instead of inserting a duplicate. A pushed payment is
    // always single-invoice.
    async function linkOwnPushedPayment(
        paymentId: string,
        lookupInvoices: () => Promise<{ id: string }[]>,
    ) {
        const own = await sdb.invoice_payment.findFirst({
            where: { id: paymentId },
            select: { id: true, invoice_id: true },
        });
        if (!own) {
            // Deleted locally while the push was in flight; don't resurrect
            // it, but the payment now in QuickBooks has nothing behind it.
            await record("webhook_echo_skipped", {
                qbPaymentId,
                paymentId,
                message: "Local payment not found",
            });
            for (const invoice of await lookupInvoices()) {
                await markQbDiverged(invoice.id, orgId, "qb_payment_delete_failed");
            }
            return;
        }
        const outcome = await sdb.$transaction(async (tx) => {
            const txc = tx as Prisma.TransactionClient;
            await lockInvoiceRow(txc, own.invoice_id, orgId);
            const row = await txc.invoice_payment.findFirst({
                where: { id: paymentId },
                select: { id: true, qb_payment_id: true, account_id: true },
            });
            if (!row) return { kind: "echo" as const };
            if (row.qb_payment_id === null) {
                await txc.invoice_payment.update({
                    where: { id: paymentId },
                    data: { qb_payment_id: qbPaymentId, account_id: accountId },
                });
                return { kind: "linked" as const };
            }
            // Linked in this company to another QuickBooks payment: the same
            // local payment reached QuickBooks twice. A link in a previous
            // company is the re-push in flight, which links it itself.
            if (row.account_id === accountId && row.qb_payment_id !== qbPaymentId) {
                return { kind: "duplicate" as const, linkedQbPaymentId: row.qb_payment_id };
            }
            return { kind: "echo" as const };
        });
        if (outcome.kind === "duplicate") {
            log.error(
                {
                    orgId,
                    paymentId,
                    invoiceId: own.invoice_id,
                    qbPaymentId,
                    linkedQbPaymentId: outcome.linkedQbPaymentId,
                },
                "QuickBooks holds a payment twice: the local payment is already linked to another",
            );
            await record("webhook_duplicate_payment", {
                qbPaymentId,
                paymentId,
                linkedQbPaymentId: outcome.linkedQbPaymentId,
            });
            await markQbDiverged(own.invoice_id, orgId, "qb_payment_duplicate");
            return;
        }
        await record(outcome.kind === "linked" ? "webhook_linked_own_push" : "webhook_echo_skipped", {
            qbPaymentId,
            paymentId,
        });
    }
}

// Read under the webhook's locks, after its totals are resynced.
async function negativePaidInvoices(
    tx: Prisma.TransactionClient,
    invoiceIds: Iterable<string>,
): Promise<{ invoiceId: string; paidCents: number }[]> {
    const negative: { invoiceId: string; paidCents: number }[] = [];
    for (const invoiceId of invoiceIds) {
        const paidCents = await invoicePaidTotalCents(invoiceId, tx);
        if (paidCents < 0) negative.push({ invoiceId, paidCents });
    }
    return negative;
}
