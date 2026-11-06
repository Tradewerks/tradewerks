import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PageReportKpis from "../PageReportKpis";
import type { PageReportState } from "../usePageReport";
import type { PageSnapshotResponse, PageSummaryResponse } from "../../../types/reports";

const snapshotData: PageSnapshotResponse = {
	page: "requests",
	stats: [
		{ label: "Open", value: 42, format: "number" },
		{ label: "Est. Value", value: 18400, format: "currency" },
	],
};

const summaryData: PageSummaryResponse = {
	page: "requests",
	stats: [{ label: "Total", value: 99, format: "number" }],
	breakdown: [],
	breakdownLabel: "By Status",
};

function report(
	overrides: Partial<PageReportState> = {},
	snapshot: object = {},
	query: object = {},
): PageReportState {
	return {
		page: "requests",
		label: "Requests report",
		canView: true,
		open: false,
		setOpen: vi.fn(),
		range: { option: "this_month" },
		setRange: vi.fn(),
		options: ["status", "priority"],
		groupBy: "status",
		setGroupBy: vi.fn(),
		query: { data: summaryData, isLoading: false, error: null, ...query } as unknown as PageReportState["query"],
		snapshot: {
			data: snapshotData,
			isLoading: false,
			error: null,
			...snapshot,
		} as unknown as PageReportState["snapshot"],
		ranged: true,
		hrefFor: () => null,
		canDrill: true,
		presets: ["all", "this_month"],
		chart: "bar",
		...overrides,
	};
}

describe("PageReportKpis", () => {
	it("shows each snapshot stat with no range label, currency compacted", () => {
		render(<PageReportKpis report={report()} />);
		expect(screen.getByText("42")).toBeInTheDocument();
		expect(screen.getByText("Open")).toBeInTheDocument();
		expect(screen.getByText("$18.4K")).toBeInTheDocument();
		expect(screen.queryByText("This month")).toBeNull();
	});

	// The popover's period numbers must never leak into the header.
	it("ignores the period summary", () => {
		render(<PageReportKpis report={report()} />);
		expect(screen.queryByText("99")).toBeNull();
	});

	it("rounds sub-thousand currency to whole dollars instead of one stray decimal", () => {
		const small = { ...snapshotData, stats: [{ label: "Unscheduled", value: 713.18, format: "currency" as const }] };
		render(<PageReportKpis report={report({}, { data: small })} />);
		expect(screen.getByText("$713")).toBeInTheDocument();
	});

	it("shows zeros, not a skeleton", () => {
		const zero = {
			...snapshotData,
			stats: [
				{ label: "Open", value: 0, format: "number" as const },
				{ label: "Pipeline", value: 0, format: "currency" as const },
			],
		};
		render(<PageReportKpis report={report({}, { data: zero })} />);
		expect(screen.getByText("0")).toBeInTheDocument();
		expect(screen.getByText("$0")).toBeInTheDocument();
		expect(document.querySelector('[aria-busy="true"]')).toBeNull();
	});

	it("announces that it opens the report dialog, and whether it is open", () => {
		const { rerender } = render(<PageReportKpis report={report()} />);
		const btn = screen.getByRole("button", { name: "Open Requests report" });
		expect(btn).toHaveAttribute("aria-haspopup", "dialog");
		expect(btn).toHaveAttribute("aria-expanded", "false");
		rerender(<PageReportKpis report={report({ open: true })} />);
		expect(btn).toHaveAttribute("aria-expanded", "true");
	});

	it("renders nothing for a user without view_reports", () => {
		const { container } = render(<PageReportKpis report={report({ canView: false })} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing when the snapshot failed", () => {
		const { container } = render(
			<PageReportKpis report={report({}, { data: undefined, error: new Error("x") })} />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("still renders when only the period summary failed", () => {
		render(<PageReportKpis report={report({}, {}, { data: undefined, error: new Error("x") })} />);
		expect(screen.getByText("42")).toBeInTheDocument();
	});

	it("shows a busy placeholder and no values while loading", () => {
		render(<PageReportKpis report={report({}, { data: undefined, isLoading: true })} />);
		expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(screen.queryByText("42")).toBeNull();
		expect(screen.queryByText("This month")).toBeNull();
	});

	it("opens the report popover on click", async () => {
		const r = report();
		render(<PageReportKpis report={r} />);
		await userEvent.click(screen.getByRole("button", { name: "Open Requests report" }));
		expect(r.setOpen).toHaveBeenCalledWith(true);
	});
});
