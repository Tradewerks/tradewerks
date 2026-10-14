import type { RequestStatus } from "../types/requests";

/**
 * Mirrors REQUEST_TRANSITIONS in backend/src/lib/statusTransitions.ts. Kept
 * here so the request page can say WHY an action is shut without a round trip;
 * the backend remains the enforcer. Any edit there needs the same edit here.
 */
const REQUEST_TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
	New: ["Reviewing", "Cancelled"],
	Reviewing: ["Quoted", "New", "Cancelled"],
	Quoted: ["QuoteApproved", "QuoteRejected", "Reviewing"],
	QuoteApproved: ["ConvertedToJob", "Cancelled", "Quoted"],
	QuoteRejected: ["Reviewing", "Quoted"],
	ConvertedToJob: [],
	Cancelled: [],
};

export function canTransitionRequest(from: RequestStatus, to: RequestStatus): boolean {
	return REQUEST_TRANSITIONS[from].includes(to);
}

/** A status with no exits at all. Distinct from an off-ramp, which has some. */
export function isRequestTerminal(status: RequestStatus): boolean {
	return REQUEST_TRANSITIONS[status].length === 0;
}
