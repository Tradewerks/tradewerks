import type { Prisma } from "../../../generated/prisma/client.js";
import { db } from "../../db.js";
import { getScopedDb } from "../../lib/context.js";
import { consumeQuota } from "../../lib/entitlements/quota.js";
import { redactLinks } from "../../lib/redactLinks.js";
import { log } from "../appLogger.js";
import { canSend, type Channel } from "../consentService.js";
import { isModuleOn } from "../entitlementService.js";
import { countSegments } from "../sms/segments.js";
import { toE164 } from "../sms/phone.js";
import { reportMessageOutcome } from "./failureReport.js";
import { getChannelAdapter } from "./channels/index.js";
import { smsUnavailableReason } from "../sms/smsAvailability.js";
import { smsSendContext, withStopLine } from "./channels/smsChannel.js";
import { SendRejected, type ChannelAdapter } from "./channels/types.js";
import {
	isCustomerEvent,
	QUIET_HOURS_EXEMPT,
	type CustomerEvent,
} from "./events.js";
import { holdForQuietHours } from "./quietHours.js";
import { renderCustomerMessage, type RenderedMessage } from "./render.js";

const INTERVAL_MS = 30_000;
const BATCH = 100;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5 * 60_000;
// A send in flight longer than this is presumed dead mid-call. Its outcome is
// unknowable, so it is never retried: a missed message beats a duplicate.
const STALE_SENDING_MS = 10 * 60_000;

type ScopedDb = ReturnType<typeof getScopedDb>;

export interface OutboxRow {
	id: string;
	organization_id: string;
	event: string;
	channel: string;
	client_id: string | null;
	contact_id: string | null;
	recipient: string;
	entity_type: string;
	entity_id: string;
	attempts: number;
	// Set on an sms row once its meter charge is taken; a retry reuses them.
	segments?: number | null;
	body?: string | null;
	created_at?: Date;
	claimed_at?: Date | null;
	dedupe_key?: string;
}

/** Atomically moves due queued rows to sending; concurrent sweeps never share a row. */
export function claimDue(now: Date): Promise<OutboxRow[]> {
	return db.$queryRaw<OutboxRow[]>`
		UPDATE "customer_message"
		SET "status" = 'sending', "claimed_at" = ${now}, "send_started_at" = NULL,
			"attempts" = "attempts" + 1
		WHERE "id" IN (
			SELECT "id" FROM "customer_message"
			WHERE "status" = 'queued' AND "send_after" <= ${now}
			ORDER BY "send_after"
			LIMIT ${BATCH}
			FOR UPDATE SKIP LOCKED
		)
		RETURNING *`;
}

/**
 * Only a row whose provider call started is written off as unknown. A claimed
 * row that never got that far (its sweep died while it waited in the batch)
 * is safe to send, so it goes back to the queue; the claim check before the
 * provider call stops its original sweep from sending it too.
 */
async function expireStaleSending(now: Date): Promise<OutboxRow[]> {
	const cutoff = new Date(now.getTime() - STALE_SENDING_MS);
	// Nothing was sent, so the claim's attempt is given back.
	const requeued = await db.$queryRaw<{ id: string }[]>`
		UPDATE "customer_message"
		SET "status" = 'queued', "attempts" = GREATEST("attempts" - 1, 0)
		WHERE "status" = 'sending' AND "send_started_at" IS NULL
			AND "claimed_at" < ${cutoff}
		RETURNING "id"`;
	if (requeued.length)
		log.warn(
			{ messageIds: requeued.map((r) => r.id) },
			"customer messages claimed but never sent; requeued",
		);
	return db.$queryRaw<OutboxRow[]>`
		UPDATE "customer_message"
		SET "status" = 'unknown', "error" = 'send outcome unknown',
			"body" = regexp_replace("body", '/app/c/[^[:space:]"<)]+', '/app/c/…', 'g')
		WHERE "status" = 'sending' AND "send_started_at" < ${cutoff}
		RETURNING *`;
}

interface EntityState {
	status: string;
	startAt?: Date;
	jobStatus?: string;
}

type Validity = (e: EntityState, now: Date, row: OutboxRow) => string | null;

// Reminder keys end in the start they were queued for (see visitEvents).
const REMINDER_START =
	/^visit_reminder:[^:]+:\d+:(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)$/;

function startMoved(e: EntityState, row: OutboxRow): string | null {
	const iso = REMINDER_START.exec(row.dedupe_key ?? "")?.[1];
	if (!iso || !e.startAt) return null;
	const queuedFor = new Date(iso);
	if (Number.isNaN(queuedFor.getTime())) return null;
	return queuedFor.getTime() === e.startAt.getTime() ? null : "start_moved";
}

