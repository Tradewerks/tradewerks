import { canTransitionQuote, QUOTE_TRANSITIONS } from "../../lib/quoteTransitions";
import type { QuoteStatus } from "../../types/quotes";
import type { LifecycleAction } from "./types";
import {
	buildAction as build,
	NO_PERMISSION,
	notApplicable,
	openDisputeReason,
	unknownDisputeReason,
} from "./actionBuilder";
import type { ActionGate } from "./actionBuilder";
import { OUTCOME_LABELS } from "../disputes/outcomes";

/**
 * The happy path, in order. Viewed is absent because nothing produces it (no
 * client portal, no open-tracking callback), so its step would sit permanently
 * unlit; Sent is the real pre-decision state.
 */
export const QUOTE_STEPS = ["Draft", "Issued", "Sent", "Approved"] as const;

/**
 * Statuses off the main path. Listed rather than derived from empty transition
 * lists, because Expired and Rejected both still have exits.
 */
export const QUOTE_OFF_RAMPS: readonly QuoteStatus[] = [
	"Viewed",
	"Disputed",
	"Rejected",
	"Cancelled",
	"Revised",
	"Expired",
];

export function isQuoteOffRamp(status: string): boolean {
	return (QUOTE_OFF_RAMPS as readonly string[]).includes(status);
}

/**
 * The statuses a quote may be revised from: the shared `→ Revised` edges, minus
 * the editable Draft/Sent/Viewed (superseding a live document burns a quote
 * number) and Disputed (revised through Revise & Resend instead). Derived so it
 * drifts from the server only if the transition table does.
 */
const NOT_REVISABLE_DESPITE_EDGE: readonly QuoteStatus[] = [
	"Draft",
	"Sent",
	"Viewed",
	"Disputed",
];
const REVISABLE: readonly QuoteStatus[] = (
	Object.keys(QUOTE_TRANSITIONS) as QuoteStatus[]
).filter(
	(s) =>
		QUOTE_TRANSITIONS[s].includes("Revised") &&
		!NOT_REVISABLE_DESPITE_EDGE.includes(s)
);
/**
 * Mirrors QUOTE_NOT_CONVERTIBLE in backend/src/controllers/jobsController.ts.
 * insertJob applies no transition guard, so that denylist is the rule and this
 * is what the page shows before the round trip. An allowlist would drop Draft,
 * which does convert.
 */
const QUOTE_TERMINAL: readonly QuoteStatus[] = ["Rejected", "Revised", "Expired", "Cancelled"];

export interface QuoteActionContext {
	status: QuoteStatus;
	hasJob: boolean;
	hasOpenDispute: boolean;
	disputeStateUnknown: boolean;
	/** disputeList.open_refusal — why Open Dispute is shut, or null. Produced by
	 *  the open door itself, so the button and the 422 body match. */
	openRefusal: string | null;
	/** disputeList.sold_refusal — why this quote can no longer be sold as-is (a
	 *  job off it or a sibling), or null. Same server function insertJob
	 *  refuses conversion with. */
	soldRefusal: string | null;
	canEdit: boolean;
	/** Holds send_quotes. Not canEdit: mailing a finished quote to the client is
	 *  not a change to what it says, and the two are granted separately. */
	canSend: boolean;
	canCreateJob: boolean;
	/** Holds open_disputes. Not canEdit: recording a disagreement isn't an edit. */
	canOpenDispute: boolean;
	/** A revision request is in flight; see reviseReason. */
	revisePending?: boolean;
	handlers: Record<
		| "issue"
		| "send"
		| "approve"
		| "convert"
		| "dispute"
		| "reject"
		| "withdraw"
		| "revise",
		() => void
	>;
}

function reviseReason(ctx: QuoteActionContext): ActionGate {
	if (!ctx.canEdit) return NO_PERMISSION;
	// Checked ahead of the status gates so an in-flight revise reads as in
	// flight rather than as not allowed.
	if (ctx.revisePending) return "Creating a revision…";
	if (ctx.status === "Disputed" || ctx.hasOpenDispute) {
		return `This quote is under dispute — resolve the dispute and choose ${OUTCOME_LABELS.ReviseAndResend} instead.`;
	}
	if (!REVISABLE.includes(ctx.status)) {
		return notApplicable(
			`A ${ctx.status.toLowerCase()} quote can't be revised. Revisions come from ${REVISABLE.map(
				(s) => s.toLowerCase()
			).join(", ")} quotes.`
		);
	}
	return null;
}

