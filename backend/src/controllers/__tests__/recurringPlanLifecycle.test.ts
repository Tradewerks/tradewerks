import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	cancelRecurringPlan,
	generateVisitFromOccurrence,
	updateRecurringPlan,
} from "../recurringPlansController.js";
import { transitionRecurringPlan } from "../../lib/recurringPlanState.js";
import { getScopedDb } from "../../lib/context.js";
import { calculateNextInvoiceAt } from "../../lib/invoiceSchedule.js";
import { deriveJobStatus } from "../../services/visitLifecycle/deriveJobStatus.js";
import { cancelJob } from "../jobsController.js";
import { notifyVisitScheduled } from "../../services/customerComms/visitEvents.js";

vi.mock("../../services/customerComms/visitEvents.js", () => ({
	notifyVisitScheduled: vi.fn(async () => undefined),
}));
vi.mock("../../services/followupTriggers.js", () => ({
	onVisitScheduled: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../db.js", () => ({
	db: {},
	generateJobNumber: vi.fn().mockResolvedValue("J-0001"),
}));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn() }));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));
vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

type VisitStatus = "Scheduled" | "InProgress" | "Completed" | "Cancelled";

const order: string[] = [];
// The visits the container is left with once the plan's tx has run.
let visitsAfter: { status: VisitStatus }[] = [];

const lifecycle = vi.hoisted(() => ({
	applyStatusChange: vi.fn(),
	syncJobFromVisits: vi.fn(),
	runPostCommit: vi.fn(),
	runJobChangePostCommit: vi.fn(async () => undefined),
	LifecycleRefusal: class LifecycleRefusal extends Error {},
}));
vi.mock("../../services/visitLifecycle/index.js", () => lifecycle);

const ORG = "org-1";
const FULL_RELATIONS = {
	client: { id: "client-1", name: "Acme", contacts: [] },
	job_container: {
		id: "job-1",
		job_number: "J-1",
		name: "Plan",
		status: "Scheduled",
	},
	invoice_schedule: null,
	rules: [],
	line_items: [],
	occurrences: [],
};
const NOW = new Date("2026-11-23T18:00:00Z"); // 12:00 in Chicago

function makePlan(over: Record<string, unknown> = {}) {
	return {
		id: "plan-1",
		organization_id: ORG,
		status: "Active",
		timezone: "America/Chicago",
		billing_mode: "subscription",
		ends_at: null as Date | null,
		job_container: { id: "job-1" },
		invoice_schedule: null as Record<string, unknown> | null,
		...over,
	};
}

function setup(
	plan: ReturnType<typeof makePlan>,
	opts: {
		scheduled?: string[];
		completed?: number;
		/** Status each visit has once its row is locked; default Scheduled. */
		lockedStatus?: Record<string, string>;
	} = {},
) {
	const tx = {
		$queryRaw: vi.fn(async (_s: TemplateStringsArray, id: string) => [
			{ status: opts.lockedStatus?.[id] ?? "Scheduled" },
		]),
		recurring_plan_line_item: { findMany: vi.fn(async () => []) },
		log: { create: vi.fn(async () => ({ id: "log-1" })) },
		recurring_plan: {
			updateMany: vi.fn(async () => ({ count: 1 })),
			findUnique: vi.fn(async () => plan),
			update: vi.fn(
				async ({ data }: { data: Record<string, unknown> }) => ({
					...plan,
					...data,
				}),
			),
		},
		recurring_occurrence: {
			updateMany: vi.fn(async () => ({ count: 0 })),
			createMany: vi.fn(async () => ({ count: 0 })),
		},
		invoice_schedule: {
			updateMany: vi.fn(async () => ({ count: 1 })),
			update: vi.fn(async () => ({})),
		},
		job_visit: {
			findMany: vi.fn(async () =>
				(opts.scheduled ?? []).map((id) => ({ id })),
			),
			count: vi.fn(async () => opts.completed ?? 0),
		},
	};
	const sdb = {
		recurring_plan: {
			findFirst: vi.fn(
				async (args: { include?: Record<string, unknown> }) =>
					args?.include?.client
						? { ...plan, ...FULL_RELATIONS }
						: plan,
			),
		},
		recurring_occurrence: { findUnique: vi.fn() },
		$transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => {
			const r = await cb(tx);
			order.push("commit");
			return r;
		}),
	};
	vi.mocked(getScopedDb).mockReturnValue(sdb as never);
	return { tx, sdb };
}