const live: Validity = ({ status: s }) =>
	s === "Cancelled"
		? "visit_cancelled"
		: s === "Completed"
			? "visit_completed"
			: null;

// Whether the entity's current status still makes this message true.
const VALIDITY: Record<CustomerEvent, Validity> = {
	visit_confirmed: live,
	// Covers quiet-hours deferrals and an outage backlog alike.
	visit_reminder: (e, now, row) =>
		live(e, now, row) ??
		(e.startAt && now >= e.startAt ? "reminder_window_passed" : null) ??
		startMoved(e, row),
	visit_rescheduled: (e, now, row) =>
		live(e, now, row) ??
		(e.startAt && now >= e.startAt ? "visit_started" : null),
	tech_on_the_way: live,
	tech_running_late: live,
	visit_cancelled: ({ status: s }) =>
		s === "Cancelled" ? null : "visit_not_cancelled",
	visit_completed: ({ status: s }) =>
		s === "Completed" ? null : "visit_not_completed",
	// A job reopened since it completed may not be finished for the customer.
	review_request: ({ status: s }) =>
		s === "Completed" ? null : "job_not_completed",
};

async function entityState(
	sdb: ScopedDb,
	type: string,
	id: string,
): Promise<EntityState | null> {
	if (type === "job_visit") {
		const v = await sdb.job_visit.findFirst({
			where: { id },
			select: {
				status: true,
				scheduled_start_at: true,
				job: { select: { status: true } },
			},
		});
		return v
			? {
					status: v.status,
					startAt: v.scheduled_start_at,
					jobStatus: v.job?.status,
				}
			: null;
	}
	if (type === "job") {
		const j = await sdb.job.findFirst({
			where: { id },
			select: { status: true },
		});
		return j ? { status: j.status } : null;
	}
	return null;
}

const REVIEW_WINDOW_MS = 180 * 24 * 3_600_000;

/**
 * The queue-time 180-day check can race (two jobs for one client completing
 * together), so it is repeated here against requests that went out, or are
 * going out ahead of this one. Rows of the same job are its other channels or
 * recipients, never a second request.
 */
async function reviewRecentlyRequested(
	sdb: ScopedDb,
	row: OutboxRow,
): Promise<boolean> {
	if (!row.client_id) return false;
	const earlierInFlight = row.created_at
		? [{ status: "sending", created_at: { lt: row.created_at } }]
		: [];
	const count = await sdb.customer_message.count({
		where: {
			event: "review_request",
			client_id: row.client_id,
			entity_id: { not: row.entity_id },
			created_at: { gte: new Date(Date.now() - REVIEW_WINDOW_MS) },
			OR: [
				{ status: { in: ["sent", "delivered", "unknown"] } },
				...earlierInFlight,
			],
		},
	});
	return count > 0;
}

function report(
	row: OutboxRow,
	status: "sent" | "failed" | "unknown",
	error?: string,
): Promise<void> {
	return reportMessageOutcome(row, status, { error });
}

/**
 * Writes the row's outcome only while it is still this sweep's claim. False when
 * the claim was lost (the stale check took it): the outcome is then not this
 * sweep's to report.
 */
async function finish(
	sdb: ScopedDb,
	row: OutboxRow,
	data: Prisma.customer_messageUpdateManyMutationInput,
	opts: { body?: string | null } = {},
): Promise<boolean> {
	// The unredacted body stays only while a retry may still resend it.
	const settles = typeof data.status === "string" && data.status !== "queued";
	if (settles && data.body === undefined && opts.body != null)
		data = { ...data, body: redactLinks(opts.body) };
	const { count } = await sdb.customer_message.updateMany({
		// claimed_at is this sweep's claim token: once the row was requeued
		// and re-claimed, a write from the stale sweep must match nothing.
		where: { id: row.id, status: "sending", claimed_at: row.claimed_at },
		data,
	});
	return count === 1;
}

async function retryOrFail(
	sdb: ScopedDb,
	row: OutboxRow,
	error: string,
	now: Date,
	body: string | null = row.body ?? null,
): Promise<void> {
	if (row.attempts < MAX_ATTEMPTS) {
		await finish(sdb, row, {
			status: "queued",
			error,
			send_after: await retryAt(row, now),
		});
		return;
	}
	if (await finish(sdb, row, { status: "failed", error }, { body }))
		await report(row, "failed", error);
}

