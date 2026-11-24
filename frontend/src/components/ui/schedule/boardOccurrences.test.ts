import { describe, expect, it } from "vitest";
import { boardToOccurrences } from "./dashboardCalendarUtils";
import { toCardModel } from "./cardModel";
import type { BoardOccurrence } from "../../../types/board";

const occ = (over: Partial<BoardOccurrence> = {}): BoardOccurrence => ({
	id: "o1",
	recurring_plan_id: "p1",
	occurrence_start_at: "2026-09-29T18:00:00.000Z",
	occurrence_end_at: "2026-09-29T20:00:00.000Z",
	status: "planned",
	arrival_constraint: "anytime",
	finish_constraint: "when_done",
	arrival_time: null,
	arrival_window_start: null,
	arrival_window_end: null,
	finish_time: null,
	job_visit_id: null,
	recurring_plan: {
		id: "p1",
		name: "Quarterly filter swap",
		description: "Swap all filters",
		address: "742 Evergreen Terrace",
		priority: "High",
		client: { id: "c1", name: "Acme" },
		job_container: { id: "j9", job_number: "J-0099", name: "Filter plan job" },
	},
	...over,
});

describe("boardToOccurrences", () => {
	it("maps a board occurrence onto the card model the plan cards print", () => {
		const [o] = boardToOccurrences([occ()], "2026-09-01");
		expect(o.job_obj.id).toBe("j9");
		expect(o.plan.id).toBe("p1");
		const m = toCardModel({ kind: "occurrence", occurrence: o }, { techs: [], isAllSelected: true });
		expect(m).toMatchObject({
			kind: "occurrence",
			title: "Filter plan job",
			client: "Acme",
			address: "742 Evergreen Terrace",
			ref: "J-0099",
			description: "Swap all filters",
		});
	});

	it("drops slots with no job container and slots before today", () => {
		const noContainer = occ({
			recurring_plan: { ...occ().recurring_plan, job_container: null },
		});
		expect(boardToOccurrences([noContainer], "2026-09-01")).toEqual([]);
		expect(boardToOccurrences([occ()], "2026-10-15")).toEqual([]);
	});
});
