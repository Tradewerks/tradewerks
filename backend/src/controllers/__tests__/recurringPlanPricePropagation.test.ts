import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	updateRecurringPlan,
	updateRecurringPlanLineItems,
} from "../recurringPlansController.js";
import { getScopedDb } from "../../lib/context.js";
import { recomputeVisitTotals } from "../../lib/recomputeDocumentTotals.js";
import { recordChanged } from "../../services/recordChanged.js";

vi.mock("../../services/recordChanged.js", () => ({ recordChanged: vi.fn() }));

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
vi.mock("../../lib/recomputeDocumentTotals.js", () => ({
	holdsKeptRate: vi.fn().mockResolvedValue(false),
	recomputeVisitTotals: vi.fn().mockResolvedValue({ ok: true }),
}));

const ORG = "org-1";
const NEW_LINES = [
	{ name: "Filter", quantity: 2, unit_price: 30, item_type: "material" },
];

/** The plan-lock query also goes through $queryRaw; pick out the eligibility one. */
function propagationSql(tx: ReturnType<typeof setup>) {
	const call = tx.$queryRaw.mock.calls.find((c) =>
		(c[0] as string[]).join("?").includes("'Scheduled'"),
	);
	return call ? (call[0] as string[]).join("?") : undefined;
}

function setup(eligible: string[], blocked: string[] = []) {
	const plan = {
		id: "plan-1",
		organization_id: ORG,
		status: "Active",
		timezone: "America/Chicago",
		starts_at: new Date("2026-11-01T06:00:00Z"),
		ends_at: null,
		rules: [],
		line_items: [{ id: "old-1" }],
	};
	const models = {
		$queryRaw: vi
			.fn()
			.mockResolvedValue([
				...eligible.map((id) => ({
					id,
					job_id: "job-1",
					blocked: false,
				})),
				...blocked.map((id) => ({
					id,
					job_id: "job-1",
					blocked: true,
				})),
			]),
		recurring_plan: {
			findUnique: vi.fn().mockResolvedValue(plan),
			update: vi.fn().mockResolvedValue(plan),
		},
		recurring_plan_line_item: {
			delete: vi.fn(),
			update: vi.fn(),
			create: vi.fn(),
			// The id-only read is the in-tx re-read of existing template rows.
			findMany: vi.fn(async (args?: { select?: unknown }) =>
				args?.select
					? [{ id: "fresh-1" }]
					: [
							{
								name: "Filter",
								description: null,
								quantity: 2,
								unit_price: 30,
								item_type: "material",
								taxable: true,
								tax_group_id: null,
								inventory_item_id: null,
							},
						],
			),
		},
		recurring_occurrence: {
			findMany: vi.fn().mockResolvedValue(
				[...eligible, "visit-started"].map((id) => ({
					job_visit_id: id,
				})),
			),
		},
		job_visit_line_item: {
			findMany: vi.fn().mockResolvedValue(
				eligible.map((v) => ({
					id: `old-line-${v}`,
					visit_id: v,
					fulfillment_status: null,
				})),
			),
			deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
			createMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		log: {
			create: vi.fn().mockResolvedValue({ id: "log-1", event_type: "x" }),
		},
		inventory_item: { findMany: vi.fn().mockResolvedValue([]) },
		tax_group: { findMany: vi.fn().mockResolvedValue([]) },
	};
	// Unlisted models answer any call, as the plan-edit path touches many.
	const tx = new Proxy(models as Record<string, Record<string, unknown>>, {
		get(t, model: string) {
			if (model === "$queryRaw") return t[model];
			t[model] ??= {};
			return new Proxy(t[model] as Record<string, unknown>, {
				get(m, fn: string) {
					m[fn] ??= vi.fn().mockResolvedValue({ id: "row-1" });
					return m[fn];
				},
			});
		},
	}) as unknown as typeof models;
	vi.mocked(getScopedDb).mockReturnValue({
		recurring_plan: { findFirst: vi.fn().mockResolvedValue(plan) },
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		$transaction: vi.fn((cb: any) => cb(tx)),
	} as never);
	return tx;
}

beforeEach(() => vi.clearAllMocks());

describe("template price propagation", () => {
	it("apply_to_scheduled_visits rewrites plan lines on a future Scheduled visit and keeps hand-added lines", async () => {
		const tx = setup(["visit-1"]);

		const r = await updateRecurringPlanLineItems(
			"job-1",
			{ line_items: NEW_LINES, apply_to_scheduled_visits: true },
			ORG,
		);

		expect(r.err).toBe("");
		expect(r.item).toMatchObject({ updated_visits: 1 });
		// Only recurring_plan-sourced lines are targeted, so manual ones survive.
		expect(
			tx.job_visit_line_item.findMany.mock.calls[0][0].where,
		).toMatchObject({
			source: "recurring_plan",
		});
		expect(tx.job_visit_line_item.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["old-line-visit-1"] } },
		});
		const created = tx.job_visit_line_item.createMany.mock.calls[0][0].data;
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({
			visit_id: "visit-1",
			name: "Filter",
			quantity: 2,
			unit_price: 30,
			total: 60,
			source: "recurring_plan",
		});
		expect(recomputeVisitTotals).toHaveBeenCalledWith(
			"visit-1",
			ORG,
			expect.anything(),
		);
	});

	it("a started or invoiced visit is not touched", async () => {
		// The lock query filters on status, start time and non-Void invoices.
		const tx = setup([]);

		const r = await updateRecurringPlanLineItems(
			"job-1",
			{ line_items: NEW_LINES, apply_to_scheduled_visits: true },
			ORG,
		);

		expect(r.item).toMatchObject({ updated_visits: 0 });
		expect(tx.job_visit_line_item.deleteMany).not.toHaveBeenCalled();
		expect(tx.job_visit_line_item.createMany).not.toHaveBeenCalled();
		expect(recomputeVisitTotals).not.toHaveBeenCalled();
		const sql = propagationSql(tx);
		expect(sql).toContain("'Scheduled'");
		expect(sql).toContain("scheduled_start_at > now()");
		expect(sql).toContain("invoice_visit");
		expect(sql).toContain("'Void'");
		expect(sql).toContain("FOR NO KEY UPDATE");
		expect(sql).toMatch(/ORDER BY v\.id/);
	});

	it("default false leaves visits alone", async () => {
		const tx = setup(["visit-1"]);

		const r = await updateRecurringPlanLineItems(
			"job-1",
			{ line_items: NEW_LINES },
			ORG,
		);
		const r2 = await updateRecurringPlan(
			"job-1",
			{ line_items: NEW_LINES },
			ORG,
		);

		expect(r.err).toBe("");
		expect(r2.err).toBe("");
		expect(propagationSql(tx)).toBeUndefined();
		expect(tx.job_visit_line_item.deleteMany).not.toHaveBeenCalled();
		expect(recomputeVisitTotals).not.toHaveBeenCalled();
	});

	it("skips visits holding a used, voided or purchase-linked plan line, decided under the lock", async () => {
		const tx = setup([]);

		await updateRecurringPlanLineItems(
			"job-1",
			{ line_items: NEW_LINES, apply_to_scheduled_visits: true },
			ORG,
		);

		const sql = propagationSql(tx)!;
		expect(sql).toContain("'used', 'voided'");
		expect(sql).toContain("purchase_line");
		expect(sql).toContain("field_purchase_line");
		expect(sql).toContain("stock_movement");
	});

	it("locks the plan row before replacing the template", async () => {
		const tx = setup([]);

		await updateRecurringPlanLineItems(
			"job-1",
			{ line_items: NEW_LINES },
			ORG,
		);

		const first = (tx.$queryRaw.mock.calls[0][0] as string[]).join("?");
		expect(first).toContain("FROM recurring_plan");
		expect(first).toContain("FOR NO KEY UPDATE");
	});

	it("updateRecurringPlan with apply_to_scheduled_visits true reprices and reports the count", async () => {
		const tx = setup(["visit-1", "visit-2"]);

		const r = await updateRecurringPlan(
			"job-1",
			{ line_items: NEW_LINES, apply_to_scheduled_visits: true },
			ORG,
		);

		expect(r.err).toBe("");
		expect(r.item).toMatchObject({ updated_visits: 2 });
		expect(tx.job_visit_line_item.createMany).toHaveBeenCalledTimes(2);
		expect(recomputeVisitTotals).toHaveBeenCalledTimes(2);
		expect(recordChanged).toHaveBeenCalledWith(
			ORG,
			"visit",
			"visit-2",
			"job-1",
		);
	});

	it("replaces template lines using the rows re-read inside the tx, not the pre-lock ones", async () => {
		const tx = setup([]);

		await updateRecurringPlanLineItems(
			"job-1",
			{ line_items: NEW_LINES },
			ORG,
		);

		expect(tx.recurring_plan_line_item.delete).toHaveBeenCalledWith({
			where: { id: "fresh-1" },
		});
		expect(tx.recurring_plan_line_item.delete).not.toHaveBeenCalledWith({
			where: { id: "old-1" },
		});
	});

	it("updateRecurringPlan also re-reads existing template rows in the tx", async () => {
		const tx = setup([]);

		await updateRecurringPlan("job-1", { line_items: NEW_LINES }, ORG);

		expect(tx.recurring_plan_line_item.delete).toHaveBeenCalledWith({
			where: { id: "fresh-1" },
		});
		expect(tx.recurring_plan_line_item.delete).not.toHaveBeenCalledWith({
			where: { id: "old-1" },
		});
	});

	it("reports visits that kept their price because a plan line is consumed or purchase-linked", async () => {
		setup(["visit-1"], ["visit-2", "visit-3"]);

		const r = await updateRecurringPlanLineItems(
			"job-1",
			{ line_items: NEW_LINES, apply_to_scheduled_visits: true },
			ORG,
		);
		const r2 = await updateRecurringPlan(
			"job-1",
			{ line_items: NEW_LINES, apply_to_scheduled_visits: true },
			ORG,
		);

		expect(r.item).toMatchObject({ updated_visits: 1, skipped_visits: 2 });
		expect(r2.item).toMatchObject({ updated_visits: 1, skipped_visits: 2 });
	});
});
