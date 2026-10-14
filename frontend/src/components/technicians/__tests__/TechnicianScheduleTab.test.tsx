import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import TechnicianScheduleTab from "../detail/TechnicianScheduleTab";
import type { Technician } from "../../../types/technicians";

const q = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../../../hooks/useJobs", () => ({ useJobVisitsByTechIdQuery: () => q.current }));

const visit = (id: string, start: string, status: string, crew = 1) => ({
	id,
	job_id: `job-${id}`,
	status,
	scheduled_start_at: start,
	scheduled_end_at: start,
	actual_start_at: null,
	actual_end_at: null,
	visit_techs: Array.from({ length: crew }, (_, i) => ({ tech_id: `t${i}` })),
	job: { name: `Job ${id}`, address: "1 Main St", client: { name: "Acme" } },
});
const setVisits = (data: unknown[]) =>
	(q.current = { data, isLoading: false, isError: false, refetch: vi.fn() });

const renderTab = () =>
	render(
		<MemoryRouter>
			<TechnicianScheduleTab technician={{ id: "t1" } as Technician} />
		</MemoryRouter>
	);

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.setSystemTime(new Date("2026-09-25T12:00:00"));
});
afterEach(() => vi.useRealTimers());

describe("TechnicianScheduleTab", () => {
	it("defaults to Upcoming and switches segments", async () => {
		setVisits([
			visit("u1", "2026-09-26T09:00:00", "Scheduled"),
			visit("p1", "2026-09-20T09:00:00", "Completed"),
		]);
		renderTab();
		expect(
			screen.getByRole("radio", { name: /Upcoming/ }).getAttribute("aria-checked")
		).toBe("true");
		expect(screen.getByText("Job u1")).toBeTruthy();
		expect(screen.queryByText("Job p1")).toBeNull();
		await user().click(screen.getByRole("radio", { name: /Past/ }));
		expect(screen.getByText("Job p1")).toBeTruthy();
	});

	it("describes the selected range beside the control", async () => {
		setVisits([]);
		renderTab();
		const group = screen.getByRole("radiogroup", { name: "Visit range" });
		const hint = () => document.getElementById(group.getAttribute("aria-describedby")!);
		expect(hint()?.textContent).toMatch(/from tomorrow on/);
		await user().click(screen.getByRole("radio", { name: /Past/ }));
		expect(hint()?.textContent).toMatch(/every cancelled visit/);
	});

	it("moves selection and focus with arrow keys (roving tab stop)", async () => {
		setVisits([]);
		renderTab();
		const upcoming = screen.getByRole("radio", { name: /Upcoming/ });
		const today = screen.getByRole("radio", { name: /Today/ });
		const past = screen.getByRole("radio", { name: /Past/ });
		upcoming.focus();
		await user().keyboard("{ArrowRight}");
		expect(today.getAttribute("aria-checked")).toBe("true");
		expect(document.activeElement).toBe(today);
		expect(today.tabIndex).toBe(0);
		expect(upcoming.tabIndex).toBe(-1);
		expect(past.tabIndex).toBe(-1);
	});

	it("links each row to its visit", () => {
		setVisits([visit("u1", "2026-09-26T09:00:00", "Scheduled")]);
		renderTab();
		expect(screen.getByRole("link", { name: /Job u1/ }).getAttribute("href")).toBe(
			"/dispatch/jobs/job-u1/visits/u1"
		);
	});

	it("opens the visit when anywhere on the row is clicked", async () => {
		setVisits([visit("u1", "2026-09-26T09:00:00", "Scheduled")]);
		render(
			<MemoryRouter initialEntries={["/dispatch/technicians/t1"]}>
				<Routes>
					<Route
						path="/dispatch/technicians/:id"
						element={
							<TechnicianScheduleTab
								technician={
									{ id: "t1" } as Technician
								}
							/>
						}
					/>
					<Route
						path="/dispatch/jobs/:jobId/visits/:visitId"
						element={<p>Visit page</p>}
					/>
				</Routes>
			</MemoryRouter>
		);
		await user().click(screen.getByText("1 Main St"));
		expect(screen.getByText("Visit page")).toBeTruthy();
	});

	it("shows crew size when others are assigned", () => {
		setVisits([visit("u1", "2026-09-26T09:00:00", "Scheduled", 3)]);
		renderTab();
		expect(screen.getByText("+2")).toBeTruthy();
	});

	it("pages past 25 rows", async () => {
		setVisits(
			Array.from({ length: 30 }, (_, i) =>
				visit(
					`u${i}`,
					`2026-10-${String(i + 1).padStart(2, "0")}T09:00:00`,
					"Scheduled"
				)
			)
		);
		renderTab();
		expect(screen.getAllByRole("row")).toHaveLength(26);
		await user().click(screen.getByRole("button", { name: /Show more/ }));
		expect(screen.getAllByRole("row")).toHaveLength(31);
	});

	it("has per-segment empty copy", () => {
		setVisits([]);
		renderTab();
		expect(screen.getByText("No upcoming visits.")).toBeTruthy();
	});

	it("offers retry on error", () => {
		q.current = { data: undefined, isLoading: false, isError: true, refetch: vi.fn() };
		renderTab();
		expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
	});
});
