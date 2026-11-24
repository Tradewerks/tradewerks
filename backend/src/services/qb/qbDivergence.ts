import { db } from "../../db.js";
import { getScopedDb, type UserContext } from "../../lib/context.js";
import { log } from "../appLogger.js";
import { logActivity } from "../logger.js";
import { getOrgRealmId } from "../quickbooksService.js";
import { notifyQbProblem } from "./qbNotify.js";

export type QbDivergenceReason =
    | "refund_not_in_qb"
    | "qb_payment_delete_failed"
    | "qb_payment_overapplied"
    | "qb_payment_duplicate"
    | "qb_payment_on_void"
    | "refund_exceeds_payments"
    | "void_not_in_qb";

// qb_diverged_reason holds every open reason, comma-joined in arrival order.
export function parseQbDivergenceReasons(stored: string | null | undefined): string[] {
    return stored ? stored.split(",").filter(Boolean) : [];
}

const MARK_ATTEMPTS = 5;

/**
 * Adds `reason` to the invoice's open QuickBooks problems. Returns true only
 * when the reason is new, so each problem notifies once. Never rejects: it
 * runs from failure paths that must not fail a second time.
 */
export async function markQbDiverged(
    invoiceId: string,
    organizationId: string,
    reason: QbDivergenceReason,
): Promise<boolean> {
    try {
        const realmId = await getOrgRealmId(organizationId);
        // An invoice never pushed to the connected company has nothing in
        // QuickBooks to disagree with.
        if (!realmId) return false;
        const sdb = getScopedDb(organizationId);
        // Compare-and-swap on the stored set: a mark racing another re-reads
        // and appends to the winner instead of overwriting it.
        for (let attempt = 0; attempt < MARK_ATTEMPTS; attempt++) {
            const invoice = await sdb.invoice.findFirst({
                where: { id: invoiceId },
                select: {
                    qb_invoice_id: true,
                    account_id: true,
                    invoice_number: true,
                    qb_diverged_at: true,
                    qb_diverged_reason: true,
                },
            });
            if (!invoice?.qb_invoice_id || invoice.account_id !== realmId) {
                return false;
            }
            const storedAt = invoice.qb_diverged_at ?? null;
            const storedReason = invoice.qb_diverged_reason ?? null;
            const reasons = storedAt ? parseQbDivergenceReasons(storedReason) : [];
            if (reasons.includes(reason)) return false;

            const now = new Date();
            const { count } = await sdb.invoice.updateMany({
                where: {
                    id: invoiceId,
                    qb_diverged_at: storedAt,
                    qb_diverged_reason: storedReason,
                    qb_invoice_id: { not: null },
                    account_id: realmId,
                },
                data: {
                    // Strictly later, so a reconcile against the old time is refused.
                    qb_diverged_at:
                        storedAt && now.getTime() <= storedAt.getTime()
                            ? new Date(storedAt.getTime() + 1)
                            : now,
                    qb_diverged_reason: [...reasons, reason].join(","),
                },
            });
            if (count === 0) continue;
            await notifyQbProblem(
                organizationId,
                { id: invoiceId, invoice_number: invoice.invoice_number },
                reason,
            );
            return true;
        }
        log.warn(
            { invoiceId, organizationId, reason },
            "QuickBooks divergence not recorded: the invoice kept changing",
        );
        return false;
    } catch (err) {
        log.error(
            { err, invoiceId, organizationId, reason },
            "Could not record a QuickBooks divergence",
        );
        return false;
    }
}

/**
 * A refund recorded before the invoice reached this QuickBooks company was
 * never flagged (there was nothing to disagree with yet), and refunds are
 * never pushed. Called once the invoice arrives. Never rejects.
 */
export async function flagRefundsMissingFromQb(
    invoiceId: string,
    organizationId: string,
): Promise<void> {
    try {
        const refund = await db.invoice_payment.findFirst({
            where: {
                invoice_id: invoiceId,
                amount: { lt: 0 },
                invoice: { organization_id: organizationId },
            },
            select: { id: true },
        });
        if (refund) await markQbDiverged(invoiceId, organizationId, "refund_not_in_qb");
    } catch (err) {
        log.error(
            { err, invoiceId, organizationId },
            "Could not check the invoice for refunds QuickBooks lacks",
        );
    }
}

/**
 * Clears only the problems the person saw: `seenDivergedAt` is the time the
 * page displayed, and any reason added since moves it.
 */
export async function clearQbDivergence(
    invoiceId: string,
    organizationId: string,
    context: UserContext,
    seenDivergedAt: Date,
): Promise<{ err: string; changed?: boolean }> {
    const sdb = getScopedDb(organizationId);
    const invoice = await sdb.invoice.findFirst({
        where: { id: invoiceId },
        select: {
            invoice_number: true,
            qb_diverged_at: true,
            qb_diverged_reason: true,
        },
    });
    if (!invoice) return { err: "Invoice not found" };
    if (!invoice.qb_diverged_at) return { err: "" };
    if (invoice.qb_diverged_at.getTime() !== seenDivergedAt.getTime()) {
        return { err: "", changed: true };
    }

    const { count } = await sdb.invoice.updateMany({
        where: { id: invoiceId, qb_diverged_at: seenDivergedAt },
        data: { qb_diverged_at: null, qb_diverged_reason: null },
    });
    if (count === 0) return { err: "", changed: true };

    await logActivity({
        event_type: "invoice.qb_reconciled",
        action: "updated",
        entity_type: "invoice",
        entity_id: invoiceId,
        organization_id: organizationId,
        actor_type: context.dispatcherId
            ? "dispatcher"
            : context.techId
              ? "technician"
              : "system",
        actor_id: context.dispatcherId ?? context.techId,
        changes: {
            qb_diverged_reason: { old: invoice.qb_diverged_reason, new: null },
            _invoice_number: { old: null, new: invoice.invoice_number },
        },
        ip_address: context.ipAddress,
        user_agent: context.userAgent,
    });
    return { err: "" };
}
