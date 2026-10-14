import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import DetailTabs, { type DetailTabDef } from "../DetailTabs";
import { useDetailTab } from "../useDetailTab";

const TABS: readonly DetailTabDef<"overview" | "payments" | "activity">[] = [
	{ id: "overview", label: "Overview" },
	{ id: "payments", label: "Payments" },
	{ id: "activity", label: "Activity" },
];

function Harness() {
	const [activeTab, setActiveTab] = useDetailTab(TABS);
	const [params] = useSearchParams();
	const location = useLocation();
	const navigate = useNavigate();

	return (
		<>
			<DetailTabs
				tabs={TABS}
				activeTab={activeTab}
				onSelect={setActiveTab}
				label="Invoice sections"
			/>
			<div data-testid="param">{params.get("tab") ?? "(none)"}</div>
			<div data-testid="here">{location.pathname + location.search}</div>
			<button onClick={() => navigate(-1)}>Back</button>
			<div
				role="tabpanel"
				id={`tabpanel-${activeTab}`}
				aria-labelledby={`tab-${activeTab}`}
			>
				{activeTab}
			</div>
		</>
	);
}

const at = (search: string) =>
	render(
		<MemoryRouter initialEntries={[`/dispatch/invoices/1${search}`]}>
			<Harness />
		</MemoryRouter>
	);

describe("DetailTabs", () => {
	it("wires each tab to its panel", () => {
		at("");

		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(3);
		expect(tabs[0].getAttribute("aria-selected")).toBe("true");
		expect(tabs[0].getAttribute("aria-controls")).toBe("tabpanel-overview");
		expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
			"tab-overview"
		);
	});

	// Roving tabindex: only the selected tab is in the tab order.
	it("keeps one tab stop", () => {
		at("");

		const tabs = screen.getAllByRole("tab");
		expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
	});

	it("opens on the tab named in the URL", () => {
		at("?tab=activity");

		expect(
			screen.getByRole("tab", { name: "Activity" }).getAttribute("aria-selected")
		).toBe("true");
	});

	// An unknown value must not render an empty page.
	it("falls back to the first tab for an unknown value", () => {
		at("?tab=nonsense");

		expect(
			screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")
		).toBe("true");
	});

	it("puts the selection in the URL, and omits the default", async () => {
		at("");
		expect(screen.getByTestId("param").textContent).toBe("(none)");

		await userEvent.click(screen.getByRole("tab", { name: "Payments" }));
		expect(screen.getByTestId("param").textContent).toBe("payments");

		await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
		expect(screen.getByTestId("param").textContent).toBe("(none)");
	});

	it("moves with the arrow keys, wrapping, selection following focus", async () => {
		at("");
		screen.getByRole("tab", { name: "Overview" }).focus();

		await userEvent.keyboard("{ArrowRight}");
		expect(screen.getByTestId("param").textContent).toBe("payments");

		await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
		expect(screen.getByTestId("param").textContent).toBe("activity");

		await userEvent.keyboard("{Home}");
		expect(screen.getByTestId("param").textContent).toBe("(none)");

		await userEvent.keyboard("{End}");
		expect(screen.getByTestId("param").textContent).toBe("activity");
	});

	// Tabs are a lens on one page, not navigation: back has to leave the detail
	// page for whatever opened it, not unwind the tabs just read through.
	it("does not bury the previous page behind tab switches", async () => {
		render(
			<MemoryRouter
				initialEntries={[
					"/dispatch/jobs/1?tab=visits",
					"/dispatch/invoices/1",
				]}
				initialIndex={1}
			>
				<Harness />
			</MemoryRouter>
		);

		await userEvent.click(screen.getByRole("tab", { name: "Payments" }));
		await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
		expect(screen.getByTestId("param").textContent).toBe("activity");

		await userEvent.click(screen.getByRole("button", { name: "Back" }));

		expect(screen.getByTestId("here").textContent).toBe("/dispatch/jobs/1?tab=visits");
	});

	it("names the strip", () => {
		at("");

		expect(screen.getByRole("tablist").getAttribute("aria-label")).toBe(
			"Invoice sections"
		);
	});
});

describe("DetailTabs live dot", () => {
	it("a live tab announces itself; others don't", () => {
		render(
			<DetailTabs
				tabs={[
					{ id: "overview", label: "Overview" },
					{ id: "map", label: "Map", live: true },
				]}
				activeTab="overview"
				onSelect={() => {}}
				label="Visit sections"
			/>,
		);
		expect(screen.getByRole("tab", { name: "Map (live)" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "Overview" })).toBeInTheDocument();
	});
});
