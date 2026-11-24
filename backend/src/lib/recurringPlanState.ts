import type { Prisma } from "../../generated/prisma/client.js";
import { getScopedDb, type UserContext } from "./context.js";
import { log } from "../services/appLogger.js";
import {
	calculateNextInvoiceAt,
	notBeforeAfterBilled,
	scheduleAnchor,
} from "./invoiceSchedule.js";
import { diffLocalDays, toLocalDate } from "./recurrence/zonedTime.js";
import type { JobChange, PostCommitEffects } from "../services/visitLifecycle/postCommit.js";

export type PlanStatus = "Active" | "Paused" | "Expired" | "Cancelled" | "Completed";

export const PLAN_TRANSITIONS: Record<PlanStatus, readonly PlanStatus[]> = {
	Active: ["Paused", "Cancelled", "Completed", "Expired"],
	Paused: ["Active", "Cancelled", "Completed"],
	Expired: ["Active", "Cancelled"],
	Cancelled: [],
	Completed: [],
};

// Expiry follows ends_at; a person ends a plan by cancelling or completing it.
const SYSTEM_ONLY: ReadonlyArray<readonly [PlanStatus, PlanStatus]> = [["Active", "Expired"]];

export function planEffects(s: PlanStatus): {
	generates: boolean;
	createsVisits: boolean;
	bills: boolean;
} {
	const on = s === "Active";
	return { generates: on, createsVisits: on, bills: on };
}

export function planBills(s: PlanStatus): boolean {
	return planEffects(s).bills;
}

const INACTIVE_MESSAGE: Record<Exclude<PlanStatus, "Active">, string> = {
	Paused: "Plan is paused",
	Expired: "Plan has expired",
	Cancelled: "Plan is cancelled",
	Completed: "Plan is completed",
};

/** Why a plan in `s` won't schedule; "" for an active plan. */
export function planInactiveMessage(s: PlanStatus): string {
	return s === "Active" ? "" : INACTIVE_MESSAGE[s];
}

export class PlanTransitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlanTransitionError";
	}
}

export function assertPlanTransition(
	from: PlanStatus,
	to: PlanStatus,
	actor: "user" | "system",
): void {
	const allowed = PLAN_TRANSITIONS[from]?.includes(to) ?? false;
	const systemOnly = SYSTEM_ONLY.some(([f, t]) => f === from && t === to);
	if (!allowed || (systemOnly && actor !== "system")) {
		throw new PlanTransitionError(
			`A ${from.toLowerCase()} plan can't be changed to ${to}.`,
		);
	}
}

/** What every plan write returns: the shape the plan detail page caches. */
export const RECURRING_PLAN_DETAIL_INCLUDE = {
	client: { include: { contacts: { include: { contact: true } } } },
	job_container: {
		select: {
			id: true,
			job_number: true,
			name: true,
			status: true,
			address: true,
			description: true,
			tax_rate: true,
		},
	},
	rules: { include: { by_weekday: true } },
	line_items: { orderBy: { sort_order: "asc" } },
	occurrences: { orderBy: { occurrence_start_at: "asc" } },
	invoice_schedule: true,
	created_by_dispatcher: { select: { id: true, name: true, email: true } },
} satisfies Prisma.recurring_planInclude;

export type RecurringPlanDetail = Prisma.recurring_planGetPayload<{
	include: typeof RECURRING_PLAN_DETAIL_INCLUDE;
}>;

const END_REASON: Partial<Record<PlanStatus, string>> = {
	Cancelled: "Plan cancelled",
	Completed: "Plan completed",
	Expired: "Plan expired",
};

function actorFields(ctx: UserContext | undefined) {
	return {
		actor_type: ctx?.techId
			? ("technician" as const)
			: ctx?.dispatcherId
				? ("dispatcher" as const)
				: ("system" as const),
		actor_id: ctx?.techId || ctx?.dispatcherId,
		ip_address: ctx?.ipAddress,
		user_agent: ctx?.userAgent,
	};
}

