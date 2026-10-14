import type { Request, Response } from "express";
import { db } from "../db.js";
import { log } from "./appLogger.js";
import { notifyDispatchers } from "../controllers/notificationsController.js";

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
function isAuthorized(req: Request): boolean {
	const secret = process.env.POSTMARK_WEBHOOK_SECRET;
	if (!secret) return process.env.NODE_ENV !== "production";

	if (typeof req.query?.secret === "string" && req.query.secret === secret) return true;

	const auth = req.headers.authorization;
	if (auth?.startsWith("Basic ")) {
		const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
		const passwordPart = decoded.slice(decoded.indexOf(":") + 1);
		if (decoded === secret || passwordPart === secret) return true;
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
					sequence: { select: { stop_on_open: true, name: true } },
					client: { select: { name: true } },
				},
			},
		},
	});
	if (!send) return; // not a tracked followup email (e.g. a quote/invoice email)

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
		send.enrollment.sequence?.stop_on_open
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

/** RecordType Bounce/SpamComplaint: mark the send failed and stop the enrollment (deliverability hygiene). */
async function handleFailureEvent(event: Record<string, unknown>, reason: string): Promise<void> {
	const messageId = typeof event.MessageID === "string" ? event.MessageID : null;
	if (!messageId) return;

	const send = await db.followup_send.findUnique({
		where: { postmark_message_id: messageId },
		select: { id: true, enrollment_id: true },
	});
	if (!send) return;

	await db.followup_send.update({
		where: { id: send.id },
		data: { status: "failed", error: reason },
	});
	await db.followup_enrollment.updateMany({
		where: { id: send.enrollment_id, status: "active" },
		data: { status: "stopped", stopped_at: new Date(), stop_reason: reason, next_send_at: null },
	});
}

/** Dispatch a single Postmark event to the right handler by RecordType. */
async function processEvent(event: Record<string, unknown>): Promise<void> {
	const recordType = typeof event.RecordType === "string" ? event.RecordType : "";
	switch (recordType) {
		case "Open":
			await handleOpen(event);
			break;
		case "Bounce":
			await handleFailureEvent(event, "bounce");
			break;
		case "SpamComplaint":
			await handleFailureEvent(event, "spam_complaint");
			break;
		default:
			// Delivery, Click, SubscriptionChange, etc. — ignored.
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
