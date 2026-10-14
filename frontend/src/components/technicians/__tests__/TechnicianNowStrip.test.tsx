import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TechnicianNowStrip from "../TechnicianNowStrip";
import { VisitStatusLabels } from "../../../types/jobs";
import type { Technician } from "../../../types/technicians";

const NOW = new Date("2026-09-25T12:00:00");

const vt = (id: string, start: string, status: string, actual?: string) => ({
	visit: {
		id,
		job_id: `job-${id}`,
		status,
		scheduled_start_at: start,
		scheduled_end_at: start,
		actual_start_at: actual ?? null,
		job: { id: `job-${id}`, name: `Job ${id}`, client: { name: "Smith Commercial" } },
	},
});

const tech = (visit_techs: unknown[]) =>
	({ id: "t1", name: "Maria", status: "Working", visit_techs }) as unknown as Technician;

const renderStrip = (t: Technician) =>
	render(
		<MemoryRouter>
			<TechnicianNowStrip technician={t} />
		</MemoryRouter>
	);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("TechnicianNowStrip", () => {
	it("shows the current visit, linked, with its own status and start time", () => {
		renderStrip(
			tech([vt("a", "2026-09-25T10:00:00", "OnSite", "2026-09-25T10:42:00")])
		);
		const link = screen.getByRole("link", { name: /Job a/ });
		expect(link.getAttribute("href")).toBe("/dispatch/jobs/job-a/visits/a");
		expect(screen.getByText(VisitStatusLabels.OnSite)).toBeTruthy();
		expect(screen.getByText(/since 10:42/i)).toBeTruthy();
	});

	it("shows the next visit time", () => {
		renderStrip(tech([vt("b", "2026-09-25T14:30:00", "Scheduled")]));
		expect(screen.getByText(/2:30/)).toBeTruthy();
		expect(screen.getByText("Not on a visit")).toBeTruthy();
	});

	it("renders all three empty states for an idle day", () => {
		renderStrip(tech([]));
		expect(screen.getByText("Not on a visit")).toBeTruthy();
		expect(screen.getByText("Nothing else scheduled today")).toBeTruthy();
		expect(screen.getByText("No visits today")).toBeTruthy();
	});

	it("never prints the technician's own status word", () => {
		renderStrip(tech([]));
		expect(screen.queryByText("Working")).toBeNull();
	});
});
