import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import DayAgenda from "./DayAgenda";
import type { AgendaGroup, OccurrenceWithPlan, VisitWithJob } from "./dashboardCalendarUtils";

function v(id: string, hhmm: string, techIds: string[]): VisitWithJob {
	const [h, m] = hhmm.split(":").map(Number);
	return {
		id,
		status: "Scheduled",
		arrival_constraint: "at",
		arrival_time: hhmm,
		scheduled_start_at: new Date(2026, 8, 29, h, m).toISOString(),
		visit_techs: techIds.map((tech_id) => ({ tech_id })),
		job_obj: { id: `job-${id}`, name: `Job ${id}`, priority: "normal" },
	} as unknown as VisitWithJob;
}

const occ = {
	id: "o1",
	occurrence_start_at: new Date(2026, 8, 29, 14, 30).toISOString(),
	job_obj: { id: "job-o1", name: "Filter Change", priority: "normal" },
} as unknown as OccurrenceWithPlan;

const timeGroups: AgendaGroup[] = [
	{
		techId: "__all__",
		techName: "",
		color: "",
		items: [
			{ type: "visit", item: v("a", "08:00", ["t1"]) },
			{ type: "visit", item: v("b", "11:00", ["t1", "t2"]) },
			{ type: "occ", item: occ },
		],
	},
];

const techColorMap = new Map([["t1", "#3b82f6"], ["t2", "#f59e0b"]]);
const techNameMap = new Map([["t1", "John Smith"], ["t2", "Maria Rodriguez"]]);

function setup(over: Partial<Parameters<typeof DayAgenda>[0]> = {}) {
	const props = {
		groups: timeGroups,
		techColorMap,
		techNameMap,
		isToday: true,
		onVisitClick: vi.fn(),
		onVisitDragStart: vi.fn(),
		onOccurrenceClick: vi.fn(),
		onOccurrenceDragStart: vi.fn(),
		onDragEnd: vi.fn(),
		sortMode: "time" as const,
		onSortModeChange: vi.fn(),
		...over,
	};
	return { props, ...render(<DayAgenda {...props} />) };
}

describe("DayAgenda", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 29, 10, 15));
	});
	afterEach(() => vi.useRealTimers());

	it("shows the count line and a Time/Tech segment with state", () => {
		const { props } = setup();
		expect(screen.getByText("2 visits, 1 recurring")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Time" })).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(screen.getByRole("button", { name: "Tech" }));
		expect(props.onSortModeChange).toHaveBeenCalledWith("tech");
	});

	it("has no sort buttons or 'open full schedule' link", () => {
		setup();
		expect(screen.queryByText(/sort by/i)).toBeNull();
		expect(screen.queryByText(/open full schedule/i)).toBeNull();
	});

	it("places the now rule after the last started row, today in Time sort", () => {
		const { container } = setup();
		const order = [...container.querySelectorAll("[data-agenda-row], [data-now-rule]")].map((el) =>
			el.hasAttribute("data-now-rule") ? "now" : el.getAttribute("aria-label")
		);
		expect(order).toEqual([
			"8:00 am, Job a, John Smith",
			"now",
			"11:00 am, Job b, John S., Maria R.",
			"2:30 pm, Filter Change",
		]);
	});

	it("omits the now rule on other days", () => {
		const { container } = setup({ isToday: false });
		expect(container.querySelector("[data-now-rule]")).toBeNull();
	});

	it("shows tech dots in Time sort, never on occurrences", () => {
		const { container } = setup();
		const dotsPerRow = [...container.querySelectorAll("[data-agenda-row]")].map(
			(r) => r.querySelectorAll("[data-agenda-dots] > span.rounded-full").length
		);
		expect(dotsPerRow).toEqual([1, 2, 0]);
	});

	it("Tech sort: one heading per group, no tech dots, no now rule", () => {
		const shared = v("b", "11:00", ["t1", "t2"]);
		const { container } = setup({
			sortMode: "tech",
			groups: [
				{ techId: "t1", techName: "John Smith", color: "#3b82f6", items: [{ type: "visit", item: shared }] },
				{ techId: "t2", techName: "Maria Rodriguez", color: "#f59e0b", items: [{ type: "visit", item: shared }] },
			],
		});
		expect([...container.querySelectorAll("[data-agenda-group]")].map((e) => e.textContent)).toEqual([
			"John Smith1",
			"Maria Rodriguez1",
		]);
		expect(screen.getByText("1 visit")).toBeInTheDocument();
		expect(container.querySelector("[data-agenda-dots]")).toBeNull();
		expect(container.querySelector("[data-now-rule]")).toBeNull();
		expect(container.querySelector("section")).toBeNull();
		expect(screen.getByRole("group", { name: "John Smith" })).toBeInTheDocument();
		expect(screen.getByRole("group", { name: "Maria Rodriguez" })).toBeInTheDocument();
	});

	it("keeps the clock running in Tech sort so switching back places the rule freshly", () => {
		const { rerender, props, container } = setup({ sortMode: "tech" });
		act(() => {
			vi.advanceTimersByTime(75 * 60_000);
		});
		rerender(<DayAgenda {...props} sortMode="time" />);
		const order = [...container.querySelectorAll("[data-agenda-row], [data-now-rule]")].map((el) =>
			el.hasAttribute("data-now-rule") ? "now" : el.getAttribute("aria-label")
		);
		expect(order.indexOf("now")).toBe(2);
	});

	it("passes drag and ghost state through to the matching rows", () => {
		setup({
			isRowDragging: (e) => e.item.id === "a",
			isRowGhost: (e) => e.item.id === "o1",
		});
		expect(screen.getByRole("button", { name: "8:00 am, Job a, John Smith" }).style.opacity).toBe(
			"0.4"
		);
		const ghost = screen.getByRole("button", { name: "2:30 pm, Filter Change" });
		expect(ghost.style.outline).toBe("1px dashed var(--color-primary)");
		expect(
			screen.getByRole("button", { name: "11:00 am, Job b, John S., Maria R." }).style.opacity
		).toBe("1");
	});

	it("an empty day says so and offers no controls", () => {
		setup({ groups: [] });
		expect(screen.getByText("No visits")).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("routes clicks to the visit or occurrence handler", () => {
		const { props } = setup();
		fireEvent.click(screen.getByRole("button", { name: "8:00 am, Job a, John Smith" }));
		fireEvent.click(screen.getByRole("button", { name: "2:30 pm, Filter Change" }));
		expect(props.onVisitClick).toHaveBeenCalledOnce();
		expect(props.onOccurrenceClick).toHaveBeenCalledOnce();
	});
});

// jsdom has no layout. Stub the two numbers the overflow hook reads: the agenda's content
// height and its parent's height. The parent is the RTL container, whose first child is the agenda.
function stubGeometry(contentH: (agenda: Element) => number, availableH: number) {
	vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
		return this.hasAttribute("data-day-agenda") ? contentH(this) : 0;
	});
	vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
		return this.firstElementChild?.hasAttribute("data-day-agenda") ? availableH : 0;
	});
}

