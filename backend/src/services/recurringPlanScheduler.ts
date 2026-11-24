import type { Prisma } from "../../generated/prisma/client.js";
import { db } from "../db.js";
import { getScopedDb } from "../lib/context.js";
import { isModuleOn } from "./entitlementService.js";
import { log } from "./appLogger.js";
import { reconcileLegacySlots } from "../lib/recurrence/reconcileLegacySlots.js";
import {
	addLocalDays,
	diffLocalDays,
	toLocalDate,
	zonedWallTimeToUtc,
	type LocalDate,
} from "../lib/recurrence/zonedTime.js";
import {
	planEffects,
	transitionRecurringPlan,
	type PlanStatus,
} from "../lib/recurringPlanState.js";
import {
	generateOccurrencesForPlan,
	generateVisitFromOccurrence,
	InvalidPlanScheduleError,
} from "../controllers/recurringPlansController.js";
import { notifyDispatchers } from "../controllers/notificationsController.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_NOTICE_DAYS = 30;

type LockedOutcome =
	| { kind: "skip" }
	| { kind: "expire"; jobId: string | null }
	| {
			kind: "topped";
			generated: number;
			timezone: string;
			today: LocalDate;
			minAdvanceDays: number;
			notice: { name: string; endsOn: LocalDate } | null;
	  };

