import { getScopedDb, type UserContext } from "../../lib/context.js";
import { logActivity } from "../logger.js";
import { getOrgRealmId } from "../quickbooksService.js";

export type QbDivergenceReason =
    | "refund_not_in_qb"
    | "qb_payment_delete_failed"
    | "qb_payment_overapplied";

// Returns true only on the transition into diverged, so a caller can notify
// once rather than on every repeat of the same problem.
export async function markQbDiverged(
    invoiceId: string,
    organizationId: string,
    reason: QbDivergenceReason,
): Promise<boolean> {
    const realmId = await getOrgRealmId(organizationId);
    // An invoice never pushed to the connected company has nothing in
    // QuickBooks to disagree with.
    if (!realmId) return false;
    const sdb = getScopedDb(organizationId);
    const invoice = await sdb.invoice.findFirst({
        where: { id: invoiceId },
        select: { qb_invoice_id: true, account_id: true },
    });
    if (!invoice?.qb_invoice_id || invoice.account_id !== realmId) {
        return false;
    }
    const { count } = await sdb.invoice.updateMany({
        where: {
            id: invoiceId,
            qb_diverged_at: null,
            qb_invoice_id: { not: null },
            account_id: realmId,
        },
        data: { qb_diverged_at: new Date(), qb_diverged_reason: reason },
    });
    // Task 10: notifyQbProblem on transition
    return count > 0;
}

export async function clearQbDivergence(
    invoiceId: string,
    organizationId: string,
    context: UserContext,
): Promise<{ err: string }> {
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

    const { count } = await sdb.invoice.updateMany({
        where: { id: invoiceId, qb_diverged_at: { not: null } },
        data: { qb_diverged_at: null, qb_diverged_reason: null },
    });
    if (count === 0) return { err: "" };

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
