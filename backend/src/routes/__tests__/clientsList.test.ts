/** GET /clients: paged list (real route + controller against the fake client). */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
}));
vi.mock("../../lib/context.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/context.js")>()),
	getUserContext: vi.fn().mockReturnValue({}),
}));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn(),
	buildChanges: vi.fn().mockReturnValue({}),
}));
vi.mock("../../services/socketService.js", () => ({
	getSocket: vi.fn().mockReturnValue(null),
	emitToOrg: vi.fn(),
}));

vi.mock("../../services/quickbooksService.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../services/quickbooksService.js")>()),
	getOrgRealmId: vi.fn(async () => "realm1"),
	QB_ENABLED: true,
}));
const { getEntitlements } = vi.hoisted(() => ({ getEntitlements: vi.fn() }));
vi.mock("../../services/entitlementService.js", () => ({ getEntitlements }));

import clientsRouter from "../clientsContacts.js";
import { db } from "../../db.js";
import { callRoute, type FakeDb } from "./harness.js";

const fake = db as unknown as FakeDb;
const user = {
	uid: "d1",
	role: "dispatcher",
	permissions: ["view_clients", "view_jobs", "view_quotes"],
};
const tech = { uid: "t1", role: "technician", permissions: ["view_clients", "view_assigned_jobs"] };

const row = (n: number) => ({
	id: `c${n}`,
	name: `Client ${n}`,
	is_active: true,
	is_tax_exempt: false,
	address: "1 Main",
	last_activity: new Date("2026-06-01"),
	created_at: new Date("2026-06-01"),
	contacts: [],
	_count: { jobs: 0, quotes: 0, requests: 0 },
});

const call = (query: Record<string, unknown>, u = user) =>
	callRoute(clientsRouter, "get", "/clients", { user: u, query });

beforeEach(() => {
	getEntitlements.mockReset().mockResolvedValue({ modules: { quickbooks: "on" } });
	fake.client.findMany.mockReset().mockResolvedValue([row(1), row(2)]);
	fake.client.count.mockReset().mockResolvedValue(120);
});

describe("GET /clients paged", () => {
	it("paged list returns limit rows and meta.count = total", async () => {
		const r = await call({ page: "2", limit: "2" });
		expect(r.status).toBe(200);
		expect(r.body.data).toHaveLength(2);
		expect(r.body.meta).toMatchObject({ count: 120, page: 2, limit: 2 });
		const args = fake.client.findMany.mock.calls[0][0];
		expect(args.skip).toBe(2);
		expect(args.take).toBe(2);
		expect(args.orderBy).toEqual([
			{ is_active: "desc" },
			{ last_activity: "desc" },
			{ id: "asc" },
		]);
	});

	it("q filters on name, address and the primary contact's name, email and phone", async () => {
		await call({ page: "1", q: "acme main" });
		const args = fake.client.findMany.mock.calls[0][0];
		const text = JSON.stringify(args.where);
		for (const term of ["acme", "main"]) {
			for (const col of ["name", "email", "phone", "address"]) {
				expect(text).toContain(`"${col}":{"contains":"${term}","mode":"insensitive"}`);
			}
		}
		expect(text).toContain('"contacts":{"some":{"is_primary":true');
		expect(args.where.AND.flatMap((c: any) => c.AND ?? [])).toHaveLength(2);
		expect(fake.client.count.mock.calls[0][0].where).toEqual(args.where);
	});

	it("status filter accepts multiple values", async () => {
		const where = (i: number) => JSON.stringify(fake.client.findMany.mock.calls[i][0].where);
		await call({ page: "1", status: "active,inactive" });
		expect(where(0)).not.toContain("is_active");
		await call({ page: "1", status: "inactive" });
		expect(where(1)).toContain('"is_active":false');
		await call({ page: "1", status: "active" });
		expect(where(2)).toContain('"is_active":true');
		const bad = await call({ page: "1", status: "Nope" });
		expect(bad.status).toBe(400);
		expect(bad.body.error.field).toBe("status");
	});

	it("tax narrows to exempt or taxable and refuses anything else", async () => {
		const where = (i: number) => JSON.stringify(fake.client.findMany.mock.calls[i][0].where);
		await call({ page: "1", tax: "exempt" });
		expect(where(0)).toContain('"is_tax_exempt":true');
		await call({ page: "1", tax: "taxable" });
		expect(where(1)).toContain('"is_tax_exempt":false');
		const bad = await call({ page: "1", tax: "x" });
		expect(bad.status).toBe(400);
		expect(bad.body.error.field).toBe("tax");
	});

	it("an explicit sort replaces the default order", async () => {
		await call({ page: "1", sort: "name", dir: "asc" });
		expect(fake.client.findMany.mock.calls[0][0].orderBy).toEqual([
			{ name: "asc" },
			{ id: "asc" },
		]);
	});

	it("legacy call returns the old array and a Deprecation header", async () => {
		const r = await call({ sort: "nope", tax: "x" });
		expect(r.status).toBe(200);
		expect(Array.isArray(r.body.data)).toBe(true);
		expect(r.res.setHeader).toHaveBeenCalledWith("Deprecation", "true");
		const args = fake.client.findMany.mock.calls[0][0];
		expect(args.take).toBeUndefined();
		expect(args.include).toBeDefined();
	});

	it("slim select omits jobs, quotes, requests, plans, notes and coords", async () => {
		await call({ page: "1" });
		const args = fake.client.findMany.mock.calls[0][0];
		expect(args.include).toBeUndefined();
		expect(Object.keys(args.select).sort()).toEqual(
			[
				"_count",
				"address",
				"contacts",
				"created_at",
				"id",
				"is_active",
				"is_tax_exempt",
				"last_activity",
				"name",
			].sort(),
		);
		expect(args.select.jobs).toBeUndefined();
		expect(args.select.quotes).toBeUndefined();
		expect(args.select._count).toEqual({
			select: { jobs: true, quotes: true, requests: true },
		});
		expect(args.select.contacts.where).toEqual({ is_primary: true });
		expect(args.select.contacts.take).toBe(1);
	});

	it("an assigned-only caller counts only their jobs and gets no quote count", async () => {
		await call({ page: "1" }, tech);
		const count = fake.client.findMany.mock.calls[0][0].select._count.select;
		expect(count.jobs).toEqual({
			where: { visits: { some: { visit_techs: { some: { tech_id: "t1" } } } } },
		});
		expect(count.quotes).toBeUndefined();
		expect(count.requests).toBe(true);
	});

	it("a caller without view_quotes gets no quote count", async () => {
		await call({ page: "1" }, { ...user, permissions: ["view_clients", "view_jobs"] });
		expect(fake.client.findMany.mock.calls[0][0].select._count.select.quotes).toBeUndefined();
	});
});

