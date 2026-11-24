import { describe, it, expect, vi, beforeEach } from "vitest";
import { rescheduleOccurrence } from "../recurringPlansController.js";
import { getScopedDb } from "../../lib/context.js";
import { zonedWallTimeToUtc } from "../../lib/recurrence/zonedTime.js";

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
vi.mock("../../services/moduleWindowService.js", () => ({
	getClosedWindows: vi.fn(),
}));
vi.mock("../../services/visitLifecycle/index.js", () => ({
	syncJobFromVisits: vi.fn(async () => null),
	runJobChangePostCommit: vi.fn(async () => undefined),
}));

const TZ = "America/Chicago";
const HOUR = 3_600_000;

type Occ = {
	id: string;
	recurring_plan_id: string;
	status: string;
	original_start_at: Date;
	occurrence_start_at: Date;
	occurrence_end_at: Date;
	arrival_constraint: string;
};

function occ(id: string, date: string, hhmm: string): Occ {
	const start = zonedWallTimeToUtc(date, hhmm, TZ);
	return {
		id,
		recurring_plan_id: "plan-1",
		status: "planned",
		original_start_at: start,
		occurrence_start_at: start,
		occurrence_end_at: new Date(start.getTime() + 2 * HOUR),
		arrival_constraint: "at",
	};
}

const atRule = {
	frequency: "daily",
	interval: 1,
	by_weekday: [] as { weekday: string }[],
	by_month_day: null,
	by_month: null,
	arrival_constraint: "at",
	finish_constraint: "when_done",
	arrival_time: "08:00" as string | null,
	arrival_window_start: null as string | null,
	arrival_window_end: null as string | null,
	finish_time: null as string | null,
};

function setup(rows: Occ[], planStatus = "Active", rule: Record<string, unknown> = atRule) {
	const update = vi.fn(
		async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
			...rows.find((r) => r.id === where.id),
			...data,
		}),
	);
	const updateMany = vi.fn(async () => ({ count: 1 }));
	const sdb: Record<string, unknown> = {
		recurring_occurrence: {
			findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
				rows.find((r) => r.id === where.id) ?? null,
			),
			findMany: vi.fn(async ({ where }: { where: { occurrence_start_at: { gt: Date } } }) =>
				rows.filter(
					(r) => r.status === "planned" && r.occurrence_start_at > where.occurrence_start_at.gt,
				),
			),
			update,
			count: vi.fn(async () => 0),
		},
		// The plan row lock.
		$queryRaw: vi.fn(async () => [{ id: "plan-1" }]),
		recurring_plan: {
			findUnique: vi.fn(async () => ({
				id: "plan-1",
				timezone: TZ,
				status: planStatus,
				rules: [rule],
			})),
		},
		recurring_rule: { updateMany },
	};
	sdb.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(sdb));
	vi.mocked(getScopedDb).mockReturnValue(sdb as never);
	return { update, updateMany, sdb };
}

