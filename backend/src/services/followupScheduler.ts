import { isModuleOn } from "./entitlementService.js";
import { lastReenabledAt } from "./moduleWindowService.js";
import { db } from "../db.js";
import { getScopedDb } from "../lib/context.js";
import { sendRenderedTracked } from "./emailService.js";
import { getOrgBrandModel } from "./emailBranding.js";
import { getEffectiveTemplate } from "./followupTemplates.js";
import { renderTemplate } from "./templateRenderer.js";
import type { email_template_category } from "../../generated/prisma/client.js";
import {
	decideStep,
	evaluateAnchorStop,
	resolveStepSendAt,
	isBeforeAnchor,
	computeReminderSendAt,
	type AnchorLookupDb,
} from "./followupEngine.js";
import { logActivity } from "./logger.js";
import { log } from "./appLogger.js";
import { expireStaleQuotes } from "./quoteExpiry.js";

// Max enrollments processed per sweep — keeps a single tick bounded.
const BATCH_LIMIT = 200;
// While an enrollment is being sent, its next_send_at is pushed out by this lease
// so a concurrent tick (or a crash mid-send) can't double-send within the window.
const LEASE_MS = 15 * 60 * 1000;
// On a transient send failure, retry the same step after this delay.
const RETRY_DELAY_MS = 60 * 60 * 1000;
// After this many failed attempts on one step, give up and mark the enrollment failed.
const MAX_STEP_ATTEMPTS = 3;
// Sweep cadence.
const INTERVAL_MS = 5 * 60 * 1000;
// A "before the visit" reminder step whose send time has already passed by more
// than this grace is skipped (not blasted late) when a later reminder still lies
// ahead — otherwise enrolling close to a visit fires every earlier reminder at once.
const REMINDER_STALE_GRACE_MS = 10 * 60 * 1000;

// Delivery semantics: this scheduler is AT-LEAST-ONCE. The email is sent outside
// the DB transaction that records/advances the step. A successful send followed by
// a post-send DB failure advances the enrollment (no re-send); but a hard process
// crash between send and the lease-guarded advance can re-send the same step after
// the lease lapses. Postmark has no idempotency key here, so rare duplicates are
// possible by design. The lease + "advance-on-post-send-failure" path keep this rare.

type FinishStatus = "completed" | "stopped" | "failed";

/** Terminate an enrollment (no further sends) with the appropriate timestamp/reason. */
async function finishEnrollment(id: string, status: FinishStatus, reason?: string): Promise<void> {
	const now = new Date();
	await db.followup_enrollment.update({
		where: { id },
		data: {
			status,
			next_send_at: null,
			// Record the reason on every terminal state — for a completed enrollment
			// it distinguishes "recipient_opened" from "all_steps_sent" in the UI.
			...(reason !== undefined ? { stop_reason: reason } : {}),
			...(status === "completed" ? { completed_at: now } : {}),
			...(status === "stopped" ? { stopped_at: now } : {}),
		},
	});
}

type DueEnrollment = Awaited<ReturnType<typeof db.followup_enrollment.findMany>>[number];

interface SeqWithSteps {
	trigger_type: string;
	stop_on_open: boolean;
	steps: { id: string; step_order: number; delay_amount: number; delay_unit: string }[];
}

/**
 * Build the enrollment update that moves past `justSentOrder`: either schedule the
 * next step, or complete the enrollment when none remain. Shared by the send and
 * skip paths so the "advance vs complete" transition lives in exactly one place.
 */
function buildAdvanceData(
	seq: SeqWithSteps,
	justSentOrder: number,
	now: Date,
	anchorAt: Date | null,
) {
	const stepAfter = seq.steps.find((s) => s.step_order > justSentOrder);
	return stepAfter
		? {
				current_step_order: justSentOrder,
				next_send_at: resolveStepSendAt(seq, stepAfter, { base: now, anchorAt }),
			}
		: {
				current_step_order: justSentOrder,
				status: "completed" as const,
				completed_at: now,
				next_send_at: null,
			};
}

