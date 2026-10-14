import type { Request } from "express";
import type { ResolveDisputeInput } from "./validate/disputes.js";
import type { DisputeKind } from "../services/disputeAdapters.js";

type Outcome = ResolveDisputeInput["resolution"];

/** Why a resolution was refused on authority rather than on input or a race.
 *  Shared so the service, the controller and the response mapper cannot drift. */
export type DisputeForbiddenReason =
	| "concession"
	| "self_resolution"
	| "not_office_staff";

/**
 * What the caller is allowed to do once past the `resolve_disputes` route gate.
 *
 * Two things that gate cannot express: whether this person may give money back,
 * and whether they may close a dispute they opened themselves.
 */
export interface DisputeAuthz {
	canConcede: boolean;
	/** Holds refund_invoices. Repeal and Revise & Resend both write status Void
	 *  on an invoice, the same act as the kebab’s Void — so concession
	 *  authority alone must not reach either. */
	canRefund: boolean;
	canResolveOwn: boolean;
}

/**
 * The least privileged reading, and the default every resolution path falls
 * back to. A caller that forgets to pass its authority gets refused rather
 * than waved through — the failure mode of a dropped argument has to be a 403,
 * not a write-off.
 */
export const NO_DISPUTE_AUTHORITY: DisputeAuthz = {
	canConcede: false,
	canRefund: false,
	canResolveOwn: false,
};

/**
 * Outcomes that hand money back: an adjustment writes a credit, a repeal
 * cancels the document outright. Revise & Resend is not here — it corrects our
 * own error and the client still owes the same money.
 */
const CONCEDING_OUTCOMES: ReadonlySet<Outcome> = new Set([
	"IssueAdjustment",
	"Repeal",
]);

const OUTCOME_LABELS: Record<Outcome, string> = {
	ReviseAndResend: "Revise & Resend",
	IssueAdjustment: "Issue Adjustment",
	Repeal: "Repeal",
};

/**
 * The caller's grants, or null for the admin role. Mirrors resolvePerms in
 * requirePermissions.ts: the admin role clears every route gate, so reading the
 * permissions array for an admin would make these the one door an admin cannot
 * open.
 */
function grantsOf(req: Request): string[] | null {
	if (req.user?.role === "admin") return null;
	return Array.isArray(req.user?.permissions)
		? (req.user.permissions as string[])
		: [];
}

/** Holds resolve_disputes, read the way the resolve route's gate reads it, so
 *  the dispute list can report that gate's answer before anything else. */
export function canResolveDisputesFrom(req: Request): boolean {
	const perms = grantsOf(req);
	return perms === null || perms.includes("resolve_disputes");
}

export function disputeAuthzFrom(req: Request): DisputeAuthz {
	const perms = grantsOf(req);
	if (perms === null) {
		return { canConcede: true, canRefund: true, canResolveOwn: true };
	}
	return {
		canConcede: perms.includes("concede_disputes"),
		canRefund: perms.includes("refund_invoices"),
		canResolveOwn: perms.includes("resolve_own_disputes"),
	};
}

/** Why this outcome is closed to this caller, or null. */
export function outcomeRefusal(
	kind: DisputeKind,
	outcome: Outcome,
	authz: DisputeAuthz,
): string | null {
	if (CONCEDING_OUTCOMES.has(outcome) && !authz.canConcede) {
		return `You don't have permission to ${OUTCOME_LABELS[outcome]} — that gives money back. Ask someone with concession authority to resolve this dispute.`;
	}
	// Repealing an invoice writes status Void, byte for byte the act the
	// kebab’s Void performs behind refund_invoices. Without this the split
	// leaks: a concession grant would reach a cash-out the roles editor
	// deliberately withheld. Repealing a QUOTE cancels an offer and moves no
	// money, so it never asks for an invoice permission.
	if (kind === "invoice" && outcome === "Repeal" && !authz.canRefund) {
		return `You don't have permission to void invoices, and a ${OUTCOME_LABELS[outcome]} voids this one permanently. Ask someone with refund and void authority to resolve this dispute.`;
	}
	// Revise & Resend voids the original before issuing its replacement: the
	// same leak by another door.
	if (kind === "invoice" && outcome === "ReviseAndResend" && !authz.canRefund) {
		return `You don't have permission to void invoices, and ${OUTCOME_LABELS[outcome]} voids this one before issuing its replacement. Ask someone with refund and void authority to resolve this dispute.`;
	}
	return null;
}

/** The document kinds whose disputes this caller may list. A dispute row carries
 *  its document's number, client and money, so each kind needs that document's
 *  view grant (DW-65). */
export function viewableDisputeKinds(req: Request): DisputeKind[] {
	const perms = grantsOf(req);
	if (perms === null) return ["quote", "invoice"];
	const kinds: DisputeKind[] = [];
	if (perms.includes("view_quotes")) kinds.push("quote");
	if (perms.includes("view_invoices")) kinds.push("invoice");
	return kinds;
}
