/** GET /invoices: paged list + summary (real route + controller against the fake client). */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
	generateInvoiceNumber: vi.fn().mockResolvedValue("INV-0001"),
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
vi.mock("../../services/emailService.js", () => ({ sendInvoiceEmail: vi.fn() }));
vi.mock("../../lib/pdf/pdfService.js", () => ({ generateInvoicePdf: vi.fn() }));
vi.mock("../../services/quickbooksService.js", () => ({
	isQBConnected: vi.fn().mockResolvedValue(true),
	getOrgRealmId: vi.fn().mockResolvedValue("realm-1"),
	getQBStatus: vi.fn().mockResolvedValue({ connected: true, realmId: "realm-1" }),
}));

import invoicesRouter from "../invoices.js";
import { db } from "../../db.js";
import { getQBStatus } from "../../services/quickbooksService.js";
import { callRoute, type FakeDb } from "./harness.js";

const fake = db as unknown as FakeDb;
const user = { uid: "d1", role: "dispatcher", permissions: ["view_invoices"] };

const row = (n: number) => ({
	id: `i${n}`,
	invoice_number: `INV-${n}`,
	status: "Issued",
	client_id: "c1",
	client: { id: "c1", name: "Acme" },
	memo: null,
	issue_date: new Date("2026-06-01"),
	due_date: new Date("2026-07-01"),
	total: "10.00",
	amount_paid: "0.00",
	balance_due: "10.00",
	qb_sync_status: "synced",
	qb_diverged_at: null,
	qb_diverged_reason: null,
	account_id: "realm-1",
});

const call = (query: Record<string, unknown>, path = "/") =>
	callRoute(invoicesRouter, "get", path, { user, query });

beforeEach(() => {
	fake.invoice.findMany.mockReset().mockResolvedValue([row(1), row(2)]);
	fake.invoice.count.mockReset().mockResolvedValue(120);
	fake.invoice.aggregate
		.mockReset()
		.mockResolvedValue({ _sum: { balance_due: "5.00", total: "9.00" }, _count: 3 });
	vi.mocked(getQBStatus).mockResolvedValue({ connected: true, realmId: "realm-1" });
});

