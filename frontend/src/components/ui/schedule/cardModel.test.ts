import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildConstraintView, toCardModel, type AssignedTech } from "./cardModel";
import { cardSpan } from "./scheduleBoardUtils";
import type { SnapshotTiming } from "./snapshotWhen";
import type { OccurrenceWithPlan, VisitWithJob } from "./dashboardCalendarUtils";

const originalTZ = process.env.TZ;
beforeAll(() => {
	process.env.TZ = "America/Chicago";
});
afterAll(() => {
	process.env.TZ = originalTZ;
});

const at = (h: number, m = 0) => new Date(2026, 8, 29, h, m).toISOString();
const ana: AssignedTech = { id: "t1", name: "Ana Ortiz", color: "#3b82f6", inFilter: true };
const ctx = { techs: [ana], isAllSelected: true };

function visit(over: Record<string, unknown> = {}, job: Record<string, unknown> = {}): VisitWithJob {
	return {
		id: "v1",
		job_id: "j1",
		name: "",
		description: null,
		arrival_constraint: "at",
		arrival_time: "09:00",
		arrival_window_start: null,
		arrival_window_end: null,
		finish_constraint: "at",
		finish_time: "11:00",
		scheduled_start_at: at(9),
		scheduled_end_at: at(11),
		status: "Scheduled",
		visit_techs: [],
		line_items: [],
		job_obj: {
			id: "j1",
			name: "RTU Replacement",
			job_number: "J-0012",
			address: "12 Elm St",
			description: "",
			priority: "Medium",
			recurring_plan: null,
			client: { id: "c1", name: "Smith Co", address: "", is_active: true },
			...job,
		},
		...over,
	} as unknown as VisitWithJob;
}

function occurrence(over: Record<string, unknown> = {}): OccurrenceWithPlan {
	return {
		id: "o1",
		recurring_plan_id: "p1",
		occurrence_start_at: at(13),
		occurrence_end_at: at(17),
		status: "planned",
		arrival_constraint: "between",
		arrival_time: null,
		arrival_window_start: "13:00",
		arrival_window_end: "15:00",
		finish_constraint: "when_done",
		finish_time: null,
		template_version: 1,
		created_at: "",
		plan: {
			id: "p1",
			name: "Quarterly PM",
			address: "400 Oak Ave",
			description: "Filter swap",
			client: { id: "c2", name: "Oak Dental", address: "", is_active: true },
		},
		job_obj: {
			id: "j2",
			name: "Oak Dental PM",
			job_number: "J-0040",
			address: "1 Other Rd",
			description: "",
			priority: "Low",
		},
		...over,
	} as unknown as OccurrenceWithPlan;
}

describe("toCardModel — visits", () => {
	it("falls back to the job name when the visit has none", () => {
		const m = toCardModel({ kind: "visit", visit: visit() }, ctx);
		expect(m.title).toBe("RTU Replacement");
		expect(m.subtitle).toBeUndefined();
	});

	it("uses the visit name first and keeps the job name as subtitle", () => {
		const m = toCardModel({ kind: "visit", visit: visit({ name: "Day 2 — startup" }) }, ctx);
		expect(m.title).toBe("Day 2 — startup");
		expect(m.subtitle).toBe("RTU Replacement");
	});

	it("drops the client when the title already names it, case-insensitively", () => {
		const m = toCardModel(
			{ kind: "visit", visit: visit({}, { name: "SMITH CO rooftop" }) },
			ctx
		);
		expect(m.client).toBeUndefined();
		expect(toCardModel({ kind: "visit", visit: visit() }, ctx).client).toBe("Smith Co");
	});

	it("suppresses the Scheduled status pill but keeps others", () => {
		expect(toCardModel({ kind: "visit", visit: visit() }, ctx).status).toBeUndefined();
		expect(
			toCardModel({ kind: "visit", visit: visit({ status: "Driving" }) }, ctx).status
		).toBe("Driving");
	});

	it("builds the ref from the job number and line-item count", () => {
		const one = visit({ line_items: [{}] });
		const three = visit({ line_items: [{}, {}, {}] });
		expect(toCardModel({ kind: "visit", visit: visit() }, ctx).ref).toBe("J-0012");
		expect(toCardModel({ kind: "visit", visit: one }, ctx).ref).toBe("J-0012 · 1 item");
		expect(toCardModel({ kind: "visit", visit: three }, ctx).ref).toBe("J-0012 · 3 items");
	});

	it("prefers the visit description over the job's", () => {
		const m = toCardModel(
			{ kind: "visit", visit: visit({ description: "Bring lift" }, { description: "Job text" }) },
			ctx
		);
		expect(m.description).toBe("Bring lift");
	});

	it("flags visits that belong to a recurring plan", () => {
		const m = toCardModel(
			{ kind: "visit", visit: visit({}, { recurring_plan: { id: "p1" } }) },
			ctx
		);
		expect(m.fromPlan).toBe(true);
	});

	it("passes techs, stock warning and filter state through", () => {
		const m = toCardModel(
			{ kind: "visit", visit: visit() },
			{ techs: [ana], stockWarning: "low", isAllSelected: false }
		);
		expect(m.techs).toEqual([ana]);
		expect(m.stockWarning).toBe("low");
		expect(m.unassignedInFilter).toBe(false);
	});

	it("summarises everything in the aria-label", () => {
		expect(toCardModel({ kind: "visit", visit: visit() }, ctx).ariaLabel).toBe(
			"RTU Replacement, 9:00–11:00, Smith Co, 12 Elm St, J-0012, Ana Ortiz"
		);
		expect(
			toCardModel(
				{ kind: "visit", visit: visit({ status: "Delayed" }) },
				{ techs: [], stockWarning: "out", isAllSelected: true }
			).ariaLabel
		).toBe("RTU Replacement, 9:00–11:00, Delayed, Smith Co, 12 Elm St, J-0012, Unassigned, Stock out");
	});
});

