import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PageSummary from "../PageSummary";
import type { PageSummaryResponse } from "../../../types/reports";

function summary(stats: PageSummaryResponse["stats"]): PageSummaryResponse {
	return { page: "projects", stats, breakdown: [], breakdownLabel: "" };
}

// Five-stat reports leave each card ~76px inside; full cents made values
// shrink unevenly and long labels wrapped, stretching the whole row.
describe("PageSummary stat cards", () => {
	it("shows money as whole dollars, with the exact amount in the tooltip", () => {
		render(<PageSummary data={summary([{ label: "Budget", value: 121750, format: "currency" }])} />);
		const value = screen.getByText("$121,750");
		expect(value.closest("[title]")?.getAttribute("title")).toContain("$121,750.00");
	});

	it("keeps each label to one line and puts the full label in its tooltip", () => {
		render(<PageSummary data={summary([{ label: "Open Balance", value: 3, format: "number" }])} />);
		const label = screen.getByText("Open Balance");
		expect(label).toHaveClass("truncate");
		expect(label.getAttribute("title")).toContain("Open Balance");
	});
});

function breakdown(page: string, slices: [string, number][]): PageSummaryResponse {
	return {
		page,
		stats: [],
		breakdown: slices.map(([label, value]) => ({ label, value })),
		breakdownLabel: "By Status",
	};
}

const chart = () => document.querySelector(".recharts-responsive-container");

// One group is not a breakdown: a 100% donut said nothing, wasted ~220px, and
// its lone ring never took a click.
describe("PageSummary single-category breakdown", () => {
	it("states the one group instead of drawing a chart", () => {
		render(<PageSummary data={breakdown("clients", [["Active", 5]])} />);
		expect(chart()).toBeNull();
		expect(screen.getByText("Active")).toBeInTheDocument();
		expect(screen.getByText("all 5")).toBeInTheDocument();
	});

	it("ignores zero-count groups when deciding there is only one", () => {
		render(<PageSummary data={breakdown("recurring_plans", [["Active", 2], ["Paused", 0]])} />);
		expect(chart()).toBeNull();
		expect(screen.queryByText("Paused")).toBeNull();
	});

	it("drills through with the stored label, not the printed one", async () => {
		const onBarClick = vi.fn();
		render(<PageSummary data={breakdown("quotes", [["Issued", 3]])} onBarClick={onBarClick} />);
		await userEvent.click(screen.getByRole("button", { name: /Created/ }));
		expect(onBarClick).toHaveBeenCalledWith("Issued");
	});

	it("is plain text when there is nowhere to drill", () => {
		render(<PageSummary data={breakdown("clients", [["Active", 5]])} />);
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("still charts two or more groups", () => {
		render(<PageSummary data={breakdown("clients", [["Active", 5], ["Inactive", 1]])} />);
		expect(chart()).not.toBeNull();
	});
});

// A donut is for a small fixed set of parts of a whole; status/priority/manager
// are open-ended or ordinal and must not flip to a donut just because today's
// data has few groups.
describe("PageSummary chart choice and donut legend", () => {
	it("draws bars for a bar grouping even when there are only two groups", () => {
		render(<PageSummary data={breakdown("recurring_plans", [["Low", 1], ["Medium", 1]])} chart="bar" />);
		expect(document.querySelector(".recharts-pie")).toBeNull();
		expect(screen.queryByRole("list", { name: "By Status" })).toBeNull();
	});

	it("labels each donut part with its count and share", () => {
		render(<PageSummary data={breakdown("clients", [["Taxable", 4], ["Exempt", 1]])} chart="donut" />);
		const legend = screen.getByRole("list", { name: "By Status" });
		expect(legend).toHaveTextContent("Taxable4 · 80%");
		expect(legend).toHaveTextContent("Exempt1 · 20%");
	});

	it("makes legend rows the drill-through targets when drillable", async () => {
		const onBarClick = vi.fn();
		render(
			<PageSummary data={breakdown("clients", [["Taxable", 4], ["Exempt", 1]])} chart="donut" onBarClick={onBarClick} />,
		);
		await userEvent.click(screen.getByRole("button", { name: /Exempt/ }));
		expect(onBarClick).toHaveBeenCalledWith("Exempt");
	});

	it("keeps legend rows as plain text when nothing drills", () => {
		render(<PageSummary data={breakdown("jobs", [["One-off", 4], ["Recurring", 2]])} chart="donut" />);
		expect(screen.queryByRole("button")).toBeNull();
	});
});

