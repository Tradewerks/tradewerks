import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCogsByItemReport, getCogsByJobReport, } from "../reportsController.js";
import { REPORT_DEFINITIONS } from "../../lib/reports/reportRegistry.js";
import { computeConsumptionCosts, type ConsumptionCostRow } from "../../lib/reports/costing.js";
import { db } from "../../db.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		job: { findMany: vi.fn() },
		inventory_item: { findMany: vi.fn() },
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

// computeConsumptionCosts owns the raw WAC-pricing SQL — untested (would need a
// real-Postgres integration test, which this repo has no pattern for yet).
// Mocking it out lets these tests focus on the by-job/by-item grouping + mapping.
vi.mock("../../lib/reports/costing.js", () => ({
	computeConsumptionCosts: vi.fn(),
}));

type Fn = ReturnType<typeof vi.fn>;
const mockDb = vi.mocked(db) as unknown as {
	job: { findMany: Fn };
	inventory_item: { findMany: Fn };
};
const mockComputeConsumptionCosts = vi.mocked(computeConsumptionCosts);

const ORG = "org-1";

const job = (overrides: Record<string, unknown> = {}) => ({
	id: "job-1",
	job_number: "J-0001",
	name: "AC Repair",
	status: "Completed",
	client: { name: "Acme" },
	...overrides,
});

const item = (overrides: Record<string, unknown> = {}) => ({
	id: "item-1",
	name: "Capacitor 45+5 MFD",
	sku: "CAP-45-5",
	category: "Electrical",
	unit: "each",
	quantity: 14,
	...overrides,
});

// One priced consumption event, as returned by costing.ts's computeConsumptionCosts
// (the raw `$queryRaw` result) — the row COGS by Job / COGS by Item both reduce.
const cogReport = (overrides: Partial<ConsumptionCostRow> = {}): ConsumptionCostRow => ({
	movementId: "sm-1",
	visitId: "visit-1",
	jobId: "job-1",
	clientId: "client-1",
	inventoryItemId: "item-1",
	consumedAt: new Date("2026-08-01T00:00:00Z"),
	reason: "parts_used",
	unit: "each",
	qtyConsumed: 2,
	unitCostBasis: 10,
	totalCost: 20,
	costSource: "wac",
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getCogsByJobReport", () => {
	it("parses the date range into Date objects and forwards it, with the org id", async () => {
		mockComputeConsumptionCosts.mockResolvedValue({ rows: [], truncated: false });
		mockDb.job.findMany.mockResolvedValue([]);

		await getCogsByJobReport("2026-08-01", "2026-08-31", ORG);

		expect(mockComputeConsumptionCosts).toHaveBeenCalledWith(ORG, {
			startDate: new Date("2026-08-01"),
			endDate: new Date("2026-08-31"),
		});
	});

	it("passes undefined dates through when no range is given", async () => {
		mockComputeConsumptionCosts.mockResolvedValue({ rows: [], truncated: false });
		mockDb.job.findMany.mockResolvedValue([]);

		await getCogsByJobReport(undefined, undefined, ORG);

		expect(mockComputeConsumptionCosts).toHaveBeenCalledWith(ORG, {
			startDate: undefined,
			endDate: undefined,
		});
	});

	it("only queries jobs that have consumption events", async () => {
		mockComputeConsumptionCosts.mockResolvedValue({
			rows: [cogReport({ jobId: "job-1" }), cogReport({ jobId: "job-2", movementId: "sm-2" })],
			truncated: false,
		});
		mockDb.job.findMany.mockResolvedValue([]);

		await getCogsByJobReport(undefined, undefined, ORG);

		const where = mockDb.job.findMany.mock.calls[0][0].where;
		expect(where.id.in).toEqual(expect.arrayContaining(["job-1", "job-2"]));
		expect(where.id.in).toHaveLength(2);
	});

	it("groups events by job and sums qty/cost, reporting costCoverage 'Full' when every event is wac-priced", async () => {
		mockComputeConsumptionCosts.mockResolvedValue({
			rows: [
				cogReport({ inventoryItemId: "item-1", qtyConsumed: 2, totalCost: 20, costSource: "wac" }),
				cogReport({
					movementId: "sm-2",
					inventoryItemId: "item-2",
					qtyConsumed: 1,
					totalCost: 5,
					costSource: "wac",
					consumedAt: new Date("2026-08-05T00:00:00Z"),
				}),
			],
			truncated: false,
		});
		mockDb.job.findMany.mockResolvedValue([job()]);

		const { rows } = await getCogsByJobReport(undefined, undefined, ORG);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: "job-1",
			jobNumber: "J-0001",
			name: "AC Repair",
			clientName: "Acme",
			status: "Completed",
			totalCogs: 25,
			costCoverage: "Full",
			itemCount: 2,
			qtyConsumed: 3,
		});
		expect(rows[0].lastConsumedAt).toEqual(new Date("2026-08-05T00:00:00Z"));
	});

	it("reports costCoverage 'Estimated' when some events fall back to a non-wac cost source", async () => {
		mockComputeConsumptionCosts.mockResolvedValue({
			rows: [
				cogReport({ costSource: "wac", totalCost: 20 }),
				cogReport({
					movementId: "sm-2",
					costSource: "fallback_current_cost",
					totalCost: 8,
				}),
			],
			truncated: false,
		});
		mockDb.job.findMany.mockResolvedValue([job()]);

		const { rows } = await getCogsByJobReport(undefined, undefined, ORG);

		expect(rows[0].costCoverage).toBe("Estimated");
		expect(rows[0].totalCogs).toBe(28);
	});

	it("reports costCoverage 'Partial' when some events have no cost data at all", async () => {
		mockComputeConsumptionCosts.mockResolvedValue({
			rows: [
				cogReport({ costSource: "wac", totalCost: 20 }),
				cogReport({ movementId: "sm-2", costSource: "no_cost_data", totalCost: 0 }),
			],
			truncated: false,
		});
		mockDb.job.findMany.mockResolvedValue([job()]);

		const { rows } = await getCogsByJobReport(undefined, undefined, ORG);

		expect(rows[0].costCoverage).toBe("Partial");
		expect(rows[0].totalCogs).toBe(20);
	});

	it("reports totalCogs null and costCoverage 'No Cost Data' when nothing is priceable", async () => {
		mockComputeConsumptionCosts.mockResolvedValue({
			rows: [cogReport({ costSource: "no_cost_data", totalCost: 0 })],
			truncated: false,
		});
		mockDb.job.findMany.mockResolvedValue([job()]);

		const { rows } = await getCogsByJobReport(undefined, undefined, ORG);

		expect(rows[0].totalCogs).toBeNull();
		expect(rows[0].costCoverage).toBe("No Cost Data");
	});

	it("propagates the truncated flag from computeConsumptionCosts unchanged", async () => {
		mockComputeConsumptionCosts.mockResolvedValue({ rows: [], truncated: true });
		mockDb.job.findMany.mockResolvedValue([]);

		const { truncated } = await getCogsByJobReport(undefined, undefined, ORG);

		expect(truncated).toBe(true);
	});
});