beforeEach(() => {
	vi.clearAllMocks();
	order.length = 0;
	visitsAfter = [];
	lifecycle.applyStatusChange.mockImplementation(
		async (_tx: unknown, args: { visitId: string }) => {
			order.push(`apply:${args.visitId}`);
			return { visitId: args.visitId, action: "cancel" };
		},
	);
	lifecycle.runPostCommit.mockImplementation(
		async (e: { visitId: string }) => {
			order.push(`post:${e.visitId}`);
		},
	);
	lifecycle.syncJobFromVisits.mockImplementation(
		async (
			_tx: unknown,
			_org: string,
			_job: string,
			o: { cancel?: unknown },
		) => ({
			from: "Scheduled",
			to: deriveJobStatus(visitsAfter, {
				cancelled_at: o.cancel ? NOW : null,
			}),
		}),
	);
});

describe("recurring plan lifecycle", () => {
	it("cancel cancels future Scheduled visits through cancelJobVisit after commit and leaves started visits alone", async () => {
		const { tx } = setup(makePlan(), { scheduled: ["v1", "v2"] });
		visitsAfter = [
			{ status: "InProgress" },
			{ status: "Cancelled" },
			{ status: "Cancelled" },
		];

		const res = await transitionRecurringPlan(
			"job-1",
			"Cancelled",
			ORG,
			undefined,
			{
				now: NOW,
				reason: "Customer moved",
			},
		);

		expect(res.err).toBe("");
		// Only future visits that haven't started are picked up.
		expect(tx.job_visit.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					job_id: "job-1",
					status: "Scheduled",
					scheduled_start_at: { gt: NOW },
				}),
			}),
		);
		expect(lifecycle.applyStatusChange).toHaveBeenCalledTimes(2);
		for (const [, args] of lifecycle.applyStatusChange.mock.calls) {
			expect(args).toMatchObject({
				action: "cancel",
				cancellationReason: "Customer moved",
			});
			// The customer gets the cancel notice.
			expect(args.suppressCustomerNotice).toBeFalsy();
		}
		expect(order).toEqual([
			"apply:v1",
			"apply:v2",
			"commit",
			"post:v1",
			"post:v2",
		]);
		expect(tx.recurring_occurrence.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ status: "planned" }),
				data: { status: "cancelled", skip_reason: "Plan cancelled" },
			}),
		);
	});

	it("ending a plan cancels a planned row whose window is still open, as top-up treats it live", async () => {
		const { tx } = setup(makePlan());
		visitsAfter = [];
		await transitionRecurringPlan("job-1", "Cancelled", ORG, undefined, {
			now: NOW,
		});
		expect(tx.recurring_occurrence.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					recurring_plan_id: "plan-1",
					status: "planned",
					occurrence_end_at: { gt: NOW },
				},
			}),
		);
	});

	it("cancel deactivates the invoice schedule and sets the container Completed when a visit was completed, Cancelled otherwise", async () => {
		const first = setup(makePlan(), { completed: 1 });
		visitsAfter = [{ status: "Completed" }, { status: "Cancelled" }];
		await transitionRecurringPlan("job-1", "Cancelled", ORG, undefined, {
			now: NOW,
		});
		expect(first.tx.invoice_schedule.updateMany).toHaveBeenCalledWith({
			where: { recurring_plan_id: "plan-1" },
			data: { is_active: false },
		});
		expect(lifecycle.runJobChangePostCommit).toHaveBeenLastCalledWith(
			expect.objectContaining({
				change: expect.objectContaining({ to: "Completed" }),
			}),
			undefined,
		);

		const second = setup(makePlan(), { completed: 0 });
		visitsAfter = [];
		await transitionRecurringPlan("job-1", "Cancelled", ORG, undefined, {
			now: NOW,
		});
		expect(second.tx.invoice_schedule.updateMany).toHaveBeenCalled();
		expect(lifecycle.runJobChangePostCommit).toHaveBeenLastCalledWith(
			expect.objectContaining({
				change: expect.objectContaining({ to: "Cancelled" }),
			}),
			undefined,
		);
	});

	it("resume with generate_days_before longer than the period does not re-bill a billed period", async () => {
		// Weekly MO, gdb 10: Mon Nov 23 was billed on Nov 13; next is Nov 20 for Nov 30.
		const schedule = {
			frequency: "weekly",
			day_of_month: null,
			day_of_week: "MO",
			generate_days_before: 10,
			next_invoice_at: new Date("2026-11-20T06:00:00Z"),
			last_invoiced_at: new Date("2026-11-13T06:05:00Z"),
			is_active: true,
		};
		const { tx } = setup(
			makePlan({
				status: "Paused",
				starts_at: new Date("2026-01-01T06:00:00Z"),
				invoice_schedule: schedule,
			}),
		);

		const res = await transitionRecurringPlan(
			"job-1",
			"Active",
			ORG,
			undefined,
			{ now: NOW },
		);

		expect(res.err).toBe("");
		// Nov 30 billing, due now: never Nov 23 again.
		expect(tx.invoice_schedule.update).toHaveBeenCalledWith({
			where: { recurring_plan_id: "plan-1" },
			data: expect.objectContaining({
				next_invoice_at: new Date("2026-11-20T06:00:00Z"),
			}),
		});
	});

	it("resume recomputes a past next_invoice_at from today", async () => {
		const schedule = {
			frequency: "monthly",
			day_of_month: 15,
			day_of_week: null,
			generate_days_before: 0,
			next_invoice_at: new Date("2026-06-15T05:00:00Z"),
			is_active: true,
		};
		const { tx } = setup(
			makePlan({ status: "Paused", invoice_schedule: schedule }),
		);

		const res = await transitionRecurringPlan(
			"job-1",
			"Active",
			ORG,
			undefined,
			{ now: NOW },
		);

		expect(res.err).toBe("");
		const expected = calculateNextInvoiceAt(
			{
				frequency: "monthly",
				dayOfMonth: 15,
				dayOfWeek: null,
				generateDaysBefore: 0,
				timezone: "America/Chicago",
			},
			{ from: NOW },
		);
		expect(expected.toISOString()).toBe("2026-12-15T06:00:00.000Z");
		expect(tx.invoice_schedule.update).toHaveBeenCalledWith({
			where: { recurring_plan_id: "plan-1" },
			data: expect.objectContaining({ next_invoice_at: expected }),
		});
	});

	it("renew from Expired requires ends_at today or later, or null", async () => {
		// 2026-11-22 local in Chicago: yesterday.
		const yesterday = new Date("2026-11-22T18:00:00Z");
		let env = setup(makePlan({ status: "Expired" }));
		let res = await transitionRecurringPlan(
			"job-1",
			"Active",
			ORG,
			undefined,
			{
				now: NOW,
				endsAt: yesterday,
			},
		);
		expect(res.err).toMatch(/today or later/);
		expect(env.sdb.$transaction).not.toHaveBeenCalled();

		env = setup(makePlan({ status: "Expired" }));
		res = await transitionRecurringPlan("job-1", "Active", ORG, undefined, {
			now: NOW,
		});
		expect(res.err).toMatch(/end date/);
		expect(env.sdb.$transaction).not.toHaveBeenCalled();

		// Local midnight today still counts as today.
		const today = new Date("2026-11-23T06:00:00Z");
		env = setup(makePlan({ status: "Expired" }));
		res = await transitionRecurringPlan("job-1", "Active", ORG, undefined, {
			now: NOW,
			endsAt: today,
		});
		expect(res.err).toBe("");
		expect(env.tx.recurring_plan.updateMany).toHaveBeenCalledWith({
			where: { id: "plan-1", status: "Expired" },
			data: {
				status: "Active",
				ends_at: today,
				expiry_notified_at: null,
			},
		});

		env = setup(makePlan({ status: "Expired" }));
		res = await transitionRecurringPlan("job-1", "Active", ORG, undefined, {
			now: NOW,
			endsAt: null,
		});
		expect(res.err).toBe("");
		expect(env.tx.recurring_plan.updateMany).toHaveBeenCalledWith({
			where: { id: "plan-1", status: "Expired" },
			data: { status: "Active", ends_at: null, expiry_notified_at: null },
		});
	});

	it("refuses a user transition the table doesn't allow", async () => {
		const { sdb } = setup(makePlan({ status: "Cancelled" }));
		const res = await transitionRecurringPlan(
			"job-1",
			"Active",
			ORG,
			undefined,
		);
		expect(res.err).not.toBe("");
		expect(sdb.$transaction).not.toHaveBeenCalled();
	});

	it("cancelling an already cancelled plan is a no-op", async () => {
		const { sdb } = setup(makePlan({ status: "Cancelled" }));
		expect((await cancelRecurringPlan("job-1", ORG)).err).toBe("");
		expect(sdb.$transaction).not.toHaveBeenCalled();
	});

	it('generateVisitFromOccurrence refuses on a paused plan with "Plan is paused"', async () => {
		const { sdb } = setup(makePlan({ status: "Paused" }));
		sdb.recurring_occurrence.findUnique.mockResolvedValue({
			id: "occ-1",
			status: "planned",
			job_visit_id: null,
			recurring_plan: {
				...makePlan({ status: "Paused" }),
				line_items: [],
				rules: [],
			},
		});

		const res = await generateVisitFromOccurrence("occ-1", ORG);

		expect(res.err).toBe("Plan is paused");
		expect(sdb.$transaction).not.toHaveBeenCalled();
	});

	it("updateRecurringPlan ignores a status field in the body", async () => {
		const plan = { ...makePlan(), rules: [], line_items: [] };
		const { tx } = setup(plan as never);

		const res = await updateRecurringPlan(
			"job-1",
			{ status: "Cancelled", generation_window_days: 30 },
			ORG,
		);

		expect(res.err).toBe("");
		expect(tx.recurring_plan.update).toHaveBeenCalledTimes(1);
		const [{ data }] = tx.recurring_plan.update.mock
			.calls[0] as unknown as [{ data: Record<string, unknown> }];
		expect(data).not.toHaveProperty("status");
		expect(data).toMatchObject({ generation_window_days: 30 });
	});
	it("returns the plan with the relations the detail page reads", async () => {
		const { sdb } = setup(makePlan());
		const res = await transitionRecurringPlan(
			"job-1",
			"Paused",
			ORG,
			undefined,
			{ now: NOW },
		);
		expect(res.err).toBe("");
		expect(res.item).toMatchObject({
			client: { name: "Acme" },
			job_container: { id: "job-1", job_number: "J-1" },
			invoice_schedule: null,
			rules: [],
			line_items: [],
		});
		const lastRead = sdb.recurring_plan.findFirst.mock.calls.at(-1)![0] as {
			include: Record<string, unknown>;
		};
		expect(Object.keys(lastRead.include)).toEqual(
			expect.arrayContaining([
				"client",
				"job_container",
				"invoice_schedule",
				"rules",
				"line_items",
			]),
		);
	});

	it("skips a visit that left Scheduled before its row was locked", async () => {
		setup(makePlan(), {
			scheduled: ["v1", "v2"],
			lockedStatus: { v2: "Driving" },
		});
		visitsAfter = [{ status: "Cancelled" }, { status: "InProgress" }];

		await transitionRecurringPlan("job-1", "Cancelled", ORG, undefined, {
			now: NOW,
		});

		expect(lifecycle.applyStatusChange).toHaveBeenCalledTimes(1);
		expect(lifecycle.applyStatusChange.mock.calls[0][1]).toMatchObject({
			visitId: "v1",
		});
		expect(order).toEqual(["apply:v1", "commit", "post:v1"]);
	});

	it("writes the transition's log row inside the transaction", async () => {
		const { tx } = setup(makePlan());
		await transitionRecurringPlan("job-1", "Paused", ORG, undefined, {
			now: NOW,
		});
		expect(tx.log.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				event_type: "recurring_plan.paused",
				changes: { status: { old: "Active", new: "Paused" } },
			}),
		});
	});

	it("refuses to renew a plan that is already active", async () => {
		const { sdb } = setup(makePlan({ status: "Active" }));
		const res = await transitionRecurringPlan(
			"job-1",
			"Active",
			ORG,
			undefined,
			{
				now: NOW,
				endsAt: new Date("2027-01-01T00:00:00Z"),
			},
		);
		expect(res.err).toMatch(/already active/);
		expect(sdb.$transaction).not.toHaveBeenCalled();
	});

	describe("generateVisitFromOccurrence racing a plan change", () => {
		function genSetup(lockedPlanStatus: string, occurrenceWritten: number) {
			const { tx, sdb } = setup(makePlan());
			const txAny = tx as unknown as Record<string, unknown>;
			tx.$queryRaw.mockImplementation(async () => [
				{ status: lockedPlanStatus },
			]);
			txAny.job_visit = {
				...tx.job_visit,
				create: vi.fn(async () => ({
					id: "visit-1",
					scheduled_start_at: NOW,
					scheduled_end_at: NOW,
				})),
			};
			txAny.recurring_occurrence = {
				...tx.recurring_occurrence,
				updateMany: vi.fn(async () => ({ count: occurrenceWritten })),
				update: vi.fn(),
				// The in-tx re-read under the plan lock.
				findUnique: vi.fn(async () => ({
					id: "occ-1",
					status: "planned",
					job_visit_id: null,
					occurrence_start_at: NOW,
					occurrence_end_at: NOW,
					template_version: 1,
				})),
			};
			sdb.recurring_occurrence.findUnique.mockResolvedValue({
				id: "occ-1",
				status: "planned",
				job_visit_id: null,
				occurrence_start_at: NOW,
				occurrence_end_at: NOW,
				template_version: 1,
				recurring_plan: {
					...makePlan(),
					job_container: { id: "job-1", tax_rate: 0 },
					line_items: [],
					rules: [{}],
				},
			});
			return { tx: txAny, sdb };
		}

		it("refuses when the plan was cancelled before the lock", async () => {
			const { tx } = genSetup("Cancelled", 1);
			const res = await generateVisitFromOccurrence("occ-1", ORG);
			expect(res.err).toBe("Plan is cancelled");
			expect(
				(tx.job_visit as { create: ReturnType<typeof vi.fn> }).create,
			).not.toHaveBeenCalled();
			expect(notifyVisitScheduled).not.toHaveBeenCalled();
		});

		it("refuses when the occurrence is no longer planned", async () => {
			const { tx } = genSetup("Active", 0);
			const res = await generateVisitFromOccurrence("occ-1", ORG);
			expect(res.err).toMatch(/planned/);
			expect(
				(
					tx.recurring_occurrence as {
						updateMany: ReturnType<typeof vi.fn>;
					}
				).updateMany,
			).toHaveBeenCalledWith(
				expect.objectContaining({
					where: {
						id: "occ-1",
						status: "planned",
						job_visit_id: null,
					},
				}),
			);
			expect(lifecycle.syncJobFromVisits).not.toHaveBeenCalled();
			expect(notifyVisitScheduled).not.toHaveBeenCalled();
		});
	});

	it("refuses to cancel the container job of a paused or expired plan", async () => {
		for (const status of ["Paused", "Expired", "Active"]) {
			const sdb = {
				job: {
					findFirst: vi.fn(async () => ({
						status: "Scheduled",
						recurring_plan: { status },
					})),
				},
				$transaction: vi.fn(),
			};
			vi.mocked(getScopedDb).mockReturnValue(sdb as never);
			const res = await cancelJob("job-1", "x", ORG, {
				dispatcherId: "d-1",
			});
			expect(res, status).toMatchObject({
				code: "WRONG_STATE",
				err: "Cancel the recurring plan instead.",
			});
			expect(sdb.$transaction).not.toHaveBeenCalled();
		}
	});
});