/** A held sms event's retry waits for the next window, like its first send. */
async function retryAt(row: OutboxRow, now: Date): Promise<Date> {
	const next = new Date(now.getTime() + RETRY_DELAY_MS);
	if (
		row.channel !== "sms" ||
		!isCustomerEvent(row.event) ||
		QUIET_HOURS_EXEMPT.includes(row.event)
	)
		return next;
	try {
		const tz = await orgTimezone(row.organization_id);
		return holdForQuietHours(next, tz, "defer");
	} catch (err) {
		log.error({ err, messageId: row.id }, "quiet hours check failed");
		return next;
	}
}

async function orgTimezone(orgId: string): Promise<string> {
	const org = await db.organization.findUnique({
		where: { id: orgId },
		select: { timezone: true },
	});
	return org?.timezone ?? "America/Chicago";
}

/**
 * The checks that run before any provider call, in order. Returns a skip reason,
 * or what to send.
 */
async function prepare(
	sdb: ScopedDb,
	row: OutboxRow,
	now: Date,
): Promise<
	| { skip: string }
	| { fail: string }
	| { adapter: ChannelAdapter; rendered: RenderedMessage; to: string }
> {
	const orgId = row.organization_id;
	const event = row.event;
	const channel = row.channel as Channel;
	const adapter = getChannelAdapter(channel);
	if (!isCustomerEvent(event) || !adapter) return { skip: "unsupported" };
	if (!(await isModuleOn(orgId, "customer_comms")))
		return { skip: "module_off" };
	if (channel === "sms") {
		const unavailable = await smsUnavailableReason(orgId);
		if (unavailable) return { skip: unavailable };
	}

	const setting = await sdb.customer_notification_setting.findFirst({
		where: { event },
		select: { email_enabled: true, sms_enabled: true },
	});
	const enabled =
		channel === "email" ? setting?.email_enabled : setting?.sms_enabled;
	if (!enabled) return { skip: "event_disabled" };

	const state = await entityState(sdb, row.entity_type, row.entity_id);
	if (state === null) return { skip: `${row.entity_type}_not_found` };
	const invalid = VALIDITY[event](state, now, row);
	if (invalid) return { skip: invalid };
	// Cancelling a job leaves its visits' own statuses alone. A cancel notice
	// is still true for the customer, so it goes.
	if (
		row.entity_type === "job_visit" &&
		state.jobStatus === "Cancelled" &&
		event !== "visit_cancelled"
	)
		return { skip: "job_cancelled" };
	if (event === "review_request" && (await reviewRecentlyRequested(sdb, row)))
		return { skip: "review_recently_requested" };

	if (!row.contact_id) return { skip: "contact_ineligible" };
	const contact = await sdb.contact.findFirst({
		where: { id: row.contact_id },
		select: { is_active: true, type: true, email: true, phone: true },
	});
	if (!contact || !contact.is_active || contact.type === "vendor")
		return { skip: "contact_ineligible" };
	// The address is part of the dedupe key, so an edited one is not followed.
	const current = (
		(channel === "email" ? contact.email : contact.phone) ?? ""
	).trim();
	const same =
		channel === "email"
			? current.toLowerCase() === row.recipient.toLowerCase()
			: (toE164(current, "US") ?? current) === row.recipient;
	if (!same) return { skip: "address_changed" };
	const e164 = channel === "sms" ? toE164(row.recipient, "US") : null;
	if (channel === "sms" && !e164) return { skip: "invalid_phone" };
	if (!(await canSend(sdb, row.contact_id, channel)))
		return { skip: "unsubscribed" };

	if (e164) {
		// Before the meter: a send that cannot start must not be charged.
		try {
			await smsSendContext(orgId, row.id);
		} catch (err) {
			if (err instanceof SendRejected && !err.retryable)
				return { fail: err.message };
			throw err;
		}
		// Already charged on an earlier attempt: send exactly what was charged.
		if (row.segments != null && row.body != null)
			return { adapter, rendered: { text: row.body }, to: e164 };
	}

	const rendered = await renderCustomerMessage(
		orgId,
		{ ...row, event },
		await orgTimezone(orgId),
	);
	if ("skip" in rendered) return rendered;
	if (e164) rendered.text = await withStopLine(sdb, e164, rendered.text);
	return { adapter, rendered, to: e164 ?? row.recipient };
}

