import type { QuoteStatus } from "../types/quotes";

/**
 * Mirror of QUOTE_TRANSITIONS in backend/src/lib/statusTransitions.ts.
 *
 * The server is authoritative and 422s on anything not in its own table, so
 * this exists purely so the UI can stop offering an action the server would
 * refuse. Keep the two tables in step — a stale copy here shows a dispatcher a
 * button that always fails, which is exactly the defect it was added to close.
 */
export const QUOTE_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
	Draft: ["Issued", "Sent", "Cancelled"],
	Issued: ["Sent", "Approved", "Rejected", "Revised", "Expired", "Cancelled", "Disputed"],
	Sent: ["Viewed", "Approved", "Rejected", "Expired", "Cancelled", "Disputed"],
	Viewed: ["Approved", "Rejected", "Expired", "Cancelled", "Disputed"],
	Approved: ["Revised", "Disputed"],
	Disputed: ["Revised", "Cancelled"],
	Rejected: ["Revised"],
	Revised: [],
	Expired: ["Revised"],
	Cancelled: [],
};

/** Whether the server would accept this status change. Self-transitions are no-ops. */
export function canTransitionQuote(from: QuoteStatus, to: QuoteStatus): boolean {
	if (from === to) return true;
	return (QUOTE_TRANSITIONS[from] ?? []).includes(to);
}
