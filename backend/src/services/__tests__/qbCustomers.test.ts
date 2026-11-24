const { mappings, fakeDb, sdb, syncLog } = vi.hoisted(() => {
	// In-memory client_external_mapping enforcing both real uniques, so a
	// concurrent writer surfaces as P2002 exactly as Postgres would report it.
	type Row = {
		client_id: string;
		provider: string;
		account_id: string;
		external_id: string;
	};
	const mappings: Row[] = [];
	type Where = Partial<Omit<Row, "client_id">> & {
		client_id?: string | { not: string };
	};
	const matches = (row: Row, where: Where) =>
		(where.provider === undefined || row.provider === where.provider) &&
		(where.account_id === undefined ||
			row.account_id === where.account_id) &&
		(where.external_id === undefined ||
			row.external_id === where.external_id) &&
		(where.client_id === undefined ||
			(typeof where.client_id === "string"
				? row.client_id === where.client_id
				: row.client_id !== where.client_id.not));
	const fakeDb = {
		client_external_mapping: {
			findFirst: vi.fn(async ({ where }: { where: Where }) => {
				return mappings.find((r) => matches(r, where)) ?? null;
			}),
			create: vi.fn(async ({ data }: { data: Row }) => {
				const clash = mappings.some(
					(r) =>
						r.provider === data.provider &&
						r.account_id === data.account_id &&
						(r.external_id === data.external_id ||
							r.client_id === data.client_id),
				);
				if (clash)
					throw Object.assign(new Error("Unique constraint failed"), {
						code: "P2002",
					});
				mappings.push({ ...data });
				return { id: `m${mappings.length}`, ...data };
			}),
		},
	};
	return {
		mappings,
		fakeDb,
		sdb: {
			client: { findFirst: vi.fn() },
			invoice_payment: {
				findFirst: vi.fn(),
				update: vi.fn(async () => ({})),
			},
		},
		syncLog: {
			logExternalSync: vi.fn(async () => {}),
			countPaymentPushHttpFailures: vi.fn(async () => 0),
		},
	};
});

vi.mock("../entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
}));
vi.mock("../../db.js", () => ({ db: fakeDb }));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => sdb) }));
vi.mock("../quickbooksService.js", () => ({
	qbFetch: vi.fn(),
	getOrgRealmId: vi.fn(async () => "realm1"),
	getValidToken: vi.fn(),
	QB_BASE: "https://qb.invalid",
}));
vi.mock("../qb/qbInvoices.js", () => ({ pushInvoice: vi.fn() }));
vi.mock("../invoiceService.js", () => ({ syncInvoicePaymentTotals: vi.fn() }));
vi.mock("../qb/qbSyncLog.js", () => syncLog);

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureQBCustomerForClient } from "../qb/qbCustomers.js";
import { pushPaymentToQB } from "../qb/qbPayments.js";
import { qbFetch } from "../quickbooksService.js";
import { QbHttpError } from "../qb/qbHttpError.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const FIRST = {
	id: "aaaaaaaa-0000-4000-8000-000000000001",
	name: "John Smith",
};
const SECOND = {
	id: "1a2b3c4d-0000-4000-8000-000000000002",
	name: "John Smith",
};
const THIRD = {
	id: "9f8e7d6c-0000-4000-8000-000000000003",
	name: "John Smith",
};

/** Fake QuickBooks company: DisplayName is unique, as QB enforces it. */
let qbCustomers: Map<string, string>;
let nextQbId: number;

