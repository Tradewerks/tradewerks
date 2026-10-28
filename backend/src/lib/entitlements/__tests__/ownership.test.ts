import { describe, it, expect, vi } from "vitest";

vi.mock("../../../db.js", () => ({ db: {} }));

import { PAGE_SUMMARY_MODULE } from "../ownership.js";
import { PAGES } from "../../../controllers/reportsController.js";

describe("PAGE_SUMMARY_MODULE", () => {
	it("gates the recurring-plans summary behind the recurring_plans module", () => {
		expect(PAGE_SUMMARY_MODULE.recurring_plans).toBe("recurring_plans");
	});

	it("only names pages the summary endpoint accepts", () => {
		for (const page of Object.keys(PAGE_SUMMARY_MODULE)) {
			expect(PAGES as readonly string[]).toContain(page);
		}
	});
});
