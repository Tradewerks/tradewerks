import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
	process.env.POSTMARK_FROM_EMAIL ||= "test@example.com";
	process.env.POSTMARK_API_KEY ||= "test-key";
});

import { fmtDate } from "../emailService.js";

describe("emailService fmtDate", () => {
	it("a due date stored as a UTC-midnight calendar date renders as the same calendar day for America/Los_Angeles and for Pacific/Auckland", () => {
		const stored = new Date("2026-11-20T00:00:00.000Z");
		const original = process.env.TZ;
		try {
			for (const tz of ["America/Los_Angeles", "Pacific/Auckland"]) {
				process.env.TZ = tz;
				expect(fmtDate(stored)).toBe("November 20, 2026");
			}
		} finally {
			if (original === undefined) delete process.env.TZ;
			else process.env.TZ = original;
		}
	});

	it.each([
		["Pacific/Auckland", "2026-11-19T11:00:00.000Z"],
		["America/Los_Angeles", "2026-11-20T08:00:00.000Z"],
	])(
		"a quote valid_until picked at local midnight in %s renders as the picked day for that org",
		(tz, iso) => {
			// Both instants are local midnight of Nov 20 in their zone.
			expect(fmtDate(iso, tz)).toBe("November 20, 2026");
		},
	);
});