/**
 * Process one due enrollment: stop-check the anchor, evaluate the next step's
 * open-gate, claim it (lease), send the templated email, then record the send and
 * advance to the next step (or complete). All side effects are best-effort and
 * isolated per enrollment so one failure never blocks the rest of the batch.
 */
async function processEnrollment(enrollment: DueEnrollment, now: Date): Promise<void> {
	const orgId = enrollment.organization_id;
	if (!orgId) return;
	// Left queued, not stopped: the org may switch Followups back on.
	if (!(await isModuleOn(orgId, "followups"))) return;
	const sdb = getScopedDb(orgId);

	// 1. Stop if the anchor entity has resolved (quote approved, invoice paid, visit cancelled, …).
	const anchorStop = await evaluateAnchorStop(
		enrollment.anchor_entity_type,
		enrollment.anchor_entity_id,
		sdb as unknown as AnchorLookupDb,
	);
	if (anchorStop) {
		await finishEnrollment(enrollment.id, "stopped", anchorStop);
		return;
	}

	// 2. Load the sequence + ordered steps; stop if it's gone or disabled.
	//    findFirst (not findUnique) so the org-scoped extension actually filters.
	const seq = await sdb.followup_sequence.findFirst({
		where: { id: enrollment.sequence_id },
		include: { steps: { orderBy: { step_order: "asc" } } },
	});
	if (!seq) {
		await finishEnrollment(enrollment.id, "stopped", "sequence_deleted");
		return;
	}
	if (!seq.is_active) {
		await finishEnrollment(enrollment.id, "stopped", "sequence_inactive");
		return;
	}

	// 3. Determine the next step; complete if none remain.
	const nextStep = seq.steps.find((s) => s.step_order > enrollment.current_step_order);
	if (!nextStep) {
		await finishEnrollment(enrollment.id, "completed", "all_steps_sent");
		return;
	}

	// 4. Open-gate: an already-opened chain ends here (opens-only chaining).
	const prevSend = await sdb.followup_send.findFirst({
		where: { enrollment_id: enrollment.id, status: "sent" },
		orderBy: { sent_at: "desc" },
		select: { opened_at: true },
	});
	const decision = decideStep(nextStep, prevSend, seq);
	if (decision.action === "stop") {
		await finishEnrollment(enrollment.id, "completed", decision.reason);
		return;
	}

	// 5. Claim: lease the enrollment by pushing next_send_at out, guarded on its
	//    current value so exactly one concurrent tick wins. Use claim-time (not the
	//    batch-start `now`) so the lease is always a real 15 min into the future,
	//    even on a slow batch.
	const claim = await db.followup_enrollment.updateMany({
		where: { id: enrollment.id, status: "active", next_send_at: enrollment.next_send_at },
		data: { next_send_at: new Date(Date.now() + LEASE_MS) },
	});
	if (claim.count === 0) return; // another tick claimed it

	// A step that fell due while the org had Followups switched off is never sent
	// late. After the skip the next step is timed from now, so it cannot match again.
	const reenabledAt = await lastReenabledAt(orgId, "followups");
	if (reenabledAt && enrollment.next_send_at && enrollment.next_send_at < reenabledAt) {
		await recordSkipAndAdvance(enrollment, seq, nextStep, now, "module_was_off");
		return;
	}

	// 6. Reminder de-burst: for "before the visit" sequences enrolled close to the
	//    visit, an early reminder step's send time may already be well past. Skip it
	//    (rather than blasting it late) as long as a later reminder still lies ahead.
	if (isBeforeAnchor(seq.trigger_type) && enrollment.anchor_at) {
		const thisSendAt = computeReminderSendAt(enrollment.anchor_at, nextStep);
		const hasLaterStep = seq.steps.some((s) => s.step_order > nextStep.step_order);
		if (hasLaterStep && thisSendAt.getTime() < now.getTime() - REMINDER_STALE_GRACE_MS) {
			await recordSkipAndAdvance(enrollment, seq, nextStep, now, "reminder_window_passed");
			return;
		}
	}

	// 7. The step's category IS the Postmark template alias.
	const templateAlias = nextStep.category;

	if (!enrollment.recipient_email) {
		await finishEnrollment(enrollment.id, "failed", "no_recipient_email");
		return;
	}

	// 8. Build the branded template model, render the org's template for this
	//    category, and send. Branding (logo, accent, contact) + client variables are
	//    substituted into our own template HTML (DB override or built-in default),
	//    then sent via Postmark HtmlBody with open tracking.
	const brand = await getOrgBrandModel(orgId);
	const client = await sdb.client.findFirst({
		where: { id: enrollment.client_id },
		select: { name: true },
	});
	const model: Record<string, unknown> = {
		...brand,
		client_name: client?.name ?? "",
		recipient_email: enrollment.recipient_email,
		anchor_type: enrollment.anchor_entity_type ?? null,
	};

	const template = await getEffectiveTemplate(orgId, templateAlias as email_template_category);
	const subject = renderTemplate(template.subject, model);
	const html = renderTemplate(template.html, model);
	// Render the custom plain-text body when the template has one; otherwise leave
	// it null so the send path auto-generates the text alternative from the HTML.
	const text = template.text ? renderTemplate(template.text, model) : null;

	// The send and the DB record/advance are deliberately in SEPARATE try blocks:
	// a send failure is safe to retry (no email went out); a post-send DB failure
	// must NOT re-send, so we advance best-effort instead of routing to retry.
	let messageId: string | null;
	try {
		({ messageId } = await sendRenderedTracked(enrollment.recipient_email, subject, html, text, {
			metadata: {
				enrollment_id: enrollment.id,
				step_order: String(nextStep.step_order),
				organization_id: orgId,
			},
		}));
	} catch (err) {
		await handleSendFailure(enrollment, nextStep.id, orgId, now, err);
		return;
	}

	const advance = buildAdvanceData(seq, nextStep.step_order, now, enrollment.anchor_at);
	try {
		// Record the send + advance atomically.
		await db.$transaction(async (tx) => {
			await tx.followup_send.create({
				data: {
					organization_id: orgId,
					enrollment_id: enrollment.id,
					step_id: nextStep.id,
					template_alias: templateAlias,
					recipient_email: enrollment.recipient_email,
					postmark_message_id: messageId,
					status: "sent",
				},
			});
			await tx.followup_enrollment.update({ where: { id: enrollment.id }, data: advance });
		});
	} catch (err) {
		// Email WAS sent. Never re-send this step: advance best-effort (outside a tx)
		// so the chain continues and the next sweep won't re-fire the same step.
		log.error(
			{ err, enrollment_id: enrollment.id, step_id: nextStep.id, messageId },
			"Followup email sent but recording/advance failed — advancing to avoid re-send",
		);
		await db.followup_send
			.create({
				data: {
					organization_id: orgId,
					enrollment_id: enrollment.id,
					step_id: nextStep.id,
					template_alias: templateAlias,
					recipient_email: enrollment.recipient_email,
					postmark_message_id: messageId,
					status: "sent",
				},
			})
			.catch((e) => log.error({ err: e, enrollment_id: enrollment.id }, "failed to record sent followup"));
		await db.followup_enrollment
			.update({ where: { id: enrollment.id }, data: advance })
			.catch((e) => log.error({ err: e, enrollment_id: enrollment.id }, "failed to advance followup after send"));
		return;
	}

	logActivity({
		event_type: "followup.sent",
		action: "sent",
		entity_type: "followup_enrollment",
		entity_id: enrollment.id,
		organization_id: orgId,
		actor_type: "system",
		actor_id: null,
		changes: {
			step_order: { old: null, new: nextStep.step_order },
			template: { old: null, new: templateAlias },
		},
	}).catch((e) => log.warn({ err: e, enrollment_id: enrollment.id }, "followup send logged but activity log failed"));
}

