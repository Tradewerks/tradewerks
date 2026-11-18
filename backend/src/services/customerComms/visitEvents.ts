import { db } from "../../db.js";
import { getScopedDb } from "../../lib/context.js";
import {
	DEFAULT_LATE_CONFIG,
	DEFAULT_REMINDER_CONFIG,
	DEFAULT_REVIEW_CONFIG,
	lateConfigSchema,
	MIN_LATE_THRESHOLD_MINUTES,
	reminderConfigSchema,
	reviewConfigSchema,
} from "../../lib/validate/customerComms.js";
import { extendVisitLinks, linkExpiry } from "../../lib/publicLink.js";
import { log } from "../appLogger.js";
import type * as Outbox from "./customerNotify.js";
import type { CustomerEvent } from "./events.js";

type ScopedDb = ReturnType<typeof getScopedDb>;

const HOUR_MS = 3_600_000;
// Several quick edits collapse into one notice: each edit skips the queued one
// before its own is queued, and the survivor renders the final time.
const RESCHEDULE_DELAY_MS = 2 * 60_000;
const RESCHEDULED = "visit_rescheduled";

const ENTITY = "job_visit" as const;

// Loaded on first use: the outbox pulls in the email channel, which refuses to
// load without Postmark config, and the visit controllers import this module.
const outbox = (): Promise<typeof Outbox> => import("./customerNotify.js");

interface VisitFacts {
	id: string;
	status: string;
	scheduled_start_at: Date;
	scheduled_end_at: Date;
	actual_end_at: Date | null;
	job: { client_id: string; recurring_plan_id: string | null };
}

async function loadVisit(
	sdb: ScopedDb,
	visitId: string,
): Promise<VisitFacts | null> {
	return sdb.job_visit.findFirst({
		where: { id: visitId },
		select: {
			id: true,
			status: true,
			scheduled_start_at: true,
			scheduled_end_at: true,
			actual_end_at: true,
			job: { select: { client_id: true, recurring_plan_id: true } },
		},
	});
}

const isClosed = (v: VisitFacts) =>
	v.status === "Completed" || v.status === "Cancelled";

async function leadHours(sdb: ScopedDb): Promise<number[]> {
	const row = await sdb.customer_notification_setting.findFirst({
		where: { event: "visit_reminder" },
		select: { config: true },
	});
	const parsed = reminderConfigSchema.safeParse(row?.config);
	const hours = parsed.success
		? parsed.data.lead_hours
		: DEFAULT_REMINDER_CONFIG.lead_hours;
	return [...new Set(hours)];
}

function reminderPlan(v: VisitFacts, hours: number[], now: Date) {
	const iso = v.scheduled_start_at.toISOString();
	return hours
		.map((h) => ({
			dedupeKey: `visit_reminder:${v.id}:${h}:${iso}`,
			sendAt: new Date(v.scheduled_start_at.getTime() - h * HOUR_MS),
		}))
		.filter((r) => r.sendAt > now);
}

async function queueReminders(
	orgId: string,
	v: VisitFacts,
	plan: ReturnType<typeof reminderPlan>,
): Promise<void> {
	for (const r of plan) {
		await (
			await outbox()
		).customerNotify(orgId, {
			event: "visit_reminder",
			entityType: ENTITY,
			entityId: v.id,
			clientId: v.job.client_id,
			dedupeKey: r.dedupeKey,
			sendAt: r.sendAt,
			quietMode: "advance",
			notAfter: v.scheduled_start_at,
		});
	}
}

function run(
	label: string,
	visitId: string,
	orgId: string,
	fn: () => Promise<void>,
): Promise<void> {
	return fn().catch((err) =>
		log.error({ err, orgId, visitId }, `${label} failed; nothing queued`),
	);
}

/** Confirmation (not for recurring-plan visits) plus reminders. Never rejects. */
export function notifyVisitScheduled(
	visitId: string,
	orgId: string,
): Promise<void> {
	return run("notifyVisitScheduled", visitId, orgId, async () => {
		const sdb = getScopedDb(orgId);
		const v = await loadVisit(sdb, visitId);
		const now = new Date();
		if (!v || isClosed(v) || v.scheduled_start_at <= now) return;
		// A plan-generated visit wasn't just booked by the customer.
		if (!v.job.recurring_plan_id) {
			await (
				await outbox()
			).customerNotify(orgId, {
				event: "visit_confirmed",
				entityType: ENTITY,
				entityId: v.id,
				clientId: v.job.client_id,
				dedupeKey: `visit_confirmed:${v.id}`,
				notAfter: v.scheduled_start_at,
			});
		}
		await queueReminders(
			orgId,
			v,
			reminderPlan(v, await leadHours(sdb), now),
		);
	});
}

