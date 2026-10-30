import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(),
	getUserContext: vi.fn().mockReturnValue({ dispatcherId: "disp-1" }),
}));

vi.mock("../../lib/entitlements/requireModule.js", () => ({
	requireModule: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../lib/requirePermissions.js", async (importActual) => ({
	...(await importActual<typeof import("../../lib/requirePermissions.js")>()),
	requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../services/quickbooksService.js", async (importActual) => ({
	...(await importActual<typeof import("../../services/quickbooksService.js")>()),
	isQBConnected: vi.fn(),
}));

vi.mock("../../services/qb/qbTax.js", async (importActual) => ({
	...(await importActual<typeof import("../../services/qb/qbTax.js")>()),
	getQBTaxPrefs: vi.fn(),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import quickbooksRouter from "../quickbooks.js";
import { callRoute } from "./harness.js";
import { isQBConnected } from "../../services/quickbooksService.js";
import { getQBTaxPrefs } from "../../services/qb/qbTax.js";
import { log } from "../../services/appLogger.js";

const mockConnected = vi.mocked(isQBConnected);
const mockPrefs = vi.mocked(getQBTaxPrefs);
const call = () => callRoute(quickbooksRouter, "get", "/tax-calculation");

describe("GET /quickbooks/tax-calculation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	it("is false without reading preferences when QuickBooks is not connected", async () => {
		mockConnected.mockResolvedValue(false);
		const { status, body } = await call();
		expect(status).toBe(200);
		expect(body.data).toEqual({ qb_calculates_tax: false });
		expect(mockPrefs).not.toHaveBeenCalled();
	});

	it("is true when the company uses Automated Sales Tax", async () => {
		mockConnected.mockResolvedValue(true);
		mockPrefs.mockResolvedValue({ automatedSalesTax: true });
		const { status, body } = await call();
		expect(status).toBe(200);
		expect(body.data).toEqual({ qb_calculates_tax: true });
		expect(mockPrefs).toHaveBeenCalledWith("org-1");
	});

	it("is false when the company does not use Automated Sales Tax", async () => {
		mockConnected.mockResolvedValue(true);
		mockPrefs.mockResolvedValue({ automatedSalesTax: false });
		const { body } = await call();
		expect(body.data).toEqual({ qb_calculates_tax: false });
	});

	it("is false with status 200 when the preferences cannot be read", async () => {
		mockConnected.mockResolvedValue(true);
		mockPrefs.mockRejectedValue(new Error("QB 401"));
		const { status, body } = await call();
		expect(status).toBe(200);
		expect(body.data).toEqual({ qb_calculates_tax: false });
		expect(log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.any(Error), orgId: "org-1" }),
			expect.any(String),
		);
		expect(console.warn).not.toHaveBeenCalled();
	});
});
