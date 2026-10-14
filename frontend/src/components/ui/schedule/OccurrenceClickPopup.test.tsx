import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import OccurrenceClickPopup from "./OccurrenceClickPopup";
import type { OccurrenceWithPlan } from "./dashboardCalendarUtils";

const occ = {
	id: "occ1",
	occurrence_start_at: "2026-09-30T09:00:00.000Z",
	occurrence_end_at: "2026-09-30T10:00:00.000Z",
	finish_constraint: "fixed",
	plan: { id: "plan1", name: "Monthly PM" },
	job_obj: { id: "job1", name: "Monthly PM — Williams" },
} as unknown as OccurrenceWithPlan;

function renderIn(position: "fixed" | "absolute") {
	return render(
		<div data-testid="host" style={{ transform: "translate(16px, 16px)", overflow: "hidden" }}>
			<OccurrenceClickPopup
				occurrence={occ}
				style={{ position, top: 10, left: 10 }}
				onClose={vi.fn()}
				onViewPlan={vi.fn()}
				onGenerate={vi.fn()}
			/>
		</div>
	);
}

describe("OccurrenceClickPopup", () => {
	it("escapes a transformed, clipping host when fixed-positioned", () => {
		renderIn("fixed");
		const host = screen.getByTestId("host");
		const title = screen.getByText("Monthly PM");
		expect(host.contains(title)).toBe(false);
		expect(document.body.contains(title)).toBe(true);
	});

	it("stays inside the host when absolutely positioned against it", () => {
		renderIn("absolute");
		expect(screen.getByTestId("host").contains(screen.getByText("Monthly PM"))).toBe(true);
	});
});

describe("OccurrenceClickPopup snapshot", () => {
	const full = {
		...occ,
		arrival_constraint: "anytime",
		finish_constraint: "when_done",
		plan: {
			id: "plan1",
			name: "Monthly PM",
			address: "1420 Oak St, Springfield",
			description: "Replace filter, inspect burner",
			priority: "Medium",
			client: { id: "c1", name: "Williams Residence" },
		},
	} as unknown as OccurrenceWithPlan;

	function renderFull(over: Partial<React.ComponentProps<typeof OccurrenceClickPopup>> = {}) {
		const props = {
			occurrence: full,
			style: { position: "fixed" as const, top: 0, left: 0 },
			onClose: vi.fn(),
			onViewPlan: vi.fn(),
			onGenerate: vi.fn(),
			...over,
		};
		render(<OccurrenceClickPopup {...props} />);
		return props;
	}

	it("titles with the plan, subtitles with the job, and marks it recurring", () => {
		renderFull();
		expect(screen.getByRole("dialog", { name: "Monthly PM" })).toBeInTheDocument();
		expect(screen.getByText("Monthly PM — Williams")).toBeInTheDocument();
		expect(screen.getByText("Recurring")).toBeInTheDocument();
		expect(screen.getByText("Planned")).toBeInTheDocument();
	});

	it("shows anytime instead of the stored 09:00 and the plan facts", () => {
		renderFull();
		expect(screen.getByText(/Anytime · until done/)).toBeInTheDocument();
		expect(screen.queryByText(/9:00/)).not.toBeInTheDocument();
		expect(screen.getByText("Williams Residence")).toBeInTheDocument();
		expect(screen.getByText("1420 Oak St, Springfield")).toBeInTheDocument();
		expect(screen.getByText("Replace filter, inspect burner")).toBeInTheDocument();
		expect(screen.getByText("Assigned when generated")).toBeInTheDocument();
	});

	it("makes Generate the primary action and wires View Plan", () => {
		const props = renderFull();
		fireEvent.click(screen.getByRole("button", { name: "Generate Visit" }));
		fireEvent.click(screen.getByRole("button", { name: "View Plan" }));
		expect(props.onGenerate).toHaveBeenCalledOnce();
		expect(props.onViewPlan).toHaveBeenCalledOnce();
	});

	it("blocks a second generate while one is in flight", () => {
		const props = renderFull({ isGenerating: true });
		const btn = screen.getByRole("button", { name: /Generating/ });
		expect(btn).toBeDisabled();
		fireEvent.click(btn);
		expect(props.onGenerate).not.toHaveBeenCalled();
	});

	it("closes on Escape", () => {
		const props = renderFull();
		fireEvent.keyDown(document, { key: "Escape" });
		expect(props.onClose).toHaveBeenCalledOnce();
	});
});
