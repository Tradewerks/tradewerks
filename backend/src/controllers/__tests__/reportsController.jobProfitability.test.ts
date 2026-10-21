import { describe, it, expect, vi, beforeEach } from "vitest";
import { getJobProfitabilityReport, discountNetFactor, NO_MATERIALS } from "../reportsController.js";
import {
	computeConsumptionCosts,
	computeJobDirectCosts,
	type ConsumptionCostRow,
	type JobDirectCostRow,
} from "../../lib/reports/costing.js";
import { db } from "../../db.js";
import { REPORT_DEFINITIONS } from "../../lib/reports/reportRegistry.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		job: { findMany: vi.fn() },
		invoice: { findMany: vi.fn() },
		inventory_item: { findMany: vi.fn() },
		organization: { findFirst: vi.fn() },
		visit_tech_time_entry: { aggregate: vi.fn() },
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

// The WAC pricing SQL and the per-job aggregate both need a real Postgres, so
// they are mocked and these tests focus on attribution and null semantics.
vi.mock("../../lib/reports/costing.js", () => ({
	computeConsumptionCosts: vi.fn(),
	computeJobDirectCosts: vi.fn(),
}));

type Fn = ReturnType<typeof vi.fn>;
const mockDb = vi.mocked(db) as unknown as {
	job: { findMany: Fn };
	invoice: { findMany: Fn };
	organization: { findFirst: Fn };
	visit_tech_time_entry: { aggregate: Fn };
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

const directCost = (overrides: Partial<JobDirectCostRow> = {}): JobDirectCostRow => ({
	jobId: "job-1",
	hours: 0,
	laborCost: 0,
	unratedHours: 0,
	miles: 0,
	visitCount: 0,
	...overrides,
});

/** Per-job hours/labor/miles, as the raw aggregate would return them. */
const withDirectCosts = (...rows: JobDirectCostRow[]) =>
	vi.mocked(computeJobDirectCosts).mockResolvedValue(rows);

/** Org costing config. Decimals arrive as strings from Prisma — mirror that. */
const withOrgCosting = (cfg: {
	cost_per_mile?: string | number;
	monthly_overhead?: string | number;
	overhead_rate_per_hour?: string | number | null;
}) =>
	mockDb.organization.findFirst.mockResolvedValue({
		cost_per_mile: cfg.cost_per_mile ?? 0,
		monthly_overhead: cfg.monthly_overhead ?? 0,
		overhead_rate_per_hour: cfg.overhead_rate_per_hour ?? null,
	});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(computeConsumptionCosts).mockResolvedValue({ rows: [], truncated: false });
	vi.mocked(computeJobDirectCosts).mockResolvedValue([]);
	mockDb.job.findMany.mockResolvedValue([]);
	withOrgCosting({});
	mockDb.visit_tech_time_entry.aggregate.mockResolvedValue({ _sum: { hours_worked: null } });
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

describe("getJobProfitabilityReport net costs", () => {
	/** job-1 billed 1000 with 100 of material, so gross profit is 900. */
	const billed1000 = () => {
		withCogs(100);
		mockDb.invoice.findMany.mockResolvedValue([invoice({ jobs: [jobLink(1000)] })]);
	};

	it("sums labor across technicians and leaves gross profit alone", async () => {
		billed1000();
		// 2.25h @ 42 + 1.5h @ 38 = 94.50 + 57.00
		withDirectCosts(directCost({ hours: 3.75, laborCost: 151.5, visitCount: 1 }));
		// An explicit zero rate, not an unset one: unset would dash overhead and
		// take netProfit with it, which this test is not about.
		withOrgCosting({ overhead_rate_per_hour: 0 });

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].laborCost).toBe(151.5);
		expect(rows[0].laborHours).toBe(3.75);
		// Gross is untouched by labor — that is the whole point of the split.
		expect(rows[0].profit).toBe(900);
		expect(rows[0].netProfit).toBe(748.5);
	});

	it("dashes labor when any technician on the job has no cost rate", async () => {
		billed1000();
		withDirectCosts(directCost({ hours: 5, laborCost: 94.5, unratedHours: 2.75, visitCount: 1 }));

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		// 94.50 is a real partial sum, but presenting it would read as exact.
		expect(rows[0].laborCost).toBe("-");
		expect(rows[0].netProfit).toBe("-");
		expect(rows[0].netMargin).toBeNull();
		expect(rows[0].profit).toBe(900);
	});

	it("reports zero labor, not unknown, for a job with no time entries", async () => {
		billed1000();
		withDirectCosts(directCost({ visitCount: 1, miles: 10 }));
		withOrgCosting({ cost_per_mile: 1 });

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].laborCost).toBe(0);
		expect(rows[0].netProfit).toBe(890);
	});

	it("prices travel from a Decimal-as-string rate", async () => {
		billed1000();
		withDirectCosts(directCost({ miles: 31, visitCount: 1 }));
		// Prisma hands Decimals back as strings; num() would silently make this 0.
		withOrgCosting({ cost_per_mile: "0.67" });

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].travelCost).toBe(20.77);
	});

	it("prices unrecorded miles at 0 and flags them, keeping net known", async () => {
		billed1000();
		withDirectCosts(directCost({ visitCount: 2, miles: 0 }));
		withOrgCosting({ cost_per_mile: "0.67" });

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].travelCost).toBe(0);
		expect(rows[0]._travelMissing).toBe(true);
		expect(rows[0].netProfit).not.toBe("-");
	});

	it("reports zero travel when the org charges nothing per mile", async () => {
		billed1000();
		withDirectCosts(directCost({ visitCount: 2, miles: 0 }));

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		// No rate means the answer is 0 whatever the miles — dashing would strand
		// the column for every org that does not estimate mileage.
		expect(rows[0].travelCost).toBe(0);
	});

	it("dashes overhead when no rate is set but hours were worked", async () => {
		billed1000();
		withDirectCosts(directCost({ hours: 4, laborCost: 160, visitCount: 1 }));

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].overheadCost).toBe("-");
		expect(rows[0].netProfit).toBe("-");
	});

	it("reports zero overhead with no rate when no hours were worked", async () => {
		billed1000();
		withDirectCosts(directCost({ visitCount: 1 }));

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].overheadCost).toBe(0);
		expect(rows[0].netProfit).toBe(900);
	});

	it("charges overhead per hour worked", async () => {
		billed1000();
		withDirectCosts(directCost({ hours: 4, laborCost: 160, visitCount: 1 }));
		withOrgCosting({ overhead_rate_per_hour: "18.5" });

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].overheadCost).toBe(74);
		expect(rows[0].netProfit).toBe(666);
	});

	it("dashes net profit when material cost is unknown, keeping the other columns", async () => {
		// An event that could not be priced makes totalCogs null.
		withCogsEvents([costEvent({ costSource: "no_cost_data", totalCost: 0 })]);
		mockDb.invoice.findMany.mockResolvedValue([invoice({ jobs: [jobLink(1000)] })]);
		withDirectCosts(directCost({ hours: 2, laborCost: 80, miles: 10, visitCount: 1 }));
		withOrgCosting({ cost_per_mile: 1, overhead_rate_per_hour: 10 });

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows[0].cogs).toBe("-");
		expect(rows[0].netProfit).toBe("-");
		expect(rows[0].laborCost).toBe(80);
		expect(rows[0].travelCost).toBe(10);
		expect(rows[0].overheadCost).toBe(20);
	});

	it("attributes direct costs per job, not across jobs", async () => {
		// Both jobs need a consumption event: getCogsByJobReport queries jobs by the
		// ids it saw events for, so a job without one cannot come back from the DB.
		withCogsEvents([costEvent({ totalCost: 0 }), costEvent({ jobId: "job-2", totalCost: 0 })]);
		mockDb.job.findMany.mockResolvedValue([COGS_JOB, { ...COGS_JOB, id: "job-2" }]);
		mockDb.invoice.findMany.mockResolvedValue([
			invoice({ jobs: [jobLink(1000, "job-1"), jobLink(500, "job-2")] }),
		]);
		withOrgCosting({ overhead_rate_per_hour: 0 });
		withDirectCosts(
			directCost({ jobId: "job-1", hours: 2, laborCost: 80, visitCount: 1 }),
			directCost({ jobId: "job-2", hours: 1, laborCost: 38, visitCount: 1 }),
		);

		const { rows } = await getJobProfitabilityReport(undefined, undefined, ORG);

		expect(rows.find((r) => r.jobId === "job-1")?.laborCost).toBe(80);
		expect(rows.find((r) => r.jobId === "job-2")?.laborCost).toBe(38);
	});
});

