import type {
	job_status,
	log as LogRow,
	visit_status,
} from "../../../generated/prisma/client.js";
import { getScopedDb, type UserContext } from "../../lib/context.js";
import { buildVisitStatusPayload } from "../../controllers/jobVisitsController.js";
import {
	createNotification,
	notifyDispatchers,
} from "../../controllers/notificationsController.js";
import {
	notifyJobCancelled,
	notifyJobCompleted,
	notifyTechOnTheWay,
	notifyVisitCancelled,
	notifyVisitCompleted,
	notifyVisitRescheduled,
	skipVisitReminders,
} from "../customerComms/visitEvents.js";
import { onVisitCancelled } from "../followupTriggers.js";
import { fireLowStockAlerts } from "../lowStockAlerts.js";
import { emitToOrg } from "../socketService.js";
import { log } from "../appLogger.js";
import { emitActivityHints } from "./activityLog.js";
import { maybeAutoInvoiceOnCompletion } from "./autoInvoice.js";
import type { VisitAction } from "./transitions.js";

export interface JobChange {
	from: job_status;
	to: job_status;
	/** The in-tx `job.updated` row; its live hints go out after commit. */
	logRow?: LogRow;
}

export interface PostCommitEffects {
	orgId: string;
	visitId: string;
	jobId: string;
	action: VisitAction;
	from: visit_status;
	to: visit_status;
	/** The transition's own clock; WrappingUp timers count from it. */
	at: Date;
	jobChange: JobChange | null;
	/** Written in-tx; their live hints go out after commit. */
	logRows?: LogRow[];
	lowStockItemIds: string[];
	autoInvoicePlanId: string | null;
	wrappingUpTechIds: string[];
	/** Cancel their WrappingUp timers. For `drive`, [0] is the tech on the way. */
	activatedTechIds: string[];
	/** Get an in-app "visit_cancelled" notice. */
	cancelledTechIds: string[];
	suppressCustomerNotice: boolean;
	cancellationReason: string | null;
}

type LoadedVisit = Parameters<typeof buildVisitStatusPayload>[0] & {
	job: { job_number: string; client: { name: string } };
};

/**
 * Everything a committed visit transition owes the outside world. Each step is
 * isolated so one failure (socket, SMTP, SMS) never skips the others, and the
 * whole thing never rejects.
 */
