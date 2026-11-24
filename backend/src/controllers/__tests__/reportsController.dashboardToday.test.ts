import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDashboardToday } from "../reportsController.js";
import { db } from "../../db.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const model = () => ({ count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() });
	const mockDb = {
		request: model(),
		quote: model(),
		job: model(),
		job_visit: model(),
		recurring_plan: model(),
		$queryRaw: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

type Fn = ReturnType<typeof vi.fn>;
type Model = { count: Fn; groupBy: Fn; findMany: Fn };
const mockDb = vi.mocked(db) as unknown as Record<
	"request" | "quote" | "job" | "job_visit" | "recurring_plan",
	Model
> & { $queryRaw: Fn };

type Where = Record<string, unknown>;
const statusOf = (w: Where) => {
	const s = w.status;
	if (typeof s === "string") return s;
	return ((s as { in?: string[] } | undefined)?.in ?? []).join("+");
};

beforeEach(() => {
	vi.clearAllMocks();
	for (const m of ["request", "quote", "job", "job_visit", "recurring_plan"] as const) {
		mockDb[m].count.mockResolvedValue(0);
		mockDb[m].groupBy.mockResolvedValue([]);
	}
	mockDb.$queryRaw.mockResolvedValue([]);
});

describe("getDashboardToday", () => {
	it("quotes_pending_approval counts Sent and Viewed", async () => {
		mockDb.quote.count.mockImplementation(async ({ where }: { where: Where }) =>
			statusOf(where) === "Sent+Viewed" ? 7 : statusOf(where) === "Approved" ? 3 : 0,
		);
		const res = await getDashboardToday("org-1", "America/Chicago", new Date("2026-06-10T15:00:00Z"));
		expect(res.quotes_pending_approval).toBe(7);
		expect(res.quotes_approved).toBe(3);
	});

	it("visits_late_now uses the org timezone, not server time", async () => {
		// 03:00Z on Jun 11 is still the evening of Jun 10 in Chicago, so the
		// local day opens at 05:00Z on Jun 10.
		const now = new Date("2026-06-11T03:00:00Z");
		mockDb.job_visit.count.mockImplementation(async ({ where }: { where: Where }) =>
			where.status === "Scheduled" && (where.scheduled_start_at as { lt?: Date }).lt ? 2 : 0,
		);
		const res = await getDashboardToday("org-1", "America/Chicago", now);
		expect(res.visits_late_now).toBe(2);
		const lateCall = mockDb.job_visit.count.mock.calls
			.map((c) => c[0].where as Where)
			.find((w) => w.status === "Scheduled")!;
		const range = lateCall.scheduled_start_at as { gte: Date; lt: Date };
		expect(range.gte.toISOString()).toBe("2026-06-10T05:00:00.000Z");
		expect(range.lt.toISOString()).toBe(now.toISOString());
	});

	it("issues no findMany", async () => {
		await getDashboardToday("org-1", "UTC", new Date("2026-06-10T15:00:00Z"));
		for (const m of ["request", "quote", "job", "job_visit", "recurring_plan"] as const) {
			expect(mockDb[m].findMany).not.toHaveBeenCalled();
		}
	});

	it("a caller without view_quotes gets null quote counts and no quote query", async () => {
		const res = await getDashboardToday("org-1", "UTC", new Date("2026-06-10T15:00:00Z"), {
			requests: true,
			quotes: false,
			jobs: true,
			recurring: true,
			visits: true,
		});
		expect(res.quotes_pending_approval).toBeNull();
		expect(res.quotes_approved).toBeNull();
		expect(mockDb.quote.count).not.toHaveBeenCalled();
		expect(res.requests_new).toBe(0);
	});

	it("a caller with only view_jobs still gets visit and job counts", async () => {
		mockDb.job.count.mockResolvedValue(5);
		mockDb.job_visit.count.mockResolvedValue(4);
		const res = await getDashboardToday("org-1", "UTC", new Date("2026-06-10T15:00:00Z"), {
			requests: false,
			quotes: false,
			jobs: true,
			recurring: false,
			visits: true,
		});
		expect(res.jobs_unscheduled).toBe(5);
		expect(res.visits_today).toBe(4);
		expect(res.requests_new).toBeNull();
		expect(res.recurring_active).toBeNull();
		expect(mockDb.request.count).not.toHaveBeenCalled();
		expect(mockDb.recurring_plan.count).not.toHaveBeenCalled();
	});

	it("visits_unassigned_today counts today's non-cancelled visits with no techs", async () => {
		await getDashboardToday("org-1", "UTC", new Date("2026-06-10T15:00:00Z"));
		const where = mockDb.job_visit.count.mock.calls
			.map((c) => c[0].where as Where)
			.find((w) => w.visit_techs)!;
		expect(where.visit_techs).toEqual({ none: {} });
		expect(where.status).toEqual({ not: "Cancelled" });
		expect((where.scheduled_start_at as { gte: Date }).gte.toISOString()).toBe(
			"2026-06-10T00:00:00.000Z",
		);
	});

	it("the techs query carries the org id", async () => {
		await getDashboardToday("org-xyz", "UTC", new Date("2026-06-10T15:00:00Z"));
		const values = mockDb.$queryRaw.mock.calls[0]!.slice(1);
		expect(values).toContain("org-xyz");
	});
});