describe("GET /clients qb filter", () => {
	const where = (i: number) => JSON.stringify(fake.client.findMany.mock.calls[i][0].where);

	it("qb=synced and qb=not_synced filter on the QuickBooks mapping in the org's realm", async () => {
		await call({ page: "1", qb: "synced" });
		expect(where(0)).toContain(
			'"client_external_mapping":{"some":{"provider":"quickbooks","account_id":"realm1"}}',
		);
		await call({ page: "1", qb: "not_synced" });
		expect(where(1)).toContain(
			'"client_external_mapping":{"none":{"provider":"quickbooks","account_id":"realm1"}}',
		);
		expect(fake.client.count.mock.calls[1][0].where).toEqual(
			fake.client.findMany.mock.calls[1][0].where,
		);
	});

	it("qb refuses other values when paged", async () => {
		const bad = await call({ page: "1", qb: "maybe" });
		expect(bad.status).toBe(400);
		expect(bad.body.error.field).toBe("qb");
	});

	it("legacy call ignores qb", async () => {
		const r = await call({ qb: "maybe" });
		expect(r.status).toBe(200);
		expect(JSON.stringify(fake.client.findMany.mock.calls[0][0].where ?? {})).not.toContain(
			"client_external_mapping",
		);
	});

	it("with_qb adds the linked QuickBooks customer id to each row", async () => {
		await call({ page: "1", with_qb: "1" });
		expect(fake.client.findMany.mock.calls[0][0].select.client_external_mapping).toEqual({
			where: { provider: "quickbooks", account_id: "realm1" },
			take: 1,
			select: { external_id: true },
		});
		await call({ page: "1" });
		expect(fake.client.findMany.mock.calls[1][0].select.client_external_mapping).toBeUndefined();
	});

	it("ignores qb and with_qb when the org is not entitled to quickbooks", async () => {
		getEntitlements.mockResolvedValue({ modules: {} });
		const r = await call({ page: "1", qb: "synced", with_qb: "1" });
		expect(r.status).toBe(200);
		const args = fake.client.findMany.mock.calls[0][0];
		expect(JSON.stringify(args.where)).not.toContain("client_external_mapping");
		expect(args.select.client_external_mapping).toBeUndefined();
	});
});
