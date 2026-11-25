/** GET /quotes: paged list (real route + controller against the fake client). */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
	generateQuoteNumber: vi.fn().mockResolvedValue("Q-0001"),
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
	onQuoteSent: vi.fn(),
}));
vi.mock("../../services/emailService.js", () => ({ sendQuoteEmail: vi.fn() }));
vi.mock("../../lib/pdf/pdfService.js", () => ({ generateQuotePdf: vi.fn() }));
vi.mock("../../services/socketService.js", () => ({
	getSocket: vi.fn().mockReturnValue(null),
	emitToOrg: vi.fn(),
}));

import quotesRouter from "../quotes.js";
import { db } from "../../db.js";
import { callRoute, type FakeDb } from "./harness.js";

const fake = db as unknown as FakeDb;
const user = { uid: "d1", role: "dispatcher", permissions: ["view_quotes"] };

const row = (n: number) => ({
	id: `q${n}`,
	quote_number: `Q-${n}`,
	title: `Quote ${n}`,
	status: "Sent",
	priority: "Medium",
	address: "1 Main",
	total: "100.00",
	client_id: "c1",
	request_id: null,
	expires_at: null,
	created_at: new Date("2026-06-01"),
	updated_at: new Date("2026-06-01"),
	client: { id: "c1", name: "Acme" },
});

const call = (query: Record<string, unknown>) =>
	callRoute(quotesRouter, "get", "/", { user, query });

beforeEach(() => {
	fake.quote.findMany.mockReset().mockResolvedValue([row(1), row(2)]);
	fake.quote.count.mockReset().mockResolvedValue(120);
});

describe("GET /quotes paged", () => {
	it("paged list returns limit rows and meta.count = total", async () => {
		const r = await call({ page: "2", limit: "2" });
		expect(r.status).toBe(200);
		expect(r.body.data).toHaveLength(2);
		expect(r.body.meta).toMatchObject({ count: 120, page: 2, limit: 2 });
		const args = fake.quote.findMany.mock.calls[0][0];
		expect(args.skip).toBe(2);
		expect(args.take).toBe(2);
		expect(args.orderBy).toEqual([{ status: "asc" }, { created_at: "desc" }, { id: "asc" }]);
	});

	it("q filters on quote number, title, client name and address, ANDing each word", async () => {
		await call({ page: "1", q: "acme roof" });
		const args = fake.quote.findMany.mock.calls[0][0];
		const text = JSON.stringify(args.where);
		for (const term of ["acme", "roof"]) {
			expect(text).toContain(`"quote_number":{"contains":"${term}","mode":"insensitive"}`);
			expect(text).toContain(`"title":{"contains":"${term}","mode":"insensitive"}`);
			expect(text).toContain(`"client":{"name":{"contains":"${term}","mode":"insensitive"}}`);
			expect(text).toContain(`"address":{"contains":"${term}","mode":"insensitive"}`);
		}
		expect(args.where.AND).toHaveLength(2);
		expect(fake.quote.count.mock.calls[0][0].where).toEqual(args.where);
	});

	it("status filter accepts multiple values", async () => {
		await call({ page: "1", status: "Sent,Viewed" });
		const args = fake.quote.findMany.mock.calls[0][0];
		expect(JSON.stringify(args.where)).toContain('"status":{"in":["Sent","Viewed"]}');
		const bad = await call({ page: "1", status: "Nope" });
		expect(bad.status).toBe(400);
		expect(bad.body.error.field).toBe("status");
	});

	it("an explicit sort replaces the status order; client sorts by client name", async () => {
		await call({ page: "1", sort: "client", dir: "asc" });
		expect(fake.quote.findMany.mock.calls[0][0].orderBy).toEqual([
			{ client: { name: "asc" } },
			{ id: "asc" },
		]);
		await call({ page: "1", sort: "total" });
		expect(fake.quote.findMany.mock.calls[1][0].orderBy).toEqual([
			{ total: "desc" },
			{ id: "asc" },
		]);
		expect((await call({ page: "1", sort: "nope" })).status).toBe(400);
	});

	it("priority, client_id and request_id narrow the list", async () => {
		await call({ page: "1", priority: "High,Urgent", client_id: "c9", request_id: "r2" });
		const s = JSON.stringify(fake.quote.findMany.mock.calls[0][0].where);
		expect(s).toContain('"priority":{"in":["High","Urgent"]}');
		expect(s).toContain('"client_id":"c9"');
		expect(s).toContain('"request_id":"r2"');
		expect((await call({ page: "1", priority: "Huge" })).status).toBe(400);
	});

	it("legacy call returns the old array and a Deprecation header", async () => {
		const r = await call({ sort: "nope", limit: "500", priority: "Huge" });
		expect(r.status).toBe(200);
		expect(Array.isArray(r.body.data)).toBe(true);
		expect(r.res.setHeader).toHaveBeenCalledWith("Deprecation", "true");
		const args = fake.quote.findMany.mock.calls[0][0];
		expect(args.take).toBeUndefined();
		expect(args.include).toBeDefined();
	});

	it("slim select omits line items, request, job and notes", async () => {
		await call({ page: "1" });
		const args = fake.quote.findMany.mock.calls[0][0];
		expect(args.include).toBeUndefined();
		expect(Object.keys(args.select).sort()).toEqual(
			[
				"address",
				"client",
				"client_id",
				"created_at",
				"expires_at",
				"id",
				"priority",
				"quote_number",
				"request_id",
				"status",
				"title",
				"total",
				"updated_at",
			].sort(),
		);
		expect(args.select.line_items).toBeUndefined();
		expect(args.select.job).toBeUndefined();
		expect(args.select.request).toBeUndefined();
	});

	it("active=true limits to live quotes without clobbering the q AND", async () => {
		await call({ page: "1", q: "roof", active: "true" });
		const where = fake.quote.findMany.mock.calls[0][0].where;
		expect(JSON.stringify(where)).toContain('"is_active":true');
		expect(JSON.stringify(where)).toContain('"title":{"contains":"roof"');
		await call({ page: "1" });
		expect(JSON.stringify(fake.quote.findMany.mock.calls[1][0].where)).not.toContain(
			"is_active\":true",
		);
		expect((await call({ page: "1", active: "maybe" })).status).toBe(200);
	});

	it("from and to bound created_at", async () => {
		await call({ page: "1", from: "2026-06-01", to: "2026-07-01T00:00:00.000Z" });
		const s = JSON.stringify(fake.quote.findMany.mock.calls[0][0].where);
		expect(s).toContain(
			'"created_at":{"gte":"2026-06-01T00:00:00.000Z",' +
				'"lt":"2026-07-01T00:00:00.000Z"}',
		);
	});
});
