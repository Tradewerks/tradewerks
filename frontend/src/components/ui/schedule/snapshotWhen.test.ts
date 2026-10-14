import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { constraintChip, snapshotWhen, type SnapshotTiming } from "./snapshotWhen";

const originalTZ = process.env.TZ;
beforeAll(() => {
	process.env.TZ = "America/Chicago";
});
afterAll(() => {
	process.env.TZ = originalTZ;
});

// 09:00 Chicago (CDT) — also what the backend stores for anytime occurrences.
const base: SnapshotTiming = {
	start: "2026-09-29T14:00:00.000Z",
	end: "2026-09-29T16:00:00.000Z",
	arrival_constraint: "at",
	arrival_time: "09:00",
	finish_constraint: "at",
	finish_time: "11:00",
};

describe("snapshotWhen", () => {
	it("formats the local date", () => {
		expect(snapshotWhen(base).date).toBe("Tue, Sep 29");
	});

	it("collapses a shared period in a fixed range", () => {
		expect(snapshotWhen(base).time).toBe("9:00 – 11:00 AM");
	});

	it("keeps both periods when the range crosses noon", () => {
		expect(snapshotWhen({ ...base, arrival_time: "11:00", finish_time: "13:30" }).time).toBe(
			"11:00 AM – 1:30 PM"
		);
	});

	it("labels an arrival window", () => {
		const t = snapshotWhen({
			...base,
			arrival_constraint: "between",
			arrival_window_start: "09:00",
			arrival_window_end: "11:00",
			finish_constraint: "when_done",
		});
		expect(t.time).toBe("Arrive 9:00 – 11:00 AM · until done");
	});

	it("labels an arrival deadline", () => {
		const t = snapshotWhen({
			...base,
			arrival_constraint: "by",
			arrival_window_end: "11:00",
			finish_constraint: "when_done",
		});
		expect(t.time).toBe("Arrive by 11:00 AM · until done");
	});

	it("never prints the stored 09:00 for anytime", () => {
		const t = snapshotWhen({ ...base, arrival_constraint: "anytime", finish_constraint: "when_done" });
		expect(t.time).toBe("Anytime · until done");
	});

	it("keeps a finish deadline distinct from a fixed end", () => {
		expect(snapshotWhen({ ...base, finish_constraint: "by" }).time).toBe(
			"9:00 AM · done by 11:00 AM"
		);
		expect(
			snapshotWhen({ ...base, arrival_constraint: "anytime", finish_time: "15:00" }).time
		).toBe("Anytime · ends 3:00 PM");
	});

	it("does not invent a deadline from the synthetic start", () => {
		const t = snapshotWhen({
			...base,
			arrival_constraint: "by",
			arrival_window_end: null,
			finish_constraint: "when_done",
		});
		expect(t.time).toBe("Arrival deadline not set · until done");
	});

	it("appends a finish deadline to a non-fixed arrival", () => {
		const t = snapshotWhen({
			...base,
			arrival_constraint: "anytime",
			finish_constraint: "by",
			finish_time: "15:00",
		});
		expect(t.time).toBe("Anytime · done by 3:00 PM");
	});

	it("marks a fixed start that finishes when done", () => {
		expect(snapshotWhen({ ...base, finish_constraint: "when_done" }).time).toBe(
			"9:00 AM · until done"
		);
	});

	it("falls back to the stored instants when constraint times are missing", () => {
		const t = snapshotWhen({ ...base, arrival_time: null, finish_time: null });
		expect(t.time).toBe("9:00 – 11:00 AM");
	});
});

describe("constraintChip", () => {
	const modes = (t: SnapshotTiming) => [
		constraintChip(t, "column"),
		constraintChip(t, "inline"),
		constraintChip(t, "sliver"),
	];

	it("at + at", () => {
		expect(modes(base)).toEqual(["9:00–11:00", "9:00", "9a"]);
	});

	it("at + by", () => {
		expect(constraintChip({ ...base, finish_constraint: "by" }, "column")).toBe(
			"9:00 · done by 11:00"
		);
	});

	it("at + when_done", () => {
		expect(modes({ ...base, finish_constraint: "when_done" })).toEqual([
			"9:00 · open end",
			"9:00",
			"9a",
		]);
	});

	it("between + when_done", () => {
		expect(
			modes({
				...base,
				arrival_constraint: "between",
				arrival_window_start: "08:00",
				arrival_window_end: "10:00",
				finish_constraint: "when_done",
			})
		).toEqual(["Arrive 8–10 · open end", "8–10", "8a ◆"]);
	});

	it("between keeps minutes and appends a fixed finish", () => {
		expect(
			constraintChip(
				{
					...base,
					arrival_constraint: "between",
					arrival_window_start: "08:30",
					arrival_window_end: "10:00",
					finish_constraint: "at",
					finish_time: "12:00",
				},
				"column"
			)
		).toBe("Arrive 8:30–10 · ends 12:00");
	});

	it("by + when_done", () => {
		expect(
			modes({
				...base,
				arrival_constraint: "by",
				arrival_window_end: "12:00",
				finish_constraint: "when_done",
			})
		).toEqual(["by 12:00 · open end", "by 12", "◆"]);
	});

	it("by + by", () => {
		const t = {
			...base,
			arrival_constraint: "by",
			arrival_window_end: "12:30",
			finish_constraint: "by",
			finish_time: "15:00",
		};
		expect(constraintChip(t, "column")).toBe("by 12:30 · done by 3:00");
		expect(constraintChip(t, "inline")).toBe("by 12:30");
	});

	it("does not invent a by deadline", () => {
		expect(
			modes({
				...base,
				arrival_constraint: "by",
				arrival_window_end: null,
				finish_constraint: "when_done",
			})
		).toEqual(["Deadline not set · open end", "by —", "◆"]);
	});

	it("returns nothing for anytime (it lives in the Anytime lane)", () => {
		expect(modes({ ...base, arrival_constraint: "anytime" })).toEqual(["", "", ""]);
	});

	it("marks afternoon in the sliver", () => {
		expect(constraintChip({ ...base, arrival_time: "13:30" }, "sliver")).toBe("1:30p");
	});

	it("falls back to the stored instants when constraint times are missing", () => {
		expect(constraintChip({ ...base, arrival_time: null, finish_time: null }, "column")).toBe(
			"9:00–11:00"
		);
	});
});
