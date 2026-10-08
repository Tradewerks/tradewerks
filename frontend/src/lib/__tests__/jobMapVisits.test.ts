import { describe, expect, test } from "vitest";
import { defaultSelectedVisitIds, isActiveVisit, isClosedVisit } from "../jobMapVisits";
import type { JobVisit, VisitStatus } from "../../types/jobs";

// Local-time constructors so "today" matches localDateKey in any runner timezone.
const NOW = new Date(2026, 9, 1, 12, 0);
const at = (month: number, day: number, hour: number) =>
	new Date(2026, month, day, hour, 0).toISOString();

function visit(id: string, status: VisitStatus, start: string): JobVisit {
	return { id, status, scheduled_start_at: start, visit_techs: [] } as unknown as JobVisit;
}

describe("isActiveVisit", () => {
	test.each<[VisitStatus, boolean]>([
		["Driving", true],
		["OnSite", true],
		["InProgress", true],
		["Paused", true],
		["Scheduled", false],
		["Delayed", false],
		["Completed", false],
		["Cancelled", false],
	])("%s → %s", (status, expected) => expect(isActiveVisit({ status })).toBe(expected));
});

describe("isClosedVisit", () => {
	test.each<[VisitStatus, boolean]>([
		["Driving", false],
		["OnSite", false],
		["InProgress", false],
		["Paused", false],
		["Scheduled", false],
		["Delayed", false],
		["Completed", true],
		["Cancelled", true],
	])("%s → %s", (status, expected) => expect(isClosedVisit({ status })).toBe(expected));
});

describe("defaultSelectedVisitIds", () => {
	test("active visits are selected even if they started on an earlier day", () => {
		const ids = defaultSelectedVisitIds([visit("a", "Paused", at(8, 29, 9))], NOW);
		expect(ids).toEqual(["a"]);
	});

	test("today's open visits are selected; today's closed ones are not", () => {
		const ids = defaultSelectedVisitIds(
			[
				visit("s", "Scheduled", at(9, 1, 15)),
				visit("c", "Completed", at(9, 1, 8)),
				visit("x", "Cancelled", at(9, 1, 10)),
				visit("f", "Scheduled", at(9, 5, 9)),
			],
			NOW,
		);
		expect(ids).toEqual(["s"]);
	});

	test("with nothing current, falls back to the next upcoming visit only", () => {
		const ids = defaultSelectedVisitIds(
			[
				visit("later", "Scheduled", at(9, 9, 9)),
				visit("soon", "Delayed", at(9, 3, 9)),
				visit("past", "Completed", at(8, 20, 9)),
			],
			NOW,
		);
		expect(ids).toEqual(["soon"]);
	});

	test("nothing current or upcoming selects nothing", () => {
		expect(defaultSelectedVisitIds([visit("done", "Completed", at(9, 1, 8))], NOW)).toEqual(
			[],
		);
		expect(defaultSelectedVisitIds([], NOW)).toEqual([]);
	});
});
