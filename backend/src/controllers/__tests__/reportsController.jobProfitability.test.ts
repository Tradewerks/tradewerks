import { describe, it, expect, vi, beforeEach } from "vitest";
import { getJobProfitabilityReport, discountNetFactor, NO_MATERIALS } from "../reportsController.js";
import { computeConsumptionCosts, type ConsumptionCostRow } from "../../lib/reports/costing.js";
import { db } from "../../db.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		job: { findMany: vi.fn() },
		invoice: { findMany: vi.fn() },
		inventory_item: { findMany: vi.fn() },
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

// The WAC pricing SQL needs a real Postgres, so consumption events are mocked
// and these tests focus on revenue attribution.
vi.mock("../../lib/reports/costing.js", () => ({
	computeConsumptionCosts: vi.fn(),
}));

type Fn = ReturnType<typeof vi.fn>;
const mockDb = vi.mocked(db) as unknown as {
	job: { findMany: Fn };
	invoice: { findMany: Fn };
};

const ORG = "org-1";
const JOB_META = { job_number: "J-0001", name: "AC Repair", client: { name: "Acme" } };

const invoice = (overrides: Record<string, unknown> = {}) => ({
	id: "inv-1",
	subtotal: 1000,
	discount_amount: null,
	jobs: [],
	visits: [],
	...overrides,
});

const jobLink = (billed: number, job_id = "job-1") => ({
	job_id,
	billed_amount: billed,
	job: JOB_META,
});

const visitLink = (billed: number, job_id = "job-1") => ({
	billed_amount: billed,
	visit: { job_id, job: JOB_META },
});

const costEvent = (overrides: Partial<ConsumptionCostRow> = {}): ConsumptionCostRow => ({
	movementId: "sm-1",
	visitId: "visit-1",
	jobId: "job-1",
	clientId: "client-1",
	inventoryItemId: "item-1",
	consumedAt: new Date("2026-08-01T00:00:00Z"),
	reason: "parts_used",
	unit: "each",
	qtyConsumed: 2,
	unitCostBasis: 50,
	totalCost: 100,
	costSource: "wac",
	...overrides,
});

const COGS_JOB = {
	id: "job-1",
	job_number: "J-0001",
	name: "AC Repair",
	status: "Completed",
	client: { name: "Acme" },
};

/** Give job-1 a COGS row built from these consumption events. */
const withCogsEvents = (events: ConsumptionCostRow[]) => {
	vi.mocked(computeConsumptionCosts).mockResolvedValue({ rows: events, truncated: false });
	mockDb.job.findMany.mockResolvedValue([COGS_JOB]);
};

/** Give job-1 a priced COGS row of `totalCost`, so profit is a number not "-". */
const withCogs = (totalCost: number) => withCogsEvents([costEvent({ totalCost })]);

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(computeConsumptionCosts).mockResolvedValue({ rows: [], truncated: false });
	mockDb.job.findMany.mockResolvedValue([]);
});

describe("discountNetFactor", () => {
	it("is 1 with no discount", () => {
		expect(discountNetFactor(1000, null)).toBe(1);
		expect(discountNetFactor(1000, 0)).toBe(1);
	});

	it("is the surviving share of the subtotal", () => {
		expect(discountNetFactor(1000, 250)).toBe(0.75);
	});

	it("clamps to 0 when the discount exceeds the subtotal", () => {
		expect(discountNetFactor(100, 250)).toBe(0);
	});

	it("is 1 when the subtotal is zero or missing", () => {
		expect(discountNetFactor(0, 50)).toBe(1);
		expect(discountNetFactor(null, 50)).toBe(1);
	});
});

