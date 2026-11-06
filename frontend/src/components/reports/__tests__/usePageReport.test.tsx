import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getReportHref, usePageReport, type ReportPage } from "../usePageReport";
import type { DateRangeValue } from "../../../util/dateRangeUtils";

const mockUsePageSummaryQuery = vi.fn();
const mockUsePageSnapshotQuery = vi.fn();
const mockUsePermission = vi.fn();

vi.mock("../../../hooks/useReports", () => ({
	usePageSummaryQuery: (...args: unknown[]) => mockUsePageSummaryQuery(...args),
	usePageSnapshotQuery: (...args: unknown[]) => mockUsePageSnapshotQuery(...args),
}));

vi.mock("../../../hooks/useQuickbooks", () => ({
	useQBStatusQuery: () => ({ data: { connected: false } }),
}));

vi.mock("../../../hooks/usePermission", () => ({
	usePermission: (p: string) => mockUsePermission(p),
}));

const mockModuleState = vi.fn();
vi.mock("../../../hooks/useEntitlements", () => ({
	useEntitlements: () => ({ data: {}, isLoading: false }),
	readCachedEntitlements: () => undefined,
}));
vi.mock("../../../lib/permissionAccess", () => ({
	moduleState: (_ent: unknown, key: string) => mockModuleState(key),
}));

const thisMonth: DateRangeValue = { option: "this_month" };

// Last call's arguments as the summary hook received them.
function lastCall(): unknown[] {
	return mockUsePageSummaryQuery.mock.calls.at(-1) as unknown[];
}

beforeEach(() => {
	vi.clearAllMocks();
	mockUsePermission.mockReturnValue(true);
	mockModuleState.mockReturnValue("on");
	mockUsePageSummaryQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
	mockUsePageSnapshotQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
});

describe("getReportHref", () => {
	it("never carries the date range onto the Jobs list", () => {
		expect(getReportHref("jobs", "status", "Scheduled", thisMonth)).toBe(
			"/dispatch/jobs?status=Scheduled",
		);
		expect(getReportHref("jobs", "priority", "High", thisMonth)).toBe(
			"/dispatch/jobs?priority=High",
		);
	});

	it("carries the date range for lists that filter by the same created date", () => {
		expect(getReportHref("quotes", "status", "Sent", thisMonth)).toBe(
			"/dispatch/quotes?status=Sent&date=this_month",
		);
	});

	it("drills recurring-plan statuses into the plans view, carrying the range", () => {
		expect(getReportHref("recurring_plans", "status", "Paused", thisMonth)).toBe(
			"/dispatch/jobs?view=templates&status=Paused&date=this_month",
		);
	});

	it("returns null where the target list has no matching filter", () => {
		expect(getReportHref("recurring_plans", "priority", "High", thisMonth)).toBeNull();
	});

	it("drills client tax status into the Clients list's tax filter", () => {
		expect(getReportHref("clients", "tax_exempt", "Exempt", thisMonth)).toBe("/dispatch/clients?tax=exempt");
		expect(getReportHref("clients", "tax_exempt", "Taxable", thisMonth)).toBe("/dispatch/clients?tax=taxable");
	});

	it("drills inventory stock status into the Inventory list's stock filter", () => {
		expect(getReportHref("inventory", "status", "Sufficient", thisMonth)).toBe(
			"/dispatch/inventory?stock=sufficient",
		);
		expect(getReportHref("inventory", "status", "Low", thisMonth)).toBe("/dispatch/inventory?stock=low");
		expect(getReportHref("inventory", "status", "Out of Stock", thisMonth)).toBe(
			"/dispatch/inventory?stock=out_of_stock",
		);
		expect(getReportHref("inventory", "qb_linked", "Linked", thisMonth)).toBeNull();
	});

	it("maps client status labels onto the list's lowercase values", () => {
		expect(getReportHref("clients", "status", "Active", thisMonth)).toBe(
			"/dispatch/clients?status=active",
		);
	});
});