describe("GET /invoices paged", () => {
	it("paged list returns limit rows and meta.count = total", async () => {
		const r = await call({ page: "2", limit: "2" });
		expect(r.status).toBe(200);
		expect(r.body.data).toHaveLength(2);
		expect(r.body.meta).toMatchObject({ count: 120, page: 2, limit: 2 });
		// All 120 are overdue here, so page 2 is cut entirely from the overdue set.
		expect(fake.invoice.findMany).toHaveBeenCalledTimes(1);
		const args = fake.invoice.findMany.mock.calls[0][0];
		expect(args.skip).toBe(2);
		expect(args.take).toBe(2);
		expect(args.orderBy).toEqual([
			{ status: "asc" },
			{ due_date: { sort: "asc", nulls: "last" } },
			{ issue_date: "desc" },
			{ id: "asc" },
		]);
	});

	it("q filters on invoice_number, client name and memo, ANDing each word", async () => {
		await call({ page: "1", q: "acme 1042", sort: "issue_date" });
		const args = fake.invoice.findMany.mock.calls[0][0];
		const text = JSON.stringify(args.where);
		for (const term of ["acme", "1042"]) {
			expect(text).toContain(`"invoice_number":{"contains":"${term}","mode":"insensitive"}`);
			expect(text).toContain(`"client":{"name":{"contains":"${term}","mode":"insensitive"}}`);
			expect(text).toContain(`"memo":{"contains":"${term}","mode":"insensitive"}`);
		}
		expect(args.where.AND.flatMap((c: any) => c.AND ?? []).length).toBe(2);
		expect(fake.invoice.count.mock.calls[0][0].where).toEqual(args.where);
	});

	it("status filter accepts multiple values", async () => {
		await call({ page: "1", status: "Issued,Paid" });
		const args = fake.invoice.findMany.mock.calls[0][0];
		expect(JSON.stringify(args.where)).toContain('"status":{"in":["Issued","Paid"]}');
		const bad = await call({ page: "1", status: "Nope" });
		expect(bad.status).toBe(400);
		expect(bad.body.error.field).toBe("status");
	});

	it("legacy call returns the old array and a Deprecation header", async () => {
		const r = await call({ sort: "nope", limit: "500" });
		expect(r.status).toBe(200);
		expect(Array.isArray(r.body.data)).toBe(true);
		expect(r.res.setHeader).toHaveBeenCalledWith("Deprecation", "true");
		const args = fake.invoice.findMany.mock.calls[0][0];
		expect(args.take).toBeUndefined();
		expect(args.include).toBeDefined();
	});

	it("slim select omits line items, payments, notes and jobs", async () => {
		await call({ page: "1" });
		const args = fake.invoice.findMany.mock.calls[0][0];
		expect(args.include).toBeUndefined();
		expect(Object.keys(args.select).sort()).toEqual(
			[
				"account_id",
				"amount_paid",
				"balance_due",
				"client",
				"client_id",
				"due_date",
				"id",
				"invoice_number",
				"issue_date",
				"memo",
				"qb_diverged_at",
				"qb_diverged_reason",
				"qb_sync_status",
				"status",
				"total",
			].sort(),
		);
		expect(args.select.line_items).toBeUndefined();
		expect(args.select.payments).toBeUndefined();
		expect(args.select.notes).toBeUndefined();
		expect(args.select.jobs).toBeUndefined();
	});

	it("an explicit sort replaces the default order; client sorts by client name", async () => {
		await call({ page: "1", sort: "client", dir: "asc" });
		expect(fake.invoice.findMany.mock.calls[0][0].orderBy).toEqual([
			{ client: { name: "asc" } },
			{ id: "asc" },
		]);
		await call({ page: "1", sort: "due_date" });
		expect(fake.invoice.findMany.mock.calls[1][0].orderBy).toEqual([
			{ due_date: { sort: "desc", nulls: "last" } },
			{ id: "asc" },
		]);
		await call({ page: "1", sort: "balance_due", dir: "asc" });
		expect(fake.invoice.findMany.mock.calls[2][0].orderBy).toEqual([
			{ balance_due: "asc" },
			{ id: "asc" },
		]);
		expect((await call({ page: "1", sort: "created_at" })).status).toBe(400);
	});

	it("from and to bound issue_date, to exclusive", async () => {
		await call({ page: "1", from: "2026-06-01", to: "2026-07-01T00:00:00.000Z" });
		const s = JSON.stringify(fake.invoice.findMany.mock.calls[0][0].where);
		expect(s).toContain(
			'"issue_date":{"gte":"2026-06-01T00:00:00.000Z","lt":"2026-07-01T00:00:00.000Z"}',
		);
	});

	it("client_id narrows the list", async () => {
		await call({ page: "1", client_id: "c9" });
		expect(JSON.stringify(fake.invoice.findMany.mock.calls[0][0].where)).toContain(
			'"client_id":"c9"',
		);
	});

	it("qb=attention keeps failed, tax_mismatch and diverged invoices in the current realm", async () => {
		await call({ page: "1", qb: "attention", sort: "issue_date" });
		const s = JSON.stringify(fake.invoice.findMany.mock.calls[0][0].where);
		expect(s).toContain('"account_id":"realm-1"');
		expect(s).toContain('"qb_sync_status":{"in":["failed","tax_mismatch"]}');
		expect(s).toContain('"qb_diverged_at":{"not":null}');
		// A diverged Void invoice still needs a person.
		expect(s).not.toContain('"status"');
		await call({ page: "1", qb: "tax_mismatch" });
		const t = JSON.stringify(fake.invoice.findMany.mock.calls[1][0].where);
		expect(t).toContain('"qb_sync_status":"tax_mismatch"');
		expect(t).toContain('"account_id":"realm-1"');
		expect((await call({ page: "1", qb: "nope" })).status).toBe(400);
	});

	it("qb filter matches nothing when QuickBooks is not connected", async () => {
		vi.mocked(getQBStatus).mockResolvedValue({ connected: false, realmId: null });
		await call({ page: "1", qb: "attention" });
		expect(JSON.stringify(fake.invoice.findMany.mock.calls[0][0].where)).toContain(
			'"id":{"in":[]}',
		);
	});
});

