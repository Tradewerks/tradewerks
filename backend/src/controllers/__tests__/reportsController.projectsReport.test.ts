import { describe, it, expect, vi, beforeEach } from "vitest";
import { getProjectsReport, getProjectsReportPage } from "../reportsController.js";
import { REPORT_DEFINITIONS } from "../../lib/reports/reportRegistry.js";
import type { FilterCondition, PaginateParams } from "../../lib/reports/filterEngine.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { db } from "../../db.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		project: { findMany: vi.fn() },
		$queryRawUnsafe: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

type Fn = ReturnType<typeof vi.fn>;
const mockDb = vi.mocked(db) as unknown as {
	project: { findMany: Fn };
	$queryRawUnsafe: Fn;
};

const ORG = "org-1";

const project = (overrides: Record<string, unknown> = {}) => ({
	id: "p1",
	project_number: "PRJ-1",
	name: "Renovation",
	client: { name: "Acme" },
	status: "Planning",
	priority: "Medium",
	manager_dispatcher: null,
	address: "123 Main St",
	starts_at: null,
	target_end_at: null,
	completed_at: null,
	cancelled_at: null,
	created_at: new Date("2026-08-01T00:00:00Z"),
	budget: null,
	jobs: [],
	_count: { jobs: 0 },
	...overrides,
});

const emptyPage: PaginateParams = { page: 0, limit: 20 };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getProjectsReport", () => {
	it("applies the date filter when start/end dates are given", async () => {
		mockDb.project.findMany.mockResolvedValue([]);
		await getProjectsReport("2026-08-01", "2026-08-31", ORG);
		const where = mockDb.project.findMany.mock.calls[0][0].where;
		expect(where.created_at).toEqual({ gte: expect.any(Date), lte: expect.any(Date) });
	});

	it("omits the date filter when no dates are given", async () => {
		mockDb.project.findMany.mockResolvedValue([]);
		await getProjectsReport(undefined, undefined, ORG);
		const where = mockDb.project.findMany.mock.calls[0][0].where;
		expect(where.created_at).toBeUndefined();
	});

	it("scopes each call to its own caller-provided organization", async () => {
		mockDb.project.findMany.mockResolvedValue([]);
		await getProjectsReport(undefined, undefined, "org-a");
		expect(mockDb.project.findMany.mock.calls[0][0].where.organization_id).toBe("org-a");

		mockDb.project.findMany.mockClear();
		await getProjectsReport(undefined, undefined, "org-b");
		expect(mockDb.project.findMany.mock.calls[0][0].where.organization_id).toBe("org-b");
	});

	it("maps budget/managerName/jobCount/totals correctly", async () => {
		mockDb.project.findMany.mockResolvedValue([
			project({
				budget: new Prisma.Decimal("1000.50"),
				manager_dispatcher: null,
				_count: { jobs: 3 },
				jobs: [
					{ estimated_total: new Prisma.Decimal("500"), actual_total: new Prisma.Decimal("450") },
					{ estimated_total: new Prisma.Decimal("200"), actual_total: null },
				],
			}),
		]);
		const [row] = await getProjectsReport(undefined, undefined, ORG);
		expect(row.budget).toBe(1000.5);
		expect(row.managerName).toBeNull();
		expect(row.jobCount).toBe(3);
		expect(row.estimatedTotal).toBe(700);
		expect(row.actualTotal).toBe(450);
		expect(row.variance).toBe(-250);
	});

	// Since bd9239e a project with jobs reports 0 (not null) actuals, matching the SQL page query
	it("reports 0 actual and full negative variance when no job has an actual total yet", async () => {
		mockDb.project.findMany.mockResolvedValue([
			project({
				_count: { jobs: 2 },
				jobs: [
					{ estimated_total: new Prisma.Decimal("500"), actual_total: null },
					{ estimated_total: new Prisma.Decimal("200"), actual_total: null },
				],
			}),
		]);
		const [row] = await getProjectsReport(undefined, undefined, ORG);
		expect(row.estimatedTotal).toBe(700);
		expect(row.actualTotal).toBe(0);
		expect(row.variance).toBe(-700);
	});

	it("reports null totals/variance for a project with no jobs", async () => {
		mockDb.project.findMany.mockResolvedValue([project({ _count: { jobs: 0 }, jobs: [] })]);
		const [row] = await getProjectsReport(undefined, undefined, ORG);
		expect(row.estimatedTotal).toBeNull();
		expect(row.actualTotal).toBeNull();
		expect(row.variance).toBeNull();
	});
});

describe("getProjectsReportPage", () => {
	beforeEach(() => {
		mockDb.$queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0 }]);
		mockDb.project.findMany.mockResolvedValue([]);
	});

	it("scopes the id-prefilter to the org and applies both date bounds", async () => {
		await getProjectsReportPage("2026-08-01", "2026-08-31", ORG, emptyPage);
		const idSql = mockDb.$queryRawUnsafe.mock.calls[0][0] as string;
		expect(idSql).toContain("p.organization_id = $1");
		expect(idSql).toContain("p.created_at >= $2");
		expect(idSql).toContain("p.created_at <= $3");
	});

	it("produces WHERE SQL for a filter condition on status", async () => {
		const conditions: FilterCondition[] = [
			{ id: "c1", columnKey: "status", operator: "equals", value: "Active" },
		];
		await getProjectsReportPage(undefined, undefined, ORG, { ...emptyPage, conditions });

		const idSql = mockDb.$queryRawUnsafe.mock.calls[0][0] as string;
		const idParams = mockDb.$queryRawUnsafe.mock.calls[0].slice(1);
		expect(idSql).toContain("p.status::text");
		expect(idParams).toContain("Active");
	});

	it("sorts on managerName through the LEFT JOIN dispatcher alias", async () => {
		await getProjectsReportPage(undefined, undefined, ORG, {
			...emptyPage,
			sortKey: "managerName",
			sortDir: "asc",
		});
		const idSql = mockDb.$queryRawUnsafe.mock.calls[0][0] as string;
		expect(idSql).toContain("md.name ASC");
	});
});

describe("REPORT_DEFINITIONS.projects.loadPage", () => {
	it("returns null for a condition the SQL pushdown can't express, so the in-memory fallback engages", async () => {
		const conditions: FilterCondition[] = [
			{
				id: "c1",
				columnKey: "status",
				operator: "equals",
				value: "priority",
				valueKind: "field",
			},
		];
		const result = await REPORT_DEFINITIONS.projects.loadPage!(ORG, {}, { ...emptyPage, conditions });
		expect(result).toBeNull();
		expect(mockDb.$queryRawUnsafe).not.toHaveBeenCalled();
	});
});
