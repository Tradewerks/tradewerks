import type { DisputeKind } from "../../types/disputes";
import { InvoiceStatusLabels, type InvoiceStatus } from "../../types/invoices";
import { QuoteStatusLabels, type QuoteStatus } from "../../types/quotes";

/**
 * A stored status as its badge reads it, for the one document kind it came
 * from. `status_at_open` is a bare string snapshot, so the same stored word can
 * mean two different labels: both kinds show `Issued` as "Created", but only an
 * invoice has `PartiallyPaid`/`Paid`, and only a quote has `Approved`/`Revised`.
 * Falls through to the raw value for anything the map doesn't know — the
 * snapshot is historical and may name a status since gone.
 */
export function documentStatusLabel(kind: DisputeKind, status: string): string {
	return kind === "invoice"
		? InvoiceStatusLabels[status as InvoiceStatus] ?? status
		: QuoteStatusLabels[status as QuoteStatus] ?? status;
}