function convertReason(ctx: QuoteActionContext): ActionGate {
	if (ctx.hasJob) return null; // the label already says a job exists
	if (!ctx.canCreateJob) return NO_PERMISSION;
	if (ctx.status === "Disputed") {
		return "This quote is under dispute — resolve the dispute before converting it to a job.";
	}
	if (ctx.disputeStateUnknown) return unknownDisputeReason("quote");
	if (ctx.soldRefusal) return ctx.soldRefusal;
	if (QUOTE_TERMINAL.includes(ctx.status)) {
		return notApplicable(`A ${ctx.status.toLowerCase()} quote can't be converted to a job.`);
	}
	return null;
}

function disputeReason(ctx: QuoteActionContext): ActionGate {
	return openDisputeReason({
		kind: "quote",
		canOpenDispute: ctx.canOpenDispute,
		disputeStateUnknown: ctx.disputeStateUnknown,
		hasOpenDispute: ctx.hasOpenDispute,
		openRefusal: ctx.openRefusal,
	});
}

/**
 * The quote's offered actions, in a fixed order. Every action is always
 * present — closed ones arrive disabled with their reason — so the row does not
 * reshuffle as the quote moves.
 */
export function quoteActions(ctx: QuoteActionContext): LifecycleAction[] {
	// `allowed` is the permission this particular door needs. It defaults to
	// canEdit because most transitions are edits, but Email to Client is gated on
	// send_quotes — passing canEdit there would shut the door on a role that
	// holds send_quotes and nothing else.
	const transition = (to: QuoteStatus, allowed: boolean = ctx.canEdit): ActionGate => {
		if (!allowed) return NO_PERMISSION;
		if (ctx.disputeStateUnknown) return unknownDisputeReason("quote");
		if (ctx.hasOpenDispute) {
			return "This quote has an open dispute — resolve it first.";
		}
		if (!canTransitionQuote(ctx.status, to)) {
			return notApplicable(
				`A ${ctx.status.toLowerCase()} quote can't be marked ${to.toLowerCase()}.`
			);
		}
		return null;
	};
	// canTransitionQuote and the server both treat a self-transition as legal,
	// so without this a Rejected quote offers a live Reject that writes nothing.
	// Not used for Sent: emailing an already-sent quote is a real re-send.
	const move = (to: QuoteStatus, done: string): ActionGate => {
		if (!ctx.canEdit) return NO_PERMISSION;
		if (ctx.status === to) return notApplicable(`This quote is already ${done}.`);
		return transition(to);
	};

	return [
		// Two delivery doors, not two steps: the system emails the document, or
		// the business issues it and delivers the PDF itself. Draft → Sent is a
		// legal transition, so neither comes before the other.
		build(
			"issue",
			"Create Without Sending",
			"neutral",
			// Not transition("Issued"): a self-transition is legal, and
			// issuing twice re-dates the document. Only Draft may issue.
			!ctx.canEdit
				? NO_PERMISSION
				: ctx.status !== "Draft"
					? notApplicable("This quote has already been created.")
					: transition("Issued"),
			ctx.handlers.issue
		),
		build(
			"send",
			"Email to Client",
			"primary",
			transition("Sent", ctx.canSend),
			ctx.handlers.send
		),
		build(
			"approve",
			"Mark as Approved",
			"primary",
			move("Approved", "approved"),
			ctx.handlers.approve
		),
		build(
			"convert",
			ctx.hasJob ? "Job Already Created" : "Convert to Job",
			"neutral",
			convertReason(ctx),
			ctx.handlers.convert
		),
		build(
			"dispute",
			"Open Dispute",
			"warning",
			disputeReason(ctx),
			ctx.handlers.dispute
		),
		// primary, not neutral: revise only reaches the visible row on a terminal
		// stage, where it is the recommended action. Neutral made the one live
		// button read quieter than the dead ones beside it.
		build(
			"revise",
			"Create Revision",
			"primary",
			reviseReason(ctx),
			ctx.handlers.revise
		),
		build(
			"reject",
			"Reject",
			"destructive",
			move("Rejected", "rejected") ?? ctx.soldRefusal,
			ctx.handlers.reject
		),
		build(
			"withdraw",
			"Withdraw",
			"destructive",
			move("Cancelled", "withdrawn") ?? ctx.soldRefusal,
			ctx.handlers.withdraw
		),
	];
}