/** Record a skipped step (e.g. template deleted, reminder window passed) and move on. */
async function recordSkipAndAdvance(
	enrollment: DueEnrollment,
	seq: SeqWithSteps,
	step: { id: string; step_order: number },
	now: Date,
	reason: string,
): Promise<void> {
	const orgId = enrollment.organization_id!;
	const advance = buildAdvanceData(seq, step.step_order, now, enrollment.anchor_at);
	await db.$transaction(async (tx) => {
		await tx.followup_send.create({
			data: {
				organization_id: orgId,
				enrollment_id: enrollment.id,
				step_id: step.id,
				recipient_email: enrollment.recipient_email,
				status: "skipped",
				error: reason,
			},
		});
		await tx.followup_enrollment.update({ where: { id: enrollment.id }, data: advance });
	});
}

/** Record a failed send and either schedule a retry of the same step or give up. */
async function handleSendFailure(
	enrollment: DueEnrollment,
	stepId: string,
	orgId: string,
	now: Date,
	err: unknown,
): Promise<void> {
	const message = err instanceof Error ? err.message : String(err);
	log.error({ err, enrollment_id: enrollment.id, step_id: stepId }, "Followup send failed");

	const priorFailures = await db.followup_send.count({
		where: { enrollment_id: enrollment.id, step_id: stepId, status: "failed" },
	});
	await db.followup_send.create({
		data: {
			organization_id: orgId,
			enrollment_id: enrollment.id,
			step_id: stepId,
			recipient_email: enrollment.recipient_email,
			status: "failed",
			error: message.slice(0, 500),
		},
	});

	if (priorFailures + 1 >= MAX_STEP_ATTEMPTS) {
		await finishEnrollment(enrollment.id, "failed", "max_send_attempts");
	} else {
		// current_step_order stays put so the same step is retried after the delay.
		await db.followup_enrollment.update({
			where: { id: enrollment.id },
			data: { next_send_at: new Date(now.getTime() + RETRY_DELAY_MS) },
		});
	}
}

