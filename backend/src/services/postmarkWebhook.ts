import crypto from "node:crypto";
import type { Request, Response } from "express";
import { db } from "../db.js";
import { log } from "./appLogger.js";
import { isBeforeAnchor } from "./followupEngine.js";
import { notifyDispatchers } from "../controllers/notificationsController.js";
import { getScopedDb } from "../lib/context.js";
import { reportMessageOutcome } from "./customerComms/failureReport.js";
import { unsubscribeByEmail, type ConsentSource } from "./consentService.js";

// ============================================================================
// Postmark webhook — records opens (for no-open chaining) and bounces/spam
// complaints (which stop a followup enrollment). Public endpoint: authenticated
// with a shared secret rather than a JWT, since Postmark is the caller.
//
// Correlation: every followup email is sent with TrackOpens + the Postmark
// MessageID stored on followup_send.postmark_message_id. Webhook events carry
// that same MessageID, which we look up to find the originating send.
// ============================================================================

/**
 * Validate the shared secret. Postmark can be configured with HTTP Basic Auth or
 * a query param on the webhook URL; we accept either. When no secret is configured,
 * auth FAILS CLOSED in production (never accept unauthenticated writes there) and is
 * skipped only outside production so local dev can exercise the endpoint.
 */
function secretMatches(provided: string, secret: string): boolean {
	const a = Buffer.from(provided);
	const b = Buffer.from(secret);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAuthorized(req: Request): boolean {
	const secret = process.env.POSTMARK_WEBHOOK_SECRET;
	if (!secret) return process.env.NODE_ENV !== "production";

	if (typeof req.query?.secret === "string" && secretMatches(req.query.secret, secret)) return true;

	const auth = req.headers.authorization;
	if (auth?.startsWith("Basic ")) {
		const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
		const passwordPart = decoded.slice(decoded.indexOf(":") + 1);
		if (secretMatches(decoded, secret) || secretMatches(passwordPart, secret)) return true;
	}
	return false;
}

/** RecordType === "Open": mark the send opened (first open only) and, if the sequence stops-on-open, complete the enrollment. */
async function handleOpen(event: Record<string, unknown>): Promise<void> {
	const messageId = typeof event.MessageID === "string" ? event.MessageID : null;
	if (!messageId) return;

	const send = await db.followup_send.findUnique({
		where: { postmark_message_id: messageId },
		include: {
			enrollment: {
				include: {
					sequence: { select: { stop_on_open: true, trigger_type: true, name: true } },
					client: { select: { name: true } },
				},
			},
		},
	});
	if (!send) return handleMessageOpen(messageId, event);

	const firstOpen = !send.opened_at;
	const openedAt = typeof event.ReceivedAt === "string" ? new Date(event.ReceivedAt) : new Date();

	await db.followup_send.update({
		where: { id: send.id },
		data: {
			open_count: { increment: 1 },
			...(firstOpen ? { opened_at: isNaN(openedAt.getTime()) ? new Date() : openedAt } : {}),
		},
	});

	// Engagement achieved: end the chain if the sequence is configured to stop on open.
	if (
		firstOpen &&
		send.enrollment &&
		send.enrollment.status === "active" &&
		send.enrollment.sequence?.stop_on_open &&
		!isBeforeAnchor(send.enrollment.sequence.trigger_type)
	) {
		await db.followup_enrollment.update({
			where: { id: send.enrollment_id },
			data: {
				status: "completed",
				completed_at: new Date(),
				stop_reason: "recipient_opened",
				next_send_at: null,
			},
		});
	}

	if (firstOpen && send.organization_id && send.enrollment) {
		notifyDispatchers({
			type: "followup_email_opened",
			title: `${send.enrollment.client.name} opened a follow-up`,
			body: `"${send.enrollment.sequence.name}" email to ${send.recipient_email} was opened.`,
			actionUrl: "/dispatch/followups",
		}, send.organization_id).catch(() => {});
	}
}

const messageSelect = {
	id: true,
	organization_id: true,
	event: true,
	recipient: true,
	entity_type: true,
	entity_id: true,
} as const;

type TrackedMessage = {
	id: string;
	organization_id: string;
	event: string;
	recipient: string;
	entity_type: string;
	entity_id: string;
};

function findMessage(messageId: string): Promise<TrackedMessage | null> {
	return db.customer_message.findUnique({
		where: { provider_message_id: messageId },
		select: messageSelect,
	});
}

function eventDate(raw: unknown): Date {
	const d = typeof raw === "string" ? new Date(raw) : new Date();
	return isNaN(d.getTime()) ? new Date() : d;
}

/** Open of a customer_message email (quote/invoice/auto-comms): first open only. */
async function handleMessageOpen(messageId: string, event: Record<string, unknown>): Promise<void> {
	const message = await findMessage(messageId);
	if (!message) return; // not a tracked email
	await getScopedDb(message.organization_id).customer_message.updateMany({
		where: { id: message.id, opened_at: null },
		data: { opened_at: eventDate(event.ReceivedAt) },
	});
}

/** Delivery: only a row still awaiting an outcome becomes delivered. */
async function handleDelivery(event: Record<string, unknown>): Promise<void> {
	const messageId = typeof event.MessageID === "string" ? event.MessageID : null;
	if (!messageId) return;
	const message = await findMessage(messageId);
	if (!message) return;
	await getScopedDb(message.organization_id).customer_message.updateMany({
		where: { id: message.id, status: { in: ["sent", "unknown"] } },
		data: { status: "delivered", delivered_at: eventDate(event.DeliveredAt) },
	});
}

/** A bounce on a customer_message email: mark it failed once and tell the office. */
async function failMessage(message: TrackedMessage, reason: string): Promise<void> {
	const { count } = await getScopedDb(message.organization_id).customer_message.updateMany({
		where: { id: message.id, status: { not: "failed" } },
		data: { status: "failed", error: reason },
	});
	if (count === 0) return; // duplicate event: already failed and reported
	await reportMessageOutcome({ ...message, channel: "email" }, "failed", {
		error: reason,
		failedBody: `The ${message.event.replace(/_/g, " ")} email to ${message.recipient} bounced.`,
	});
}

type FailureSend = {
	organization_id: string | null;
	recipient_email: string | null;
};

type FollowupSend = FailureSend & { id: string; enrollment_id: string };

// Permanent bounce types per Postmark; transient/soft types may recover.
const PERMANENT_BOUNCE_TYPES = new Set(["HardBounce", "BadEmailAddress"]);

/**
 * Unsubscribe within the org of the originating send (found by MessageID on the
 * root db) so a same-address contact in another org is never touched.
 */
async function suppressEmail(
	send: FailureSend,
	address: unknown,
	source: ConsentSource,
	detail: string,
): Promise<void> {
	const email = typeof address === "string" && address ? address : send.recipient_email;
	if (!send.organization_id || !email) return;
	await unsubscribeByEmail(send.organization_id, email, source, detail);
}

/** Mark the send failed and stop the enrollment (deliverability hygiene). */
async function recordFailure(send: FollowupSend, reason: string): Promise<void> {
	await db.followup_send.update({
		where: { id: send.id },
		data: { status: "failed", error: reason },
	});
	await db.followup_enrollment.updateMany({
		where: { id: send.enrollment_id, status: "active" },
		data: { status: "stopped", stopped_at: new Date(), stop_reason: reason, next_send_at: null },
	});
}

/** Run a step so one failing step never skips the others; Postmark still gets a 200. */
async function guarded(step: string, event: Record<string, unknown>, fn: () => Promise<void>) {
	try {
		await fn();
	} catch (err) {
		log.error({ err, step, recordType: event.RecordType }, "Postmark webhook step failed");
	}
}

/**
 * Bounce / SpamComplaint / SubscriptionChange all correlate by MessageID. The
 * suppression runs first and independently of the followup bookkeeping.
 */
async function handleDeliverabilityEvent(
	event: Record<string, unknown>,
	opts: {
		failureReason?: string;
		suppress: { address: unknown; source: ConsentSource; detail: string } | null;
	},
): Promise<void> {
	const messageId = typeof event.MessageID === "string" ? event.MessageID : null;
	if (!messageId) return;

	const send = await db.followup_send.findUnique({
		where: { postmark_message_id: messageId },
		select: { id: true, enrollment_id: true, organization_id: true, recipient_email: true },
	});
	const { suppress, failureReason } = opts;
	if (!send) {
		const message = await findMessage(messageId);
		if (!message) return;
		if (suppress) {
			await guarded("suppress", event, () =>
				suppressEmail(
					{ organization_id: message.organization_id, recipient_email: message.recipient },
					suppress.address,
					suppress.source,
					suppress.detail,
				),
			);
		}
		// A spam complaint was delivered; only a bounce is a failed send.
		if (failureReason === "bounce") {
			await guarded("record_failure", event, () => failMessage(message, failureReason));
		}
		return;
	}

	if (suppress) {
		await guarded("suppress", event, () =>
			suppressEmail(send, suppress.address, suppress.source, suppress.detail),
		);
	}
	if (failureReason) {
		await guarded("record_failure", event, () => recordFailure(send, failureReason));
	}
}

/** Dispatch a single Postmark event to the right handler by RecordType. */
async function processEvent(event: Record<string, unknown>): Promise<void> {
	const recordType = typeof event.RecordType === "string" ? event.RecordType : "";
	switch (recordType) {
		case "Open":
			await handleOpen(event);
			break;
		case "Delivery":
			await handleDelivery(event);
			break;
		case "Bounce":
			await handleDeliverabilityEvent(event, {
				failureReason: "bounce",
				suppress:
					typeof event.Type === "string" && PERMANENT_BOUNCE_TYPES.has(event.Type)
						? { address: event.Email, source: "bounce", detail: `Postmark ${event.Type}` }
						: null,
			});
			break;
		case "SpamComplaint":
			await handleDeliverabilityEvent(event, {
				failureReason: "spam_complaint",
				suppress: { address: event.Email, source: "spam_complaint", detail: "Postmark spam complaint" },
			});
			break;
		case "SubscriptionChange":
			// Re-subscribing (SuppressSending false) is a human action, never automatic.
			if (event.SuppressSending === true) {
				await handleDeliverabilityEvent(event, {
					suppress: { address: event.Recipient, source: "provider", detail: "Postmark suppression" },
				});
			}
			break;
		default:
			// Click, etc. — ignored.
			break;
	}
}

/**
 * Express handler for POST /integrations/postmark/webhook.
 * Accepts either a single event object or a batched array of events. Always responds
 * 200 on authenticated requests (even on internal processing errors, which are logged)
 * so Postmark does not enter a retry storm — open tracking is best-effort by design.
 */
export async function handlePostmarkWebhook(req: Request, res: Response): Promise<void> {
	if (!isAuthorized(req)) {
		res.status(401).json({ received: false, error: "unauthorized" });
		return;
	}

	const body = req.body ?? {};
	const events = Array.isArray(body) ? body : [body];

	for (const event of events) {
		try {
			await processEvent(event as Record<string, unknown>);
		} catch (err) {
			const recordType = (event as Record<string, unknown>)?.RecordType;
			log.error({ err, recordType }, "Postmark webhook processing failed");
		}
	}

	res.status(200).json({ received: true });
}
