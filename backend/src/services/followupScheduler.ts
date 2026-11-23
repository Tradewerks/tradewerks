import { isModuleOn } from "./entitlementService.js";
import { lastReenabledAt } from "./moduleWindowService.js";
import { db } from "../db.js";
import { getScopedDb } from "../lib/context.js";
import { sendRenderedTracked } from "./emailService.js";
import { canSend } from "./consentService.js";
import { getOrgBrandModel } from "./emailBranding.js";
import { issueLink, unsubscribeHeaders } from "../lib/publicLink.js";
import { getEffectiveTemplate } from "./followupTemplates.js";
import { renderTemplate } from "./templateRenderer.js";
import { buildVisitModel } from "./visitMessageModel.js";
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
// than this grace is skipped, not blasted late — otherwise enrolling close to a
// visit fires every earlier reminder at once.
const REMINDER_STALE_GRACE_MS = 10 * 60 * 1000;

// Delivery semantics: at-most-once per step and anchor. A "sending" row is written
// before the Postmark call and a partial unique index allows one live row per step.
// A crash between send and record leaves that row; the next sweep marks it
// outcome_unknown and advances instead of re-sending. A successful send followed by
// a post-send DB failure also advances (no re-send).

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
 * Advance only while this worker still holds the lease it set: a stale worker whose
 * lease lapsed must not overwrite an advance made by whoever re-claimed the step.
 */
function guardedAdvance(
	client: Pick<typeof db, "followup_enrollment">,
	id: string,
	leaseAt: Date,
	data: ReturnType<typeof buildAdvanceData>,
) {
	return client.followup_enrollment.updateMany({ where: { id, next_send_at: leaseAt }, data });
}

/**
 * A live (sending or sent) row for this step and anchor means the step must not go
 * out again. "sending" that outlived the lease is a worker that died between the
 * Postmark call and recording it: the outcome is unknowable, so it counts as sent (a
 * missed reminder beats a duplicate). "sent" is a recorded send whose advance never
 * landed. Either way, advance past the step. Returns false when no live row exists.
 */