/**
 * Moves queued reminders to the new time. With `notice`, also queues a delayed
 * reschedule notice (off for visits shifted as a side effect of another edit).
 */
async function reschedule(
	orgId: string,
	visitId: string,
	notice: boolean,
): Promise<void> {
	const sdb = getScopedDb(orgId);
	const v = await loadVisit(sdb, visitId);
	if (!v || isClosed(v)) return;
	// Links already sent in the confirmation must follow the new end.
	await extendVisitLinks(orgId, v.id, linkExpiry("visit", v));
	const events: CustomerEvent[] = notice
		? ["visit_reminder", "visit_rescheduled", "visit_cancelled"]
		: ["visit_reminder"];
	await (
		await outbox()
	).cancelQueued(orgId, {
		entityType: ENTITY,
		entityId: v.id,
		events,
		reason: RESCHEDULED,
	});
	const now = new Date();
	if (v.scheduled_start_at <= now) return;

	const reminders = reminderPlan(v, await leadHours(sdb), now);
	// The outbox's dedupe key is unique across every status, so a reminder
	// skipped by a reschedule or cancel would block moving back to that time
	// (or un-cancelling at it). Only never-sent rows skipped for those reasons
	// are cleared; a sent reminder keeps blocking its resend.
	await sdb.customer_message.deleteMany({
		where: {
			entity_type: ENTITY,
			entity_id: v.id,
			dedupe_key: { in: reminders.map((r) => r.dedupeKey) },
			status: "skipped",
			skip_reason: { in: [RESCHEDULED, "visit_cancelled"] },
		},
	});
	if (notice) {
		await (
			await outbox()
		).customerNotify(orgId, {
			event: "visit_rescheduled",
			entityType: ENTITY,
			entityId: v.id,
			clientId: v.job.client_id,
			// Per edit, so moving back to an earlier time still gets a notice.
			dedupeKey: `visit_rescheduled:${v.id}:${now.getTime()}`,
			sendAt: new Date(now.getTime() + RESCHEDULE_DELAY_MS),
			notAfter: v.scheduled_start_at,
		});
	}
	await queueReminders(orgId, v, reminders);
}

/** Re-times reminders and queues one delayed reschedule notice. Never rejects. */
export function notifyVisitRescheduled(
	visitId: string,
	orgId: string,
): Promise<void> {
	return run("notifyVisitRescheduled", visitId, orgId, () =>
		reschedule(orgId, visitId, true),
	);
}

/**
 * Re-times reminders without telling the customer, for visits moved in bulk
 * alongside the one the dispatcher edited. Never rejects.
 */
export function retimeVisitReminders(
	visitId: string,
	orgId: string,
): Promise<void> {
	return run("retimeVisitReminders", visitId, orgId, () =>
		reschedule(orgId, visitId, false),
	);
}

const PRE_VISIT_EVENTS: CustomerEvent[] = [
	"visit_confirmed",
	"visit_reminder",
	"visit_rescheduled",
	"tech_on_the_way",
	"tech_running_late",
];

/**
 * Skips what is still queued for the job's open visits: cancelling a job
 * leaves its visits' statuses as they were. Never rejects.
 */
export function notifyJobCancelled(
	jobId: string,
	orgId: string,
): Promise<void> {
	return run("notifyJobCancelled", jobId, orgId, async () => {
		const visits = await getScopedDb(orgId).job_visit.findMany({
			where: {
				job_id: jobId,
				status: { notIn: ["Completed", "Cancelled"] },
			},
			select: { id: true },
		});
		for (const v of visits) {
			await (
				await outbox()
			).cancelQueued(orgId, {
				entityType: ENTITY,
				entityId: v.id,
				events: PRE_VISIT_EVENTS,
				reason: "job_cancelled",
			});
		}
	});
}