describe("getJobProfitabilityReport COGS", () => {
	it("reports 0 for a job that consumed nothing, not a dash", async () => {
		mockDb.invoice.findMany.mockResolvedValue([invoice({ jobs: [jobLink(1000)] })]);

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].cogs).toBe(0);
		expect(rows[0].profit).toBe(1000);
		expect(rows[0].margin).toBe(100);
	});

	it("reports 0 when the priced events happen to total 0", async () => {
		withCogs(0);
		mockDb.invoice.findMany.mockResolvedValue([invoice({ jobs: [jobLink(1000)] })]);

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].cogs).toBe(0);
		expect(rows[0].profit).toBe(1000);
	});

	it("carries costCoverage onto the row", async () => {
		withCogsEvents([
			costEvent({ costSource: "wac" }),
			costEvent({ movementId: "sm-2", costSource: "fallback_current_cost" }),
		]);
		mockDb.invoice.findMany.mockResolvedValue([invoice({ jobs: [jobLink(1000)] })]);

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].costCoverage).toBe("Estimated");
	});

	it("marks a job that consumed nothing as No Materials, not a coverage gap", async () => {
		mockDb.invoice.findMany.mockResolvedValue([invoice({ jobs: [jobLink(1000)] })]);

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].costCoverage).toBe(NO_MATERIALS);
	});

	it("dashes COGS and profit when events exist but none could be priced", async () => {
		withCogsEvents([costEvent({ costSource: "no_cost_data", unitCostBasis: 0, totalCost: 0 })]);
		mockDb.invoice.findMany.mockResolvedValue([invoice({ jobs: [jobLink(1000)] })]);

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].cogs).toBe("-");
		expect(rows[0].profit).toBe("-");
		expect(rows[0].margin).toBeNull();
		expect(rows[0].costCoverage).toBe("No Cost Data");
	});
});

describe("getJobProfitabilityReport revenue", () => {
	it("bills the full amount when the invoice carries no discount", async () => {
		withCogs(100);
		mockDb.invoice.findMany.mockResolvedValue([invoice({ jobs: [jobLink(1000)] })]);

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].revenue).toBe(1000);
		expect(rows[0].profit).toBe(900);
	});

	it("takes the discount off revenue before subtracting COGS", async () => {
		withCogs(100);
		mockDb.invoice.findMany.mockResolvedValue([
			invoice({ discount_amount: 200, jobs: [jobLink(1000)] }),
		]);

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].revenue).toBe(800);
		expect(rows[0].profit).toBe(700);
		expect(rows[0].margin).toBe(87.5);
	});

	it("scales job revenue by the invoice discount", async () => {
		mockDb.invoice.findMany.mockResolvedValue([
			invoice({ discount_amount: 100, jobs: [jobLink(1000)] }),
		]);

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].revenue).toBe(900);
	});

	it("scales visit revenue the same way", async () => {
		mockDb.invoice.findMany.mockResolvedValue([
			invoice({ discount_amount: 250, visits: [visitLink(1000)] }),
		]);

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].revenue).toBe(750);
	});

	it("splits the discount across jobs in proportion to what each was billed", async () => {
		mockDb.invoice.findMany.mockResolvedValue([
			invoice({
				subtotal: 1000,
				discount_amount: 100,
				jobs: [jobLink(750, "job-1"), jobLink(250, "job-2")],
			}),
		]);

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);
		const byJob = new Map(rows.map((r) => [r.jobId, r.revenue]));

		expect(byJob.get("job-1")).toBe(675);
		expect(byJob.get("job-2")).toBe(225);
	});

	it("leaves unattributed line items to absorb their own share of the discount", async () => {
		// 1000 subtotal, only 400 attributed to a job, 100 discount -> the job
		// keeps 90% of its 400, not 400 minus the whole discount.
		mockDb.invoice.findMany.mockResolvedValue([
			invoice({ subtotal: 1000, discount_amount: 100, jobs: [jobLink(400)] }),
		]);

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].revenue).toBe(360);
	});

	it("never reports negative revenue when the discount exceeds the subtotal", async () => {
		mockDb.invoice.findMany.mockResolvedValue([
			invoice({ subtotal: 100, discount_amount: 500, jobs: [jobLink(100)] }),
		]);

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].revenue).toBe(0);
		expect(rows[0].margin).toBeNull();
	});

	it("discounts each invoice on its own factor when a job spans two", async () => {
		mockDb.invoice.findMany.mockResolvedValue([
			invoice({ id: "inv-1", subtotal: 1000, discount_amount: 100, jobs: [jobLink(1000)] }),
			invoice({ id: "inv-2", subtotal: 500, discount_amount: null, jobs: [jobLink(500)] }),
		]);

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows).toHaveLength(1);
		expect(rows[0].revenue).toBe(1400);
	});
});
