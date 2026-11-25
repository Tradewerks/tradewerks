/** GET /requests: paged list (real route + controller against the fake client). */
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
vi.mock("../../services/followupTriggers.js", () => ({
	onRequestCreated: vi.fn(),
}));
vi.mock("../../services/socketService.js", () => ({
	getSocket: vi.fn().mockReturnValue(null),
	emitToOrg: vi.fn(),
}));

import requestsRouter from "../requests.js";
import { db } from "../../db.js";
import { callRoute, type FakeDb } from "./harness.js";

const fake = db as unknown as FakeDb;
const user = { uid: "d1", role: "dispatcher", permissions: ["view_requests"] };

const row = (n: number) => ({
	id: `r${n}`,
	title: `Request ${n}`,
	status: "New",
	priority: "Medium",
	address: "1 Main",
	created_at: new Date("2026-06-01"),
	updated_at: new Date("2026-06-01"),
	client: { id: "c1", name: "Acme" },
	_count: { quotes: 0 },
});

const call = (query: Record<string, unknown>) =>
	callRoute(requestsRouter, "get", "/", { user, query });

beforeEach(() => {
	fake.request.findMany.mockReset().mockResolvedValue([row(1), row(2)]);
	fake.request.count.mockReset().mockResolvedValue(120);
});

describe("GET /requests paged", () => {
	it("paged list returns limit rows and meta.count = total", async () => {
		const r = await call({ page: "2", limit: "2" });
		expect(r.status).toBe(200);
		expect(r.body.data).toHaveLength(2);
		expect(r.body.meta).toMatchObject({ count: 120, page: 2, limit: 2 });
		const args = fake.request.findMany.mock.calls[0][0];
		expect(args.skip).toBe(2);
		expect(args.take).toBe(2);
		expect(args.orderBy).toEqual([{ status: "asc" }, { priority: "desc" }, { id: "asc" }]);
	});

	it("q filters on title, client name and address, ANDing each word", async () => {
		await call({ page: "1", q: "acme main" });
		const args = fake.request.findMany.mock.calls[0][0];
		const text = JSON.stringify(args.where);
		for (const term of ["acme", "main"]) {
			expect(text).toContain(`"title":{"contains":"${term}","mode":"insensitive"}`);
			expect(text).toContain(`"client":{"name":{"contains":"${term}","mode":"insensitive"}}`);
			expect(text).toContain(`"address":{"contains":"${term}","mode":"insensitive"}`);
		}
		expect(args.where.AND.flatMap((c: any) => c.AND ?? []).length).toBe(2);
		expect(fake.request.count.mock.calls[0][0].where).toEqual(args.where);
	});

	it("an explicit sort replaces the triage order; client sorts by client name", async () => {
		await call({ page: "1", sort: "client", dir: "asc" });
		expect(fake.request.findMany.mock.calls[0][0].orderBy).toEqual([
			{ client: { name: "asc" } },
			{ id: "asc" },
		]);
		await call({ page: "1", sort: "title" });
		expect(fake.request.findMany.mock.calls[1][0].orderBy).toEqual([
			{ title: "desc" },
			{ id: "asc" },
		]);
	});

	it("legacy call ignores stray priority and sort params", async () => {
		const r = await call({ priority: "Huge", sort: "nope" });
		expect(r.status).toBe(200);
	});

	it("status filter accepts multiple values", async () => {
		await call({ page: "1", status: "New,Reviewing" });
		const args = fake.request.findMany.mock.calls[0][0];
		expect(JSON.stringify(args.where)).toContain('"status":{"in":["New","Reviewing"]}');
		const bad = await call({ page: "1", status: "Nope" });
		expect(bad.status).toBe(400);
		expect(bad.body.error.field).toBe("status");
	});

	it("legacy call returns the old array and a Deprecation header", async () => {
		const r = await call({});
		expect(r.status).toBe(200);
		expect(Array.isArray(r.body.data)).toBe(true);
		expect(r.res.setHeader).toHaveBeenCalledWith("Deprecation", "true");
		const args = fake.request.findMany.mock.calls[0][0];
		expect(args.take).toBeUndefined();
		expect(args.include).toBeDefined();
	});

	it("slim select omits quotes, jobs and notes bodies", async () => {
		await call({ page: "1" });
		const args = fake.request.findMany.mock.calls[0][0];
		expect(args.include).toBeUndefined();
		expect(Object.keys(args.select).sort()).toEqual(
			[
				"_count",
				"address",
				"client",
				"client_id",
				"created_at",
				"id",
				"priority",
				"status",
				"title",
				"updated_at",
			].sort(),
		);
		expect(args.select.quotes).toBeUndefined();
		expect(args.select.jobs).toBeUndefined();
		expect(args.select._count).toEqual({ select: { quotes: true } });
	});

	it("priority and client_id narrow the list", async () => {
		await call({ page: "1", priority: "High,Urgent", client_id: "c9" });
		const s = JSON.stringify(fake.request.findMany.mock.calls[0][0].where);
		expect(s).toContain('"priority":{"in":["High","Urgent"]}');
		expect(s).toContain('"client_id":"c9"');
		expect((await call({ page: "1", priority: "Huge" })).status).toBe(400);
	});

	it("from and to bound created_at", async () => {
		await call({ page: "1", from: "2026-06-01", to: "2026-07-01T00:00:00.000Z" });
		const s = JSON.stringify(fake.request.findMany.mock.calls[0][0].where);
		expect(s).toContain('"created_at":{"gte":"2026-06-01T00:00:00.000Z","lt":"2026-07-01T00:00:00.000Z"}');
	});
});