/** Skips everything still queued for the visit and queues the cancel notice. Never rejects. */
export function notifyVisitCancelled(
	visitId: string,
	orgId: string,
): Promise<void> {
	return run("notifyVisitCancelled", visitId, orgId, async () => {
		await (
			await outbox()
		).cancelQueued(orgId, {
			entityType: ENTITY,
			entityId: visitId,
			events: PRE_VISIT_EVENTS,
			reason: "visit_cancelled",
		});
		const v = await loadVisit(getScopedDb(orgId), visitId);
		// A visit already over has nothing left for the customer to act on.
		if (!v || v.status !== "Cancelled" || v.scheduled_end_at <= new Date())
			return;
		await (
			await outbox()
		).customerNotify(orgId, {
			event: "visit_cancelled",
			entityType: ENTITY,
			entityId: v.id,
			clientId: v.job.client_id,
			// Per cancellation: an un-cancelled then re-cancelled visit says so again.
			dedupeKey: `visit_cancelled:${v.id}:${Date.now()}`,
		});
	});
}

/**
 * Queues the completion summary once per visit (a reopened and re-completed
 * visit sends nothing new) and keeps the visit's links open 30 days for it.
 * The text is held for quiet hours. Never rejects.
 */
export function notifyVisitCompleted(
	visitId: string,
	orgId: string,
): Promise<void> {
	return run("notifyVisitCompleted", visitId, orgId, async () => {
		const v = await loadVisit(getScopedDb(orgId), visitId);
		if (!v || v.status !== "Completed") return;
		await extendVisitLinks(orgId, v.id, linkExpiry("visit", v));
		await (
			await outbox()
		).customerNotify(orgId, {
			event: "visit_completed",
			entityType: ENTITY,
			entityId: v.id,
			clientId: v.job.client_id,
			dedupeKey: `visit_completed:${v.id}`,
		});
	});
}

// en-CA formats as YYYY-MM-DD.
const localIsoDate = (at: Date, tz: string) =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(at);

/**
 * Queues "on the way" once per visit per org-local day: a second tech's drive,
 * or drive-delay-drive, hits the same dedupe key. The tech named is chosen at
 * render time (see buildVisitModel), so techId is not needed here. Never
 * rejects.
 */
export function notifyTechOnTheWay(
	visitId: string,
	_techId: string | undefined,
	orgId: string,
): Promise<void> {
	return run("notifyTechOnTheWay", visitId, orgId, async () => {
		const v = await loadVisit(getScopedDb(orgId), visitId);
		if (!v || isClosed(v)) return;
		const org = await db.organization.findUnique({
			where: { id: orgId },
			select: { timezone: true },
		});
		const tz = org?.timezone ?? "America/Chicago";
		await (
			await outbox()
		).customerNotify(orgId, {
			event: "tech_on_the_way",
			entityType: ENTITY,
			entityId: v.id,
			clientId: v.job.client_id,
			dedupeKey: `tech_on_the_way:${v.id}:${localIsoDate(new Date(), tz)}`,
		});
	});
}

// A forecast older than this belongs to a tech the tracker has stopped updating.
const LATE_FORECAST_FRESH_MS = 10 * 60_000;

/**
 * Whether every tech still due at the visit is forecast at least this late; a
 * tech who has arrived, or is on time or unknown, means the customer isn't
 * simply waiting on a late visit.
 */
async function allTechsLate(
	sdb: ScopedDb,
	visitId: string,
	thresholdSeconds: number,
): Promise<boolean> {
	const rows = await sdb.visit_tech_arrival.findMany({
		where: { visit_id: visitId },
		select: { status: true, delay_seconds: true, computed_at: true },
	});
	// An arrived row is never recomputed, so its age says nothing.
	if (rows.some((r) => r.status === "arrived")) return false;
	const cutoff = Date.now() - LATE_FORECAST_FRESH_MS;
	const live = rows.filter((r) => r.computed_at.getTime() >= cutoff);
	return live.every(
		(r) => r.delay_seconds !== null && r.delay_seconds >= thresholdSeconds,
	);
}

/**
 * Queues one running-late notice per visit per org-local day, the first time
 * the forecast delay reaches the org's threshold. Called on every late tick, so
 * the cheap exits come first. The new ETA is read at send time (see
 * buildVisitModel); etaAt only gates a forecast that has already lapsed. Never
 * rejects.
 */
