import { describe, it, expect } from "vitest";
import {
	agendaCountLabel,
	agendaSignature,
	buildAgendaRows,
	countAgenda,
	nowRuleIndex,
	railTimeFromMs,
	whoLabel,
	type AgendaEntry,
} from "./agendaRows";
import type { AgendaGroup, OccurrenceWithPlan, VisitWithJob } from "./dashboardCalendarUtils";

function visit(id: string, hhmm: string | null, techIds: string[] = []): AgendaEntry {
	const [h, m] = (hhmm ?? "00:00").split(":").map(Number);
	return {
		type: "visit",
		item: {
			id,
			arrival_constraint: hhmm ? "at" : "anytime",
			arrival_time: hhmm,
			scheduled_start_at: new Date(2026, 8, 29, h, m).toISOString(),
			visit_techs: techIds.map((tech_id) => ({ tech_id })),
		} as unknown as VisitWithJob,
	};
}

function occ(
	id: string,
	h: number,
	m: number,
	arrival_constraint?: "anytime" | "at"
): AgendaEntry {
	return {
		type: "occ",
		item: {
			id,
			arrival_constraint,
			occurrence_start_at: new Date(2026, 8, 29, h, m).toISOString(),
		} as unknown as OccurrenceWithPlan,
	};
}

describe("railTimeFromMs", () => {
	const ms = (h: number, m: number) => new Date(2026, 8, 29, h, m).getTime();

	it("formats local time as h:mm plus am/pm, independent of locale", () => {
		expect(railTimeFromMs(ms(7, 0))).toEqual({ time: "7:00", suffix: "am" });
		expect(railTimeFromMs(ms(13, 5))).toEqual({ time: "1:05", suffix: "pm" });
	});

	it("maps midnight and noon hours to 12", () => {
		expect(railTimeFromMs(ms(0, 30))).toEqual({ time: "12:30", suffix: "am" });
		expect(railTimeFromMs(ms(12, 0))).toEqual({ time: "12:00", suffix: "pm" });
	});
});

describe("buildAgendaRows", () => {
	it("puts Anytime rows first and labels them without a clock time", () => {
		const rows = buildAgendaRows([visit("a", "07:00"), visit("b", null)], "all");
		expect(rows.map((r) => r.entry.item.id)).toEqual(["b", "a"]);
		expect(rows[0]).toMatchObject({ anytime: true, time: "", suffix: "", showTime: true });
		expect(rows[1]).toMatchObject({ anytime: false, time: "7:00", suffix: "am" });
	});

	it("prints a repeated start time once", () => {
		const rows = buildAgendaRows(
			[visit("a", "08:00"), visit("b", "08:00"), visit("c", "09:00")],
			"all"
		);
		expect(rows.map((r) => r.showTime)).toEqual([true, false, true]);
		expect(rows[1].time).toBe("8:00");
	});

	it("treats an anytime occurrence (stored at 09:00) as Anytime", () => {
		const rows = buildAgendaRows([occ("o1", 14, 30, "at"), occ("o2", 9, 0, "anytime")], "all");
		expect(rows.map((r) => [r.entry.item.id, r.anytime])).toEqual([
			["o2", true],
			["o1", false],
		]);
		expect(rows[0]).toMatchObject({ time: "", suffix: "" });
		expect(rows[1]).toMatchObject({ time: "2:30", suffix: "pm" });
	});

	it("falls back to a midnight check when an occurrence has no arrival constraint", () => {
		const rows = buildAgendaRows([occ("o1", 14, 30), occ("o2", 0, 0)], "all");
		expect(rows.map((r) => [r.entry.item.id, r.anytime])).toEqual([
			["o2", true],
			["o1", false],
		]);
	});

	it("labels a 'by' visit with the instant it sorts by, not its deadline", () => {
		const by = {
			type: "visit",
			item: {
				id: "by",
				arrival_constraint: "by",
				arrival_time: null,
				arrival_window_end: "13:00",
				scheduled_start_at: new Date(2026, 8, 29, 9, 0).toISOString(),
				visit_techs: [],
			} as unknown as VisitWithJob,
		} as AgendaEntry;
		const rows = buildAgendaRows([by, visit("a", "10:00")], "all");
		expect(rows[0]).toMatchObject({ time: "9:00", suffix: "am", anytime: false });
		expect(nowRuleIndex(rows, new Date(2026, 8, 29, 9, 30).getTime())).toBe(1);
	});

	it("keys rows by prefix, type and id", () => {
		expect(buildAgendaRows([visit("a", "07:00")], "tech-1")[0].key).toBe("tech-1:visit:a");
	});
});

