import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	insertRecurringPlan,
	updateRecurringPlan,
} from "../recurringPlansController.js";
import { getScopedDb } from "../../lib/context.js";
import { topUpPlan } from "../../services/recurringPlanScheduler.js";

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
vi.mock("../../services/recurringPlanScheduler.js", () => ({
	topUpPlan: vi.fn(async () => ({ generated: 0, visitsCreated: 0 })),
}));

const ORG = "org-1";
const CHI = "America/Chicago";
const RULE = {
	frequency: "daily",
	interval: 1,
	by_weekday: [] as { weekday: string }[],
	by_month_day: null,
	by_month: null,
	arrival_constraint: "anytime",
	finish_constraint: "when_done",
	arrival_time: null,
	arrival_window_start: null,
	arrival_window_end: null,
	finish_time: null,
};

function storedPlan(over: Record<string, unknown> = {}) {
	return {
		id: "plan-1",
		organization_id: ORG,
		status: "Active",
		timezone: CHI,
		starts_at: new Date("2026-11-01T06:00:00Z"),
		ends_at: new Date("2026-12-20T06:00:00Z") as Date | null,
		generation_window_days: 30,
		min_advance_days: 14,
		billing_mode: "none",
		default_technician_id: null,
		rules: [{ id: "rule-1", ...RULE }],
		line_items: [],
		...over,
	};
}

/** A tx that answers any model call; `plan` is what every plan read returns. */
function proxyTx(
	plan: Record<string, unknown>,
	overrides: Record<string, Record<string, unknown>> = {},
) {
	const models: Record<string, Record<string, unknown>> = {
		recurring_plan: {
			create: vi.fn().mockResolvedValue(plan),
			update: vi.fn().mockResolvedValue(plan),
			findUnique: vi.fn().mockResolvedValue(plan),
		},
		client: {
			findUnique: vi
				.fn()
				.mockResolvedValue({ id: "c", organization_id: ORG }),
		},
		organization: {
			findFirst: vi.fn().mockResolvedValue({ timezone: CHI }),
		},
		invoice_schedule: { findFirst: vi.fn().mockResolvedValue(null) },
		recurring_occurrence: {
			createMany: vi.fn().mockResolvedValue({ count: 0 }),
			findMany: vi.fn().mockResolvedValue([]),
		},
		log: {
			create: vi.fn().mockResolvedValue({ id: "log-1", event_type: "x" }),
		},
		...overrides,
	};
	// Row locks taken with raw SQL.
	const queryRaw = vi.fn().mockResolvedValue([{ id: "plan-1" }]);
	return new Proxy(models, {
		get(t, model: string) {
			if (model === "$queryRaw") return queryRaw;
			t[model] ??= {};
			return new Proxy(t[model], {
				get(m, fn: string) {
					m[fn] ??= vi.fn().mockResolvedValue({ id: "row-1" });
					return m[fn];
				},
			});
		},
	}) as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
}

function mockUpdate(existing: ReturnType<typeof storedPlan>, after = existing) {
	const tx = proxyTx(after);
	vi.mocked(getScopedDb).mockReturnValue({
		recurring_plan: { findFirst: vi.fn().mockResolvedValue(existing) },
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		$transaction: vi.fn((cb: any) => cb(tx)),
	} as never);
	return tx;
}

beforeEach(() => vi.clearAllMocks());

describe("ends_at edits and the expiry notice", () => {
	it("extending ends_at clears expiry_notified_at", async () => {
		const tx = mockUpdate(
			storedPlan({
				expiry_notified_at: new Date("2026-11-20T18:00:00Z"),
			}),
		);

		const r = await updateRecurringPlan(
			"job-1",
			{ ends_at: "2027-06-30T05:00:00.000Z" },
			ORG,
		);

		expect(r.err).toBe("");
		const data = tx.recurring_plan.update.mock.calls[0][0].data;
		expect(data.expiry_notified_at).toBeNull();
	});

	it("resending the same ends_at keeps expiry_notified_at", async () => {
		const tx = mockUpdate(
			storedPlan({
				expiry_notified_at: new Date("2026-11-20T18:00:00Z"),
			}),
		);

		await updateRecurringPlan(
			"job-1",
			{ ends_at: "2026-12-20T06:00:00.000Z" },
			ORG,
		);

		const data = tx.recurring_plan.update.mock.calls[0][0].data;
		expect(data).not.toHaveProperty("expiry_notified_at");
	});
});

describe("plan writes top the plan up after commit", () => {
	it("insertRecurringPlan tops up a new Active plan", async () => {
		const tx = proxyTx(storedPlan());
		vi.mocked(getScopedDb).mockReturnValue({
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			$transaction: vi.fn((cb: any) => cb(tx)),
		} as never);

		const r = await insertRecurringPlan(
			{
				body: {
					client_id: "55555555-5555-4555-8555-555555555555",
					name: "P",
					description: "d",
					address: "a",
					coords: { lat: 1, lon: 1 },
					starts_at: "2026-11-01T00:00:00.000Z",
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
		await vi.waitFor(() =>
			expect(topUpPlan).toHaveBeenCalledWith("plan-1", ORG),
		);
	});

	it("a rule edit on an Active plan tops it up", async () => {
		mockUpdate(storedPlan());

		const r = await updateRecurringPlan(
			"job-1",
			{
				rule: {
					frequency: "weekly",
					interval: 1,
					by_weekday: ["MO"],
					arrival_constraint: "anytime",
					finish_constraint: "when_done",
				},
			},
			ORG,
		);

		expect(r.err).toBe("");
		await vi.waitFor(() =>
			expect(topUpPlan).toHaveBeenCalledWith("plan-1", ORG),
		);
	});

	it("a generation window or min_advance_days edit on an Active plan tops it up", async () => {
		mockUpdate(storedPlan());
		await updateRecurringPlan("job-1", { generation_window_days: 60 }, ORG);
		mockUpdate(storedPlan());
		await updateRecurringPlan("job-1", { min_advance_days: 21 }, ORG);

		await vi.waitFor(() => expect(topUpPlan).toHaveBeenCalledTimes(2));
	});

	it("does not top up a paused plan or an edit that leaves the schedule alone", async () => {
		const paused = storedPlan({ status: "Paused" });
		mockUpdate(paused);
		await updateRecurringPlan("job-1", { min_advance_days: 21 }, ORG);
		mockUpdate(storedPlan());
		await updateRecurringPlan("job-1", { name: "Renamed" }, ORG);

		await vi.dynamicImportSettled();
		await new Promise((r) => setTimeout(r, 0));
		expect(topUpPlan).not.toHaveBeenCalled();
	});
});
