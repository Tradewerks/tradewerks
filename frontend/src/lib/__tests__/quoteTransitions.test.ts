import { describe, it, expect } from "vitest";
import { canTransitionQuote } from "../quoteTransitions";

/**
 * quoteTransitions.ts mirrors QUOTE_TRANSITIONS in
 * backend/src/lib/statusTransitions.ts. Parity is pinned on the backend side,
 * which reads THIS file as text and deep-equals it against the authoritative
 * table both directions (backend/src/lib/__tests__/quoteTransitionsParity.test.ts,
 * DW-21). These tests only cover the frontend helper's behaviour.
 */
describe("canTransitionQuote", () => {
	it("lets a rejected quote be superseded and nothing else", () => {
		expect(canTransitionQuote("Rejected", "Revised")).toBe(true);
		expect(canTransitionQuote("Rejected", "Sent")).toBe(false);
		expect(canTransitionQuote("Rejected", "Approved")).toBe(false);
	});

	it("treats a self-transition as a no-op", () => {
		expect(canTransitionQuote("Rejected", "Rejected")).toBe(true);
	});

	it("offers a dispute on a hand-delivered quote", () => {
		expect(canTransitionQuote("Issued", "Disputed")).toBe(true);
	});
});