async function processRow(row: OutboxRow, now: Date): Promise<void> {
	const sdb = getScopedDb(row.organization_id);

	let plan: Awaited<ReturnType<typeof prepare>>;
	try {
		plan = await prepare(sdb, row, now);
	} catch (err) {
		// Nothing reached a provider, so this is as safe to retry as a rejection.
		log.error(
			{ err, messageId: row.id },
			"customer message prepare failed",
		);
		return retryOrFail(sdb, row, "prepare_failed", now);
	}
	// A charged sms body from an earlier attempt, redacted once the row settles.
	let body = row.body ?? null;
	if ("skip" in plan) {
		await finish(
			sdb,
			row,
			{ status: "skipped", skip_reason: plan.skip },
			{ body },
		);
		return;
	}
	if ("fail" in plan) {
		const failed = await finish(
			sdb,
			row,
			{ status: "failed", error: plan.fail },
			{ body },
		);
		if (failed) await report(row, "failed", plan.fail);
		return;
	}

	const { adapter, rendered, to } = plan;
	// Re-assert this sweep's claim right before the provider call: if the
	// stale check wrote the row off, or requeued it for another sweep to
	// claim, sending now would be the duplicate. From here the row counts as
	// in flight for the stale check.
	const stillOurs = await finish(sdb, row, { send_started_at: new Date() });
	if (!stillOurs) return;
	if (row.channel === "sms" && row.segments == null) {
		// Charged once per row, before the first call, and never refunded:
		// once a request may have reached the provider it may have been billed.
		const segments = countSegments(rendered.text).segments;
		let quota: Awaited<ReturnType<typeof consumeQuota>>;
		try {
			quota = await consumeQuota(
				row.organization_id,
				"sms_segments_month",
				segments,
			);
		} catch (err) {
			log.error({ err, messageId: row.id }, "sms meter check failed");
			return retryOrFail(sdb, row, "quota_check_failed", now, body);
		}
		if (!quota.allowed) {
			await finish(sdb, row, {
				status: "skipped",
				skip_reason: "sms_limit_reached",
			});
			return;
		}
		// The charge and the body it paid for travel with the row to retries.
		if (!(await finish(sdb, row, { segments, body: rendered.text })))
			return;
		body = rendered.text;
	}
	let result: Awaited<ReturnType<ChannelAdapter["send"]>>;
	try {
		result = await adapter.send({
			orgId: row.organization_id,
			to,
			subject: rendered.subject,
			html: rendered.html,
			text: rendered.text,
			messageRowId: row.id,
			...(rendered.headers ? { headers: rendered.headers } : {}),
		});
	} catch (err) {
		if (err instanceof SendRejected) {
			if (err.retryable)
				return retryOrFail(sdb, row, err.message, now, body);
			const failed = await finish(
				sdb,
				row,
				{ status: "failed", error: err.message },
				{ body },
			);
			if (failed) await report(row, "failed", err.message);
			return;
		}
		log.error(
			{ err, messageId: row.id },
			"customer message send outcome unknown",
		);
		const error = err instanceof Error ? err.message : String(err);
		if (await finish(sdb, row, { status: "unknown", error }, { body }))
			await report(row, "unknown", error);
		return;
	}

	const sent = {
		segments: result.segments ?? null,
		subject: rendered.subject ?? null,
		body: redactLinks(rendered.text) || null,
		sent_at: new Date(),
	};
	const won = await finish(sdb, row, {
		...sent,
		status: "sent",
		provider_message_id: result.providerMessageId,
		error: null,
	});
	if (won) return report(row, "sent");
	if (!result.providerMessageId) return;
	// A delivery report can land before the write above and settle the row
	// itself (found by the row id in its callback URL). Its status stands;
	// what was sent is still ours to record.
	const settled = await sdb.customer_message.findFirst({
		where: { id: row.id, provider_message_id: result.providerMessageId },
		select: { status: true },
	});
	if (!settled) return;
	await sdb.customer_message.updateMany({
		where: { id: row.id },
		data: sent,
	});
	if (settled.status === "delivered") await report(row, "sent");
}

export async function runOutboxSweep(now: Date = new Date()): Promise<void> {
	const stale = await expireStaleSending(now);
	for (const row of stale) {
		log.warn(
			{ messageId: row.id },
			"customer message left sending; marked unknown",
		);
		await report(row, "unknown", "send outcome unknown");
	}

	const claimed = await claimDue(now);
	for (const row of claimed) {
		try {
			await processRow(row, now);
		} catch (err) {
			// Left in sending for the stale check: unknown if its provider
			// call had started, otherwise requeued.
			log.error(
				{ err, messageId: row.id },
				"customer message outcome not recorded",
			);
		}
	}
}

let running = false;

export function startOutboxSweeperInterval(): void {
	setInterval(async () => {
		if (running) return;
		running = true;
		try {
			await runOutboxSweep();
		} catch (err) {
			log.error({ err }, "customer message outbox sweep failed");
		} finally {
			running = false;
		}
	}, INTERVAL_MS);
}