export async function transitionRecurringPlan(
	jobId: string,
	to: PlanStatus,
	orgId: string,
	ctx: UserContext | undefined,
	opts: {
		endsAt?: Date | null;
		reason?: string;
		actor?: "user" | "system";
		now?: Date;
	} = {},
): Promise<{ err: string; item?: RecurringPlanDetail }> {
	const actor = opts.actor ?? "user";
	const now = opts.now ?? new Date();
	try {
		const sdb = getScopedDb(orgId);
		const plan = await sdb.recurring_plan.findFirst({
			where: { job_container: { id: jobId } },
			include: {
				invoice_schedule: true,
				job_container: { select: { id: true } },
			},
		});
		if (!plan) return { err: "Recurring plan not found" };
		const from = plan.status as PlanStatus;
		const readDetail = async () =>
			(await sdb.recurring_plan.findFirst({
				where: { id: plan.id },
				include: RECURRING_PLAN_DETAIL_INCLUDE,
			})) ?? undefined;
		if (from === to) {
			// Silently dropping the new end date would read as a successful renewal.
			if (to === "Active" && opts.endsAt !== undefined) {
				throw new PlanTransitionError(
					"This plan is already active. Change its end date by editing the plan.",
				);
			}
			return { err: "", item: await readDetail() };
		}
		assertPlanTransition(from, to, actor);

		if (to === "Active") {
			if (from === "Expired" && opts.endsAt === undefined) {
				throw new PlanTransitionError(
					"Choose a new end date, or no end date, to renew this plan.",
				);
			}
			if (
				opts.endsAt &&
				diffLocalDays(
					toLocalDate(opts.endsAt, plan.timezone),
					toLocalDate(now, plan.timezone),
				) < 0
			) {
				throw new PlanTransitionError("The new end date must be today or later.");
			}
		}

		// Lazy: the lifecycle's load graph reaches the email service.
		const lifecycle = await import("../services/visitLifecycle/index.js");
		const { logActivityInTx, emitActivityHints } = await import(
			"../services/visitLifecycle/activityLog.js"
		);
		const endReason = END_REASON[to];
		const containerId = plan.job_container?.id ?? null;

		const { effects, jobChange, logRow } = await sdb.$transaction(async (stx) => {
			const tx = stx as unknown as Prisma.TransactionClient;
			// Plan row first: a concurrent transition waits here, then misses.
			const renewing = to === "Active" && opts.endsAt !== undefined;
			const written = await tx.recurring_plan.updateMany({
				where: { id: plan.id, status: from },
				data: {
					status: to,
					...(renewing && { ends_at: opts.endsAt, expiry_notified_at: null }),
				},
			});
			if (written.count === 0) {
				throw new PlanTransitionError(
					"This plan changed while you were saving. Reload and try again.",
				);
			}

			const effects: PostCommitEffects[] = [];
			let jobChange: JobChange | null = null;

			if (to === "Active") {
				const s = plan.invoice_schedule;
				if (s) {
					const data: Prisma.invoice_scheduleUpdateInput = {};
					// No catch-up: billing picks up from today.
					if (
						s.frequency !== "on_visit_completion" &&
						s.next_invoice_at &&
						s.next_invoice_at < now
					) {
						data.next_invoice_at = calculateNextInvoiceAt(
							scheduleAnchor(s, plan.timezone),
							{
								from: now,
								notBefore: notBeforeAfterBilled(
									plan.timezone,
									plan.starts_at,
									s,
								),
							},
						);
					}
					// Expiry switched the schedule off; billing_mode "none" keeps it off.
					if (from === "Expired" && plan.billing_mode !== "none") {
						data.is_active = true;
					}
					if (Object.keys(data).length > 0) {
						await tx.invoice_schedule.update({
							where: { recurring_plan_id: plan.id },
							data,
						});
					}
				}
			}

			if (endReason) {
				if (containerId && (to === "Cancelled" || to === "Completed")) {
					// Id order, like every multi-visit writer, so two writers can't deadlock.
					const scheduled = await tx.job_visit.findMany({
						where: {
							job_id: containerId,
							status: "Scheduled",
							scheduled_start_at: { gt: now },
							recurring_occurrence: { is: { recurring_plan_id: plan.id } },
						},
						select: { id: true },
						orderBy: { id: "asc" },
					});
					for (const v of scheduled) {
						// The read above took no lock: a visit that has since started is
						// left alone, as a started visit always is.
						const [locked] = await tx.$queryRaw<{ status: string }[]>`
							SELECT status::text AS status FROM job_visit
							WHERE id = ${v.id} FOR NO KEY UPDATE`;
						if (locked?.status !== "Scheduled") continue;
						effects.push(
							await lifecycle.applyStatusChange(tx, {
								orgId,
								visitId: v.id,
								action: "cancel",
								context: ctx,
								now,
								cancellationReason: opts.reason ?? endReason,
								deferJobSync: true,
							}),
						);
					}
				}

				await tx.recurring_occurrence.updateMany({
					where: {
						recurring_plan_id: plan.id,
						status: "planned",
						// Top-up still turns a row into a visit until its window closes.
						occurrence_end_at: { gt: now },
					},
					data: { status: "cancelled", skip_reason: endReason },
				});
				await tx.invoice_schedule.updateMany({
					where: { recurring_plan_id: plan.id },
					data: { is_active: false },
				});

				if (containerId) {
					const completed = await tx.job_visit.count({
						where: { job_id: containerId, status: "Completed" },
					});
					// Without cancel, a container with no visits derives Unscheduled.
					jobChange = await lifecycle.syncJobFromVisits(tx, orgId, containerId, {
						now,
						context: ctx,
						...(completed === 0 && {
							cancel: { reason: opts.reason ?? endReason },
						}),
					});
				}
			}

			const logRow = await logActivityInTx(tx, {
				event_type: `recurring_plan.${to.toLowerCase()}`,
				action: "updated",
				entity_type: "recurring_plan",
				entity_id: plan.id,
				organization_id: orgId,
				...actorFields(ctx),
				changes: {
					status: { old: from, new: to },
					...(opts.reason && { reason: { old: null, new: opts.reason } }),
				},
			});

			return { effects, jobChange, logRow };
		});

		try {
			await emitActivityHints(logRow);
		} catch (err) {
			log.warn({ err, planId: plan.id }, "Plan transition activity hint failed");
		}
		for (const e of effects) await lifecycle.runPostCommit(e, ctx);
		if (jobChange && containerId) {
			await lifecycle.runJobChangePostCommit(
				{ orgId, jobId: containerId, change: jobChange },
				ctx,
			);
		}
		if (to === "Active") {
			// A rule edit while paused deleted the future rows, so this is what
			// refills the calendar and creates the visits now due.
			const { topUpPlan } = await import("../services/recurringPlanScheduler.js");
			void topUpPlan(plan.id, orgId).catch((err: unknown) =>
				log.warn({ err, planId: plan.id }, "Post-resume occurrence top-up failed"),
			);
		}

		return { err: "", item: await readDetail() };
	} catch (e) {
		if (e instanceof PlanTransitionError) return { err: e.message };
		// By name: the class lives in the lazily loaded lifecycle module.
		if (e instanceof Error && e.name === "LifecycleRefusal") return { err: e.message };
		log.error({ err: e, jobId, to }, "Recurring plan transition error");
		throw e;
	}
}
