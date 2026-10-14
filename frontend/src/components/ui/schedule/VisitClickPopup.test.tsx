import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import VisitClickPopup from "./VisitClickPopup";
import type { VisitWithJob } from "./dashboardCalendarUtils";
import type { Technician } from "../../../types/technicians";

const job = {
	id: "job1",
	name: "Williams — Annual Service",
	address: "1420 Oak St, Springfield",
	priority: "Medium",
	description: "Annual maintenance agreement",
	client: { id: "c1", name: "Williams Residence" },
};

function makeVisit(over: Partial<VisitWithJob> = {}): VisitWithJob {
	return {
		id: "v1",
		job_id: "job1",
		name: "Furnace no-heat diagnosis",
		description: "No heat since Monday",
		status: "Scheduled",
		arrival_constraint: "at",
		arrival_time: "09:00",
		finish_constraint: "at",
		finish_time: "11:00",
		scheduled_start_at: "2026-09-29T14:00:00.000Z",
		scheduled_end_at: "2026-09-29T16:00:00.000Z",
		visit_techs: [
			{ visit_id: "v1", tech_id: "t1", tech_status: "", tech: { id: "t1", name: "Ana Ruiz" } },
		],
		job_obj: job,
		...over,
	} as unknown as VisitWithJob;
}

const technicians = [{ id: "t1", name: "Ana Ruiz" }] as unknown as Technician[];

type Handlers = Partial<Record<"onClose" | "onViewVisit" | "onViewJob", () => void>>;

function renderPopup(visit: VisitWithJob, handlers: Handlers = {}) {
	return render(
		<VisitClickPopup
			visit={visit}
			style={{ position: "fixed", top: 0, left: 0 }}
			technicians={technicians}
			techColorMap={new Map([["t1", "var(--color-tech-1)"]])}
			onClose={handlers.onClose ?? vi.fn()}
			onViewVisit={handlers.onViewVisit ?? vi.fn()}
			onViewJob={handlers.onViewJob ?? vi.fn()}
		/>
	);
}

describe("VisitClickPopup", () => {
	it("titles the dialog with the visit name and shows the job underneath", () => {
		renderPopup(makeVisit());
		expect(screen.getByRole("dialog", { name: "Furnace no-heat diagnosis" })).toBeInTheDocument();
		expect(screen.getByText("Williams — Annual Service")).toBeInTheDocument();
	});

	it("falls back to the job name without repeating it", () => {
		renderPopup(makeVisit({ name: "  " }));
		expect(screen.getByRole("dialog", { name: "Williams — Annual Service" })).toBeInTheDocument();
		expect(screen.getAllByText("Williams — Annual Service")).toHaveLength(1);
	});

	it("shows the snapshot facts", () => {
		renderPopup(makeVisit());
		expect(screen.getByText(/9:00 – 11:00 AM/)).toBeInTheDocument();
		expect(screen.getByText("Ana Ruiz")).toBeInTheDocument();
		expect(screen.getByText("Williams Residence")).toBeInTheDocument();
		expect(screen.getByText("1420 Oak St, Springfield")).toBeInTheDocument();
		expect(screen.getByText("No heat since Monday")).toBeInTheDocument();
		expect(screen.getByText("Scheduled")).toBeInTheDocument();
	});

	it("flags an unassigned visit", () => {
		renderPopup(makeVisit({ visit_techs: [] }));
		expect(screen.getByText("Unassigned")).toBeInTheDocument();
	});

	it("falls back to the job description and omits rows with no data", () => {
		renderPopup(
			makeVisit({
				description: null,
				job_obj: { ...job, address: "", client: undefined } as unknown as VisitWithJob["job_obj"],
			})
		);
		expect(screen.getByText("Annual maintenance agreement")).toBeInTheDocument();
		expect(screen.queryByText("Williams Residence")).not.toBeInTheDocument();
		expect(screen.getAllByRole("listitem")).toHaveLength(2); // when + techs
	});

	it("only raises a priority chip above normal", () => {
		const { unmount } = renderPopup(makeVisit());
		expect(screen.queryByText("Medium")).not.toBeInTheDocument();
		unmount();
		renderPopup(
			makeVisit({ job_obj: { ...job, priority: "Urgent" } as unknown as VisitWithJob["job_obj"] })
		);
		expect(screen.getByText("Urgent")).toBeInTheDocument();
	});

	it("takes focus on open and hands it back on close", () => {
		const trigger = document.createElement("button");
		document.body.appendChild(trigger);
		trigger.focus();
		const { unmount } = renderPopup(makeVisit());
		expect(document.activeElement).toBe(screen.getByRole("dialog"));
		unmount();
		expect(document.activeElement).toBe(trigger);
		trigger.remove();
	});

	it("leaves Escape to a layer that already handled it", () => {
		const onClose = vi.fn();
		renderPopup(makeVisit(), { onClose });
		const blocker = (e: KeyboardEvent) => e.preventDefault();
		window.addEventListener("keydown", blocker, { capture: true });
		fireEvent.keyDown(document, { key: "Escape" });
		window.removeEventListener("keydown", blocker, { capture: true });
		expect(onClose).not.toHaveBeenCalled();
	});

	it("ignores Escape while focus sits in another dialog", () => {
		const onClose = vi.fn();
		renderPopup(makeVisit(), { onClose });
		const other = document.createElement("div");
		other.setAttribute("role", "dialog");
		const input = document.createElement("input");
		other.appendChild(input);
		document.body.appendChild(other);
		input.focus();
		fireEvent.keyDown(input, { key: "Escape" });
		other.remove();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("wires the actions and closes on Escape", () => {
		const onClose = vi.fn();
		const onViewVisit = vi.fn();
		const onViewJob = vi.fn();
		renderPopup(makeVisit(), { onClose, onViewVisit, onViewJob });
		fireEvent.click(screen.getByRole("button", { name: "View Visit" }));
		fireEvent.click(screen.getByRole("button", { name: "View Job" }));
		fireEvent.keyDown(document, { key: "Escape" });
		expect(onViewVisit).toHaveBeenCalledOnce();
		expect(onViewJob).toHaveBeenCalledOnce();
		expect(onClose).toHaveBeenCalledOnce();
	});
});
