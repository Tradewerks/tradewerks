import { describe, it, expect, vi } from "vitest";
import { PRIMARY_SLOTS, splitActions } from "../overflow";
import type { LifecycleAction } from "../types";

const action = (over: Partial<LifecycleAction> = {}): LifecycleAction => ({
	id: "approve",
	label: "Approve",
	intent: "primary",
	disabled: false,
	onSelect: vi.fn(),
	...over,
});

/** The two placement rules splitActions owns. */
describe("splitActions", () => {
	it("puts destructive actions in the overflow whatever their position", () => {
		const kill = action({ id: "void", label: "Void", intent: "destructive" });
		const { inline, overflow } = splitActions("normal", [
			kill,
			action({ id: "send", label: "Email to Client" }),
		]);

		expect(inline).not.toContain(kill);
		expect(overflow).toContain(kill);
	});

	it("shows at most PRIMARY_SLOTS actions inline", () => {
		const actions = ["a", "b", "c", "d", "e"].map((id) => action({ id, label: id }));
		const { inline, overflow } = splitActions("normal", actions);

		expect(inline).toHaveLength(PRIMARY_SLOTS);
		expect(overflow).toHaveLength(actions.length - PRIMARY_SLOTS);
	});

	// Muscle memory: a button must not move as a document progresses.
	it("keeps a disabled action in its slot on the normal stage", () => {
		const revise = action({ id: "revise", label: "Create Revision" });
		const { inline, overflow } = splitActions("normal", [
			action({ id: "issue", disabled: true }),
			action({ id: "send", disabled: true }),
			action({ id: "approve", disabled: true }),
			revise,
		]);

		expect(inline.map((a) => a.id)).toEqual(["issue", "send", "approve"]);
		expect(overflow).toContain(revise);
	});

	// A document that has stopped progressing has no muscle memory to protect,
	// and the literal rule buried the one live action those stages exist for.
	it.each(["terminal", "dispute"] as const)(
		"promotes enabled actions on the %s stage",
		(stage) => {
			const revise = action({ id: "revise", label: "Create Revision" });
			const { inline } = splitActions(stage, [
				action({ id: "issue", disabled: true }),
				action({ id: "send", disabled: true }),
				action({ id: "approve", disabled: true }),
				revise,
			]);

			expect(inline[0]).toBe(revise);
		}
	);

	// Held back on every stage, a disputed quote whose only live action is Repeal
	// shows two dead inline buttons and hides its one exit in the kebab.
	it("keeps an enabled destructive action inline on the dispute stage", () => {
		const repeal = action({ id: "Repeal", label: "Repeal", intent: "destructive" });
		const { inline } = splitActions("dispute", [
			action({ id: "ReviseAndResend", disabled: true }),
			action({ id: "IssueAdjustment", disabled: true }),
			repeal,
		]);

		expect(inline).toContain(repeal);
	});

	it("still holds a destructive action back on the normal stage", () => {
		const kill = action({ id: "void", intent: "destructive" });
		const { inline, overflow } = splitActions("normal", [
			kill,
			action({ id: "send", label: "Email to Client" }),
		]);

		expect(inline).not.toContain(kill);
		expect(overflow).toContain(kill);
	});

	it("returns inline and overflow as an exact partition", () => {
		const actions = [
			action({ id: "a" }),
			action({ id: "b", intent: "destructive" }),
			action({ id: "c" }),
			action({ id: "d" }),
			action({ id: "e" }),
		];
		const { inline, overflow } = splitActions("normal", actions);

		expect([...inline, ...overflow]).toHaveLength(actions.length);
		expect(new Set([...inline, ...overflow]).size).toBe(actions.length);
	});
});

/**
 * `offRamp` lets a page say "off the happy path" on the `normal` stage. Without
 * it Rule 2 keeps the slots in catalog order, and a paused visit's Resume — the
 * one legal move, fifth in that order — ends up behind the kebab.
 */
describe("splitActions off-ramp flag", () => {
	// The paused-visit shape: three blocked steps ahead of the one live exit.
	it("promotes a live action ahead of blocked earlier ones when off the happy path", () => {
		const resume = action({ id: "resume", label: "Resume", intent: "primary" });
		const { inline } = splitActions(
			"normal",
			[
				action({ id: "drive", label: "Start Driving", disabled: true }),
				action({ id: "arrive", label: "Mark On Site", disabled: true }),
				action({ id: "start", label: "Start Work", disabled: true }),
				resume,
			],
			{ offRamp: true }
		);

		expect(inline).toContain(resume);
	});

	// Off-ramp only changes which group (live vs blocked) goes first; the
	// catalog's fixed order still decides within each group.
	it("preserves the fixed order within the live and blocked groups", () => {
		const actions = [
			action({ id: "drive", label: "Start Driving", disabled: true }),
			action({ id: "arrive", label: "Mark On Site", disabled: true }),
			action({ id: "start", label: "Start Work", disabled: true }),
			action({ id: "resume", label: "Resume", intent: "primary" }),
		];
		const { inline, overflow } = splitActions("normal", actions, { offRamp: true });

		expect(inline.map((a) => a.id)).toEqual(["resume", "drive", "arrive"]);
		expect(overflow.map((a) => a.id)).toEqual(["start"]);
	});

	// Rule 1 stays keyed on stage alone: a paused visit's Cancel Visit must
	// still be held back to the overflow, not pulled inline by the new flag.
	it("still holds a destructive action back on the normal stage when off the happy path", () => {
		const cancel = action({ id: "cancel", label: "Cancel Visit", intent: "destructive" });
		const resume = action({ id: "resume", label: "Resume", intent: "primary" });
		const { inline, overflow } = splitActions("normal", [cancel, resume], {
			offRamp: true,
		});

		expect(inline).not.toContain(cancel);
		expect(overflow).toContain(cancel);
	});

	// Quote and invoice never pass the flag, so the default must not shift.
	it("keeps the muscle-memory rule when the flag is omitted", () => {
		const revise = action({ id: "revise", label: "Create Revision" });
		const actions = [
			action({ id: "issue", disabled: true }),
			action({ id: "send", disabled: true }),
			action({ id: "approve", disabled: true }),
			revise,
		];

		expect(splitActions("normal", actions).inline.map((a) => a.id)).toEqual([
			"issue",
			"send",
			"approve",
		]);
		expect(splitActions("normal", actions, { offRamp: false }).inline.map((a) => a.id)).toEqual(
			["issue", "send", "approve"]
		);
	});
});
describe("splitActions hidden actions", () => {
	const make = (id: string, over: Partial<LifecycleAction> = {}): LifecycleAction => ({
		id,
		label: id,
		intent: "primary",
		disabled: false,
		onSelect: () => {},
		...over,
	});

	it("drops hidden actions from both the bar and the menu", () => {
		const { inline, overflow } = splitActions("normal", [
			make("pause"),
			make("resume", { disabled: true, hidden: true }),
			make("cancel", { intent: "destructive" }),
		]);

		expect(inline.map((a) => a.id)).toEqual(["pause"]);
		expect(overflow.map((a) => a.id)).toEqual(["cancel"]);
	});
});