describe("usePageReport", () => {
	it("sends a bounded range by default (this month)", () => {
		renderHook(() => usePageReport("invoices", "Invoices report"));
		const [page, start, end] = lastCall() as [string, string, string];
		expect(page).toBe("invoices");
		expect(new Date(start).getTime()).toBeLessThan(new Date(end).getTime());
	});

	it("sends no dates once the range is cleared to All", () => {
		const { result } = renderHook(() => usePageReport("invoices", "Invoices report"));
		act(() => result.current.setRange({ option: "all" }));
		const [, start, end] = lastCall();
		expect(start).toBeUndefined();
		expect(end).toBeUndefined();
	});

	it("does not fetch for a user without view_reports", () => {
		mockUsePermission.mockReturnValue(false);
		const { result } = renderHook(() => usePageReport("quotes", "Quotes report"));
		expect(mockUsePermission).toHaveBeenCalledWith("view_reports");
		expect(result.current.canView).toBe(false);
		expect(lastCall()[4]).toBe(false);
	});

	it("does not fetch a module-owned report when the org's plan lacks that module", () => {
		mockModuleState.mockImplementation((key: string) =>
			key === "recurring_plans" ? "not_in_plan" : "on",
		);
		const { result } = renderHook(() => usePageReport("recurring_plans", "Report"));
		expect(result.current.canView).toBe(false);
		expect(lastCall()[4]).toBe(false);
	});

	it("still fetches core page reports regardless of module state", () => {
		mockModuleState.mockReturnValue("not_in_plan");
		const { result } = renderHook(() => usePageReport("requests", "Report"));
		expect(result.current.canView).toBe(true);
	});

	it("sends the range for recurring plans (filtered by next visit server-side)", () => {
		renderHook(() => usePageReport("recurring_plans", "Report"));
		const [, start, end] = lastCall() as [string, string, string];
		expect(new Date(start).getTime()).toBeLessThan(new Date(end).getTime());
	});

	it("offers plans past and future ranges (plans are ranged by when they're in effect)", () => {
		const plans = renderHook(() => usePageReport("recurring_plans", "Report")).result.current;
		expect(plans.presets).toEqual([
			"all", "today", "last_7_days", "last_30_days", "this_month", "next_7_days", "next_30_days", "next_month", "custom",
		]);
		const quotes = renderHook(() => usePageReport("quotes", "Report")).result.current;
		expect(quotes.presets).toEqual(["all", "today", "last_7_days", "last_30_days", "this_month", "custom"]);
	});

	it("picks the chart by grouping, not by how many groups the data has", () => {
		const { result } = renderHook(() => usePageReport("jobs", "Report"));
		expect(result.current.chart).toBe("bar");
		act(() => result.current.setGroupBy("type"));
		expect(result.current.chart).toBe("donut");
		const plans = renderHook(() => usePageReport("recurring_plans", "Report")).result.current;
		expect(plans.chart).toBe("bar");
		const inventory = renderHook(() => usePageReport("inventory", "Report")).result.current;
		expect(inventory.chart).toBe("donut");
		const clients = renderHook(() => usePageReport("clients", "Report")).result.current;
		expect(clients.chart).toBe("donut");
	});

	it("hides and skips the report when the caller disallows it", () => {
		const { result } = renderHook(() =>
			usePageReport("recurring_plans", "Report", { allowed: false }),
		);
		expect(result.current.canView).toBe(false);
		expect(lastCall()[4]).toBe(false);
	});

	it("clamps a jobs-only breakdown when the page switches to recurring plans", () => {
		const { result, rerender } = renderHook(
			({ page }: { page: ReportPage }) => usePageReport(page, "Report"),
			{ initialProps: { page: "jobs" as ReportPage } },
		);
		act(() => result.current.setGroupBy("type"));
		expect(result.current.groupBy).toBe("type");

		rerender({ page: "recurring_plans" });
		expect(result.current.groupBy).toBe("status");
		expect(lastCall()[0]).toBe("recurring_plans");
		expect(lastCall()[3]).toBe("status");
	});

	it("exposes drill-through only for groupings the list can filter by", () => {
		const { result } = renderHook(() => usePageReport("clients", "Clients report"));
		expect(result.current.canDrill).toBe(true);
		expect(result.current.hrefFor("Inactive")).toBe("/dispatch/clients?status=inactive");
		act(() => result.current.setGroupBy("tax_exempt"));
		expect(result.current.canDrill).toBe(true);
		expect(result.current.hrefFor("Exempt")).toBe("/dispatch/clients?tax=exempt");
	});
});

describe("usePageReport — snapshot", () => {
	const lastSnapshot = () => mockUsePageSnapshotQuery.mock.calls.at(-1) as unknown[];

	it("fetches the snapshot for the report page, with no dates", () => {
		renderHook(() => usePageReport("jobs", "Jobs report"));
		expect(lastSnapshot()).toEqual(["jobs", true]);
	});

	it("does not refetch the snapshot when the range changes", () => {
		const { result } = renderHook(() => usePageReport("jobs", "Jobs report"));
		act(() => result.current.setRange({ option: "last_7_days" }));
		for (const call of mockUsePageSnapshotQuery.mock.calls) expect(call).toEqual(["jobs", true]);
	});

	it("switches the snapshot with the page (Jobs → Plans)", () => {
		const { rerender } = renderHook(({ page }: { page: ReportPage }) => usePageReport(page, "Report"), {
			initialProps: { page: "jobs" as ReportPage },
		});
		rerender({ page: "recurring_plans" });
		expect(lastSnapshot()).toEqual(["recurring_plans", true]);
	});

	it("skips the snapshot without view_reports or the module", () => {
		mockUsePermission.mockReturnValue(false);
		renderHook(() => usePageReport("quotes", "Report"));
		expect(lastSnapshot()[1]).toBe(false);

		mockUsePermission.mockReturnValue(true);
		mockModuleState.mockImplementation((key: string) => (key === "projects" ? "not_in_plan" : "on"));
		renderHook(() => usePageReport("projects", "Report"));
		expect(lastSnapshot()[1]).toBe(false);
	});

	it("marks inventory unranged and sends it no dates", () => {
		const inv = renderHook(() => usePageReport("inventory", "Report")).result.current;
		expect(inv.ranged).toBe(false);
		const [, start, end] = lastCall();
		expect(start).toBeUndefined();
		expect(end).toBeUndefined();
		expect(renderHook(() => usePageReport("jobs", "Report")).result.current.ranged).toBe(true);
	});
});