function queriedName(path: string): string {
	const sql = decodeURIComponent(path.slice(path.indexOf("query=") + 6));
	const m = /DisplayName = '((?:\\'|[^'])*)'/.exec(sql);
	if (!m) throw new Error(`unexpected query ${sql}`);
	return m[1].replace(/\\'/g, "'");
}

function fakeQuickBooks() {
	mockFn(qbFetch).mockImplementation(
		async (
			_org: string,
			method: string,
			path: string,
			body?: { DisplayName?: string },
		) => {
			if (method === "GET" && path.startsWith("/query?")) {
				const id = qbCustomers.get(queriedName(path));
				return { QueryResponse: id ? { Customer: [{ Id: id }] } : {} };
			}
			if (method === "POST" && path === "/customer") {
				const name = body!.DisplayName!;
				if (qbCustomers.has(name)) {
					throw new QbHttpError(
						"POST",
						"/customer",
						400,
						'{"Fault":{"Error":[{"Message":"Duplicate Name Exists Error","code":"6240"}],"type":"ValidationFault"}}',
					);
				}
				const id = `qb-${nextQbId++}`;
				qbCustomers.set(name, id);
				return { Customer: { Id: id, DisplayName: name } };
			}
			if (method === "POST" && path === "/payment") {
				return { Payment: { Id: "qb-pay-1" } };
			}
			throw new Error(`unexpected ${method} ${path}`);
		},
	);
}

function createdNames(): string[] {
	return mockFn(qbFetch)
		.mock.calls.filter((c) => c[1] === "POST" && c[2] === "/customer")
		.map((c) => (c[3] as { DisplayName: string }).DisplayName);
}

describe("ensureQBCustomerForClient", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mappings.length = 0;
		qbCustomers = new Map();
		nextQbId = 100;
		fakeQuickBooks();
	});

	it("reuses the existing mapping without calling QuickBooks", async () => {
		mappings.push({
			client_id: FIRST.id,
			provider: "quickbooks",
			account_id: "realm1",
			external_id: "qb-7",
		});

		await expect(
			ensureQBCustomerForClient("org1", FIRST, "realm1"),
		).resolves.toBe("qb-7");
		expect(qbFetch).not.toHaveBeenCalled();
	});

	it("adopts an unmapped QuickBooks customer with the same DisplayName", async () => {
		qbCustomers.set("John Smith", "qb-55");

		await expect(
			ensureQBCustomerForClient("org1", FIRST, "realm1"),
		).resolves.toBe("qb-55");
		expect(createdNames()).toEqual([]);
		expect(mappings).toEqual([
			{
				client_id: FIRST.id,
				provider: "quickbooks",
				account_id: "realm1",
				external_id: "qb-55",
			},
		]);
	});

	it('creates "John Smith (1a2b3c4d)" when "John Smith" is already mapped to another client', async () => {
		qbCustomers.set("John Smith", "qb-55");
		mappings.push({
			client_id: FIRST.id,
			provider: "quickbooks",
			account_id: "realm1",
			external_id: "qb-55",
		});

		const id = await ensureQBCustomerForClient("org1", SECOND, "realm1");

		expect(createdNames()).toEqual(["John Smith (1a2b3c4d)"]);
		expect(id).toBe(qbCustomers.get("John Smith (1a2b3c4d)"));
		expect(mappings).toContainEqual({
			client_id: SECOND.id,
			provider: "quickbooks",
			account_id: "realm1",
			external_id: id,
		});
	});

	it("a third same-name client gets its own suffixed customer", async () => {
		const first = await ensureQBCustomerForClient("org1", FIRST, "realm1");
		const second = await ensureQBCustomerForClient(
			"org1",
			SECOND,
			"realm1",
		);
		const third = await ensureQBCustomerForClient("org1", THIRD, "realm1");

		expect(new Set([first, second, third]).size).toBe(3);
		expect(createdNames()).toEqual([
			"John Smith",
			"John Smith (1a2b3c4d)",
			"John Smith (9f8e7d6c)",
		]);
		expect(mappings.map((m) => m.client_id)).toEqual([
			FIRST.id,
			SECOND.id,
			THIRD.id,
		]);
	});

	it("extends the suffix when the suffixed name is already taken in QuickBooks", async () => {
		qbCustomers.set("John Smith", "qb-55");
		mappings.push({
			client_id: FIRST.id,
			provider: "quickbooks",
			account_id: "realm1",
			external_id: "qb-55",
		});
		// A user-created customer already holds the 8-char suffix, mapped to someone else.
		qbCustomers.set("John Smith (1a2b3c4d)", "qb-56");
		mappings.push({
			client_id: "other",
			provider: "quickbooks",
			account_id: "realm1",
			external_id: "qb-56",
		});

		const id = await ensureQBCustomerForClient("org1", SECOND, "realm1");

		expect(createdNames()).toEqual(["John Smith (1a2b3c4d-0000)"]);
		expect(id).toBe(qbCustomers.get("John Smith (1a2b3c4d-0000)"));
	});

	it("a duplicate-name rejection from a concurrent create adopts the winner instead of creating twice", async () => {
		let raced = false;
		const base = mockFn(qbFetch).getMockImplementation()!;
		mockFn(qbFetch).mockImplementation(async (...args: unknown[]) => {
			// Another push for the same client creates "John Smith" between our query and our create.
			if (!raced && args[1] === "POST" && args[2] === "/customer") {
				raced = true;
				qbCustomers.set("John Smith", "qb-race");
			}
			return base(...args);
		});

		await expect(
			ensureQBCustomerForClient("org1", FIRST, "realm1"),
		).resolves.toBe("qb-race");
		expect(qbCustomers.size).toBe(1);
	});

	it("a concurrent mapping write for the same client returns the winner's customer", async () => {
		qbCustomers.set("John Smith", "qb-55");
		fakeDb.client_external_mapping.create.mockImplementationOnce(
			async () => {
				mappings.push({
					client_id: FIRST.id,
					provider: "quickbooks",
					account_id: "realm1",
					external_id: "qb-55",
				});
				throw Object.assign(new Error("Unique constraint failed"), {
					code: "P2002",
				});
			},
		);

		await expect(
			ensureQBCustomerForClient("org1", FIRST, "realm1"),
		).resolves.toBe("qb-55");
	});

	it("throws when the QuickBooks query returns 500", async () => {
		mockFn(qbFetch).mockRejectedValue(
			new QbHttpError("GET", "/query", 500, "boom"),
		);

		await expect(
			ensureQBCustomerForClient("org1", FIRST, "realm1"),
		).rejects.toThrow(/500/);
		expect(createdNames()).toEqual([]);
	});

	it("does not swallow a mapping write failure", async () => {
		fakeDb.client_external_mapping.create.mockRejectedValueOnce(
			new Error("connection reset"),
		);

		await expect(
			ensureQBCustomerForClient("org1", FIRST, "realm1"),
		).rejects.toThrow("connection reset");
	});
});