describe("toCardModel — occurrences", () => {
	it("uses the job name, plan address and plan description, with no techs", () => {
		const m = toCardModel({ kind: "occurrence", occurrence: occurrence() }, ctx);
		expect(m.kind).toBe("occurrence");
		expect(m.fromPlan).toBe(true);
		expect(m.title).toBe("Oak Dental PM");
		expect(m.address).toBe("400 Oak Ave");
		expect(m.description).toBe("Filter swap");
		expect(m.techs).toEqual([]);
		expect(m.status).toBeUndefined();
		expect(m.ref).toBe("J-0040");
	});

	it("dedupes the plan client against the title", () => {
		expect(toCardModel({ kind: "occurrence", occurrence: occurrence() }, ctx).client).toBeUndefined();
	});

	it("names the occurrence as recurring and unassigned", () => {
		expect(toCardModel({ kind: "occurrence", occurrence: occurrence() }, ctx).ariaLabel).toBe(
			"Recurring, Oak Dental PM, Arrive 1–3 · open end, 400 Oak Ave, J-0040, Unassigned"
		);
	});
});

describe("buildConstraintView", () => {
	const timing = (fields: Partial<SnapshotTiming>): SnapshotTiming => ({
		start: at(13),
		end: at(17),
		arrival_constraint: "at",
		arrival_time: "13:00",
		finish_constraint: "at",
		finish_time: "17:00",
		...fields,
	});

	it("uses the neutral tone and a solid strip for at", () => {
		const v = buildConstraintView(timing({}), cardSpan({ start: at(13), end: at(17) }));
		expect(v.tone).toBe("neutral");
		expect(v.windowBand).toBeUndefined();
		expect(v.deadlineTick).toBeUndefined();
		expect(v.chip).toEqual({ column: "1:00–5:00", inline: "1:00", sliver: "1p" });
	});

	it("maps a between window to a fraction of the card", () => {
		const v = buildConstraintView(
			timing({ arrival_constraint: "between", arrival_window_start: "13:00", arrival_window_end: "15:00" }),
			cardSpan({ start: at(13), end: at(17) })
		);
		expect(v.tone).toBe("window");
		expect(v.windowBand).toEqual({ from: 0, to: 0.5 });
	});

	it("clips a window that runs past the card end", () => {
		const v = buildConstraintView(
			timing({ arrival_constraint: "between", arrival_window_start: "15:00", arrival_window_end: "19:00" }),
			cardSpan({ start: at(13), end: at(17) })
		);
		expect(v.windowBand).toEqual({ from: 0.5, to: 1 });
	});

	it("collapses a window entirely outside the card to zero length", () => {
		const v = buildConstraintView(
			timing({ arrival_constraint: "between", arrival_window_start: "18:00", arrival_window_end: "19:00" }),
			cardSpan({ start: at(13), end: at(17) })
		);
		expect(v.windowBand).toEqual({ from: 1, to: 1 });
	});

	it("ticks a by deadline only when it falls inside the card", () => {
		const inside = buildConstraintView(
			timing({ arrival_constraint: "by", arrival_window_end: "14:00" }),
			cardSpan({ start: at(13), end: at(17) })
		);
		expect(inside.deadlineTick).toBeCloseTo(0.25);
		const outside = buildConstraintView(
			timing({ arrival_constraint: "by", arrival_window_end: "18:00" }),
			cardSpan({ start: at(13), end: at(17) })
		);
		expect(outside.deadlineTick).toBeUndefined();
		expect(outside.tone).toBe("window");
	});

	it("carries the open-ended flag from the span", () => {
		const v = buildConstraintView(
			timing({ finish_constraint: "when_done" }),
			cardSpan({ start: at(13), end: at(15), finish_constraint: "when_done" })
		);
		expect(v.openEnded).toBe(true);
	});
});
