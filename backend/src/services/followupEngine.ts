// ============================================================================
// Followup engine — pure, unit-testable scheduling + decision helpers.
// No direct DB access except evaluateAnchorStop, which takes an injectable
// scoped-db-like object so it can be mocked in tests.
// ============================================================================

export type DelayUnit = "hours" | "days";

export interface StepTiming {
	delay_amount: number;
	delay_unit: string; // "hours" | "days"
}

export interface StepDecisionInput {
	condition: string; // followup_step_condition: "always" | "if_previous_not_opened"
}

export interface SequenceMode {
	trigger_type: string; // followup_trigger_type
	stop_on_open: boolean;
}

/** Convert a step delay into milliseconds. Unknown units fall back to days. */
export function delayToMs(amount: number, unit: string): number {
	const HOUR = 60 * 60 * 1000;
	const DAY = 24 * HOUR;
	return unit === "hours" ? amount * HOUR : amount * DAY;
}

/** "After-base" timing: base + step delay (used by manual / entity-triggered / date_based chains). */
export function computeNextSendAt(step: StepTiming, from: Date): Date {
	return new Date(from.getTime() + delayToMs(step.delay_amount, step.delay_unit));
}

/** "Before-anchor" timing: anchor - step delay (used by visit reminders — e.g. 1 day before the visit). */
export function computeReminderSendAt(anchorAt: Date, step: StepTiming): Date {
	return new Date(anchorAt.getTime() - delayToMs(step.delay_amount, step.delay_unit));
}

/** Reminder sequences fire relative to (before) their anchor; everything else chains after a base time. */
export function isBeforeAnchor(triggerType: string): boolean {
	return triggerType === "visit_scheduled";
}

/**
 * Resolve when a given step should fire.
 * - before-anchor (reminders): anchorAt - delay. Falls back to base when anchorAt is missing.
 * - after-base (everything else): base + delay.
 */
export function resolveStepSendAt(
	sequence: SequenceMode,
	step: StepTiming,
	ctx: { base: Date; anchorAt: Date | null },
): Date {
	if (isBeforeAnchor(sequence.trigger_type)) {
		return ctx.anchorAt ? computeReminderSendAt(ctx.anchorAt, step) : ctx.base;
	}
	return computeNextSendAt(step, ctx.base);
}

export type StepAction = "send" | "stop";

export interface StepDecision {
	action: StepAction;
	reason?: string;
}

/**
 * Decide whether to send the next step, given the previous send's open state.
 * Opens-only chaining: we nudge until the recipient opens. An open ends the chain
 * when the sequence stops-on-open, or when the step is gated on "if previous not opened".
 */
export function decideStep(
	step: StepDecisionInput,
	prevSend: { opened_at: Date | null } | null,
	sequence: SequenceMode,
): StepDecision {
	const opened = !!prevSend?.opened_at;
	if (opened && sequence.stop_on_open) return { action: "stop", reason: "recipient_opened" };
	if (opened && step.condition === "if_previous_not_opened") return { action: "stop", reason: "recipient_opened" };
	return { action: "send" };
}

// ── Recipient resolution ────────────────────────────────────────────────────

export interface ContactLink {
	is_primary?: boolean;
	is_billing?: boolean;
	contact?: { email?: string | null } | null;
}

/**
 * Pick a client's best followup recipient email. Prefers the primary contact,
 * then the billing contact, then the first contact — but only among contacts that
 * actually HAVE an email, so a primary contact with a null email doesn't block the
 * followup when another contact has a usable address.
 */
export function resolveContactEmail(contacts: ContactLink[]): string | null {
	const withEmail = contacts.filter((c) => !!c.contact?.email);
	if (withEmail.length === 0) return null;
	const primary = withEmail.find((c) => c.is_primary);
	const billing = withEmail.find((c) => c.is_billing);
	return (primary ?? billing ?? withEmail[0]).contact!.email!;
}

// ── Anchor stop evaluation ──────────────────────────────────────────────────

/** Minimal shape of the (scoped) db needed to look up anchor entity statuses. */
export interface AnchorLookupDb {
	quote: { findUnique(args: { where: { id: string }; select: { status: true } }): Promise<{ status: string } | null> };
	invoice: { findUnique(args: { where: { id: string }; select: { status: true } }): Promise<{ status: string } | null> };
	request: { findUnique(args: { where: { id: string }; select: { status: true } }): Promise<{ status: string } | null> };
	job_visit: { findUnique(args: { where: { id: string }; select: { status: true } }): Promise<{ status: string } | null> };
}

// Statuses that mean "the followup goal is resolved — stop chasing".
// Not the same thing as terminal: a Disputed quote is very much alive, but
// chasing the client about a document they are contesting is the wrong email,
// and a Revised one has been superseded — the replacement enrolls on its own
// send. Neither can ever return to Sent, so stopping here strands nothing.
const QUOTE_STOP_CHASING = new Set([
	"Approved",
	"Rejected",
	"Cancelled",
	"Expired",
	"Disputed",
	"Revised",
]);
// Same reasoning as QUOTE_STOP_CHASING: dunning a client for a balance they
// are actively contesting is the wrong email. Disputed is not terminal — the
// invoice returns to status_at_open after an adjustment — but stopping the
// enrollment here strands nothing, because an actual re-send re-enrolls it.
const INVOICE_STOP_CHASING = new Set(["Paid", "Void", "Disputed"]);
const VISIT_TERMINAL = new Set(["Cancelled", "Completed"]);
// A request should still be chased only while it is New/Reviewing.
const REQUEST_ACTIVE = new Set(["New", "Reviewing"]);

/**
 * Returns a stop reason string if the enrollment's anchor entity has resolved
 * (so we should stop chasing), or null to keep going. No anchor => never stops here.
 */
export async function evaluateAnchorStop(
	anchorType: string | null,
	anchorId: string | null,
	db: AnchorLookupDb,
): Promise<string | null> {
	if (!anchorType || !anchorId) return null;

	switch (anchorType) {
		case "quote": {
			const q = await db.quote.findUnique({ where: { id: anchorId }, select: { status: true } });
			if (!q) return "quote_missing";
			return QUOTE_STOP_CHASING.has(q.status) ? `quote_${q.status.toLowerCase()}` : null;
		}
		case "invoice": {
			const inv = await db.invoice.findUnique({ where: { id: anchorId }, select: { status: true } });
			if (!inv) return "invoice_missing";
			return INVOICE_STOP_CHASING.has(inv.status) ? `invoice_${inv.status.toLowerCase()}` : null;
		}
		case "request": {
			const r = await db.request.findUnique({ where: { id: anchorId }, select: { status: true } });
			if (!r) return "request_missing";
			return REQUEST_ACTIVE.has(r.status) ? null : `request_${r.status.toLowerCase()}`;
		}
		case "job_visit": {
			const v = await db.job_visit.findUnique({ where: { id: anchorId }, select: { status: true } });
			if (!v) return "visit_missing";
			return VISIT_TERMINAL.has(v.status) ? `visit_${v.status.toLowerCase()}` : null;
		}
		default:
			return null;
	}
}