describe("getJobProfitabilityReport absorption variance", () => {
	it("is null without a date window", async () => {
		withOrgCosting({ monthly_overhead: "9500", overhead_rate_per_hour: "18.5" });

		const summary = await getJobProfitabilityReport(undefined, undefined, ORG);

		// A monthly pool spread over all time is meaningless.
		expect(summary.overheadPool).toBeNull();
		expect(summary.absorptionVariance).toBeNull();
	});

	it("compares the windowed pool against absorbed overhead", async () => {
		withOrgCosting({ monthly_overhead: "9500", overhead_rate_per_hour: "18.5" });
		mockDb.visit_tech_time_entry.aggregate.mockResolvedValue({ _sum: { hours_worked: "100" } });

		const summary = await getJobProfitabilityReport(
			"2026-03-01T00:00:00Z",
			"2026-03-31T00:00:00Z",
			ORG,
		);

		expect(summary.overheadAbsorbed).toBe(1850);
		expect(summary.overheadPool).toBe(9500);
		expect(summary.absorptionVariance).toBe(7650);
		expect(summary.overheadRateSet).toBe(true);
	});

	it("reports no absorption when the rate is unset", async () => {
		withOrgCosting({ monthly_overhead: "9500" });

		const summary = await getJobProfitabilityReport(
			"2026-03-01T00:00:00Z",
			"2026-03-31T00:00:00Z",
			ORG,
		);

		expect(summary.overheadAbsorbed).toBeNull();
		expect(summary.absorptionVariance).toBeNull();
		expect(summary.overheadRateSet).toBe(false);
	});
});

