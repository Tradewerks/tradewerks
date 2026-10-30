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

vi.mock("../../services/qb/qbInvoices.js", async (importActual) => ({
	...(await importActual<typeof import("../../services/qb/qbInvoices.js")>()),
	pushInvoice: vi.fn(),
}));

import quickbooksRouter from "../quickbooks.js";
import { callRoute } from "./harness.js";
import { db } from "../../db.js";
import { pushInvoice } from "../../services/qb/qbInvoices.js";
import { getScopedDb } from "../../lib/context.js";

const mockPush = vi.mocked(pushInvoice);
const scopedUpdateMany = vi.fn();
const sync = () =>
	callRoute(quickbooksRouter, "post", "/invoices/:id/sync", { params: { id: "inv1" } });

describe("POST /quickbooks/invoices/:id/sync", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		scopedUpdateMany.mockResolvedValue({ count: 1 });
		vi.mocked(getScopedDb).mockReturnValue({ invoice: { updateMany: scopedUpdateMany } } as never);
	});

	it("answers a QuickBooks validation fault with its message, not a 500", async () => {
		mockPush.mockRejectedValueOnce(
			new Error(
				'QB POST /invoice → 400: {"Fault":{"Error":[{"Detail":"Business Validation Error: X","code":"6000"}]}}',
			),
		);

		const { status, body } = await sync();

		expect(status).toBe(502);
		expect(body.error.code).toBe("QB_SYNC_FAILED");
		expect(body.error.message).toBe("QuickBooks rejected this document: Business Validation Error: X");
		expect(getScopedDb).toHaveBeenCalledWith("org-1");
		expect(scopedUpdateMany).toHaveBeenCalledWith({
			where: { id: "inv1" },
			data: { qb_sync_status: "failed" },
		});
		expect(db.invoice.update).not.toHaveBeenCalled();
	});

	it("passes an error with no QuickBooks fault on to the generic handler", async () => {
		const boom = new Error("socket hang up");
		mockPush.mockRejectedValueOnce(boom);

		const result = await callRoute(quickbooksRouter, "post", "/invoices/:id/sync", {
			params: { id: "inv1" },
		}).catch((e) => e);

		expect(result).toBe(boom);
		expect(getScopedDb).toHaveBeenCalledWith("org-1");
		expect(scopedUpdateMany).toHaveBeenCalledWith({
			where: { id: "inv1" },
			data: { qb_sync_status: "failed" },
		});
		expect(db.invoice.update).not.toHaveBeenCalled();
	});

	it("reports success when the push lands", async () => {
		mockPush.mockResolvedValueOnce({} as never);

		const { status, body } = await sync();

		expect(status).toBe(200);
		expect(body.data).toEqual({ synced: true });
	});
});