describe("pushPaymentToQB customer resolution", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mappings.length = 0;
		qbCustomers = new Map();
		nextQbId = 100;
		fakeQuickBooks();
	});

	it('payment push resolves a missing mapping instead of failing with "Customer not found in QuickBooks"', async () => {
		// "John Smith" already belongs to the first client; the second's mapping is missing.
		qbCustomers.set("John Smith", "qb-55");
		mappings.push({
			client_id: FIRST.id,
			provider: "quickbooks",
			account_id: "realm1",
			external_id: "qb-55",
		});
		sdb.invoice_payment.findFirst.mockResolvedValue({
			id: "pay1",
			amount: 40,
			paid_at: new Date("2026-11-20T15:00:00Z"),
			qb_payment_id: null,
			account_id: null,
			invoice: {
				id: "inv1",
				qb_invoice_id: "158",
				account_id: "realm1",
				client_id: SECOND.id,
				client: {
					id: SECOND.id,
					name: SECOND.name,
					client_external_mapping: [],
				},
			},
		});

		await pushPaymentToQB("pay1", "org1");

		const paymentPost = mockFn(qbFetch).mock.calls.find(
			(c) => c[2] === "/payment",
		)!;
		const ownId = qbCustomers.get("John Smith (1a2b3c4d)");
		expect(ownId).toBeDefined();
		expect(
			(paymentPost[3] as { CustomerRef: { value: string } }).CustomerRef
				.value,
		).toBe(ownId);
		expect(mappings).toContainEqual({
			client_id: SECOND.id,
			provider: "quickbooks",
			account_id: "realm1",
			external_id: ownId,
		});
		expect(sdb.invoice_payment.update).toHaveBeenCalledWith({
			where: { id: "pay1" },
			data: { qb_payment_id: "qb-pay-1", account_id: "realm1" },
		});
	});
});
