import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	updateRecurringPlan,
	upsertInvoiceSchedule,
} from "../recurringPlansController.js";
import { getScopedDb } from "../../lib/context.js";

vi.mock("../../services/customerComms/visitEvents.js", () => ({
	notifyVisitScheduled: vi.fn(async () => undefined),
	notifyVisitRescheduled: vi.fn(async () => undefined),
	notifyVisitCancelled: vi.fn(async () => undefined),
	retimeVisitReminders: vi.fn(async () => undefined),
	notifyJobCompleted: vi.fn(async () => undefined),
	notifyVisitCompleted: vi.fn(async () => undefined),
	notifyTechOnTheWay: vi.fn(async () => undefined),
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
vi.mock("../../services/followupTriggers.js", () => ({
	onVisitScheduled: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("invoice schedule recompute after billing", () => {
	it("editing the schedule on the billing day after the run bills next month, not today", async () => {
		// The scheduler billed Nov 23 at 00:05 Chicago; the edit lands at 15:00.
		vi.setSystemTime(new Date("2026-11-23T21:00:00Z"));
		const upsert = vi.fn().mockResolvedValue({ id: "sched-1" });
		vi.mocked(getScopedDb).mockReturnValue({
			recurring_plan: {
				findFirst: vi.fn().mockResolvedValue({
					id: "plan-1",
					timezone: "America/Chicago",
					starts_at: new Date("2026-01-01T06:00:00Z"),
				}),
			},
			invoice_schedule: {
				findFirst: vi.fn().mockResolvedValue({
					frequency: "monthly",
					day_of_month: 23,
					day_of_week: null,
					generate_days_before: 0,
					next_invoice_at: new Date("2026-12-23T06:00:00Z"),
					last_invoiced_at: new Date("2026-11-23T06:05:00Z"),
				}),
				upsert,
			},
		} as never);

		const r = await upsertInvoiceSchedule(
			"job-1",
			{
				billing_basis: "plan_line_items",
				frequency: "monthly",
				day_of_month: 23,
				generate_days_before: 2,
			},
			"org-1",
		);

		expect(r.err).toBe("");
		expect(
			upsert.mock.calls[0][0].update.next_invoice_at.toISOString(),
		).toBe("2026-12-21T06:00:00.000Z");
	});

	it("moving starts_at later recomputes next_invoice_at even with the anchor unchanged", async () => {
		vi.setSystemTime(new Date("2026-11-23T21:00:00Z"));
		const tz = "America/Chicago";
		const upsert = vi.fn().mockResolvedValue({ id: "sched-1" });
		const tx = {
			recurring_plan: {
				update: vi.fn().mockResolvedValue({
					id: "plan-1",
					timezone: tz,
					starts_at: new Date("2027-03-10T15:00:00Z"),
				}),
				findUnique: vi.fn().mockResolvedValue({ id: "plan-1" }),
			},
			invoice_schedule: {
				findFirst: vi.fn().mockResolvedValue({
					frequency: "monthly",
					day_of_month: 1,
					day_of_week: null,
					generate_days_before: 0,
					next_invoice_at: new Date("2026-12-01T06:00:00Z"),
					last_invoiced_at: null,
				}),
				upsert,
			},
		};
		vi.mocked(getScopedDb).mockReturnValue({
			recurring_plan: {
				findFirst: vi.fn().mockResolvedValue({
					id: "plan-1",
					organization_id: "org-1",
					timezone: tz,
					starts_at: new Date("2026-01-01T06:00:00Z"),
					rules: [],
					line_items: [],
				}),
			},
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			$transaction: vi.fn((cb: any) => cb(tx)),
		} as never);

		const r = await updateRecurringPlan(
			"job-1",
			{
				starts_at: "2027-03-10T15:00:00.000Z",
				billing_mode: "subscription",
				invoice_schedule: {
					billing_basis: "plan_line_items",
					frequency: "monthly",
					day_of_month: 1,
				},
			},
			"org-1",
		);

		expect(r.err).toBe("");
		expect(
			upsert.mock.calls[0][0].update.next_invoice_at.toISOString(),
		).toBe("2027-04-01T05:00:00.000Z");
	});

	describe("floor at the first unbilled period from next_invoice_at", () => {
		const CHI = "America/Chicago";

		async function editGdb(
			now: string,
			existing: Record<string, unknown>,
			body: Record<string, unknown>,
		) {
			vi.setSystemTime(new Date(now));
			const upsert = vi.fn().mockResolvedValue({ id: "sched-1" });
			vi.mocked(getScopedDb).mockReturnValue({
				recurring_plan: {
					findFirst: vi.fn().mockResolvedValue({
						id: "plan-1",
						timezone: CHI,
						starts_at: new Date("2026-01-01T06:00:00Z"),
					}),
				},
				invoice_schedule: {
					findFirst: vi.fn().mockResolvedValue(existing),
					upsert,
				},
			} as never);
			const r = await upsertInvoiceSchedule(
				"job-1",
				{ billing_basis: "plan_line_items", ...body },
				"org-1",
			);
			expect(r.err).toBe("");
			return upsert.mock.calls[0][0].update.next_invoice_at as Date;
		}

		it("two gdb edits between runs keep the Dec 23 billing", async () => {
			// Billed Nov 23 (run Nov 18, gdb 5); Nov 19 edit set gdb 0.
			const next = await editGdb(
				"2026-11-20T21:00:00Z",
				{
					frequency: "monthly",
					day_of_month: 23,
					day_of_week: null,
					generate_days_before: 0,
					next_invoice_at: new Date("2026-12-23T06:00:00Z"),
					last_invoiced_at: new Date("2026-11-18T06:05:00Z"),
				},
				{
					frequency: "monthly",
					day_of_month: 23,
					generate_days_before: 3,
				},
			);
			expect(next.toISOString()).toBe("2026-12-20T06:00:00.000Z");
		});

		it("gdb edit after an early manual generate keeps the Jan 1 billing", async () => {
			// Manual generate Nov 20 billed Dec 1 and advanced to Jan 1.
			const next = await editGdb(
				"2026-11-22T21:00:00Z",
				{
					frequency: "monthly",
					day_of_month: 1,
					day_of_week: null,
					generate_days_before: 0,
					next_invoice_at: new Date("2027-01-01T06:00:00Z"),
					last_invoiced_at: new Date("2026-11-20T21:00:00Z"),
				},
				{
					frequency: "monthly",
					day_of_month: 1,
					generate_days_before: 2,
				},
			);
			expect(next.toISOString()).toBe("2026-12-30T06:00:00.000Z");
		});

		it("edit after a late weekly run does not skip the next period", async () => {
			// Nov 23 billing ran 4 days late on Nov 27; next is Nov 30 billing.
			const next = await editGdb(
				"2026-11-27T16:00:00Z",
				{
					frequency: "weekly",
					day_of_month: null,
					day_of_week: "MO",
					generate_days_before: 3,
					next_invoice_at: new Date("2026-11-27T06:00:00Z"),
					last_invoiced_at: new Date("2026-11-27T15:00:00Z"),
				},
				{
					frequency: "weekly",
					day_of_week: "MO",
					generate_days_before: 2,
				},
			);
			expect(next.toISOString()).toBe("2026-11-28T06:00:00.000Z");
		});
	});

	describe("watermark survives on_visit_completion and re-enable", () => {
		const CHI = "America/Chicago";

		function sdbWith(existing: Record<string, unknown> | null) {
			const upsert = vi.fn().mockResolvedValue({ id: "sched-1" });
			vi.mocked(getScopedDb).mockReturnValue({
				recurring_plan: {
					findFirst: vi.fn().mockResolvedValue({
						id: "plan-1",
						timezone: CHI,
						starts_at: new Date("2026-01-01T06:00:00Z"),
					}),
				},
				invoice_schedule: {
					findFirst: vi.fn().mockResolvedValue(existing),
					upsert,
				},
			} as never);
			return upsert;
		}

		it("round trip through on_visit_completion does not re-bill the billed period", async () => {
			// Nov 18 run billed Nov 23 with gdb 5; next is Dec 18 (Dec 23 billing).
			const billed = {
				frequency: "monthly",
				day_of_month: 23,
				day_of_week: null,
				generate_days_before: 5,
				next_invoice_at: new Date("2026-12-18T06:00:00Z"),
				last_invoiced_at: new Date("2026-11-18T06:05:00Z"),
				is_active: true,
			};
			vi.setSystemTime(new Date("2026-11-19T21:00:00Z"));
			let upsert = sdbWith(billed);
			await upsertInvoiceSchedule(
				"job-1",
				{
					billing_basis: "plan_line_items",
					frequency: "on_visit_completion",
				},
				"org-1",
			);
			const afterOvc = { ...billed, ...upsert.mock.calls[0][0].update };
			expect(afterOvc.next_invoice_at).toEqual(billed.next_invoice_at);

			vi.setSystemTime(new Date("2026-11-20T21:00:00Z"));
			upsert = sdbWith(afterOvc);
			await upsertInvoiceSchedule(
				"job-1",
				{
					billing_basis: "plan_line_items",
					frequency: "monthly",
					day_of_month: 23,
					generate_days_before: 3,
				},
				"org-1",
			);
			expect(
				upsert.mock.calls[0][0].update.next_invoice_at.toISOString(),
			).toBe("2026-12-20T06:00:00.000Z");
		});

		it("re-enabling an inactive schedule with a stale next_invoice_at does not catch up", async () => {
			vi.setSystemTime(new Date("2026-11-20T21:00:00Z"));
			const upsert = sdbWith({
				frequency: "monthly",
				day_of_month: 23,
				day_of_week: null,
				generate_days_before: 0,
				next_invoice_at: new Date("2026-08-23T05:00:00Z"),
				last_invoiced_at: new Date("2026-07-23T05:05:00Z"),
				is_active: false,
			});
			await upsertInvoiceSchedule(
				"job-1",
				{
					billing_basis: "plan_line_items",
					frequency: "monthly",
					day_of_month: 23,
				},
				"org-1",
			);
			expect(
				upsert.mock.calls[0][0].update.next_invoice_at.toISOString(),
			).toBe("2026-11-23T06:00:00.000Z");
		});

		it("billing_mode none -> subscription with the anchor unchanged moves a stale date to today forward", async () => {
			vi.setSystemTime(new Date("2026-11-20T21:00:00Z"));
			const startsAt = new Date("2026-01-01T06:00:00Z");
			const upsert = vi.fn().mockResolvedValue({ id: "sched-1" });
			const tx = {
				recurring_plan: {
					update: vi.fn().mockResolvedValue({
						id: "plan-1",
						timezone: CHI,
						starts_at: startsAt,
					}),
					findUnique: vi.fn().mockResolvedValue({ id: "plan-1" }),
				},
				invoice_schedule: {
					findFirst: vi.fn().mockResolvedValue({
						frequency: "monthly",
						day_of_month: 23,
						day_of_week: null,
						generate_days_before: 0,
						next_invoice_at: new Date("2026-08-23T05:00:00Z"),
						last_invoiced_at: new Date("2026-07-23T05:05:00Z"),
						is_active: false,
					}),
					upsert,
				},
			};
			vi.mocked(getScopedDb).mockReturnValue({
				recurring_plan: {
					findFirst: vi.fn().mockResolvedValue({
						id: "plan-1",
						organization_id: "org-1",
						timezone: CHI,
						starts_at: startsAt,
						billing_mode: "none",
						rules: [],
						line_items: [],
					}),
				},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				$transaction: vi.fn((cb: any) => cb(tx)),
			} as never);

			const r = await updateRecurringPlan(
				"job-1",
				{
					billing_mode: "subscription",
					invoice_schedule: {
						billing_basis: "plan_line_items",
						frequency: "monthly",
						day_of_month: 23,
					},
				},
				"org-1",
			);

			expect(r.err).toBe("");
			expect(
				upsert.mock.calls[0][0].update.next_invoice_at.toISOString(),
			).toBe("2026-11-23T06:00:00.000Z");
		});
	});
});

describe("schedule is_active follows billing_mode", () => {
	const CHI = "America/Chicago";
	const stored = {
		frequency: "monthly",
		day_of_month: 1,
		day_of_week: null,
		generate_days_before: 0,
		next_invoice_at: new Date("2026-12-01T06:00:00Z"),
		last_invoiced_at: null,
		is_active: false,
	};

	it("editing the schedule of a billing_mode none plan keeps it inactive", async () => {
		vi.setSystemTime(new Date("2026-11-20T21:00:00Z"));
		const upsert = vi.fn().mockResolvedValue({ id: "sched-1" });
		vi.mocked(getScopedDb).mockReturnValue({
			recurring_plan: {
				findFirst: vi.fn().mockResolvedValue({
					id: "plan-1",
					timezone: CHI,
					starts_at: new Date("2026-01-01T06:00:00Z"),
					billing_mode: "none",
					status: "Active",
				}),
			},
			invoice_schedule: {
				findFirst: vi.fn().mockResolvedValue(stored),
				upsert,
			},
		} as never);

		await upsertInvoiceSchedule(
			"job-1",
			{ billing_basis: "plan_line_items", frequency: "monthly", day_of_month: 1 },
			"org-1",
		);

		expect(upsert.mock.calls[0][0].update.is_active).toBe(false);
		expect(upsert.mock.calls[0][0].create.is_active).toBe(false);
	});

	it("editing the schedule of a paused plan leaves status gating to the scheduler", async () => {
		vi.setSystemTime(new Date("2026-11-20T21:00:00Z"));
		const upsert = vi.fn().mockResolvedValue({ id: "sched-1" });
		vi.mocked(getScopedDb).mockReturnValue({
			recurring_plan: {
				findFirst: vi.fn().mockResolvedValue({
					id: "plan-1",
					timezone: CHI,
					starts_at: new Date("2026-01-01T06:00:00Z"),
					billing_mode: "subscription",
					status: "Paused",
				}),
			},
			invoice_schedule: {
				findFirst: vi.fn().mockResolvedValue({ ...stored, is_active: true }),
				upsert,
			},
		} as never);

		await upsertInvoiceSchedule(
			"job-1",
			{ billing_basis: "plan_line_items", frequency: "monthly", day_of_month: 1 },
			"org-1",
		);

		expect(upsert.mock.calls[0][0].update.is_active).toBe(true);
	});

	it("switching billing_mode to none without a schedule in the request deactivates it", async () => {
		vi.setSystemTime(new Date("2026-11-20T21:00:00Z"));
		const startsAt = new Date("2026-01-01T06:00:00Z");
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const tx = {
			recurring_plan: {
				update: vi.fn().mockResolvedValue({
					id: "plan-1",
					timezone: CHI,
					starts_at: startsAt,
					billing_mode: "none",
				}),
				findUnique: vi.fn().mockResolvedValue({ id: "plan-1" }),
			},
			invoice_schedule: { updateMany, upsert: vi.fn() },
		};
		vi.mocked(getScopedDb).mockReturnValue({
			recurring_plan: {
				findFirst: vi.fn().mockResolvedValue({
					id: "plan-1",
					organization_id: "org-1",
					timezone: CHI,
					starts_at: startsAt,
					billing_mode: "subscription",
					rules: [],
					line_items: [],
				}),
			},
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			$transaction: vi.fn((cb: any) => cb(tx)),
		} as never);

		const r = await updateRecurringPlan(
			"job-1",
			{ billing_mode: "none" },
			"org-1",
		);

		expect(r.err).toBe("");
		expect(updateMany).toHaveBeenCalledWith({
			where: { recurring_plan_id: "plan-1" },
			data: { is_active: false },
		});
	});

	it("a plan update without billing_mode keeps a stored none schedule inactive", async () => {
		vi.setSystemTime(new Date("2026-11-20T21:00:00Z"));
		const startsAt = new Date("2026-01-01T06:00:00Z");
		const upsert = vi.fn().mockResolvedValue({ id: "sched-1" });
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const tx = {
			recurring_plan: {
				update: vi.fn().mockResolvedValue({
					id: "plan-1",
					timezone: CHI,
					starts_at: startsAt,
					billing_mode: "none",
				}),
				findUnique: vi.fn().mockResolvedValue({ id: "plan-1" }),
			},
			invoice_schedule: {
				findFirst: vi.fn().mockResolvedValue(stored),
				upsert,
				updateMany,
			},
		};
		vi.mocked(getScopedDb).mockReturnValue({
			recurring_plan: {
				findFirst: vi.fn().mockResolvedValue({
					id: "plan-1",
					organization_id: "org-1",
					timezone: CHI,
					starts_at: startsAt,
					billing_mode: "none",
					rules: [],
					line_items: [],
				}),
			},
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			$transaction: vi.fn((cb: any) => cb(tx)),
		} as never);

		const r = await updateRecurringPlan(
			"job-1",
			{
				invoice_schedule: {
					billing_basis: "plan_line_items",
					frequency: "monthly",
					day_of_month: 1,
				},
			},
			"org-1",
		);

		expect(r.err).toBe("");
		const writes = [
			...upsert.mock.calls.map((c) => c[0].update.is_active),
			...updateMany.mock.calls.map((c) => c[0].data.is_active),
		];
		expect(writes).not.toContain(true);
	});
});

describe("extending ends_at reactivates a schedule expiry switched off", () => {
	const CHI = "America/Chicago";
	const startsAt = new Date("2026-01-01T06:00:00Z");

	function run(newEndsAt: string, status = "Active") {
		const update = vi.fn().mockResolvedValue({});
		const tx = {
			recurring_plan: {
				update: vi.fn().mockResolvedValue({
					id: "plan-1",
					status,
					timezone: CHI,
					starts_at: startsAt,
					ends_at: new Date(newEndsAt),
					billing_mode: "subscription",
				}),
				findUnique: vi.fn().mockResolvedValue({ id: "plan-1" }),
			},
			invoice_schedule: {
				// The scheduler stopped at Dec 1, past the old Nov 30 end.
				findFirst: vi.fn().mockResolvedValue({
					id: "sched-1",
					frequency: "monthly",
					day_of_month: 1,
					day_of_week: null,
					generate_days_before: 0,
					next_invoice_at: new Date("2026-12-01T06:00:00Z"),
					last_invoiced_at: new Date("2026-11-01T06:00:00Z"),
					is_active: false,
				}),
				update,
				updateMany: vi.fn(),
				upsert: vi.fn(),
			},
		};
		vi.mocked(getScopedDb).mockReturnValue({
			recurring_plan: {
				findFirst: vi.fn().mockResolvedValue({
					id: "plan-1",
					organization_id: "org-1",
					status,
					timezone: CHI,
					starts_at: startsAt,
					ends_at: new Date("2026-11-30T06:00:00Z"),
					billing_mode: "subscription",
					rules: [],
					line_items: [],
				}),
			},
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			$transaction: vi.fn((cb: any) => cb(tx)),
		} as never);
		return {
			update,
			result: updateRecurringPlan("job-1", { ends_at: newEndsAt }, "org-1"),
		};
	}

	it("switches billing back on from the first unbilled period, no catch-up", async () => {
		vi.setSystemTime(new Date("2026-12-10T18:00:00Z"));
		const { update, result } = run("2027-06-30T05:00:00.000Z");

		expect((await result).err).toBe("");
		expect(update).toHaveBeenCalledTimes(1);
		const data = update.mock.calls[0][0].data;
		expect(data.is_active).toBe(true);
		// Dec 1 has passed; billing resumes Jan 1 rather than billing December late.
		expect(data.next_invoice_at).toEqual(new Date("2027-01-01T06:00:00Z"));
	});

	it("stays off when the new end date is before the next billing date", async () => {
		vi.setSystemTime(new Date("2026-12-10T18:00:00Z"));
		const { update, result } = run("2026-12-20T06:00:00.000Z");

		expect((await result).err).toBe("");
		expect(update).not.toHaveBeenCalled();
	});

	it("leaves a paused plan's schedule to resume", async () => {
		vi.setSystemTime(new Date("2026-12-10T18:00:00Z"));
		const { update, result } = run("2027-06-30T05:00:00.000Z", "Paused");

		expect((await result).err).toBe("");
		expect(update).not.toHaveBeenCalled();
	});
});
