import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
	class InvalidPlanScheduleError extends Error {
		constructor(planId: string) {
			super(`Recurring plan ${planId} can't be scheduled`);
			this.name = "InvalidPlanScheduleError";
		}
	}
	return {
		InvalidPlanScheduleError,
		findActivePlans: vi.fn(),
		isModuleOn: vi.fn(),
		reconcileLegacySlots: vi.fn(),
		generateOccurrencesForPlan: vi.fn(),
		generateVisitFromOccurrence: vi.fn(),
		transitionRecurringPlan: vi.fn(),
		notifyDispatchers: vi.fn(),
		getScopedDb: vi.fn(),
		log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
	};
});

vi.mock("../../db.js", () => ({
	db: { recurring_plan: { findMany: m.findActivePlans } },
}));
vi.mock("../../lib/context.js", () => ({ getScopedDb: m.getScopedDb }));
vi.mock("../entitlementService.js", () => ({ isModuleOn: m.isModuleOn }));
vi.mock("../appLogger.js", () => ({ log: m.log }));
vi.mock("../../lib/recurrence/reconcileLegacySlots.js", () => ({
	reconcileLegacySlots: m.reconcileLegacySlots,
}));
vi.mock("../../controllers/recurringPlansController.js", () => ({
	InvalidPlanScheduleError: m.InvalidPlanScheduleError,
	generateOccurrencesForPlan: m.generateOccurrencesForPlan,
	generateVisitFromOccurrence: m.generateVisitFromOccurrence,
}));
vi.mock("../../lib/recurringPlanState.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../lib/recurringPlanState.js")
	>()),
	transitionRecurringPlan: m.transitionRecurringPlan,
}));
vi.mock("../../controllers/notificationsController.js", () => ({
	notifyDispatchers: m.notifyDispatchers,
}));

import { runRecurringPlanTopUp, topUpPlan } from "../recurringPlanScheduler.js";

const NOW = new Date("2026-11-23T18:00:00Z"); // 12:00 in Chicago
const DAY = 86_400_000;

type PlanRow = {
	id: string;
	organization_id: string;
	name: string;
	status: string;
	timezone: string;
	ends_at: Date | null;
	expiry_notified_at: Date | null;
	min_advance_days: number;
	job_container: { id: string } | null;
};

let plans: Record<string, PlanRow>;
let heldLocks: Set<string>;
let occurrences: { id: string; plan: string; start: Date; end?: Date }[];
const endOf = (o: { start: Date; end?: Date }) =>
	o.end ?? new Date(o.start.getTime() + 2 * 3_600_000);

function plan(id: string, over: Partial<PlanRow> = {}): PlanRow {
	return {
		id,
		organization_id: "org-1",
		name: `Plan ${id}`,
		status: "Active",
		timezone: "America/Chicago",
		ends_at: null,
		expiry_notified_at: null,
		min_advance_days: 14,
		job_container: { id: `job-${id}` },
		...over,
	};
}

function makeTx() {
	return {
		$queryRaw: vi.fn(
			async (strings: TemplateStringsArray, ...values: unknown[]) => {
				const sql = strings.join("?");
				if (sql.includes("pg_try_advisory_xact_lock")) {
					const key = String(values[0]);
					return [{ got: !heldLocks.has(key) }];
				}
				return [{ id: values[0] }];
			},
		),
		recurring_plan: {
			findUnique: vi.fn(
				async ({ where }: { where: { id: string } }) =>
					plans[where.id] ?? null,
			),
			update: vi.fn(async () => ({})),
			updateMany: vi.fn(
				async ({
					where,
					data,
				}: {
					where: { id: string };
					data: Partial<PlanRow>;
				}) => {
					const p = plans[where.id];
					if (!p || p.expiry_notified_at) return { count: 0 };
					Object.assign(p, data);
					return { count: 1 };
				},
			),
		},
	};
}

let txs: ReturnType<typeof makeTx>[];

beforeEach(() => {
	vi.clearAllMocks();
	plans = {};
	heldLocks = new Set();
	occurrences = [];
	txs = [];
	m.isModuleOn.mockResolvedValue(true);
	m.reconcileLegacySlots.mockResolvedValue(0);
	m.generateOccurrencesForPlan.mockResolvedValue({
		generated: 3,
		skipped: 0,
	});
	m.generateVisitFromOccurrence.mockImplementation(async (id: string) => ({
		err: "",
		item: { visit_id: `visit-${id}` },
	}));
	m.transitionRecurringPlan.mockResolvedValue({ err: "" });
	m.notifyDispatchers.mockResolvedValue([]);
	m.findActivePlans.mockImplementation(async () =>
		Object.values(plans)
			.filter((p) => p.status === "Active")
			.map((p) => ({ id: p.id, organization_id: p.organization_id })),
	);
	m.getScopedDb.mockImplementation(() => ({
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
			const tx = makeTx();
			txs.push(tx);
			return fn(tx);
		}),
		recurring_occurrence: {
			findMany: vi.fn(
				async ({
					where,
				}: {
					where: {
						recurring_plan_id: string;
						occurrence_start_at: { gt?: Date; lt: Date };
						occurrence_end_at?: { gt: Date };
					};
				}) =>
					occurrences
						.filter(
							(o) =>
								o.plan === where.recurring_plan_id &&
								(!where.occurrence_start_at.gt ||
									o.start > where.occurrence_start_at.gt) &&
								(!where.occurrence_end_at ||
									endOf(o) > where.occurrence_end_at.gt) &&
								o.start < where.occurrence_start_at.lt,
						)
						.sort((a, b) => a.start.getTime() - b.start.getTime())
						.map((o) => ({ id: o.id })),
			),
		},
	}));
});

