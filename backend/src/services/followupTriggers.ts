import { getScopedDb } from "../lib/context.js";
import { Prisma, followup_trigger_type } from "../../generated/prisma/client.js";
import { resolveStepSendAt, resolveContactEmail } from "./followupEngine.js";
import { log } from "./appLogger.js";
import { isModuleOn } from "./entitlementService.js";

// ============================================================================
// Followup triggers — best-effort hooks called from entity controllers to
// auto-enroll clients into followup sequences on lifecycle events.
//
// These NEVER throw into the caller: every entry point wraps its work in run()
// so a followup failure can never break a quote send, invoice send, etc.
//
// Stopping an enrollment when its anchor resolves (quote approved, invoice paid,
// visit cancelled) is handled centrally by the scheduler's evaluateAnchorStop —
// it runs before every send — so only "enroll" and reminder time-tracking live
// here. The one exception is visit reschedule, where the reminder's send time
// must move with the visit; that recompute is done in onVisitRescheduled.
// ============================================================================

type ScopedDb = ReturnType<typeof getScopedDb>;

/**
 * Fire-and-forget wrapper: log failures, never propagate to the caller. Returns
 * the (already-caught, non-rejecting) promise so tests can await completion;
 * call sites intentionally ignore it.
 */
function run(fn: () => Promise<void>, label: string, ctx: Record<string, unknown>): Promise<void> {
	return fn().catch((err) => log.error({ err, ...ctx }, `followup trigger ${label} failed`));
}

const orgFollowupsEnabled = (orgId: string): Promise<boolean> => isModuleOn(orgId, "followups");

/** Pick a client's best contact email (primary → billing → first, among those with an email). */
async function resolveClientRecipient(sdb: ScopedDb, clientId: string): Promise<string | null> {
	const client = await sdb.client.findFirst({
		where: { id: clientId },
		include: { contacts: { include: { contact: true } } },
	});
	if (!client) return null;
	return resolveContactEmail(client.contacts);
}

// Reasons that mean "this address should not be contacted again" — a re-fired
// trigger must not resurrect a chain that was stopped for a deliverability problem.
const SUPPRESSED_STOP_REASONS = ["bounce", "spam_complaint"];

interface EnrollParams {
	orgId: string;
	triggerType: followup_trigger_type;
	clientId: string;
	anchorEntityType: string;
	anchorEntityId: string;
	anchorAt?: Date | null;
}

/**
 * Enroll a client into every active sequence with the given trigger type.
 * Gated on the org's Followups module. Duplicate active
 * enrollments for the same (sequence, anchor) are prevented by a partial unique
 * index and silently skipped, so re-firing a trigger is safe/idempotent.
 */
async function enrollForTrigger(p: EnrollParams): Promise<void> {
	if (!(await orgFollowupsEnabled(p.orgId))) return;

	const sdb = getScopedDb(p.orgId);
	const sequences = await sdb.followup_sequence.findMany({
		where: { trigger_type: p.triggerType, is_active: true },
		include: { steps: { orderBy: { step_order: "asc" } } },
	});
	if (sequences.length === 0) return;

	const recipient = await resolveClientRecipient(sdb, p.clientId);
	if (!recipient) {
		log.warn({ orgId: p.orgId, clientId: p.clientId, trigger: p.triggerType }, "followup trigger: no recipient email");
		return;
	}

	// Suppress re-enrollment against this anchor if a prior enrollment for it was
	// stopped for a deliverability reason (bounce/spam) — never re-chase that address.
	// Also lets us skip anchors that already have an active enrollment without relying
	// solely on the partial unique index (which a `prisma db push` could drop).
	const priorEnrollments = await sdb.followup_enrollment.findMany({
		where: {
			anchor_entity_type: p.anchorEntityType,
			anchor_entity_id: p.anchorEntityId,
			sequence_id: { in: sequences.map((s) => s.id) },
		},
		select: { sequence_id: true, status: true, stop_reason: true },
	});
	const activeSequenceIds = new Set(
		priorEnrollments.filter((e) => e.status === "active").map((e) => e.sequence_id),
	);
	const suppressedSequenceIds = new Set(
		priorEnrollments
			.filter((e) => e.stop_reason && SUPPRESSED_STOP_REASONS.includes(e.stop_reason))
			.map((e) => e.sequence_id),
	);

	const now = new Date();
	const anchorAt = p.anchorAt ?? null;

	for (const seq of sequences) {
		if (seq.steps.length === 0) continue;
		if (activeSequenceIds.has(seq.id) || suppressedSequenceIds.has(seq.id)) continue;
		const next_send_at = resolveStepSendAt(seq, seq.steps[0], { base: now, anchorAt });
		try {
			await sdb.followup_enrollment.create({
				data: {
					organization_id: p.orgId,
					sequence_id: seq.id,
					client_id: p.clientId,
					recipient_email: recipient,
					status: "active",
					current_step_order: 0,
					next_send_at,
					anchor_at: anchorAt,
					anchor_entity_type: p.anchorEntityType,
					anchor_entity_id: p.anchorEntityId,
					enrolled_by_dispatcher_id: null, // system/auto
				},
			});
		} catch (e) {
			// Partial unique index (one active enrollment per sequence+anchor) — skip dupes.
			if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue;
			throw e;
		}
	}
}