describe("nowRuleIndex", () => {
	const at = (h: number, m: number) => new Date(2026, 8, 29, h, m).getTime();
	const rows = buildAgendaRows(
		[visit("any", null), visit("a", "08:00"), visit("b", "09:30"), visit("c", "11:00")],
		"all"
	);

	it("sits after Anytime rows, before the first timed row, early in the day", () => {
		expect(nowRuleIndex(rows, at(7, 0))).toBe(1);
	});

	it("sits after the last started row", () => {
		expect(nowRuleIndex(rows, at(10, 15))).toBe(3);
	});

	it("counts a row starting exactly now as started", () => {
		expect(nowRuleIndex(rows, at(9, 30))).toBe(3);
	});

	it("sits after every row once the day is done", () => {
		expect(nowRuleIndex(rows, at(18, 0))).toBe(4);
	});

	it("is null when no row has a clock time", () => {
		expect(nowRuleIndex(buildAgendaRows([visit("any", null)], "all"), at(10, 0))).toBeNull();
	});
});

describe("whoLabel", () => {
	it("names a single tech in full", () => {
		expect(whoLabel(["Maria Rodriguez"])).toBe("Maria Rodriguez");
	});
	it("shortens two techs to first name and initial", () => {
		expect(whoLabel(["John Smith", "Maria Rodriguez"])).toBe("John S., Maria R.");
	});
	it("keeps a one-word name whole when shortening", () => {
		expect(whoLabel(["Cher", "John Smith"])).toBe("Cher, John S.");
	});
	it("counts three or more", () => {
		expect(whoLabel(["A B", "C D", "E F"])).toBe("3 techs");
	});
	it("says Unassigned for none", () => {
		expect(whoLabel([])).toBe("Unassigned");
	});
});

describe("countAgenda", () => {
	it("counts a multi-tech visit once across tech groups", () => {
		const shared = visit("v1", "08:00", ["t1", "t2"]);
		const groups = [
			{ techId: "t1", techName: "A", color: "", items: [shared] },
			{ techId: "t2", techName: "B", color: "", items: [shared, occ("o1", 9, 0)] },
		] as AgendaGroup[];
		expect(countAgenda(groups)).toEqual({ visits: 1, occs: 1 });
	});
});

describe("agendaCountLabel", () => {
	it("pluralises and separates recurring", () => {
		expect(agendaCountLabel(0, 0)).toBe("No visits");
		expect(agendaCountLabel(1, 0)).toBe("1 visit");
		expect(agendaCountLabel(8, 0)).toBe("8 visits");
		expect(agendaCountLabel(8, 2)).toBe("8 visits, 2 recurring");
		expect(agendaCountLabel(0, 2)).toBe("2 recurring");
	});
});

describe("agendaSignature", () => {
	const groups = (ids: string[]): AgendaGroup[] => [
		{ techId: "__all__", techName: "", color: "", items: ids.map((id) => visit(id, "08:00")) },
	];

	it("is stable for the same rows", () => {
		expect(agendaSignature(groups(["a", "b"]), "time", true)).toBe(
			agendaSignature(groups(["a", "b"]), "time", true)
		);
	});

	it("changes when a row is added, the sort changes, or the now rule toggles", () => {
		const base = agendaSignature(groups(["a", "b"]), "time", true);
		expect(agendaSignature(groups(["a", "b", "c"]), "time", true)).not.toBe(base);
		expect(agendaSignature(groups(["a", "b"]), "tech", true)).not.toBe(base);
		expect(agendaSignature(groups(["a", "b"]), "time", false)).not.toBe(base);
	});
});