export async function runPostCommit(
	e: PostCommitEffects,
	context?: UserContext,
): Promise<void> {
	const step = async (name: string, fn: () => unknown) => {
		try {
			await fn();
		} catch (err) {
			log.warn(
				{ err, visitId: e.visitId, step: name },
				"visit post-commit step failed",
			);
		}
	};
	// Customer messages are fire-and-forget: never awaited, never allowed to throw.
	const fire = (name: string, fn: () => Promise<unknown>) => {
		try {
			void fn().catch((err) =>
				log.warn(
					{ err, visitId: e.visitId, step: name },
					"visit post-commit notice failed",
				),
			);
		} catch (err) {
			log.warn(
				{ err, visitId: e.visitId, step: name },
				"visit post-commit notice failed",
			);
		}
	};
	const completed = e.action === "complete" || e.action === "record_complete";

	for (const row of e.logRows ?? []) {
		await step("activityHints", () => emitActivityHints(row));
	}

	if (e.lowStockItemIds.length > 0) {
		// Email delivery; the response shouldn't wait on it.
		fire("lowStock", () => fireLowStockAlerts(e.lowStockItemIds, e.orgId));
	}

	let visit: LoadedVisit | null = null;
	await step("loadVisit", async () => {
		visit = (await getScopedDb(e.orgId).job_visit.findFirst({
			where: { id: e.visitId },
			include: {
				job: { include: { client: true } },
				visit_techs: { include: { tech: true } },
			},
		})) as LoadedVisit | null;
	});
	const v = visit as LoadedVisit | null;
	const jobNumber = v?.job.job_number ?? "";
	const clientName = v?.job.client.name ?? "the client";

	await step("emitVisit", () => {
		if (v)
			emitToOrg(
				e.orgId,
				"job_visit:status_changed",
				buildVisitStatusPayload(v, e.from, true, context),
			);
	});

	if (e.wrappingUpTechIds.length > 0) {
		await step("armWrappingUp", async () => {
			const org = await getScopedDb(e.orgId).organization.findUnique({
				where: { id: e.orgId },
				select: { wrapping_up_minutes: true },
			});
			// Lazy: wrappingUpTimer imports techniciansController, which would cycle at load.
			const { scheduleWrappingUpClear } =
				await import("../wrappingUpTimer.js");
			for (const techId of e.wrappingUpTechIds) {
				scheduleWrappingUpClear(
					techId,
					e.orgId,
					e.at,
					org?.wrapping_up_minutes ?? 15,
				);
			}
		});
	}
	if (e.activatedTechIds.length > 0) {
		await step("cancelWrappingUp", async () => {
			const { cancelWrappingUpTimer } =
				await import("../wrappingUpTimer.js");
			for (const techId of e.activatedTechIds)
				cancelWrappingUpTimer(techId);
		});
	}

	if (e.action === "cancel") {
		fire("onVisitCancelled", () => onVisitCancelled(e.visitId, e.orgId));
	}

	// Also sent for a dispatcher drive with no eligible tech: the notice
	// doesn't name the tech.
	if (e.action === "drive") {
		const techId = e.activatedTechIds[0];
		fire("notifyTechOnTheWay", () =>
			notifyTechOnTheWay(e.visitId, techId, e.orgId),
		);
	}
	if (completed) {
		fire("notifyVisitCompleted", () =>
			notifyVisitCompleted(e.visitId, e.orgId),
		);
	}
	if (e.action === "cancel" && !e.suppressCustomerNotice) {
		fire("notifyVisitCancelled", () =>
			notifyVisitCancelled(e.visitId, e.orgId),
		);
	} else if (e.action === "cancel") {
		// notifyJobCancelled only reaches still-open visits, so a silenced
		// cancel must drop its own queued reminders.
		fire("skipVisitReminders", () =>
			skipVisitReminders(e.visitId, e.orgId, "job_cancelled"),
		);
	}
	if (e.action === "restore") {
		fire("notifyVisitRescheduled", () =>
			notifyVisitRescheduled(e.visitId, e.orgId),
		);
	}

	if (e.jobChange) {
		await runJobChangePostCommit(
			{ orgId: e.orgId, jobId: e.jobId, change: e.jobChange },
			context,
			v ? { jobNumber, clientName } : undefined,
		);
	}

	if (e.action === "delay") {
		await step("delayNotice", () =>
			notifyDispatchers(
				{
					type: "visit_delayed",
					title: `Visit delayed — Job ${jobNumber}`,
					body: `${clientName}'s visit was marked delayed.`,
					actionUrl: `/dispatch/jobs/${e.jobId}/visits/${e.visitId}`,
				},
				e.orgId,
				context?.dispatcherId,
			),
		);
	}

	if (e.action === "cancel") {
		const reason = e.cancellationReason;
		for (const techId of e.cancelledTechIds) {
			await step(`cancelNotice:${techId}`, () =>
				createNotification(
					{
						technicianId: techId,
						type: "visit_cancelled",
						title: `Visit cancelled: ${clientName}`,
						body: `A visit at ${clientName} has been cancelled.${reason ? ` Reason: ${reason}` : ""}`,
						vars: reason ? { client: clientName, reason, variant: "reason" } : { client: clientName },
						actionUrl: `/technician/visits/${e.visitId}`,
					},
					e.orgId,
				),
			);
		}
	}

	if (e.autoInvoicePlanId) {
		const planId = e.autoInvoicePlanId;
		await step("autoInvoice", () =>
			maybeAutoInvoiceOnCompletion(e.orgId, e.visitId, planId),
		);
	}
}

/**
 * What a committed job status change owes the outside world, for any writer
 * that ran syncJobFromVisits. Never rejects.
 */
export async function runJobChangePostCommit(
	args: { orgId: string; jobId: string; change: JobChange },
	context?: UserContext,
	names?: { jobNumber: string; clientName: string },
): Promise<void> {
	const { orgId, jobId, change } = args;
	const step = async (name: string, fn: () => unknown) => {
		try {
			await fn();
		} catch (err) {
			log.warn({ err, jobId, step: name }, "job post-commit step failed");
		}
	};
	const fire = (name: string, fn: () => Promise<unknown>) => {
		try {
			void fn().catch((err) =>
				log.warn({ err, jobId, step: name }, "job post-commit notice failed"),
			);
		} catch (err) {
			log.warn({ err, jobId, step: name }, "job post-commit notice failed");
		}
	};

	if (change.logRow) {
		const row = change.logRow;
		await step("activityHints", () => emitActivityHints(row));
	}
	await step("emitJob", () =>
		emitToOrg(orgId, "job:updated", { jobId, organizationId: orgId }),
	);

	if (change.to === "Completed") {
		fire("notifyJobCompleted", () => notifyJobCompleted(jobId, orgId));
		await step("jobFinishedNotice", async () => {
			let jobNumber = names?.jobNumber;
			let clientName = names?.clientName;
			if (jobNumber === undefined || clientName === undefined) {
				const job = await getScopedDb(orgId).job.findFirst({
					where: { id: jobId },
					select: {
						job_number: true,
						client: { select: { name: true } },
					},
				});
				jobNumber = job?.job_number ?? "";
				clientName = job?.client.name ?? "the client";
			}
			await notifyDispatchers(
				{
					type: "job_finished",
					title: `Job ${jobNumber} finished`,
					body: `${clientName}: all visits are complete.`,
					actionUrl: `/dispatch/jobs/${jobId}`,
				},
				orgId,
				context?.dispatcherId,
			);
		});
	}
	if (change.to === "Cancelled") {
		fire("notifyJobCancelled", () => notifyJobCancelled(jobId, orgId));
	}
}
