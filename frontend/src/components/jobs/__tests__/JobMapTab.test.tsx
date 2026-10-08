import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi, beforeEach } from "vitest";
import type { Job, JobVisit } from "../../../types/jobs";
import type { RailVisit } from "../../ui/maps/RecordMapRail";

type MapProps = {
	techIds: string[];
	focusVisitIds: string[];
	visits?: RailVisit[];
	onToggleVisit?: (id: string) => void;
	tz?: string;
	address: string;
	hiddenNote?: string;
	emptyTechText?: string;
};
const last = vi.hoisted(() => ({ props: null as null | MapProps }));

vi.mock("../../ui/maps/RecordMap", () => ({
	default: (p: MapProps) => {
		last.props = p;
		return (
			<div>
				{p.visits?.map((v) => (
					<button key={v.id} type="button" onClick={() => p.onToggleVisit?.(v.id)}>
						{v.name}
					</button>
				))}
			</div>
		);
	},
}));
vi.mock("../../../auth/authStore", () => ({
	useAuthStore: () => ({ user: { orgTimezone: "America/Chicago" } }),
}));

import JobMapTab from "../JobMapTab";

const job = {
	id: "j1",
	name: "AC Repair",
	address: "123 Main St",
	coords: { lat: 43.9, lon: -91.3 },
	client: { name: "Acme" },
} as unknown as Job;

function visit(
	id: string,
	name: string,
	status: JobVisit["status"],
	start: Date,
	techs: string[],
): JobVisit {
	return {
		id,
		name,
		status,
		scheduled_start_at: start.toISOString(),
		visit_techs: techs.map((t) => ({ visit_id: id, tech_id: t, tech_status: "Assigned" })),
	} as unknown as JobVisit;
}

const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 0);
const nextWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7, 9, 0);

beforeEach(() => {
	last.props = null;
});

describe("JobMapTab", () => {
	test("defaults to today's visit and its crew; visits reach the rail in date order", () => {
		render(
			<JobMapTab
				job={job}
				visits={[
					visit("v1", "Repair", "Scheduled", today, ["t1", "t2"]),
					visit("v2", "Follow-up", "Scheduled", nextWeek, ["t2", "t3"]),
				]}
			/>,
		);
		expect(last.props!.focusVisitIds).toEqual(["v1"]);
		expect([...last.props!.techIds].sort()).toEqual(["t1", "t2"]);
		expect(last.props!.visits!.map((v) => [v.id, v.selected])).toEqual([
			["v1", true],
			["v2", false],
		]);
		expect(last.props!.tz).toBe("America/Chicago");
		expect(last.props!.address).toBe("123 Main St");
	});

	test("toggling a visit adds its crew once", async () => {
		render(
			<JobMapTab
				job={job}
				visits={[
					visit("v1", "Repair", "Scheduled", today, ["t1", "t2"]),
					visit("v2", "Follow-up", "Scheduled", nextWeek, ["t2", "t3"]),
				]}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: /Follow-up/ }));
		expect([...last.props!.focusVisitIds].sort()).toEqual(["v1", "v2"]);
		expect([...last.props!.techIds].sort()).toEqual(["t1", "t2", "t3"]);
	});

	test("visits that load after mount still get the default selection", () => {
		const { rerender } = render(<JobMapTab job={job} visits={[]} />);
		expect(last.props!.focusVisitIds).toEqual([]);
		rerender(
			<JobMapTab job={job} visits={[visit("v1", "Repair", "Scheduled", today, ["t1"])]} />,
		);
		expect(last.props!.focusVisitIds).toEqual(["v1"]);
	});

	test("an untouched picker follows a visit that goes active, keeping date order", () => {
		const v1 = visit("v1", "Repair", "Scheduled", today, ["t1"]);
		const v2 = visit("v2", "Follow-up", "Scheduled", nextWeek, ["t3"]);
		const { rerender } = render(<JobMapTab job={job} visits={[v1, v2]} />);
		rerender(<JobMapTab job={job} visits={[v1, { ...v2, status: "Driving" }]} />);
		expect([...last.props!.focusVisitIds].sort()).toEqual(["v1", "v2"]);
		expect(last.props!.visits!.map((v) => v.id)).toEqual(["v1", "v2"]);
		expect(last.props!.visits![1]).toMatchObject({ status: "Driving", selected: true });
	});

	// The rail derives the closed-visit note per visit from positionHidden.
	test("the job tab passes no page-level hidden note", async () => {
		const done = visit("v0", "Install", "Completed", today, ["t9"]);
		const v1 = visit("v1", "Repair", "Scheduled", today, ["t1"]);
		render(<JobMapTab job={job} visits={[done, v1]} />);
		await userEvent.click(screen.getByRole("button", { name: /Install/ }));
		expect(last.props!.focusVisitIds).toContain("v0");
		expect(last.props!.visits!.find((v) => v.id === "v0")).toMatchObject({
			status: "Completed",
			selected: true,
		});
		expect(last.props!.hiddenNote).toBeUndefined();
	});

	test("a job whose visits are all closed explains the empty crew list", () => {
		const done = visit("v0", "Install", "Completed", nextWeek, ["t9"]);
		render(<JobMapTab job={job} visits={[done]} />);
		expect(last.props!.focusVisitIds).toEqual([]);
		expect(last.props!.emptyTechText).toBe("Select a visit to see its crew");
	});

	test("a job with no visits keeps the default empty-crew copy", () => {
		render(<JobMapTab job={job} visits={[]} />);
		expect(last.props!.emptyTechText).toBeUndefined();
	});

	test("an unnamed visit reaches the rail as an empty name", () => {
		const v = {
			...visit("v1", "", "Scheduled", today, []),
			name: undefined,
		} as unknown as JobVisit;
		render(<JobMapTab job={job} visits={[v]} />);
		expect(last.props!.visits![0].name).toBe("");
	});

	test("rail visits carry their crew size", () => {
		render(
			<JobMapTab
				job={job}
				visits={[
					visit("v1", "Repair", "Scheduled", today, ["t1", "t2"]),
					visit("v2", "Follow-up", "Scheduled", nextWeek, []),
				]}
			/>,
		);
		expect(last.props!.visits!.map((v) => v.crewCount)).toEqual([2, 0]);
	});
});
