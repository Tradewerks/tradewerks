import { describe, it, expect } from "vitest";
import { canTransitionRequest, isRequestTerminal } from "../requestTransitions";

describe("canTransitionRequest", () => {
	it("allows the happy path", () => {
		expect(canTransitionRequest("New", "Reviewing")).toBe(true);
		expect(canTransitionRequest("Reviewing", "Quoted")).toBe(true);
		expect(canTransitionRequest("Quoted", "QuoteApproved")).toBe(true);
		expect(canTransitionRequest("QuoteApproved", "ConvertedToJob")).toBe(true);
	});

	it("allows the backward steps the backend allows", () => {
		expect(canTransitionRequest("Reviewing", "New")).toBe(true);
		expect(canTransitionRequest("QuoteRejected", "Quoted")).toBe(true);
	});

	it("refuses a jump the backend refuses", () => {
		expect(canTransitionRequest("New", "ConvertedToJob")).toBe(false);
		expect(canTransitionRequest("Quoted", "Cancelled")).toBe(false);
	});

	/**
	 * The backend table gives these empty lists, so a self-transition is not
	 * silently legal the way canTransitionQuote treats one.
	 */
	it("treats the two dead ends as terminal", () => {
		expect(isRequestTerminal("ConvertedToJob")).toBe(true);
		expect(isRequestTerminal("Cancelled")).toBe(true);
		expect(isRequestTerminal("QuoteRejected")).toBe(false);
	});
});
