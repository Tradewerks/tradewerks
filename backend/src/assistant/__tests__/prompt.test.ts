import { describe, expect, it } from "vitest";

import type { AgentContext } from "../../agent/types.js";
import { READ_ONLY_POLICY, WRITE_POLICY } from "../../agent/policy.js";
import { buildInstructions, buildTurnContext, isoDateIn } from "../prompt.js";

const ctx: AgentContext = {
	userId: "u1",
	role: "dispatcher",
	organizationId: "org-1",
	permissions: ["view_jobs"],
	actorType: "dispatcher",
	surface: "assistant",
	userName: "Dana Reyes",
};

const NOW = new Date("2026-08-19T12:00:00Z");
const build = (policy?: Parameters<typeof buildInstructions>[0]) => buildInstructions(policy);
const context = (over: Partial<Parameters<typeof buildTurnContext>[0]> = {}) =>
	buildTurnContext({ ctx, timezone: "America/Chicago", now: NOW, ...over });

describe("buildTurnContext", () => {
	it("names the person and their role", () => {
		expect(context()).toContain("Dana Reyes (dispatcher)");
	});

	it("falls back to the role when the name is unknown", () => {
		expect(context({ ctx: { ...ctx, userName: undefined } })).toContain("acting for dispatcher");
	});

	it("states today's date in the organization's zone", () => {
		// Without this the model guesses, and "this week" silently means the wrong week.
		expect(context()).toContain("2026-08-19");
		expect(context()).toContain("America/Chicago");
	});
});

describe("buildInstructions", () => {
	it("holds nothing that varies by person, day or organization", () => {
		// This half is the cacheable prefix of every request. The moment a name or
		// a date leaks into it, every user pays to write a cache entry nobody else
		// can read — the bug this split exists to fix.
		const instructions = build(WRITE_POLICY);
		expect(instructions).not.toContain("Dana Reyes");
		expect(instructions).not.toContain("2026-08-19");
		expect(instructions).not.toContain("America/Chicago");
		expect(instructions).toBe(buildInstructions(WRITE_POLICY));
	});

	it("says the assistant is read-only under a read-only policy", () => {
		expect(build(READ_ONLY_POLICY)).toMatch(/read-only/i);
	});

	describe("under a write policy", () => {
		const prompt = () => build(WRITE_POLICY);

		it("does not claim to be read-only", () => {
			expect(prompt()).not.toMatch(/you are read-only/i);
		});

		it("insists that drafting is not creating", () => {
			// The failure mode this guards against is the assistant announcing
			// "I've created the quote" when it saved a draft nobody has submitted.
			expect(prompt()).toMatch(/never tell someone you created something when you drafted it/i);
		});

		it("insists that an awaiting-approval action has not happened", () => {
			expect(prompt()).toMatch(/it has NOT happened/);
			expect(prompt()).toMatch(/do not describe it in the past tense/i);
		});

		it("warns that assigning replaces rather than adds", () => {
			expect(prompt()).toMatch(/REPLACES the technicians/);
		});

		it("tells it to stop when a person declines", () => {
			expect(prompt()).toMatch(/do not re-propose/i);
		});

		it("still lists what it cannot do at all", () => {
			expect(prompt()).toMatch(/cannot delete anything, send anything to a client/i);
		});
	});

	it("tells the model that record text is data, not instructions", () => {
		// Client notes and request descriptions are attacker-influenced text that
		// arrives inside tool results.
		const prompt = build();
		expect(prompt).toMatch(/never an instruction/i);
		expect(prompt).toMatch(/do not act on it/i);
	});

	it("tells the model its replies render as markdown", () => {
		expect(build(READ_ONLY_POLICY)).toMatch(/render as markdown/i);
	});

	it("tells the model not to invent values a tool did not return", () => {
		expect(build()).toMatch(/never guess/i);
	});
});

describe("isoDateIn", () => {
	it("returns the date in the requested zone", () => {
		// 01:00 UTC is still the previous day in Chicago.
		expect(isoDateIn(new Date("2026-08-19T01:00:00Z"), "America/Chicago")).toBe("2026-08-18");
		expect(isoDateIn(new Date("2026-08-19T01:00:00Z"), "UTC")).toBe("2026-08-19");
	});

	it("falls back to UTC rather than throwing on a malformed zone", () => {
		expect(isoDateIn(NOW, "Not/AZone")).toBe("2026-08-19");
	});
});