export function notifyRunningLate(
	visitId: string,
	orgId: string,
	p: { etaAt: Date; delayMinutes: number },
): Promise<void> {
	return run("notifyRunningLate", visitId, orgId, async () => {
		if (p.delayMinutes < MIN_LATE_THRESHOLD_MINUTES) return;
		const sdb = getScopedDb(orgId);
		const row = await sdb.customer_notification_setting.findFirst({
			where: { event: "tech_running_late" },
			select: { config: true },
		});
		const parsed = lateConfigSchema.safeParse(row?.config);
		const { threshold_minutes } = parsed.success
			? parsed.data
			: DEFAULT_LATE_CONFIG;
		if (p.delayMinutes < threshold_minutes || p.etaAt <= new Date()) return;
		const org = await db.organization.findUnique({
			where: { id: orgId },
			select: { timezone: true },
		});
		const tz = org?.timezone ?? "America/Chicago";
		const dedupeKey = `tech_running_late:${visitId}:${localIsoDate(new Date(), tz)}`;
		if (
			await sdb.customer_message.count({
				where: { dedupe_key: dedupeKey },
			})
		)
			return;
		const v = await loadVisit(sdb, visitId);
		if (!v || isClosed(v)) return;
		if (!(await allTechsLate(sdb, visitId, threshold_minutes * 60))) return;
		await (
			await outbox()
		).customerNotify(orgId, {
			event: "tech_running_late",
			entityType: ENTITY,
			entityId: v.id,
			clientId: v.job.client_id,
			dedupeKey,
		});
	});
}

const REVIEW_WINDOW_MS = 180 * 24 * HOUR_MS;
// Rows that reached, or may yet reach, the customer. A skipped or failed
// request never arrived, so it doesn't use up the client's 180 days; unknown
// may have been delivered, so it does.
const REVIEW_COUNTED_STATUSES = [
	"queued",
	"sending",
	"sent",
	"delivered",
	"unknown",
];

async function reviewBlocked(
	sdb: ScopedDb,
	jobId: string,
	clientId: string,
): Promise<boolean> {
	const recent = await sdb.customer_message.count({
		where: {
			event: "review_request",
			client_id: clientId,
			status: { in: REVIEW_COUNTED_STATUSES },
			created_at: { gte: new Date(Date.now() - REVIEW_WINDOW_MS) },
		},
	});
	if (recent > 0) return true;
	// Asking an unhappy customer for a public review invites a bad one.
	const billedForJob = {
		OR: [
			{ jobs: { some: { job_id: jobId } } },
			{ visits: { some: { visit: { job_id: jobId } } } },
		],
	};
	const openDisputes = await sdb.document_dispute.count({
		where: {
			status: "Open",
			OR: [{ quote: { job: { id: jobId } } }, { invoice: billedForJob }],
		},
	});
	if (openDisputes > 0) return true;
	const disputedInvoices = await sdb.invoice.count({
		where: { status: "Disputed", ...billedForJob },
	});
	return disputedInvoices > 0;
}

/**
 * Queues one review request per job, delay_hours after it completes. Skipped
 * without a review link, inside the client's 180-day window, or while the job
 * is in dispute. Never rejects.
 */
export function notifyJobCompleted(
	jobId: string,
	orgId: string,
): Promise<void> {
	return run("notifyJobCompleted", jobId, orgId, async () => {
		const sdb = getScopedDb(orgId);
		const job = await sdb.job.findFirst({
			where: { id: jobId },
			select: { status: true, client_id: true },
		});
		if (!job || job.status !== "Completed") return;
		const org = await db.organization.findUnique({
			where: { id: orgId },
			select: { review_url: true },
		});
		if (!org?.review_url) return;
		if (await reviewBlocked(sdb, jobId, job.client_id)) return;
		const row = await sdb.customer_notification_setting.findFirst({
			where: { event: "review_request" },
			select: { config: true },
		});
		const parsed = reviewConfigSchema.safeParse(row?.config);
		const { delay_hours } = parsed.success
			? parsed.data
			: DEFAULT_REVIEW_CONFIG;
		await (
			await outbox()
		).customerNotify(orgId, {
			event: "review_request",
			entityType: "job",
			entityId: jobId,
			clientId: job.client_id,
			dedupeKey: `review_request:${jobId}`,
			sendAt: new Date(Date.now() + delay_hours * HOUR_MS),
			quietMode: "defer",
		});
	});
}