describe("recurring plan top-up", () => {
	it("skips a plan whose advisory lock is held", async () => {
		plans.a = plan("a");
		plans.b = plan("b");
		heldLocks.add("recurring_topup:a");

		await runRecurringPlanTopUp(NOW);

		const generatedFor = m.generateOccurrencesForPlan.mock.calls.map(
			(c) => c[0],
		);
		expect(generatedFor).toEqual(["b"]);
		expect(m.reconcileLegacySlots.mock.calls.map((c) => c[0])).toEqual([
			"b",
		]);
		const result = await topUpPlan("a", "org-1", NOW);
		expect(result).toEqual({ generated: 0, visitsCreated: 0 });
	});

	it("creates visits only for occurrences inside min_advance_days", async () => {
		plans.a = plan("a", { min_advance_days: 14 });
		occurrences = [
			{
				id: "past",
				plan: "a",
				start: new Date(NOW.getTime() - 3 * 3_600_000),
				end: new Date(NOW.getTime() - 3_600_000),
			},
			// Started an hour ago, its window still open: still worth a visit.
			{
				id: "open",
				plan: "a",
				start: new Date(NOW.getTime() - 3_600_000),
				end: new Date(NOW.getTime() + 3_600_000),
			},
			{ id: "soon", plan: "a", start: new Date(NOW.getTime() + 2 * DAY) },
			// Dec 7 09:00 Chicago: the 14th local day after today, still inside.
			{ id: "edge", plan: "a", start: new Date("2026-12-07T15:00:00Z") },
			// Dec 8 09:00 Chicago: one local day past the window.
			{ id: "far", plan: "a", start: new Date("2026-12-08T15:00:00Z") },
		];

		const result = await topUpPlan("a", "org-1", NOW);

		expect(m.generateVisitFromOccurrence.mock.calls).toEqual([
			["open", "org-1", undefined],
			["soon", "org-1", undefined],
			["edge", "org-1", undefined],
		]);
		expect(result).toEqual({ generated: 3, visitsCreated: 3 });
		// Visits are made after the lock tx has committed, in their own txs.
		expect(m.generateOccurrencesForPlan).toHaveBeenCalledWith("a", txs[0], {
			now: NOW,
		});
	});

	it("expires a plan whose ends_at is before today, with actor system", async () => {
		// Nov 22 local in Chicago: yesterday.
		plans.a = plan("a", { ends_at: new Date("2026-11-22T06:00:00Z") });
		// Nov 23 local: today, so this one keeps going.
		plans.b = plan("b", { ends_at: new Date("2026-11-23T06:00:00Z") });

		await runRecurringPlanTopUp(NOW);

		expect(m.transitionRecurringPlan).toHaveBeenCalledTimes(1);
		expect(m.transitionRecurringPlan).toHaveBeenCalledWith(
			"job-a",
			"Expired",
			"org-1",
			undefined,
			expect.objectContaining({ actor: "system" }),
		);
		expect(
			m.generateOccurrencesForPlan.mock.calls.map((c) => c[0]),
		).toEqual(["b"]);
		expect(m.generateVisitFromOccurrence).not.toHaveBeenCalled();
	});

	it("sends recurring_plan_expiring once", async () => {
		// Dec 20 local: 27 days out.
		plans.a = plan("a", {
			name: "Quarterly PM",
			ends_at: new Date("2026-12-20T06:00:00Z"),
		});
		// Feb 1: more than 30 days out, no notice yet.
		plans.b = plan("b", { ends_at: new Date("2027-02-01T06:00:00Z") });

		await runRecurringPlanTopUp(NOW);
		await runRecurringPlanTopUp(new Date(NOW.getTime() + DAY));

		expect(m.notifyDispatchers).toHaveBeenCalledTimes(1);
		expect(m.notifyDispatchers).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "recurring_plan_expiring",
				title: "Plan ending soon",
				body: "Quarterly PM ends Dec 20, 2026. Renew it to keep visits coming.",
			}),
			"org-1",
		);
		expect(plans.a.expiry_notified_at).toEqual(NOW);
		expect(plans.b.expiry_notified_at).toBeNull();
	});

	it("skips orgs with recurring_plans switched off", async () => {
		plans.a = plan("a", { organization_id: "org-off" });
		plans.b = plan("b", { organization_id: "org-1" });
		plans.c = plan("c", { organization_id: "org-off" });
		m.isModuleOn.mockImplementation(
			async (orgId: string) => orgId !== "org-off",
		);

		await runRecurringPlanTopUp(NOW);

		expect(
			m.generateOccurrencesForPlan.mock.calls.map((c) => c[0]),
		).toEqual(["b"]);
		expect(m.getScopedDb).not.toHaveBeenCalledWith("org-off");
		// Looked up once per org, not once per plan.
		expect(
			m.isModuleOn.mock.calls.filter((c) => c[0] === "org-off"),
		).toHaveLength(1);
	});

	it("a failing plan does not stop the next plan", async () => {
		plans.a = plan("a");
		plans.b = plan("b");
		plans.c = plan("c");
		occurrences = [
			{ id: "occ-c", plan: "c", start: new Date(NOW.getTime() + DAY) },
		];
		m.generateOccurrencesForPlan.mockImplementation(async (id: string) => {
			if (id === "a") throw new m.InvalidPlanScheduleError("a");
			if (id === "b") throw new Error("boom");
			return { generated: 1, skipped: 0 };
		});

		await runRecurringPlanTopUp(NOW);

		expect(
			m.generateOccurrencesForPlan.mock.calls.map((c) => c[0]),
		).toEqual(["a", "b", "c"]);
		expect(m.generateVisitFromOccurrence).toHaveBeenCalledWith(
			"occ-c",
			"org-1",
			undefined,
		);
		expect(m.log.error).toHaveBeenCalledTimes(2);
	});
});
