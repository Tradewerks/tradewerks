import { notifyDispatchers } from "../../controllers/notificationsController.js";
import { log } from "../appLogger.js";
import type { QbDivergenceReason } from "./qbDivergence.js";

export type QbProblemKind =
    | "push_failed"
    | "payment_push_failed"
    | "void_failed"
    | QbDivergenceReason;

const RETRY = "Open the invoice and choose Retry sync.";

const COPY: Record<QbProblemKind, (n: string) => { title: string; body: string }> = {
    push_failed: (n) => ({
        title: `QuickBooks sync failed for Invoice ${n}`,
        body: RETRY,
    }),
    payment_push_failed: (n) => ({
        title: `A payment on Invoice ${n} didn't reach QuickBooks`,
        body: RETRY,
    }),
    // Retry sync cannot help here: a void invoice is never pushed.
    void_failed: (n) => ({
        title: `Invoice ${n} is void here but still open in QuickBooks`,
        body: "Void the invoice in QuickBooks.",
    }),
    refund_not_in_qb: (n) => ({
        title: `Invoice ${n}: refund not in QuickBooks`,
        body: "Record the refund in QuickBooks, then mark the invoice reconciled.",
    }),
    qb_payment_delete_failed: (n) => ({
        title: `Invoice ${n}: payment still in QuickBooks`,
        body: "Delete the payment in QuickBooks, then mark the invoice reconciled.",
    }),
    qb_payment_overapplied: (n) => ({
        title: `Invoice ${n}: QuickBooks payment larger than the balance`,
        body: "Check the payment in QuickBooks, then mark the invoice reconciled.",
    }),
};

// Both run from QuickBooks failure paths: a notification that cannot be sent
// must not turn into a second failure for the caller.
export async function notifyQbProblem(
    organizationId: string,
    invoice: { id: string; invoice_number: string },
    kind: QbProblemKind,
): Promise<void> {
    try {
        await notifyDispatchers(
            {
                type: "qb_sync_failed",
                ...COPY[kind](invoice.invoice_number),
                actionUrl: `/dispatch/invoices/${invoice.id}`,
            },
            organizationId,
        );
    } catch (err) {
        log.error(
            { err, invoiceId: invoice.id, organizationId, kind },
            "Could not notify dispatchers of a QuickBooks problem",
        );
    }
}

export async function notifyQbDisconnected(organizationId: string): Promise<void> {
    try {
        await notifyDispatchers(
            {
                type: "qb_connection_lost",
                title: "QuickBooks disconnected",
                body: "Reconnect in Admin → Settings → Integrations. Nothing syncs until you do.",
                actionUrl: "/dispatch/admin?tab=integrations",
            },
            organizationId,
        );
    } catch (err) {
        log.error(
            { err, organizationId },
            "Could not notify dispatchers that QuickBooks disconnected",
        );
    }
}
