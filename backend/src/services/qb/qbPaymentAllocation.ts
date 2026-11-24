import { toCents } from "../../lib/money.js";
import type { QBPaymentLine } from "./qbPayments.js";

export interface QBPaymentAllocation {
    qbInvoiceId: string;
    cents: number;
}

/**
 * Splits a QB payment's cash across the invoices it is applied to.
 *
 * Only TotalAmt − UnappliedAmt is cash on invoices. When credit memo lines
 * also fund the invoices, the invoice line amounts add up to more than the
 * cash, so cash is placed line by line until it runs out. A line whose
 * invoice is not in `balanceCentsByQbInvoiceId` (not in this app) still
 * consumes its cash, since QB applied it there. Cash beyond an invoice's
 * remaining balance is `unplacedCents`: QB says it was paid, but recording it
 * would push the invoice past its total; `overappliedQbInvoiceIds` names the
 * invoices it was meant for.
 */
export function allocateQBPaymentCash(input: {
    totalAmt: number;
    unappliedAmt?: number;
    lines: QBPaymentLine[];
    balanceCentsByQbInvoiceId: Map<string, number>;
}): {
    allocations: QBPaymentAllocation[];
    unplacedCents: number;
    overappliedQbInvoiceIds: string[];
} {
    let cashCents = Math.max(
        0,
        toCents(input.totalAmt) - toCents(input.unappliedAmt ?? 0),
    );
    const remaining = new Map<string, number>();
    for (const [id, cents] of input.balanceCentsByQbInvoiceId) {
        remaining.set(id, Math.max(0, cents));
    }
    const placed = new Map<string, number>();
    let unplacedCents = 0;
    const overapplied = new Set<string>();

    for (const line of input.lines) {
        const invoice = line.LinkedTxn?.find((t) => t.TxnType === "Invoice");
        if (!invoice) continue;
        const lineCents = Math.min(Math.max(0, toCents(line.Amount)), cashCents);
        if (lineCents <= 0) continue;
        cashCents -= lineCents;

        const balance = remaining.get(invoice.TxnId);
        if (balance === undefined) continue;
        const cents = Math.min(lineCents, balance);
        remaining.set(invoice.TxnId, balance - cents);
        unplacedCents += lineCents - cents;
        if (lineCents > cents) overapplied.add(invoice.TxnId);
        if (cents > 0) {
            placed.set(invoice.TxnId, (placed.get(invoice.TxnId) ?? 0) + cents);
        }
    }

    return {
        allocations: [...placed].map(([qbInvoiceId, cents]) => ({
            qbInvoiceId,
            cents,
        })),
        unplacedCents,
        overappliedQbInvoiceIds: [...overapplied],
    };
}
