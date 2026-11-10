import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import PageReportButton from "../PageReportButton";
import { getReportHref, type PageReportState } from "../usePageReport";
import type { PageSummaryResponse } from "../../../types/reports";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-router-dom")>();
	return { ...actual, useNavigate: () => mockNavigate };
});

// The real PageSummary is a recharts chart; jsdom can't lay it out, and all
// this test needs is a way to click a breakdown slice.
vi.mock("../PageSummary", () => ({
	default: ({
		data,
		onBarClick,
	}: {
		data: PageSummaryResponse;
		onBarClick?: (label: string) => void;
	}) => (
		<div>
			{data.breakdown.map((s) => (
				<button key={s.label} onClick={() => onBarClick?.(s.label)}>
					{s.label}
				</button>
			))}
		</div>
	),
}));

const data: PageSummaryResponse = {
	page: "quotes",
	stats: [],
	breakdown: [{ label: "Sent", value: 3 }],
	breakdownLabel: "By Status",
};

const setGroupBy = vi.fn();

function Harness({
	canView = true,
	inMain = false,
	ranged = true,
}: {
	canView?: boolean;
	inMain?: boolean;
	ranged?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const range = { option: "this_month" } as const;
	const report: PageReportState = {
		page: "quotes",
		label: "Quotes report",
		canView,
		open,
		setOpen,
		range,
		setRange: vi.fn(),
		options: ["status", "priority"],
		groupBy: "status",
		setGroupBy,
		query: { data, isLoading: false, error: null } as unknown as PageReportState["query"],
		snapshot: { data: { page: "quotes", stats: [] }, isLoading: false, error: null } as unknown as PageReportState["snapshot"],
		ranged,
		hrefFor: (l) => getReportHref("quotes", "status", l, range),
		canDrill: true,
		presets: ["all", "this_month"],
		chart: "bar",
	};
	const body = (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				opener
			</button>
			<PageReportButton report={report} />
			<p>outside</p>
			<div data-report-context>context toggle</div>
		</>
	);
	return <MemoryRouter>{inMain ? <main>{body}</main> : body}</MemoryRouter>;
}

const trigger = () => screen.getByRole("button", { name: "Report" });
const dialog = () => screen.queryByRole("dialog", { name: "Quotes report" });

beforeEach(() => {
	vi.clearAllMocks();
});

describe("PageReportButton", () => {
	it("opens the popover from the trigger", async () => {
		render(<Harness />);
		expect(trigger()).toHaveAttribute("aria-expanded", "false");
		await userEvent.click(trigger());
		expect(trigger()).toHaveAttribute("aria-expanded", "true");
		expect(dialog()).toBeInTheDocument();
	});

	it("drills into the filtered list and closes", async () => {
		render(<Harness />);
		await userEvent.click(trigger());
		await userEvent.click(screen.getByRole("button", { name: "Sent" }));
		expect(mockNavigate).toHaveBeenLastCalledWith("/dispatch/quotes?status=Sent&date=this_month");
		expect(dialog()).toBeNull();
	});

	it("closes on Escape and returns focus to the trigger", async () => {
		render(<Harness />);
		await userEvent.click(trigger());
		await userEvent.keyboard("{Escape}");
		expect(dialog()).toBeNull();
		expect(trigger()).toHaveFocus();
	});

	it("keeps the popover open when Escape only dismisses the open date menu", async () => {
		render(<Harness />);
		await userEvent.click(trigger());
		await userEvent.click(screen.getByRole("button", { name: /Date: This month/ }));
		await userEvent.keyboard("{Escape}");
		expect(dialog()).toBeInTheDocument();
	});

	it("closes on an outside mousedown but not on one inside", async () => {
		render(<Harness />);
		await userEvent.click(trigger());
		fireEvent.mouseDown(dialog()!);
		expect(dialog()).toBeInTheDocument();
		fireEvent.mouseDown(screen.getByText("outside"));
		expect(dialog()).toBeNull();
	});

	it("hides the date range on an unranged report", async () => {
		render(<Harness ranged={false} />);
		await userEvent.click(trigger());
		expect(dialog()).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Date:/ })).toBeNull();
	});

	it("renders nothing for a user without view_reports", () => {
		render(<Harness canView={false} />);
		expect(screen.queryByRole("button", { name: "Report" })).toBeNull();
	});

	// jsdom has no layout: stub the trigger wrapper's right edge, the popover's
	// natural width, and (optionally) <main>'s box.
	function stubLayout(anchorRight: number, main?: { left: number; right: number }) {
		const real = HTMLElement.prototype.getBoundingClientRect;
		const box = (left: number, right: number) =>
			({ left, right, width: right - left, top: 0, bottom: 0, height: 0, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
		HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
			if (this.getAttribute("role") === "dialog") return box(0, 343);
			if (this.firstElementChild?.getAttribute("aria-haspopup") === "dialog")
				return box(anchorRight - 100, anchorRight);
			if (this.tagName === "MAIN" && main) return box(main.left, main.right);
			return real.call(this);
		};
		return () => {
			HTMLElement.prototype.getBoundingClientRect = real;
		};
	}

	it("shifts the popover back inside the viewport when the trigger sits left of the edge", async () => {
		const restore = stubLayout(243);
		try {
			render(<Harness />);
			await userEvent.click(trigger());
			// 343 wide ending at 243 starts at -100; 16px gutter → 116px moved right.
			expect(dialog()!.style.right).toBe("-116px");
		} finally {
			restore();
		}
	});

	it("fits the popover inside <main> (it clips overflow), not the viewport", async () => {
		const restore = stubLayout(320, { left: 64, right: 375 });
		try {
			render(<Harness inMain />);
			await userEvent.click(trigger());
			// Room inside main: 375-16 - (64+16) = 279 → width 279, starts at 41, needs 80 → 39px.
			expect(dialog()!.style.maxWidth).toBe("279px");
			expect(dialog()!.style.right).toBe("-39px");
		} finally {
			restore();
		}
	});

	it("returns focus to whatever opened it (the KPI line), not always the trigger", async () => {
		render(<Harness />);
		const opener = screen.getByRole("button", { name: "opener" });
		await userEvent.click(opener);
		expect(dialog()).toBeInTheDocument();
		await userEvent.keyboard("{Escape}");
		expect(opener).toHaveFocus();
	});

	it("stays open across a click on a report-context control (the Jobs/Plans toggle)", async () => {
		render(<Harness />);
		await userEvent.click(trigger());
		fireEvent.mouseDown(screen.getByText("context toggle"));
		expect(dialog()).toBeInTheDocument();
	});

	it("switches the breakdown from the popover's grouping menu", async () => {
		render(<Harness />);
		await userEvent.click(trigger());
		await userEvent.click(screen.getByRole("button", { name: /^Break down by/ }));
		await userEvent.click(screen.getByRole("option", { name: "Priority" }));
		expect(setGroupBy).toHaveBeenCalledWith("priority");
		expect(dialog()).toBeInTheDocument();
	});

	it("keeps the popover open when Escape only dismisses the grouping menu", async () => {
		render(<Harness />);
		await userEvent.click(trigger());
		await userEvent.click(screen.getByRole("button", { name: /^Break down by/ }));
		await userEvent.keyboard("{Escape}");
		expect(dialog()).toBeInTheDocument();
		expect(screen.queryByRole("listbox")).toBeNull();
	});
});
