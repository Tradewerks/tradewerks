import { describe, expect, it } from "vitest";
import { shouldOpenRow } from "../rowOpen";

const target = (tag = "td") => document.createElement(tag);
const ev = (over: Record<string, unknown> = {}) =>
	({
		button: 0,
		metaKey: false,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		target: target(),
		...over,
	}) as never;

describe("shouldOpenRow", () => {
	it("opens on a plain primary click", () => {
		expect(shouldOpenRow(ev(), "")).toBe(true);
	});
	it("ignores modified and non-primary clicks", () => {
		for (const over of [
			{ button: 1 },
			{ metaKey: true },
			{ ctrlKey: true },
			{ shiftKey: true },
			{ altKey: true },
		])
			expect(shouldOpenRow(ev(over), "")).toBe(false);
	});
	it("ignores clicks on links, buttons, inputs and labels", () => {
		for (const tag of ["a", "button", "input", "label"])
			expect(shouldOpenRow(ev({ target: target(tag) }), "")).toBe(false);
	});
	it("does not navigate while text is selected", () => {
		expect(shouldOpenRow(ev(), "Acme Heating")).toBe(false);
	});
});