async function advanceOverLiveRow(
	enrollment: DueEnrollment,
	seq: SeqWithSteps,
	step: { id: string; step_order: number },
	now: Date,
	leaseAt: Date,
): Promise<boolean> {
	const sdb = getScopedDb(enrollment.organization_id!);
	const live = await sdb.followup_send.findFirst({
		where: {
			enrollment_id: enrollment.id,
			step_id: step.id,
			status: { in: ["sending", "sent"] },
			anchor_at: enrollment.anchor_at,
		},
		select: { id: true, status: true },
	});
	if (!live) return false;
	log.warn(
		{ enrollment_id: enrollment.id, step_id: step.id, status: live.status },
		"Followup step already has a live send row — advancing without sending",
	);
	const advance = buildAdvanceData(seq, step.step_order, now, enrollment.anchor_at);
	await db.$transaction(async (tx) => {
		if (live.status === "sending") {
			await tx.followup_send.update({
				where: { id: live.id },
				data: { status: "sent", error: "outcome_unknown" },
			});
		}
		await guardedAdvance(tx, enrollment.id, leaseAt, advance);
	});
	return true;
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
	const leaseAt = new Date(Date.now() + LEASE_MS);
	const claim = await db.followup_enrollment.updateMany({
		where: { id: enrollment.id, status: "active", next_send_at: enrollment.next_send_at },
		data: { next_send_at: leaseAt },
	});
	if (claim.count === 0) return; // another tick claimed it

	if (await advanceOverLiveRow(enrollment, seq, nextStep, now, leaseAt)) return;

	// A step that fell due while the org had Followups switched off is never sent
	// late. After the skip the next step is timed from now, so it cannot match again.
	const reenabledAt = await lastReenabledAt(orgId, "followups");
	if (reenabledAt && enrollment.next_send_at && enrollment.next_send_at < reenabledAt) {
		await recordSkipAndAdvance(enrollment, seq, nextStep, now, "module_was_off");
		return;
	}

	// 6. Reminder de-burst: for "before the visit" sequences enrolled close to the
	//    visit, an early reminder step's send time may already be well past. Skip it
	//    (rather than blasting it late). Applies to the last step too: a lone
	//    "1 day before" reminder must not go out an hour before the visit.
	if (isBeforeAnchor(seq.trigger_type) && enrollment.anchor_at) {
		const thisSendAt = computeReminderSendAt(enrollment.anchor_at, nextStep);
		if (thisSendAt.getTime() < now.getTime() - REMINDER_STALE_GRACE_MS) {
			await recordSkipAndAdvance(enrollment, seq, nextStep, now, "reminder_window_passed");
			return;
		}
	}

	// 7. The step's category IS the Postmark template alias.
	const templateAlias = nextStep.category;

	// Read the contact's CURRENT email: it may have been edited, deactivated or
	// deleted since enrollment. recipient_email is only the fallback for
	// enrollments with no contact (manual override, or enrolled before contact_id).
	let recipient = enrollment.recipient_email;
	if (enrollment.contact_id) {
		const contact = await sdb.contact.findFirst({
			where: { id: enrollment.contact_id },
			select: { email: true, is_active: true, type: true },
		});
		recipient = contact && contact.is_active && contact.type !== "vendor" ? (contact.email ?? "") : "";
	}
	if (!recipient) {
		await finishEnrollment(enrollment.id, "failed", "no_recipient_email");
		return;
	}

	// Consent is read at send time: an unsubscribe or bounce after enrollment
	// must stop the chain even though the enrollment itself predates it.
	if (await isEmailSuppressed(sdb, enrollment.contact_id, recipient)) {
		await db.followup_send.create({
			data: {
				organization_id: orgId,
				enrollment_id: enrollment.id,
				step_id: nextStep.id,
				recipient_email: recipient,
				status: "skipped",
				error: "unsubscribed",
			},
		});
		await finishEnrollment(enrollment.id, "stopped", "unsubscribed");
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
		recipient_email: recipient,
		anchor_type: enrollment.anchor_entity_type ?? null,
		unsubscribe_url: "",
	};
	// The link is keyed to a contact, so an enrollment with only a raw recipient
	// address goes out without one. A throw here (no PUBLIC_LINK_SECRET) leaves the
	// step unsent until the lease lapses rather than mailing with no way to opt out.
	let headers: { Name: string; Value: string }[] | undefined;
	// Enrollments created without a contact borrow the org contact that owns
	// the address, so the recipient still gets a working opt-out.
	const unsubContactId =
		enrollment.contact_id ??
		(
			await sdb.contact.findFirst({
				where: {
					email: { equals: recipient, mode: "insensitive" },
					is_active: true,
					OR: [{ type: null }, { type: { not: "vendor" } }],
				},
				select: { id: true },
				orderBy: { created_at: "asc" },
			})
		)?.id ??
		null;
	if (unsubContactId) {
		const link = await issueLink(orgId, {
			purpose: "unsubscribe",
			entityId: unsubContactId,
			contactId: unsubContactId,
		});
		model.unsubscribe_url = link.url;
		headers = unsubscribeHeaders(link.token);
	}
	if (enrollment.anchor_entity_type === "job_visit" && enrollment.anchor_entity_id) {
		const org = await db.organization.findUnique({
			where: { id: orgId },
			select: { timezone: true },
		});
		const visitModel = org
			? await buildVisitModel(sdb, enrollment.anchor_entity_id, org.timezone)
			: null;
		if (!visitModel) {
			// A reminder with no visit to describe would go out with blank times
			await db.followup_send.create({
				data: {
					organization_id: orgId,
					enrollment_id: enrollment.id,
					step_id: nextStep.id,
					recipient_email: recipient,
					status: "skipped",
					error: "visit_not_found",
				},
			});
			await finishEnrollment(enrollment.id, "stopped", "visit_not_found");
			return;
		}
		Object.assign(model, visitModel);
	}

	const template = await getEffectiveTemplate(orgId, templateAlias as email_template_category);
	const subject = renderTemplate(template.subject, model, { escape: false });
	const html = renderTemplate(template.html, model);
	// Render the custom plain-text body when the template has one; otherwise leave
	// it null so the send path auto-generates the text alternative from the HTML.
	// Plain text isn't HTML: escaping would show "Smith &amp; Sons" literally.
	const text = template.text ? renderTemplate(template.text, model, { escape: false }) : null;

	// The send and the DB record/advance are deliberately in SEPARATE try blocks:
	// a send failure is safe to retry (no email went out); a post-send DB failure
	// must NOT re-send, so we advance best-effort instead of routing to retry.
	// The "sending" row is written first so a crash mid-send leaves evidence; the
	// partial unique index (see schema comment) rejects it if another worker holds
	// this step for this anchor.
	let sendRowId: string;
	try {
		({ id: sendRowId } = await db.followup_send.create({
			data: {
				organization_id: orgId,
				enrollment_id: enrollment.id,
				step_id: nextStep.id,
				template_alias: templateAlias,
				recipient_email: recipient,
				status: "sending",
				anchor_at: enrollment.anchor_at,
			},
			select: { id: true },
		}));
	} catch (err) {
		if ((err as { code?: string }).code === "P2002") {
			// The lease already serializes workers, so a live row exists: advance over it.
			await advanceOverLiveRow(enrollment, seq, nextStep, now, leaseAt);
			return;
		}
		throw err;
	}

	let messageId: string | null;
	try {
		({ messageId } = await sendRenderedTracked(recipient, subject, html, text, {
			metadata: {
				enrollment_id: enrollment.id,
				step_order: String(nextStep.step_order),
				organization_id: orgId,
			},
			fromName: brand.brand.name,
			replyTo: brand.brand.reply_to,
			...(headers ? { headers } : {}),
		}));
	} catch (err) {
		await handleSendFailure(enrollment, nextStep.id, sendRowId, now, err);
		return;
	}

	const advance = buildAdvanceData(seq, nextStep.step_order, now, enrollment.anchor_at);
	const sentData = { status: "sent" as const,
		postmark_message_id: messageId,
		sent_at: new Date(),
		error: null,
	};
	try {
		// Record the send + advance atomically.
		await db.$transaction(async (tx) => {
			await tx.followup_send.update({ where: { id: sendRowId }, data: sentData });
			await guardedAdvance(tx, enrollment.id, leaseAt, advance);
		});
	} catch (err) {
		// Email WAS sent. Never re-send this step: advance best-effort (outside a tx)
		// so the chain continues and the next sweep won't re-fire the same step.
		log.error(
			{ err, enrollment_id: enrollment.id, step_id: nextStep.id, messageId },
			"Followup email sent but recording/advance failed — advancing to avoid re-send",
		);
		await db.followup_send
			.update({ where: { id: sendRowId }, data: sentData })
			.catch((e) => log.error({ err: e, enrollment_id: enrollment.id }, "failed to record sent followup"));
		await guardedAdvance(db, enrollment.id, leaseAt, advance)
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

/**
 * An enrollment with no contact still honours opt-outs: any org contact sharing
 * the address that is unsubscribed blocks the send.
 */
async function isEmailSuppressed(
	sdb: ReturnType<typeof getScopedDb>,
	contactId: string | null,
	recipient: string,
): Promise<boolean> {
	if (contactId) return !(await canSend(sdb, contactId, "email"));
	const matches = await sdb.contact.findMany({
		where: { email: { equals: recipient, mode: "insensitive" } },
		select: { id: true },
	});
	for (const m of matches) {
		if (!(await canSend(sdb, m.id, "email"))) return true;
	}
	return false;
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
	sendRowId: string,
	now: Date,
	err: unknown,
): Promise<void> {
	const message = err instanceof Error ? err.message : String(err);
	log.error({ err, enrollment_id: enrollment.id, step_id: stepId }, "Followup send failed");

	const priorFailures = await db.followup_send.count({
		where: { enrollment_id: enrollment.id, step_id: stepId, status: "failed" },
	});
	await db.followup_send
		.update({
			where: { id: sendRowId },
			data: { status: "failed", error: message.slice(0, 500) },
		})
		.catch((e) =>
			log.error({ err: e, enrollment_id: enrollment.id, step_id: stepId }, "failed to record failed followup send"),
		);

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
	if (!process.env.PUBLIC_LINK_SECRET) {
		log.warn("PUBLIC_LINK_SECRET is not set: followup emails to contacts cannot be sent");
	}
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
