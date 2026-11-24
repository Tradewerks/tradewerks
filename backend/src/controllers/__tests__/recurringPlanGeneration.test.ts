import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	generateOccurrencesForPlan,
	getSkippedDatesForJob,
	insertRecurringPlan,
	InvalidPlanScheduleError,
} from "../recurringPlansController.js";
import { createRecurringPlanSchema } from "../../lib/validate/recurringPlans.js";
import { getScopedDb } from "../../lib/context.js";
import { getClosedWindows } from "../../services/moduleWindowService.js";
import { zonedWallTimeToUtc } from "../../lib/recurrence/zonedTime.js";

vi.mock("../../services/customerComms/visitEvents.js", () => ({
	notifyVisitScheduled: vi.fn(async () => undefined),
	notifyVisitRescheduled: vi.fn(async () => undefined),
	notifyVisitCancelled: vi.fn(async () => undefined),
	retimeVisitReminders: vi.fn(async () => undefined),
	notifyJobCompleted: vi.fn(async () => undefined),
	notifyVisitCompleted: vi.fn(async () => undefined),
	notifyTechOnTheWay: vi.fn(async () => undefined),
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
const ORG = "org-1";

type Row = { original_start_at: Date; occurrence_start_at: Date };

const baseRule = {
	frequency: "daily",
	interval: 1,
	by_weekday: [] as { weekday: string }[],
	by_month_day: null as number | null,
	by_month: null as number | null,
	arrival_constraint: "anytime",
	finish_constraint: "when_done",
	arrival_time: null,
	arrival_window_start: null,
	arrival_window_end: null,
	finish_time: null,
};

function makePlan(over: Record<string, unknown> = {}) {
	return {
		id: "plan-1",
		organization_id: ORG,
		status: "Active",
		starts_at: new Date("2026-11-01T06:00:00.000Z"),
		ends_at: null,
		timezone: TZ,
		generation_window_days: 30,
		rules: [baseRule],
		...over,
	};
}

/** A tx whose recurring_occurrence store honours the (plan, original_start_at) unique key. */
function makeTx(plan: Record<string, unknown>, rows: Row[] = []) {
	const createMany = vi.fn(
		async ({
			data,
			skipDuplicates,
		}: {
			data: Row[];
			skipDuplicates?: boolean;
		}) => {
			let count = 0;
			for (const r of data) {
				const dup = rows.some(
					(x) =>
						x.original_start_at.getTime() ===
						r.original_start_at.getTime(),
				);
				if (dup) {
					if (!skipDuplicates) throw new Error("P2002");
					continue;
				}
				rows.push(r);
				count++;
			}
			return { count };
		},
	);
	const tx = {
		recurring_plan: { findUnique: vi.fn().mockResolvedValue(plan) },
		recurring_occurrence: {
			createMany,
			// The taken-dates read; dates outside the window never match a slot.
			findMany: vi.fn(async () => rows.map((r) => ({ ...r }))),
			create: vi.fn(() => {
				throw new Error("per-row create is not used");
			}),
			findFirst: vi.fn(() => {
				throw new Error("per-row existence check is not used");
			}),
		},
	};
	return { tx, createMany, rows };
}

const at = (date: string, hhmm = "09:00") => zonedWallTimeToUtc(date, hhmm, TZ);

describe("recurring plan generation on the slot engine", () => {
	beforeEach(() => vi.clearAllMocks());

	it("generating twice creates each slot once", async () => {
		const { tx, createMany } = makeTx(makePlan());
		const now = new Date("2026-11-20T12:00:00.000Z");

		const first = await generateOccurrencesForPlan("plan-1", tx as never, {
			now,
			daysAhead: 6,
		});
		expect(first.generated).toBe(7);
		expect(first.skipped).toBe(0);

		const second = await generateOccurrencesForPlan("plan-1", tx as never, {
			now,
			daysAhead: 6,
		});
		expect(second.generated).toBe(0);
		expect(second.skipped).toBe(7);

		// Every date is taken, so the second pass writes nothing.
		expect(createMany).toHaveBeenCalledTimes(1);
		expect(createMany.mock.calls[0][0].skipDuplicates).toBe(true);
		const row = createMany.mock.calls[0][0].data[0];
		expect(row).toMatchObject({
			recurring_plan_id: "plan-1",
			original_start_at: at("2026-11-20"),
			occurrence_start_at: at("2026-11-20"),
			slot_verified: true,
			arrival_constraint: "anytime",
			finish_constraint: "when_done",
		});
	});

	it("a slot already past today is not created", async () => {
		const { tx, createMany } = makeTx(makePlan());
		// 12:00 in Chicago: today's 09:00 slot has gone.
		const now = new Date("2026-11-20T18:00:00.000Z");

		const r = await generateOccurrencesForPlan("plan-1", tx as never, {
			now,
			daysAhead: 2,
		});

		expect(r.generated).toBe(2);
		const starts = createMany.mock.calls[0][0].data.map(
			(d: Row) => d.original_start_at,
		);
		expect(starts).toEqual([at("2026-11-21"), at("2026-11-22")]);
	});

	it("today's slot is created while its window is still open", async () => {
		const { tx, createMany } = makeTx(makePlan());
		// 10:00 in Chicago: the 09:00-11:00 slot has started but not ended.
		const now = new Date("2026-11-20T16:00:00.000Z");

		const r = await generateOccurrencesForPlan("plan-1", tx as never, {
			now,
			daysAhead: 1,
		});

		expect(r.generated).toBe(2);
		expect(createMany.mock.calls[0][0].data[0].original_start_at).toEqual(
			at("2026-11-20"),
		);
	});

	it("a rescheduled occurrence is not re-created", async () => {
		const slot = at("2026-11-20");
		const { tx, createMany, rows } = makeTx(makePlan(), [
			{ original_start_at: slot, occurrence_start_at: at("2026-11-21", "14:00") },
		]);

		const r = await generateOccurrencesForPlan("plan-1", tx as never, {
			now: new Date("2026-11-20T12:00:00.000Z"),
			daysAhead: 0,
		});

		expect(createMany).not.toHaveBeenCalled();
		expect(r.generated).toBe(0);
		expect(r.skipped).toBe(1);
		expect(rows).toHaveLength(1);
	});

	it("a row re-timed off its slot keeps its date from being generated again", async () => {
		// A rule edit moved 09:00 to 14:00; the generated row kept its 09:00 identity.
		const { tx, createMany } = makeTx(makePlan({ rules: [{ ...baseRule, arrival_constraint: "at", arrival_time: "14:00" }] }), [
			{ original_start_at: at("2026-11-21"), occurrence_start_at: at("2026-11-21") },
		]);

		const r = await generateOccurrencesForPlan("plan-1", tx as never, {
			now: new Date("2026-11-20T12:00:00.000Z"),
			daysAhead: 2,
		});

		const starts = createMany.mock.calls[0][0].data.map((d: Row) => d.original_start_at);
		expect(starts).toEqual([at("2026-11-20", "14:00"), at("2026-11-22", "14:00")]);
		expect(r).toMatchObject({ generated: 2, skipped: 1 });
	});

	it("a visit moved to the next day doesn't take that day's own slot", async () => {
		// Daily plan: Friday's visit was moved on its own to Saturday 14:00.
		const { tx, createMany } = makeTx(makePlan(), [
			{ original_start_at: at("2026-11-20"), occurrence_start_at: at("2026-11-21", "14:00") },
		]);

		const r = await generateOccurrencesForPlan("plan-1", tx as never, {
			now: new Date("2026-11-20T12:00:00.000Z"),
			daysAhead: 1,
		});

		const starts = createMany.mock.calls[0][0].data.map((d: Row) => d.original_start_at);
		expect(starts).toEqual([at("2026-11-21")]);
		expect(r).toMatchObject({ generated: 1, skipped: 1 });
	});

	it("insertRecurringPlan stores the organization timezone, ignoring the body", async () => {
		const planCreate = vi.fn().mockResolvedValue({ id: "plan-1" });
		const models: Record<string, Record<string, unknown>> = {
			client: {
				findUnique: vi.fn().mockResolvedValue({ id: "c", organization_id: ORG }),
			},
			organization: {
				findFirst: vi.fn().mockResolvedValue({ timezone: "America/New_York" }),
			},
			recurring_plan: {
				create: planCreate,
				findUnique: vi.fn().mockResolvedValue(makePlan({ status: "Paused" })),
			},
		};
		const tx = new Proxy(models, {
			get(t, model: string) {
				t[model] ??= {};
				return new Proxy(t[model], {
					get(m, fn: string) {
						m[fn] ??= vi.fn().mockResolvedValue({ id: "row-1" });
						return m[fn];
					},
				});
			},
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const sdb = { $transaction: vi.fn((cb: any) => cb(tx)) };
		vi.mocked(getScopedDb).mockReturnValue(sdb as never);

		const r = await insertRecurringPlan(
			{
				body: {
					client_id: "55555555-5555-4555-8555-555555555555",
					name: "P",
					description: "d",
					address: "a",
					coords: { lat: 1, lon: 1 },
					starts_at: "2026-11-01T00:00:00.000Z",
					timezone: "UTC",
					rule: {
						frequency: "daily",
						interval: 1,
						arrival_constraint: "anytime",
						finish_constraint: "when_done",
					},
				},
			} as never,
			ORG,
		);

		expect(r.err).toBe("");
		expect(planCreate.mock.calls[0][0].data.timezone).toBe("America/New_York");
	});

	it("monthly on the 1st created on the 16th generates next month's 1st", async () => {
		const plan = makePlan({
			starts_at: at("2026-11-16", "10:00"),
			generation_window_days: 30,
			rules: [{ ...baseRule, frequency: "monthly", by_month_day: 1 }],
		});
		const { tx, createMany } = makeTx(plan);

		const r = await generateOccurrencesForPlan("plan-1", tx as never, {
			now: at("2026-11-16", "10:00"),
		});

		expect(r.generated).toBe(1);
		const data = createMany.mock.calls[0][0].data;
		expect(data).toHaveLength(1);
		expect(data[0].original_start_at.toISOString()).toBe(
			at("2026-12-01").toISOString(),
		);
	});

	it("generate on a paused plan returns 0 generated", async () => {
		const { tx, createMany } = makeTx(makePlan({ status: "Paused" }));

		const r = await generateOccurrencesForPlan("plan-1", tx as never, {
			now: new Date("2026-11-20T12:00:00.000Z"),
		});

		expect(r.generated).toBe(0);
		expect(r.skipped).toBe(0);
		expect(createMany).not.toHaveBeenCalled();
	});

	it("getSkippedDatesForJob ignores slots that already have an occurrence by original_start_at", async () => {
		const slotA = at("2026-11-10");
		const slotB = at("2026-11-11");
		const rows: Row[] = [
			// Generated for the 10th, then moved to the 12th afternoon.
			{ original_start_at: slotA, occurrence_start_at: at("2026-11-12", "15:00") },
		];
		const findMany = vi.fn(
			async ({ where }: { where: Record<string, { in?: Date[] }> }) => {
				const wanted = where.original_start_at?.in ?? [];
				return rows
					.filter((r) =>
						wanted.some(
							(d) => d.getTime() === r.original_start_at.getTime(),
						),
					)
					.map((r) => ({ original_start_at: r.original_start_at }));
			},
		);
		const sdb = {
			job: {
				findFirst: vi.fn().mockResolvedValue({ recurring_plan_id: "plan-1" }),
			},
			recurring_plan: { findFirst: vi.fn().mockResolvedValue(makePlan()) },
			recurring_occurrence: { findMany },
		};
		vi.mocked(getScopedDb).mockReturnValue(sdb as never);
		vi.mocked(getClosedWindows).mockResolvedValue([
			{
				off: new Date("2026-11-10T06:00:00.000Z"),
				on: new Date("2026-11-11T22:00:00.000Z"),
			},
		] as never);

		const skipped = await getSkippedDatesForJob("job-1", ORG);

		expect(skipped.map((d) => d.toISOString())).toEqual([slotB.toISOString()]);
	});
	it("a stored rule time that is not a real wall time fails that plan with a clear error", async () => {
		const plan = makePlan({
			rules: [{ ...baseRule, arrival_constraint: "at", arrival_time: "25:00" }],
		});
		const { tx, createMany } = makeTx(plan);

		const p = generateOccurrencesForPlan("plan-1", tx as never, {
			now: new Date("2026-11-20T12:00:00.000Z"),
			daysAhead: 1,
		});
		await expect(p).rejects.toBeInstanceOf(InvalidPlanScheduleError);
		await expect(p).rejects.toThrow(/plan-1.*25:00/);
		expect(createMany).not.toHaveBeenCalled();
	});

	it("an invalid plan timezone surfaces as InvalidPlanScheduleError", async () => {
		const { tx, createMany } = makeTx(makePlan({ timezone: "Not/AZone" }));
		await expect(
			generateOccurrencesForPlan("plan-1", tx as never, {
				now: new Date("2026-11-20T12:00:00.000Z"),
				daysAhead: 1,
			}),
		).rejects.toBeInstanceOf(InvalidPlanScheduleError);
		expect(createMany).not.toHaveBeenCalled();

		const sdb = {
			job: { findFirst: vi.fn().mockResolvedValue({ recurring_plan_id: "plan-1" }) },
			recurring_plan: {
				findFirst: vi.fn().mockResolvedValue(makePlan({ timezone: "Not/AZone" })),
			},
			recurring_occurrence: { findMany: vi.fn() },
		};
		vi.mocked(getScopedDb).mockReturnValue(sdb as never);
		vi.mocked(getClosedWindows).mockResolvedValue([
			{
				off: new Date("2026-11-10T06:00:00.000Z"),
				on: new Date("2026-11-11T22:00:00.000Z"),
			},
		] as never);
		await expect(getSkippedDatesForJob("job-1", ORG)).resolves.toEqual([]);
	});

	it("rule time validation rejects hours past 23 and minutes past 59", () => {
		const rule = (arrival_time: string) =>
			createRecurringPlanSchema.safeParse({
				client_id: "55555555-5555-4555-8555-555555555555",
				name: "P",
				description: "d",
				address: "a",
				coords: { lat: 1, lon: 1 },
				starts_at: "2026-11-01T00:00:00.000Z",
				rule: {
					frequency: "daily",
					interval: 1,
					arrival_constraint: "at",
					arrival_time,
					finish_constraint: "when_done",
				},
			}).success;
		expect(rule("23:59")).toBe(true);
		expect(rule("25:00")).toBe(false);
		expect(rule("24:00")).toBe(false);
		expect(rule("12:60")).toBe(false);
	});
});