describe("job-profitability filteredSummary", () => {
	const summaryOf = (rows: Record<string, unknown>[]) =>
		REPORT_DEFINITIONS["job-profitability"].filteredSummary!(rows) as Record<string, number>;

	const row = (over: Record<string, unknown> = {}) => ({
		revenue: 1000,
		cogs: 100,
		laborCost: 50,
		travelCost: 20,
		overheadCost: 30,
		costCoverage: "Full",
		...over,
	});

	it("tiles reconcile when a row's cost is unknown", async () => {
		// The old bug: totalProfit summed the profit column, num("-") is 0, so an
		// uncosted row contributed full revenue and no cost and the tiles came out
		// short by exactly that revenue.
		const s = summaryOf([row(), row({ cogs: "-", costCoverage: "No Cost Data" })]);

		expect(s.totalRevenue).toBe(2000);
		expect(s.totalCogs).toBe(100);
		expect(s.totalProfit).toBe(s.totalRevenue - s.totalCogs);
		expect(s.totalNetProfit).toBe(
			s.totalRevenue - s.totalCogs - s.totalLabor - s.totalTravel - s.totalOverhead,
		);
	});

	it("counts each unknown cost separately from the material gap", async () => {
		const s = summaryOf([
			row(),
			row({ laborCost: "-" }),
			row({ overheadCost: "-" }),
			row({ travelCost: 0, _travelMissing: true }),
		]);

		expect(s.jobsMissingLaborCost).toBe(1);
		expect(s.jobsMissingOverheadCost).toBe(1);
		expect(s.jobsMissingTravelCost).toBe(1);
		// costCoverage still means materials only — widening it would move the
		// cogs-by-job report, which shares summarizeCostSource.
		expect(s.jobsMissingCostData).toBe(0);
	});

	it("treats a job that consumed nothing as fully costed", async () => {
		const s = summaryOf([row({ costCoverage: NO_MATERIALS, cogs: 0 })]);

		expect(s.jobsMissingCostData).toBe(0);
	});
});