// ── Entity enroll triggers ──────────────────────────────────────────────────

export function onQuoteSent(quoteId: string, orgId: string): Promise<void> {
	return run(
		async () => {
			const sdb = getScopedDb(orgId);
			const quote = await sdb.quote.findFirst({ where: { id: quoteId }, select: { client_id: true } });
			if (!quote) return;
			await enrollForTrigger({
				orgId,
				triggerType: "quote_sent",
				clientId: quote.client_id,
				anchorEntityType: "quote",
				anchorEntityId: quoteId,
			});
		},
		"onQuoteSent",
		{ quoteId, orgId },
	);
}

export function onInvoiceSent(invoiceId: string, orgId: string): Promise<void> {
	return run(
		async () => {
			const sdb = getScopedDb(orgId);
			const invoice = await sdb.invoice.findFirst({ where: { id: invoiceId }, select: { client_id: true } });
			if (!invoice) return;
			await enrollForTrigger({
				orgId,
				triggerType: "invoice_sent",
				clientId: invoice.client_id,
				anchorEntityType: "invoice",
				anchorEntityId: invoiceId,
			});
		},
		"onInvoiceSent",
		{ invoiceId, orgId },
	);
}

export function onRequestCreated(requestId: string, orgId: string): Promise<void> {
	return run(
		async () => {
			const sdb = getScopedDb(orgId);
			const request = await sdb.request.findFirst({ where: { id: requestId }, select: { client_id: true } });
			if (!request) return;
			await enrollForTrigger({
				orgId,
				triggerType: "request_created",
				clientId: request.client_id,
				anchorEntityType: "request",
				anchorEntityId: requestId,
			});
		},
		"onRequestCreated",
		{ requestId, orgId },
	);
}

// ── Visit reminders ─────────────────────────────────────────────────────────

export function onVisitScheduled(visitId: string, orgId: string): Promise<void> {
	return run(
		async () => {
			const sdb = getScopedDb(orgId);
			const visit = await sdb.job_visit.findFirst({
				where: { id: visitId },
				select: { scheduled_start_at: true, status: true, job: { select: { client_id: true } } },
			});
			if (!visit || !visit.job) return;
			if (visit.status === "Cancelled" || visit.status === "Completed") return;
			// No point scheduling a reminder for a visit that already started / is in the past.
			if (visit.scheduled_start_at.getTime() <= Date.now()) return;

			await enrollForTrigger({
				orgId,
				triggerType: "visit_scheduled",
				clientId: visit.job.client_id,
				anchorEntityType: "job_visit",
				anchorEntityId: visitId,
				anchorAt: visit.scheduled_start_at,
			});
		},
		"onVisitScheduled",
		{ visitId, orgId },
	);
}

/** Reschedule: move each active reminder for this visit to track the new start time. */
export function onVisitRescheduled(visitId: string, orgId: string, newStart: Date): Promise<void> {
	return run(
		async () => {
			const sdb = getScopedDb(orgId);
			const enrollments = await sdb.followup_enrollment.findMany({
				where: { anchor_entity_type: "job_visit", anchor_entity_id: visitId, status: "active" },
				include: { sequence: { include: { steps: { orderBy: { step_order: "asc" } } } } },
			});

			// No reminder existed yet (e.g. the visit was first created in the past, so
			// onVisitScheduled skipped it) — enroll now if the new time is in the future.
			if (enrollments.length === 0) {
				if (newStart.getTime() > Date.now()) {
					const visit = await sdb.job_visit.findFirst({
						where: { id: visitId },
						select: { job: { select: { client_id: true } } },
					});
					if (visit?.job) {
						await enrollForTrigger({
							orgId,
							triggerType: "visit_scheduled",
							clientId: visit.job.client_id,
							anchorEntityType: "job_visit",
							anchorEntityId: visitId,
							anchorAt: newStart,
						});
					}
				}
				return;
			}

			const now = new Date();
			for (const e of enrollments) {
				const nextStep = e.sequence.steps.find((s) => s.step_order > e.current_step_order);
				const next_send_at = nextStep
					? resolveStepSendAt(e.sequence, nextStep, { base: now, anchorAt: newStart })
					: null;
				await sdb.followup_enrollment.update({
					where: { id: e.id },
					data: { anchor_at: newStart, next_send_at },
				});
			}
		},
		"onVisitRescheduled",
		{ visitId, orgId },
	);
}

/** Cancel: stop active reminders for this visit immediately (scheduler would also catch it). */
export function onVisitCancelled(visitId: string, orgId: string): Promise<void> {
	return run(
		async () => {
			const sdb = getScopedDb(orgId);
			await sdb.followup_enrollment.updateMany({
				where: { anchor_entity_type: "job_visit", anchor_entity_id: visitId, status: "active" },
				data: { status: "stopped", stopped_at: new Date(), stop_reason: "visit_cancelled", next_send_at: null },
			});
		},
		"onVisitCancelled",
		{ visitId, orgId },
	);
}