describe("getCogsByItemReport", () => {
	it("parses the date range into Date objects and forwards it, with the org id", async () => {
		mockComputeConsumptionCosts.mockResolvedValue({ rows: [], truncated: false });
		mockDb.inventory_item.findMany.mockResolvedValue([]);

		await getCogsByItemReport("2026-08-01", "2026-08-31", ORG);

		expect(mockComputeConsumptionCosts).toHaveBeenCalledWith(ORG, {
			startDate: new Date("2026-08-01"),
			endDate: new Date("2026-08-31"),
		});
	});

	it("passes undefined dates through when no range is given", async () => {
		mockComputeConsumptionCosts.mockResolvedValue({ rows: [], truncated: false });
		mockDb.inventory_item.findMany.mockResolvedValue([]);

		await getCogsByItemReport(undefined, undefined, ORG);

		expect(mockComputeConsumptionCosts).toHaveBeenCalledWith(ORG, {
			startDate: undefined,
			endDate: undefined,
		});
	});

	it("only queries items that have consumption events", async () => {
		mockComputeConsumptionCosts.mockResolvedValue({
			rows: [
				cogReport({ inventoryItemId: "item-1" }),
				cogReport({ inventoryItemId: "item-2", movementId: "sm-2" }),
			],
			truncated: false,
		});
		mockDb.inventory_item.findMany.mockResolvedValue([]);

		await getCogsByItemReport(undefined, undefined, ORG);

		const where = mockDb.inventory_item.findMany.mock.calls[0][0].where;
		expect(where.id.in).toEqual(expect.arrayContaining(["item-1", "item-2"]));
		expect(where.id.in).toHaveLength(2);
	});

	it("groups events by item and sums qty/cost, reporting costCoverage 'Full' with an avgUnitCost when every event is wac-priced", async () => {
		mockComputeConsumptionCosts.mockResolvedValue({
			rows: [
				cogReport({ jobId: "job-1", qtyConsumed: 2, totalCost: 20, costSource: "wac" }),
				cogReport({
					movementId: "sm-2",
					jobId: "job-2",
					qtyConsumed: 1,
					totalCost: 5,
					costSource: "wac",
					consumedAt: new Date("2026-08-05T00:00:00Z"),
				}),
			],
			truncated: false,
		});
		mockDb.inventory_item.findMany.mockResolvedValue([item()]);

		const { rows } = await getCogsByItemReport(undefined, undefined, ORG);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: "item-1",
			name: "Capacitor 45+5 MFD",
			sku: "CAP-45-5",
			category: "Electrical",
			unit: "each",
			quantity: 14,
			totalCogs: 25,
			costCoverage: "Full",
			jobCount: 2,
			qtyConsumed: 3,
			avgUnitCost: 8.33,
		});
		expect(rows[0].lastConsumedAt).toEqual(new Date("2026-08-05T00:00:00Z"));
	});

	it("reports costCoverage 'Estimated' when some events fall back to a non-wac cost source", async () => {
		mockComputeConsumptionCosts.mockResolvedValue({
			rows: [
				cogReport({ costSource: "wac", totalCost: 20 }),
				cogReport({
					movementId: "sm-2",
					costSource: "fallback_current_cost",
					totalCost: 8,
				}),
			],
			truncated: false,
		});
		mockDb.inventory_item.findMany.mockResolvedValue([item()]);

		const { rows } = await getCogsByItemReport(undefined, undefined, ORG);

		expect(rows[0].costCoverage).toBe("Estimated");
		expect(rows[0].totalCogs).toBe(28);
	});

	it("reports costCoverage 'Partial' when some events have no cost data at all", async () => {
		mockComputeConsumptionCosts.mockResolvedValue({
			rows: [
				cogReport({ costSource: "wac", totalCost: 20 }),
				cogReport({ movementId: "sm-2", costSource: "no_cost_data", totalCost: 0 }),
			],
			truncated: false,
		});
		mockDb.inventory_item.findMany.mockResolvedValue([item()]);

		const { rows } = await getCogsByItemReport(undefined, undefined, ORG);

		expect(rows[0].costCoverage).toBe("Partial");
		expect(rows[0].totalCogs).toBe(20);
	});

	it("reports totalCogs/avgUnitCost null and costCoverage 'No Cost Data' when nothing is priceable", async () => {
		mockComputeConsumptionCosts.mockResolvedValue({
			rows: [cogReport({ costSource: "no_cost_data", totalCost: 0 })],
			truncated: false,
		});
		mockDb.inventory_item.findMany.mockResolvedValue([item()]);

		const { rows } = await getCogsByItemReport(undefined, undefined, ORG);

		expect(rows[0].totalCogs).toBeNull();
		expect(rows[0].avgUnitCost).toBeNull();
		expect(rows[0].costCoverage).toBe("No Cost Data");
	});

	it("propagates the truncated flag from computeConsumptionCosts unchanged", async () => {
		mockComputeConsumptionCosts.mockResolvedValue({ rows: [], truncated: true });
		mockDb.inventory_item.findMany.mockResolvedValue([]);

		const { truncated } = await getCogsByItemReport(undefined, undefined, ORG);

		expect(truncated).toBe(true);
	});
});