/**
 * Sweep due enrollments. Unscoped cross-org read (system process); each enrollment
 * is then processed under its own org scope. Sequential to keep DB load predictable
 * and avoid interleaving transactions on the same rows.
 */
export async function runDueFollowups(): Promise<void> {
	const now = new Date();
	const due = await db.followup_enrollment.findMany({
		where: { status: "active", next_send_at: { lte: now } },
		orderBy: { next_send_at: "asc" },
		take: BATCH_LIMIT,
	});
	if (due.length === 0) return;

	log.info({ count: due.length }, "Processing due followups");

	for (const enrollment of due) {
		try {
			await processEnrollment(enrollment, now);
		} catch (err) {
			log.error({ err, enrollment_id: enrollment.id }, "Followup enrollment processing failed — continuing");
		}
	}
}

/** Start the followup scheduler: a startup catch-up run, then a sweep every 5 minutes. */
export function startFollowupSchedulerInterval(): void {
	runDueFollowups().catch((err) => log.error({ err }, "Followup scheduler startup run failed"));
	// Piggybacks on the same tick — an unrelated sweep, but there's no other
	// scheduler in the process to hang it off, and a failure here must never
	// stop followups from running.
	expireStaleQuotes().catch((err) => log.error({ err }, "Quote expiry sweep failed"));

	setInterval(() => {
		runDueFollowups().catch((err) => log.error({ err }, "Followup scheduler interval run failed"));
		expireStaleQuotes().catch((err) => log.error({ err }, "Quote expiry sweep failed"));
	}, INTERVAL_MS);
}