const isOverdueQuery = (args: any) => JSON.stringify(args.where).includes('"due_date":{"lt"');

describe("GET /invoices default order", () => {
	it("a Disputed overdue row orders ahead of a non-overdue Issued row", async () => {
		const disputed = { ...row(1), id: "disputed", status: "Disputed" };
		const issued = { ...row(2), id: "issued", status: "Issued" };
		fake.invoice.count.mockReset().mockResolvedValueOnce(2).mockResolvedValueOnce(1);
		fake.invoice.findMany.mockReset().mockImplementation(async (args: any) =>
			isOverdueQuery(args) ? [disputed] : [issued],
		);
		const r = await call({ page: "1", limit: "50" });
		expect(r.body.data.map((x: any) => x.id)).toEqual(["disputed", "issued"]);
		expect(r.body.meta.count).toBe(2);
		const rest = fake.invoice.findMany.mock.calls.map((c: any) => c[0]).find((a: any) => !isOverdueQuery(a));
		expect(JSON.stringify(rest.where)).toContain('"due_date":null');
	});

	it("a page that straddles the overdue boundary takes the tail of the overdue set then tops up", async () => {
		fake.invoice.count.mockReset().mockResolvedValueOnce(5).mockResolvedValueOnce(3);
		fake.invoice.findMany.mockReset().mockImplementation(async (args: any) =>
			isOverdueQuery(args) ? [{ ...row(3), id: "o3" }] : [{ ...row(4), id: "n1" }],
		);
		const r = await call({ page: "2", limit: "2" });
		expect(r.body.data.map((x: any) => x.id)).toEqual(["o3", "n1"]);
		const calls = fake.invoice.findMany.mock.calls.map((c: any) => c[0]);
		const over = calls.find(isOverdueQuery);
		const rest = calls.find((a: any) => !isOverdueQuery(a));
		expect(over).toMatchObject({ skip: 2, take: 1 });
		expect(rest).toMatchObject({ skip: 0, take: 1 });
	});

	it("a page past the overdue set skips only the overdue rows already passed", async () => {
		fake.invoice.count.mockReset().mockResolvedValueOnce(10).mockResolvedValueOnce(3);
		fake.invoice.findMany.mockReset().mockResolvedValue([row(9)]);
		await call({ page: "2", limit: "4" });
		expect(fake.invoice.findMany).toHaveBeenCalledTimes(1);
		expect(fake.invoice.findMany.mock.calls[0][0]).toMatchObject({ skip: 1, take: 4 });
		expect(isOverdueQuery(fake.invoice.findMany.mock.calls[0][0])).toBe(false);
	});
});

describe("GET /invoices/summary", () => {
	it("totals outstanding, overdue and paid from SQL aggregates", async () => {
		fake.invoice.aggregate
			.mockReset()
			.mockResolvedValueOnce({ _sum: { balance_due: "100.50" }, _count: 4 })
			.mockResolvedValueOnce({ _sum: { balance_due: "20.00" }, _count: 2 })
			.mockResolvedValueOnce({ _sum: { total: "300.00" }, _count: 7 });
		fake.invoice.count.mockReset().mockResolvedValueOnce(3).mockResolvedValueOnce(5);
		vi.mocked(getQBStatus).mockClear();
		const r = await call({}, "/summary");
		expect(r.status).toBe(200);
		expect(r.body.data).toEqual({
			outstanding: { amount: 100.5, count: 4 },
			overdue: { amount: 20, count: 2 },
			paid: { amount: 300, count: 7 },
			qbTaxMismatchCount: 3,
			qbAttentionCount: 5,
		});
		expect(vi.mocked(getQBStatus)).toHaveBeenCalledTimes(1);
		const outstanding = JSON.stringify(fake.invoice.aggregate.mock.calls[0][0].where);
		expect(outstanding).toContain('"notIn":["Paid","Void"]');
		expect(JSON.stringify(fake.invoice.aggregate.mock.calls[1][0].where)).toContain(
			'"due_date":{"lt"',
		);
		expect(JSON.stringify(fake.invoice.aggregate.mock.calls[2][0].where)).toContain('"status":"Paid"');
	});
});