describe("REPORT_DEFINITIONS[\"cogs-by-job\"].filteredSummary", () => {
	const filteredSummary = REPORT_DEFINITIONS["cogs-by-job"].filteredSummary!;

	it("sums totalCogs, counts jobs, and counts jobs whose coverage isn't 'Full'", () => {
		const rows = [
			{ totalCogs: 20, costCoverage: "Full" },
			{ totalCogs: 8, costCoverage: "Estimated" },
			{ totalCogs: "—", costCoverage: "No Cost Data" },
		];

		expect(filteredSummary(rows)).toEqual({
			totalCogs: 28,
			jobCount: 3,
			jobsMissingCostData: 2,
		});
	});

	it("treats a non-numeric ('—') totalCogs as 0 rather than throwing or producing NaN", () => {
		const rows = [{ totalCogs: "—", costCoverage: "No Cost Data" }];

		expect(filteredSummary(rows).totalCogs).toBe(0);
	});

	it("returns zeros for an empty (fully filtered-out) row set", () => {
		expect(filteredSummary([])).toEqual({
			totalCogs: 0,
			jobCount: 0,
			jobsMissingCostData: 0,
		});
	});
});

describe("REPORT_DEFINITIONS[\"cogs-by-item\"].filteredSummary", () => {
	const filteredSummary = REPORT_DEFINITIONS["cogs-by-item"].filteredSummary!;

	it("sums totalCogs, counts items, and counts items whose coverage isn't 'Full'", () => {
		const rows = [
			{ totalCogs: 20, costCoverage: "Full" },
			{ totalCogs: 8, costCoverage: "Estimated" },
			{ totalCogs: "—", costCoverage: "No Cost Data" },
		];

		expect(filteredSummary(rows)).toEqual({
			totalCogs: 28,
			itemCount: 3,
			itemsMissingCostData: 2,
		});
	});

	it("treats a non-numeric ('—') totalCogs as 0 rather than throwing or producing NaN", () => {
		const rows = [{ totalCogs: "—", costCoverage: "No Cost Data" }];

		expect(filteredSummary(rows).totalCogs).toBe(0);
	});

	it("returns zeros for an empty (fully filtered-out) row set", () => {
		expect(filteredSummary([])).toEqual({
			totalCogs: 0,
			itemCount: 0,
			itemsMissingCostData: 0,
		});
	});
});
