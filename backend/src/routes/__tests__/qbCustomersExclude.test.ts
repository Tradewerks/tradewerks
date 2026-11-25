/** GET /quickbooks/customers?exclude_existing=1 drops QB customers already in the org. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { findClients } = vi.hoisted(() => ({ findClients: vi.fn() }));

vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
}));
vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => ({ client: { findMany: findClients } })),
	getUserContext: vi.fn().mockReturnValue({}),
}));
vi.mock("../../lib/entitlements/requireModule.js", () => ({
	requireModule: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../lib/requirePermissions.js", async (importActual) => ({
	...(await importActual<typeof import("../../lib/requirePermissions.js")>()),
	requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const { findQB } = vi.hoisted(() => ({ findQB: vi.fn() }));
vi.mock("../../services/qb/qbCustomers.js", async (importActual) => ({
	...(await importActual<typeof import("../../services/qb/qbCustomers.js")>()),
	findAllQBCustomers: findQB,
}));

import quickbooksRouter from "../quickbooks.js";
import { callRoute } from "./harness.js";

const call = (query: Record<string, unknown>) =>
	callRoute(quickbooksRouter, "get", "/customers", { query });

beforeEach(() => {
	findQB.mockReset().mockResolvedValue([
		{ Id: "1", DisplayName: "Acme Heating" },
		{ Id: "2", DisplayName: "New Customer" },
	]);
	findClients.mockReset().mockResolvedValue([{ name: "ACME heating" }]);
});

describe("GET /quickbooks/customers", () => {
	it("exclude_existing=1 drops customers whose name matches a client, ignoring case", async () => {
		const r = await call({ exclude_existing: "1" });
		expect(r.body.data.map((c: { Id: string }) => c.Id)).toEqual(["2"]);
		expect(findClients.mock.calls[0][0].where).toEqual({
			name: { in: ["Acme Heating", "New Customer"], mode: "insensitive" },
		});
	});

	it("without it every QB customer comes back and no client query runs", async () => {
		const r = await call({});
		expect(r.body.data).toHaveLength(2);
		expect(findClients).not.toHaveBeenCalled();
	});

	it("skips the client query when QuickBooks has no customers", async () => {
		findQB.mockResolvedValue([]);
		const r = await call({ exclude_existing: "1" });
		expect(r.body.data).toEqual([]);
		expect(findClients).not.toHaveBeenCalled();
	});
});
