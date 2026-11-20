import type { Prisma } from "../../../generated/prisma/client.js";
import type { UserContext } from "../../lib/context.js";
import { deductInventoryForVisit } from "../../controllers/inventoryController.js";
import { parentBreadcrumb } from "../../controllers/logsController.js";
import { logActivityInTx } from "./activityLog.js";
import { deriveJobStatus } from "./deriveJobStatus.js";
import { recomputeJobActualTotal } from "./jobRollup.js";
import type { JobChange, PostCommitEffects } from "./postCommit.js";
import { applyTechStatus } from "./techStatus.js";
import { closeOpenTimeEntries } from "./timeEntries.js";
import {
	NEEDS_TECH,
	actorOf,
	checkTransition,
	type VisitAction,
} from "./transitions.js";

export type LifecycleRefusalCode =
	"FORBIDDEN" | "WRONG_STATE" | "CONFLICT" | "NOT_FOUND";

export class LifecycleRefusal extends Error {
	constructor(
		public code: LifecycleRefusalCode,
		message: string,
	) {
		super(message);
		this.name = "LifecycleRefusal";
	}
}

const CLOSES_TIME: readonly VisitAction[] = [
	"pause",
	"complete",
	"record_complete",
	"cancel",
];

const actorFields = (context?: UserContext) => ({
	actor_type: actorOf(context),
	actor_id: context?.techId || context?.dispatcherId,
	ip_address: context?.ipAddress,
	user_agent: context?.userAgent,
});

/**
 * The one way a visit changes status. Must run inside the caller's
 * transaction; the caller runs `runPostCommit` on the result after commit.
 * Throws LifecycleRefusal for anything the caller should map to 403/404/409.
 */
export async function applyStatusChange(
	tx: Prisma.TransactionClient,
	args: {
		orgId: string;
		visitId: string;
		action: VisitAction;
		context?: UserContext;
		now?: Date;
		actingTechIds?: string[];
		pauseReason?: string;
		cancellationReason?: string;
		deferJobSync?: boolean;
		suppressCustomerNotice?: boolean;
	},
): Promise<PostCommitEffects> {
	const { orgId, visitId, action, context } = args;
	const now = args.now ?? new Date();

	// Lock first, read second: a read taken before the lock can be stale by
	// the time we write, which turned compatible concurrent changes into
	// CONFLICTs. Visit before any assignment, technician or job row.
	const locked = await tx.$queryRaw<{ id: string }[]>`
		SELECT v.id FROM job_visit v JOIN job j ON j.id = v.job_id
		WHERE v.id = ${visitId} AND j.organization_id = ${orgId}
		FOR NO KEY UPDATE OF v`;
	if (locked.length === 0)
		throw new LifecycleRefusal("NOT_FOUND", "Job visit not found");

	const visit = await tx.job_visit.findFirst({
		where: { id: visitId, job: { organization_id: orgId } },
		include: {
			job: {
				select: { id: true, job_number: true, recurring_plan_id: true },
			},
			visit_techs: { select: { tech_id: true } },
		},
	});
	if (!visit) throw new LifecycleRefusal("NOT_FOUND", "Job visit not found");

	const actor = actorOf(context);
	const techId = context?.techId;
	const assignedIds = visit.visit_techs.map((vt) => vt.tech_id);
	if (actor === "technician" && (!techId || !assignedIds.includes(techId))) {
		throw new LifecycleRefusal(
			"FORBIDDEN",
			"You aren't assigned to this visit.",
		);
	}
	const check = checkTransition(action, visit.status, actor);
	if (!check.ok) throw new LifecycleRefusal(check.code, check.reason);
	const from = visit.status;
	const to = check.to;
	const noTechMessage = "Assign a technician to this visit first.";
	// Assignment writers take this visit's lock first, so assignedIds is stable.
	if (NEEDS_TECH.includes(to) && assignedIds.length === 0) {
		throw new LifecycleRefusal("WRONG_STATE", noTechMessage);
	}

	const stamps: Prisma.job_visitUpdateManyMutationInput = {};
	if (action === "start" && !visit.actual_start_at)
		stamps.actual_start_at = now;
	if (action === "complete" || action === "record_complete") {
		stamps.actual_end_at = now;
		if (!visit.actual_start_at) stamps.actual_start_at = now;
	}
	if (action === "cancel")
		stamps.cancellation_reason = args.cancellationReason ?? null;
	if (action === "restore") stamps.cancellation_reason = null;
	if (action === "reopen") stamps.actual_end_at = null;

	const actingTechIds =
		args.actingTechIds ??
		(context?.techId
			? [context.techId]
			: (
					await tx.technician.findMany({
						where: {
							id: { in: assignedIds },
							status: { not: "Break" },
							time_entries: { none: { clocked_out_at: null } },
						},
						select: { id: true },
					})
				).map((t) => t.id));

	// The row is locked, so this predicate can't miss; it stays as a belt.
	const written = await tx.job_visit.updateMany({
		where: { id: visitId, status: from },
		data: { status: to, ...stamps },
	});
	if (written.count === 0) {
		throw new LifecycleRefusal(
			"CONFLICT",
			"This visit changed while you were saving. Refresh and try again.",
		);
	}

	const closed = CLOSES_TIME.includes(action)
		? await closeOpenTimeEntries(
				tx,
				orgId,
				visitId,
				now,
				action === "pause" ? args.pauseReason : undefined,
			)
		: { techIds: [] };

	let lowStockItemIds: string[] = [];
	if (action === "complete" || action === "record_complete") {
		// Lines settled by an earlier completion are `used` and skipped, so a
		// reopened visit's second completion moves no stock.
		({ lowStockItemIds } = await deductInventoryForVisit(
			visitId,
			tx,
			orgId,
			context,
		));
	}

	const tech = await applyTechStatus(tx, {
		visitId,
		action,
		actingTechIds,
		closedTechIds: closed.techIds,
	});

	const jobChange = args.deferJobSync
		? null
		: await syncJobFromVisits(tx, orgId, visit.job_id, { now, context });

	let autoInvoicePlanId: string | null = null;
	if (to === "Completed" && visit.job.recurring_plan_id) {
		const billed = await tx.invoice_visit.count({
			where: { visit_id: visitId },
		});
		if (billed === 0) autoInvoicePlanId = visit.job.recurring_plan_id;
	}

	const stampChanges = Object.fromEntries(
		Object.entries(stamps).map(([k, v]) => [
			k,
			{ old: visit[k as keyof typeof visit] ?? null, new: v },
		]),
	);
	const logRow = await logActivityInTx(tx, {
		event_type: "job_visit.updated",
		action: "updated",
		entity_type: "job_visit",
		entity_id: visitId,
		organization_id: orgId,
		...actorFields(context),
		changes: {
			status: { old: from, new: to },
			...stampChanges,
			...parentBreadcrumb("job", visit.job_id),
			_job_number: { old: null, new: visit.job.job_number },
		},
	});

	return {
		orgId,
		visitId,
		jobId: visit.job_id,
		action,
		from,
		to,
		at: now,
		jobChange,
		logRows: [logRow],
		lowStockItemIds,
		autoInvoicePlanId,
		wrappingUpTechIds: tech.wrappingUpTechIds,
		activatedTechIds: tech.activatedTechIds,
		cancelledTechIds: action === "cancel" ? assignedIds : [],
		suppressCustomerNotice: args.suppressCustomerNotice ?? false,
		cancellationReason:
			action === "cancel" ? (args.cancellationReason ?? null) : null,
	};
}