describe("DayAgenda overflow", () => {
	afterEach(() => vi.restoreAllMocks());

	it("shows no bar while every row fits", () => {
		stubGeometry(() => 200, 291);
		const { container } = setup();
		expect(container.querySelector("[data-agenda-below]")).toBeNull();
	});

	it("measures without its own height, so a shrunk day drops the bar", () => {
		// The bar adds 18px (16 + gap) wherever it renders; 2 rows fit only without it.
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
			this: HTMLElement
		) {
			return this.hasAttribute("data-agenda-below") ? 16 : 0;
		});
		stubGeometry(
			(a) =>
				a.querySelectorAll("[data-agenda-row]").length * 140 +
				(a.querySelector("[data-agenda-below]") ? 18 : 0),
			291
		);
		const { container, rerender, props } = setup();
		expect(container.querySelector("[data-agenda-below]")).not.toBeNull();
		const fewer: AgendaGroup[] = [{ ...timeGroups[0], items: timeGroups[0].items.slice(0, 2) }];
		rerender(<DayAgenda {...props} groups={fewer} />);
		expect(container.querySelector("[data-agenda-below]")).toBeNull();
	});

	it("counts rows below the bar while content overflows", () => {
		stubGeometry(() => 500, 291);
		const rect = (top: number, bottom: number) =>
			({ top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
		vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
			if (this.hasAttribute("data-agenda-below")) return rect(50, 66);
			const rows = [...document.querySelectorAll("[data-agenda-row]")];
			const i = rows.indexOf(this);
			return i >= 0 ? rect(30 * i, 30 * (i + 1)) : rect(0, 0);
		});
		const { container } = setup();
		// Row bottoms 30, 60, 90 against a cut at 50: two are hidden.
		const bar = container.querySelector("[data-agenda-below]")!;
		expect(bar.textContent).toBe("+2 below");
		expect(bar.className).not.toContain("invisible");
	});

	it("pages the first hidden row to the top, clearing a sticky tech header", () => {
		stubGeometry(() => 500, 291);
		const rect = (top: number, bottom: number) =>
			({ top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
		vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
			if (this.hasAttribute("data-agenda-below")) return rect(50, 66);
			const rows = [...document.querySelectorAll("[data-agenda-row]")];
			const i = rows.indexOf(this);
			return i >= 0 ? rect(30 * i, 30 * (i + 1)) : rect(0, 0);
		});
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
			this: HTMLElement
		) {
			return this.hasAttribute("data-agenda-group") ? 20 : 0;
		});
		const scrollBy = vi.fn();
		Element.prototype.scrollBy = scrollBy as unknown as Element["scrollBy"];
		onTestFinished(() => {
			delete (Element.prototype as Partial<Element>).scrollBy;
		});

		const { container, rerender, props } = setup();
		fireEvent.click(container.querySelector("[data-agenda-below]")!);
		// First hidden row (bottom 60 > cut 50) is row 1, top 30.
		expect(scrollBy).toHaveBeenLastCalledWith({ top: 30, behavior: "auto" });

		rerender(
			<DayAgenda
				{...props}
				sortMode="tech"
				groups={[{ techId: "t1", techName: "John Smith", color: "#3b82f6", items: timeGroups[0].items }]}
			/>
		);
		fireEvent.click(container.querySelector("[data-agenda-below]")!);
		// Header 20 + gap 2 stay above the row.
		expect(scrollBy).toHaveBeenLastCalledWith({ top: 8, behavior: "auto" });
	});

	it("hides an empty bar from focus and assistive tech", () => {
		stubGeometry(() => 500, 291); // all rects are 0 in jsdom, so nothing counts as below
		const { container } = setup();
		const bar = container.querySelector<HTMLElement>("[data-agenda-below]")!;
		expect(bar.className).toContain("invisible");
		expect(bar.tabIndex).toBe(-1);
		expect(bar.getAttribute("aria-hidden")).toBe("true");
	});
});