function formatLocalDate(d: LocalDate): string {
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${d}T00:00:00Z`));
}

/**
 * One plan's daily run: repair legacy slots, expire or warn about the end
 * date, extend the occurrence window, then create the visits due within
 * min_advance_days. Visits are created after the lock tx commits, each in
 * generateVisitFromOccurrence's own tx, so the lock order there (plan, visit,
 * occurrence, job) never nests inside ours.
 */
export async function topUpPlan(
	planId: string,
	orgId: string,
	now: Date = new Date(),
): Promise<{ generated: number; visitsCreated: number }> {
	const sdb = getScopedDb(orgId);

	const outcome = await sdb.$transaction(
		async (stx): Promise<LockedOutcome> => {
			const tx = stx as unknown as Prisma.TransactionClient;
			const [{ got }] = await tx.$queryRaw<
				{ got: boolean }[]
			>`SELECT pg_try_advisory_xact_lock(hashtext(${"recurring_topup:" + planId})) AS got`;
			if (!got) {
				log.debug(
					{ planId },
					"Recurring plan top-up held elsewhere - skipping",
				);
				return { kind: "skip" };
			}
			// Row lock first, as every plan writer takes it: a transition or
			// visit generation waits for this run instead of seeing half of it.
			const locked = await tx.$queryRaw<{ id: string }[]>`
				SELECT id FROM recurring_plan WHERE id = ${planId} FOR NO KEY UPDATE`;
			if (locked.length === 0) return { kind: "skip" };
			const plan = await tx.recurring_plan.findUnique({
				where: { id: planId },
				select: {
					name: true,
					status: true,
					timezone: true,
					ends_at: true,
					expiry_notified_at: true,
					min_advance_days: true,
					job_container: { select: { id: true } },
				},
			});
			if (!plan || !planEffects(plan.status as PlanStatus).generates) {
				return { kind: "skip" };
			}

			await reconcileLegacySlots(planId, tx);

			const today = toLocalDate(now, plan.timezone);
			let notice: { name: string; endsOn: LocalDate } | null = null;
			if (plan.ends_at) {
				const endsOn = toLocalDate(plan.ends_at, plan.timezone);
				const daysLeft = diffLocalDays(endsOn, today);
				if (daysLeft < 0) {
					return {
						kind: "expire",
						jobId: plan.job_container?.id ?? null,
					};
				}
				if (
					daysLeft <= EXPIRY_NOTICE_DAYS &&
					!plan.expiry_notified_at
				) {
					// Keyed on ends_at too: a renewal that moved the date
					// clears the flag for the new date, which this must not set.
					const flagged = await tx.recurring_plan.updateMany({
						where: {
							id: planId,
							expiry_notified_at: null,
							ends_at: plan.ends_at,
						},
						data: { expiry_notified_at: now },
					});
					if (flagged.count > 0) notice = { name: plan.name, endsOn };
				}
			}

			const { generated } = await generateOccurrencesForPlan(planId, tx, {
				now,
			});
			await tx.recurring_plan.update({
				where: { id: planId },
				data: { last_topped_up_at: now },
			});
			return {
				kind: "topped",
				generated,
				timezone: plan.timezone,
				today,
				minAdvanceDays: plan.min_advance_days,
				notice,
			};
		},
		{ timeout: 120_000, maxWait: 10_000 },
	);

	if (outcome.kind === "skip") return { generated: 0, visitsCreated: 0 };

	if (outcome.kind === "expire") {
		if (!outcome.jobId) {
			log.warn(
				{ planId, orgId },
				"Recurring plan past its end date has no job - not expired",
			);
			return { generated: 0, visitsCreated: 0 };
		}
		const res = await transitionRecurringPlan(
			outcome.jobId,
			"Expired",
			orgId,
			undefined,
			{
				actor: "system",
				now,
			},
		);
		if (res.err) {
			log.warn(
				{ planId, orgId, err: res.err },
				"Recurring plan expiry refused",
			);
		}
		return { generated: 0, visitsCreated: 0 };
	}

	if (outcome.notice) {
		try {
			await notifyDispatchers(
				{
					type: "recurring_plan_expiring",
					title: "Plan ending soon",
					body: `${outcome.notice.name} ends ${formatLocalDate(outcome.notice.endsOn)}. Renew it to keep visits coming.`,
					actionUrl: `/dispatch/recurring-plans/${planId}`,
				},
				orgId,
			);
		} catch (err) {
			log.error(
				{ err, planId, orgId },
				"Recurring plan expiry notice failed",
			);
		}
	}

	// Exclusive end: the first instant of the day after the last day in range.
	const horizon = zonedWallTimeToUtc(
		addLocalDays(outcome.today, Math.max(0, outcome.minAdvanceDays) + 1),
		"00:00",
		outcome.timezone,
	);
	const due = await sdb.recurring_occurrence.findMany({
		where: {
			recurring_plan_id: planId,
			status: "planned",
			job_visit_id: null,
			// Same rule as generation: a started visit whose window is open still counts.
			occurrence_end_at: { gt: now },
			occurrence_start_at: { lt: horizon },
		},
		select: { id: true },
		orderBy: { occurrence_start_at: "asc" },
	});

	let visitsCreated = 0;
	for (const occ of due) {
		try {
			const res = await generateVisitFromOccurrence(
				occ.id,
				orgId,
				undefined,
			);
			if (res.err) {
				log.warn(
					{ planId, orgId, occurrenceId: occ.id, err: res.err },
					"Recurring visit not created",
				);
				continue;
			}
			visitsCreated += 1;
		} catch (err) {
			log.error(
				{ err, planId, orgId, occurrenceId: occ.id },
				"Recurring visit creation failed - continuing",
			);
		}
	}

	return { generated: outcome.generated, visitsCreated };
}

export async function runRecurringPlanTopUp(
	now: Date = new Date(),
): Promise<void> {
	// Root db for the claim only; each plan then works through its org's scoped db.
	const plans = await db.recurring_plan.findMany({
		where: { status: "Active", organization_id: { not: null } },
		select: { id: true, organization_id: true },
		orderBy: { id: "asc" },
	});
	if (plans.length === 0) return;
	log.info({ count: plans.length }, "Running recurring plan top-up");

	const moduleOn = new Map<string, boolean>();
	for (const p of plans) {
		const orgId = p.organization_id;
		if (!orgId) continue;
		try {
			if (!moduleOn.has(orgId)) {
				moduleOn.set(orgId, await isModuleOn(orgId, "recurring_plans"));
			}
			if (!moduleOn.get(orgId)) continue;
			await topUpPlan(p.id, orgId, now);
		} catch (err) {
			log.error(
				{ err, planId: p.id, orgId },
				err instanceof InvalidPlanScheduleError
					? "Recurring plan can't be scheduled - skipped this run"
					: "Recurring plan top-up failed - continuing",
			);
		}
	}
}

export function startRecurringPlanSchedulerInterval(): void {
	// Startup run fills any window missed during downtime.
	runRecurringPlanTopUp().catch((err) =>
		log.error({ err }, "Recurring plan top-up startup run failed"),
	);
	setInterval(() => {
		runRecurringPlanTopUp().catch((err) =>
			log.error({ err }, "Recurring plan top-up interval run failed"),
		);
	}, DAY_MS);
}
