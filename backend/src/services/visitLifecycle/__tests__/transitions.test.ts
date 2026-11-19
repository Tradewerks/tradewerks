import { describe, it, expect } from "vitest";
import {
	VISIT_TRANSITIONS,
	HTTP_TRANSITION_ACTIONS,
	OPEN_VISIT_STATUSES,
	ACTIVE_VISIT_STATUSES,
	NEEDS_TECH,
	actorOf,
	checkTransition,
	actionForStatusChange,
	type VisitAction,
} from "../transitions.js";

describe("VISIT_TRANSITIONS", () => {
	it("no action's from-set contains its own to-state", () => {
		for (const [action, edge] of Object.entries(VISIT_TRANSITIONS)) {
			expect(edge.from, action).not.toContain(edge.to);
		}
	});

	it("Completed has no edge to Cancelled", () => {
		const r = checkTransition("cancel", "Completed", "dispatcher");
		expect(r).toEqual({
			ok: false,
			code: "WRONG_STATE",
			reason: 'Cannot cancel a visit with status "Completed". Expected one of: Scheduled, Delayed, Driving, OnSite, InProgress, Paused.',
		});
	});

	it.each<VisitAction>([
		"cancel",
		"delay",
		"restore",
		"reopen",
		"record_complete",
	])("technicians cannot %s", (action) => {
		const from = VISIT_TRANSITIONS[action].from[0];
		const r = checkTransition(action, from, "technician");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("FORBIDDEN");
	});

	it("technicians cannot cancel, delay, restore, reopen or record_complete", () => {
		for (const action of [
			"cancel",
			"delay",
			"restore",
			"reopen",
			"record_complete",
		] as const) {
			expect(VISIT_TRANSITIONS[action].actors).not.toContain(
				"technician",
			);
		}
	});

	it("only the system can recall", () => {
		expect(checkTransition("recall", "Driving", "system")).toEqual({
			ok: true,
			to: "Scheduled",
		});
		expect(checkTransition("recall", "Driving", "dispatcher").ok).toBe(
			false,
		);
	});

	it("allows a valid edge", () => {
		expect(checkTransition("drive", "Delayed", "technician")).toEqual({
			ok: true,
			to: "Driving",
		});
		expect(checkTransition("reopen", "Completed", "dispatcher")).toEqual({
			ok: true,
			to: "InProgress",
		});
	});

	it("checks the actor before the state", () => {
		const r = checkTransition("reopen", "Scheduled", "technician");
		expect(r.ok === false && r.code).toBe("FORBIDDEN");
	});

	it("exposes the HTTP action allow-list", () => {
		expect([...HTTP_TRANSITION_ACTIONS].sort()).toEqual(
			[
				"drive",
				"arrive",
				"start",
				"pause",
				"resume",
				"complete",
				"delay",
				"restore",
			].sort(),
		);
	});

	it("defines the status sets", () => {
		expect([...OPEN_VISIT_STATUSES].sort()).toEqual(
			[
				"Scheduled",
				"Delayed",
				"Driving",
				"OnSite",
				"InProgress",
				"Paused",
			].sort(),
		);
		expect([...ACTIVE_VISIT_STATUSES].sort()).toEqual(
			["Delayed", "Driving", "OnSite", "InProgress", "Paused"].sort(),
		);
		expect([...NEEDS_TECH].sort()).toEqual(
			["Driving", "OnSite", "InProgress", "Paused", "Completed"].sort(),
		);
	});
});

describe("actorOf", () => {
	it("maps the context to an actor", () => {
		expect(actorOf({ techId: "t" })).toBe("technician");
		expect(actorOf({ dispatcherId: "d" })).toBe("dispatcher");
		expect(actorOf({})).toBe("system");
		expect(actorOf()).toBe("system");
	});
});

describe("actionForStatusChange", () => {
	it("maps a PUT Scheduled→Completed by a dispatcher to record_complete and InProgress→Completed to complete", () => {
		expect(
			actionForStatusChange("Scheduled", "Completed", "dispatcher"),
		).toBe("record_complete");
		expect(
			actionForStatusChange("InProgress", "Completed", "dispatcher"),
		).toBe("complete");
	});

	it("maps a PUT with no edge to null", () => {
		expect(
			actionForStatusChange("Completed", "Scheduled", "dispatcher"),
		).toBeNull();
	});

	it("returns null when the only edge belongs to another actor", () => {
		expect(
			actionForStatusChange("Scheduled", "Completed", "technician"),
		).toBeNull();
		expect(
			actionForStatusChange("Driving", "Scheduled", "dispatcher"),
		).toBeNull();
	});

	it("maps the remaining PUT edges", () => {
		expect(
			actionForStatusChange("Delayed", "Scheduled", "dispatcher"),
		).toBe("undelay");
		expect(actionForStatusChange("Driving", "Scheduled", "system")).toBe(
			"recall",
		);
		expect(actionForStatusChange("Paused", "Cancelled", "dispatcher")).toBe(
			"cancel",
		);
	});
});
