import { describe, expect, it, vi } from "vitest";

vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
	generateJobNumber: vi.fn(),
	generateQuoteNumber: vi.fn(),
	generateInvoiceNumber: vi.fn(),
	generateProjectNumber: vi.fn(),
	SECRET_FIELD_OMIT: {},
}));
const retry = vi.hoisted(() => vi.fn());
vi.mock("../../controllers/fieldPurchasesController.js", async (orig) => ({
	...(await orig<typeof import("../../controllers/fieldPurchasesController.js")>()),
	retryOcr: retry,
}));

import router from "../fieldPurchases.js";
import { SCANS_USED_UP } from "../../controllers/fieldPurchasesController.js";
import { callRoute } from "./harness.js";

const user = { uid: "tech-1", role: "admin", organization_id: "org-1", permissions: null };

describe("POST /field-purchases/:id/ocr/retry — receipt scan meter", () => {
	it("answers 429 QUOTA_EXCEEDED when the month's scans are used up, like the AI meter", async () => {
		retry.mockResolvedValue({ err: SCANS_USED_UP });
		const r = await callRoute(router, "post", "/:id/ocr/retry", {
			user,
			params: { id: "fp-1" },
		});
		expect(r.status).toBe(429);
		expect(r.body.error).toEqual({ code: "QUOTA_EXCEEDED", message: SCANS_USED_UP });
	});

	it("still answers 400 for other refusals", async () => {
		retry.mockResolvedValue({ err: "This receipt is already being read" });
		const r = await callRoute(router, "post", "/:id/ocr/retry", {
			user,
			params: { id: "fp-1" },
		});
		expect(r.status).toBe(400);
		expect(r.body.error.code).toBe("VALIDATION_ERROR");
	});
});