describe("rescheduleOccurrence", () => {
	beforeEach(() => vi.clearAllMocks());

	it("reads the plan and its rule only after locking the plan row", async () => {
		const { sdb: raw } = setup([occ("o1", "2026-10-29", "08:00")]);
		const sdb = raw as unknown as {
			$queryRaw: ReturnType<typeof vi.fn>;
			recurring_plan: { findUnique: ReturnType<typeof vi.fn> };
		};

		await rescheduleOccurrence(
			"o1",
			{
				new_start_at: zonedWallTimeToUtc("2026-10-29", "09:00", TZ).toISOString(),
				scope: "future",
			},
			"org-1",
		);

		expect(String(sdb.$queryRaw.mock.calls[0][0])).toMatch(/FOR NO KEY UPDATE/);
		expect(sdb.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
			sdb.recurring_plan.findUnique.mock.invocationCallOrder[0],
		);
	});

	it("all-future re-time keeps 09:00 local across the November DST change", async () => {
		const first = occ("o1", "2026-10-29", "08:00");
		const second = occ("o2", "2026-11-05", "08:00");
		const { update, updateMany } = setup([first, second]);

		const res = await rescheduleOccurrence(
			"o1",
			{
				new_start_at: zonedWallTimeToUtc("2026-10-29", "09:00", TZ).toISOString(),
				scope: "future",
			},
			"org-1",
		);

		expect(res.err).toBe("");
		const call = update.mock.calls.find(([a]) => a.where.id === "o2")![0];
		expect((call.data.occurrence_start_at as Date).toISOString()).toBe("2026-11-05T15:00:00.000Z");
		expect((call.data.occurrence_end_at as Date).toISOString()).toBe("2026-11-05T17:00:00.000Z");
		const target = update.mock.calls.find(([a]) => a.where.id === "o1")![0];
		expect(target.data.arrival_time).toBe("09:00");
		expect(call.data.arrival_time).toBe("09:00");
		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ arrival_time: "09:00" }) }),
		);
	});

	it("all-future with a date change is rejected with the edit-schedule message", async () => {
		const first = occ("o1", "2026-10-29", "08:00");
		const second = occ("o2", "2026-11-05", "08:00");
		const { update, updateMany } = setup([first, second]);

		const res = await rescheduleOccurrence(
			"o1",
			{
				new_start_at: zonedWallTimeToUtc("2026-10-30", "08:00", TZ).toISOString(),
				scope: "future",
			},
			"org-1",
		);

		expect(res.err).toBe("To move every future visit to another day, edit the plan's schedule.");
		expect(update).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("reschedule never changes original_start_at", async () => {
		const first = occ("o1", "2026-10-29", "08:00");
		const second = occ("o2", "2026-11-05", "08:00");
		const { update } = setup([first, second]);

		await rescheduleOccurrence(
			"o1",
			{
				new_start_at: zonedWallTimeToUtc("2026-10-29", "09:00", TZ).toISOString(),
				scope: "future",
			},
			"org-1",
		);
		await rescheduleOccurrence(
			"o2",
			{ new_start_at: zonedWallTimeToUtc("2026-11-07", "10:00", TZ).toISOString() },
			"org-1",
		);

		expect(update).toHaveBeenCalled();
		for (const [arg] of update.mock.calls) {
			expect(arg.data).not.toHaveProperty("original_start_at");
		}
	});

	it("refuses to reschedule a paused plan with \"Plan is paused\"", async () => {
		const first = occ("o1", "2026-10-29", "08:00");
		const { update } = setup([first], "Paused");
		const res = await rescheduleOccurrence(
			"o1",
			{ new_start_at: zonedWallTimeToUtc("2026-10-29", "09:00", TZ).toISOString() },
			"org-1",
		);
		expect(res.err).toBe("Plan is paused");
		expect(update).not.toHaveBeenCalled();
	});

	it("all-future shifts a between window and derives start from its shifted start", async () => {
		const rule = {
			...atRule,
			arrival_constraint: "between",
			arrival_time: null,
			arrival_window_start: "08:00",
			arrival_window_end: "10:00",
		};
		const first = { ...occ("o1", "2026-10-29", "08:00"), arrival_constraint: "between" };
		const second = { ...occ("o2", "2026-11-05", "08:00"), arrival_constraint: "between" };
		const { update, updateMany } = setup([first, second], "Active", rule);

		const res = await rescheduleOccurrence(
			"o1",
			{
				new_start_at: zonedWallTimeToUtc("2026-10-29", "09:30", TZ).toISOString(),
				scope: "future",
			},
			"org-1",
		);

		expect(res.err).toBe("");
		const call = update.mock.calls.find(([a]) => a.where.id === "o2")![0];
		expect((call.data.occurrence_start_at as Date).toISOString()).toBe("2026-11-05T15:30:00.000Z");
		expect(call.data.arrival_window_start).toBe("09:30");
		expect(call.data.arrival_window_end).toBe("11:30");
		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					arrival_window_start: "09:30",
					arrival_window_end: "11:30",
				}),
			}),
		);
	});

	it("all-future shifts a finish-by time and the derived end moves with it", async () => {
		const rule = { ...atRule, finish_constraint: "by", finish_time: "11:00" };
		const first = occ("o1", "2026-10-29", "08:00");
		const second = occ("o2", "2026-11-05", "08:00");
		const { update, updateMany } = setup([first, second], "Active", rule);

		await rescheduleOccurrence(
			"o1",
			{
				new_start_at: zonedWallTimeToUtc("2026-10-29", "09:00", TZ).toISOString(),
				scope: "future",
			},
			"org-1",
		);

		const call = update.mock.calls.find(([a]) => a.where.id === "o2")![0];
		expect((call.data.occurrence_start_at as Date).toISOString()).toBe("2026-11-05T15:00:00.000Z");
		// finish 12:00 local (CST) -> 18:00Z, i.e. a 3h visit from 09:00
		expect((call.data.occurrence_end_at as Date).toISOString()).toBe("2026-11-05T18:00:00.000Z");
		expect(call.data.finish_time).toBe("12:00");
		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ finish_time: "12:00" }) }),
		);
	});

	it("all-future that pushes a rule time past midnight is rejected", async () => {
		const rule = { ...atRule, finish_constraint: "by", finish_time: "23:00" };
		const { update, updateMany } = setup([occ("o1", "2026-10-29", "08:00")], "Active", rule);

		const res = await rescheduleOccurrence(
			"o1",
			{
				new_start_at: zonedWallTimeToUtc("2026-10-29", "10:00", TZ).toISOString(),
				scope: "future",
			},
			"org-1",
		);

		expect(res.err).toMatch(/past midnight/);
		expect(update).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("all-future time move on an anytime arrival is refused", async () => {
		const rule = { ...atRule, arrival_constraint: "anytime", arrival_time: null };
		const first = { ...occ("o1", "2026-10-29", "09:00"), arrival_constraint: "anytime" };
		const { update } = setup([first], "Active", rule);

		const res = await rescheduleOccurrence(
			"o1",
			{
				new_start_at: zonedWallTimeToUtc("2026-10-29", "10:00", TZ).toISOString(),
				scope: "future",
			},
			"org-1",
		);

		expect(res.err).toMatch(/anytime/);
		expect(update).not.toHaveBeenCalled();
	});

	it("an invalid plan timezone returns the schedule error instead of throwing", async () => {
		const sdbRows = [occ("o1", "2026-10-29", "08:00")];
		setup(sdbRows);
		const sdb = vi.mocked(getScopedDb)("org-1") as unknown as {
			recurring_plan: { findUnique: ReturnType<typeof vi.fn> };
		};
		sdb.recurring_plan.findUnique.mockResolvedValue({
			id: "plan-1",
			timezone: "Not/AZone",
			status: "Active",
			rules: [atRule],
		});
		const res = await rescheduleOccurrence(
			"o1",
			{ new_start_at: "2026-10-29T15:00:00.000Z" },
			"org-1",
		);
		expect(res.err).toMatch(/can't be scheduled/);
	});

	it("rejects a reschedule time field that is not HH:MM", async () => {
		setup([occ("o1", "2026-10-29", "08:00")]);
		const res = await rescheduleOccurrence(
			"o1",
			{ new_start_at: "2026-10-29T15:00:00.000Z", arrival_time: "25:99" },
			"org-1",
		);
		expect(res.err).toMatch(/Validation failed/);
	});

	it("all-future measures the shift from the rule, not from a previously moved visit", async () => {
		const rule = { ...atRule, arrival_time: "09:00" };
		const moved = occ("o1", "2026-10-29", "11:00");
		const second = occ("o2", "2026-11-05", "09:00");
		const { update, updateMany } = setup([moved, second], "Active", rule);

		const res = await rescheduleOccurrence(
			"o1",
			{
				new_start_at: zonedWallTimeToUtc("2026-10-29", "12:00", TZ).toISOString(),
				scope: "future",
			},
			"org-1",
		);

		expect(res.err).toBe("");
		const target = update.mock.calls.find(([a]) => a.where.id === "o1")![0];
		const future = update.mock.calls.find(([a]) => a.where.id === "o2")![0];
		expect(target.data.arrival_time).toBe("12:00");
		expect(future.data.arrival_time).toBe("12:00");
		expect((future.data.occurrence_start_at as Date).toISOString()).toBe("2026-11-05T18:00:00.000Z");
		expect((target.data.occurrence_start_at as Date).toISOString()).toBe("2026-10-29T17:00:00.000Z");
		expect(
			(target.data.occurrence_end_at as Date).getTime() -
				(target.data.occurrence_start_at as Date).getTime(),
		).toBe(
			(future.data.occurrence_end_at as Date).getTime() -
				(future.data.occurrence_start_at as Date).getTime(),
		);
		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ arrival_time: "12:00" }) }),
		);
	});

	it("all-future on a by arrival whose start is clamped is refused", async () => {
		const rule = {
			...atRule,
			arrival_constraint: "by",
			arrival_time: null,
			arrival_window_end: "12:00",
		};
		const first = { ...occ("o1", "2026-10-29", "09:00"), arrival_constraint: "by" };
		const { update, updateMany } = setup([first], "Active", rule);

		const res = await rescheduleOccurrence(
			"o1",
			{
				new_start_at: zonedWallTimeToUtc("2026-10-29", "10:00", TZ).toISOString(),
				scope: "future",
			},
			"org-1",
		);

		expect(res.err).toMatch(/can't move to that time/);
		expect(update).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("all-future refuses explicit time or constraint fields", async () => {
		const { update } = setup([occ("o1", "2026-10-29", "08:00")]);
		for (const extra of [
			{ arrival_time: "07:00" },
			{ arrival_window_start: "08:00" },
			{ finish_time: "12:00" },
			{ arrival_constraint: "between" },
		]) {
			const res = await rescheduleOccurrence(
				"o1",
				{
					new_start_at: zonedWallTimeToUtc("2026-10-29", "09:00", TZ).toISOString(),
					scope: "future",
					...extra,
				},
				"org-1",
			);
			expect(res.err).toBe(
				"To change the plan's arrival window or finish time, edit the plan's schedule.",
			);
		}
		expect(update).not.toHaveBeenCalled();
	});
});
