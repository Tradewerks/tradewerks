import { describe, it, expect, vi } from "vitest";
import { placeActions } from "../placement";
import type { LifecycleAction } from "../types";

const action = (over: Partial<LifecycleAction> = {}): LifecycleAction => ({
	id: "approve",
	label: "Approve",
	intent: "primary",
	disabled: false,
	onSelect: vi.fn(),
	...over,
});

/**
 * Where a lifecycle action is rendered, as opposed to whether it is inline at
 * all — that second question is splitActions', and this defers to it.
 */
describe("placeActions", () => {
	it("puts inline actions in the header on the happy path", () => {
		const send = action({ id: "send", label: "Email to Client" });
		const p = placeActions("normal", [send]);

		expect(p.headerActions).toEqual([send]);
		expect(p.barActions).toEqual([]);
	});

	it("draws no bar on the happy path", () => {
		expect(placeActions("normal", [action()]).showBar).toBe(false);
	});

	it("draws no bar for an off-ramp either: the status pill already names it", () => {
		const p = placeActions("normal", [action()], { offRamp: true });

		expect(p.showBar).toBe(false);
		expect(p.headerActions).toHaveLength(1);
	});

	it("keeps dispute actions in the bar, beside the reason they answer", () => {
		const uphold = action({ id: "uphold", label: "Uphold Quote" });
		const p = placeActions("dispute", [uphold]);

		expect(p.barActions).toEqual([uphold]);
		expect(p.headerActions).toEqual([]);
		expect(p.showBar).toBe(true);
	});

	it("keeps terminal actions in the bar", () => {
		const revise = action({ id: "revise", label: "Create Revision" });
		const p = placeActions("terminal", [revise]);

		expect(p.barActions).toEqual([revise]);
		expect(p.headerActions).toEqual([]);
		expect(p.showBar).toBe(true);
	});

	it("shows the bar on a terminal stage even with nothing left to do", () => {
		// The terminal reason is the point of the band, not the buttons.
		expect(placeActions("terminal", []).showBar).toBe(true);
	});

	it("hands overflow through untouched", () => {
		const many = [
			action({ id: "a" }),
			action({ id: "b" }),
			action({ id: "c" }),
			action({ id: "d" }),
		];

		expect(placeActions("normal", many).overflow.map((a) => a.id)).toEqual(["d"]);
	});

	it("passes offRamp through to splitActions so the live exit is promoted", () => {
		const blocked = action({ id: "start", label: "Start Work", disabled: true });
		const resume = action({ id: "resume", label: "Resume" });
		const p = placeActions("normal", [blocked, resume], { offRamp: true });

		// Rule 2 inverts off the happy path: live actions take the slots.
		expect(p.headerActions[0]).toBe(resume);
	});
});
