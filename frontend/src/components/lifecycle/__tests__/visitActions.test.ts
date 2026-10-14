import { describe, it, expect } from "vitest";
import {
	visitActions,
	VISIT_STEPS,
	isVisitOffRamp,
	isVisitTerminal,
	isVisitNonTerminalOffRamp,
	VISIT_TERMINAL,
} from "../visitActions";
import { splitActions } from "../overflow";
import { VisitStatusValues } from "../../../types/jobs";
import type { VisitStatus } from "../../../types/jobs";

const noop = () => {};
const handlers = {
	drive: noop,
	arrive: noop,
	start: noop,
	pause: noop,
	resume: noop,
	complete: noop,
	delay: noop,
	cancel: noop,
};

const ctx = (over: Record<string, unknown> = {}) => ({
	status: "Scheduled" as VisitStatus,
	canUpdateStatus: true,
	handlers,
	...over,
});

describe("visit path", () => {
	it("keeps the five happy-path steps in order", () => {
		expect(VISIT_STEPS).toEqual([
			"Scheduled",
			"Driving",
			"OnSite",
			"InProgress",
			"Completed",
		]);
	});

	it("treats the three interruption states as off-ramps", () => {
		expect(isVisitOffRamp("Paused")).toBe(true);
		expect(isVisitOffRamp("Delayed")).toBe(true);
		expect(isVisitOffRamp("Cancelled")).toBe(true);
		expect(isVisitOffRamp("OnSite")).toBe(false);
	});
});

describe("visitActions", () => {
	it("offers the same actions in the same order in every status", () => {
		const ids = visitActions(ctx()).map((a) => a.id);
		expect(ids).toEqual([
			"drive",
			"arrive",
			"start",
			"pause",
			"resume",
			"delay",
			"complete",
			"cancel",
		]);

		for (const status of VisitStatusValues) {
			expect(visitActions(ctx({ status })).map((a) => a.id)).toEqual(ids);
		}
	});

	it("gives every disabled action a reason, in every status", () => {
		for (const status of VisitStatusValues) {
			for (const a of visitActions(ctx({ status }))) {
				if (a.disabled) {
					expect(a.disabledReason, `${status}/${a.id}`).toBeTruthy();
				}
			}
		}
	});

	it("never puts the destructive action in the visible row", () => {
		for (const status of VisitStatusValues) {
			const { inline } = splitActions("normal", visitActions(ctx({ status })));
			expect(inline.some((a) => a.intent === "destructive")).toBe(false);
		}
	});

	it("enables exactly the verbs the backend from-sets allow", () => {
		const enabled = (status: VisitStatus) =>
			visitActions(ctx({ status }))
				.filter((a) => !a.disabled)
				.map((a) => a.id)
				.sort();

		expect(enabled("Scheduled")).toEqual(["cancel", "delay", "drive"]);
		expect(enabled("Driving")).toEqual(["arrive", "cancel", "delay"]);
		expect(enabled("Paused")).toEqual(["cancel", "complete", "resume"]);
	});

	/**
	 * Resume from Paused is the whole point of the paused off-ramp stage: the
	 * bar's visible row must be able to carry it, so it cannot be disabled
	 * there for any reason other than permission.
	 */
	it("keeps Resume live on a paused visit", () => {
		const resume = visitActions(ctx({ status: "Paused" })).find(
			(a) => a.id === "resume"
		);
		expect(resume?.disabled).toBe(false);
	});

	it("names the states an action is reachable from", () => {
		const start = visitActions(ctx({ status: "Scheduled" })).find(
			(a) => a.id === "start"
		);
		expect(start?.disabledReason).toMatch(/on site/i);
	});

	it("refuses everything without update_visit_status", () => {
		for (const a of visitActions(ctx({ canUpdateStatus: false }))) {
			expect(a.disabled).toBe(true);
			expect(a.disabledReason).toMatch(/permission/i);
		}
	});
});

describe("visit terminal vs off-ramp", () => {
	/**
	 * Paused and Delayed are return trips with live exits (Resume, and Drive
	 * from Delayed), so a stage derived from isVisitOffRamp would render a visit
	 * paused for lunch as one that ended.
	 */
	it("treats only Cancelled as terminal", () => {
		expect(isVisitTerminal("Cancelled")).toBe(true);
		expect(isVisitTerminal("Paused")).toBe(false);
		expect(isVisitTerminal("Delayed")).toBe(false);
		expect(isVisitTerminal("InProgress")).toBe(false);
	});

	it("keeps Paused and Delayed off-ramps", () => {
		expect(isVisitOffRamp("Paused")).toBe(true);
		expect(isVisitOffRamp("Delayed")).toBe(true);
	});

	it("makes every terminal status an off-ramp too", () => {
		for (const status of VISIT_TERMINAL) {
			expect(isVisitOffRamp(status)).toBe(true);
		}
	});
});

describe("isVisitNonTerminalOffRamp", () => {
	// The set the pages gate on: off the happy path, live exit still in the row.
	// Tabled over every status so a new one can't drift the predicate silently.
	it("accepts exactly the non-terminal off-ramps and rejects everything else", () => {
		for (const status of VisitStatusValues) {
			const expected = status === "Paused" || status === "Delayed";
			expect(isVisitNonTerminalOffRamp(status)).toBe(expected);
		}
	});
});