/**
 * Re-derives the job's status from its visits and keeps the lifecycle stamps
 * honest: entering Completed/Cancelled stamps, leaving clears. Always refreshes
 * actual_total. Returns the status change, or null when there was none.
 */
export async function syncJobFromVisits(
	tx: Prisma.TransactionClient,
	orgId: string,
	jobId: string,
	opts: {
		now?: Date;
		cancel?: { reason: string };
		context?: UserContext;
	} = {},
): Promise<JobChange | null> {
	const now = opts.now ?? new Date();
	// Two txs finishing different visits of one job would each still see the
	// other's visit open and both leave the job InProgress. The job lock
	// serialises them (always taken after the visit lock, so no cycle), and
	// every read below runs after it, on a fresh READ COMMITTED snapshot.
	const locked = await tx.$queryRaw<{ id: string }[]>`
		SELECT id FROM job WHERE id = ${jobId} AND organization_id = ${orgId}
		FOR NO KEY UPDATE`;
	if (locked.length === 0)
		throw new LifecycleRefusal("NOT_FOUND", "Job not found");
	const job = await tx.job.findFirst({
		where: { id: jobId, organization_id: orgId },
		select: {
			status: true,
			completed_at: true,
			cancelled_at: true,
			cancellation_reason: true,
		},
	});
	if (!job) throw new LifecycleRefusal("NOT_FOUND", "Job not found");
	const visits = await tx.job_visit.findMany({
		where: { job_id: jobId },
		select: { status: true },
	});
	const cancelledAt = opts.cancel
		? (job.cancelled_at ?? now)
		: job.cancelled_at;
	const to = deriveJobStatus(visits, { cancelled_at: cancelledAt });

	let change: JobChange | null = null;
	if (to !== job.status) {
		const data: Prisma.jobUpdateInput = {
			status: to,
			status_changed_at: now,
		};
		if (to === "Completed") data.completed_at = now;
		else if (job.status === "Completed") data.completed_at = null;
		if (to === "Cancelled") {
			data.cancelled_at = cancelledAt ?? now;
			if (opts.cancel) data.cancellation_reason = opts.cancel.reason;
		} else if (job.status === "Cancelled") {
			data.cancelled_at = null;
			data.cancellation_reason = null;
		}
		await tx.job.update({ where: { id: jobId }, data });

		const changes: Record<string, { old: unknown; new: unknown }> = {
			status: { old: job.status, new: to },
		};
		for (const key of [
			"completed_at",
			"cancelled_at",
			"cancellation_reason",
		] as const) {
			if (key in data && data[key] !== job[key]) {
				changes[key] = { old: job[key], new: data[key] };
			}
		}
		const logRow = await logActivityInTx(tx, {
			event_type: "job.updated",
			action: "updated",
			entity_type: "job",
			entity_id: jobId,
			organization_id: orgId,
			...actorFields(opts.context),
			changes,
		});
		change = { from: job.status, to, logRow };
	}

	await recomputeJobActualTotal(tx, jobId);
	return change;
}
