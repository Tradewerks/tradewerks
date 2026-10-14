/**
 * getLinkageAudit runs two raw queries plus one catalog read. The SQL is
 * inspected rather than executed, so the assertions are on the Prisma.Sql
 * object: org id bound as a parameter and never interpolated, terminal
 * statuses excluded, invoices deliberately not.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";
import { getLinkageAudit } from "../inventoryController.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const lineItemTable = () => ({ updateMany: vi.fn().mockResolvedValue({ count: 1 }) });
	const mockDb = {
		inventory_item: { findFirst: vi.fn(), findMany: vi.fn() },
		quote_line_item: lineItemTable(),
		job_line_item: lineItemTable(),
		recurring_plan_line_item: lineItemTable(),
		invoice_line_item: lineItemTable(),
		job_visit_line_item: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
		$queryRaw: vi.fn(),
		$transaction: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { db } = require("../../db.js");
		return db;
	}),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../../services/lowStockAlerts.js", () => ({
	sendLowStockAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/stockMovements.js", () => ({
	recordMovements: vi.fn().mockResolvedValue({ lowStockItemIds: [] }),
	InsufficientStockError: class extends Error {},
}));

vi.mock("xlsx", () => ({
	default: {},
	read: vi.fn(),
	utils: {
		sheet_to_json: vi.fn(),
		json_to_sheet: vi.fn(),
		book_new: vi.fn(),
		book_append_sheet: vi.fn(),
		aoa_to_sheet: vi.fn(),
	},
	write: vi.fn(),
}));

import { db } from "../../db.js";
const mockDb = vi.mocked(db);

const ORG = "org-1";

/** Shape enough of Prisma.Sql to inspect what actually reached $queryRaw. */
type SqlLike = { strings: string[]; values: unknown[] };

type CountRow = { entity: string; linked: bigint; unmapped: bigint };
type NameRow = {
	name: string;
	lines: bigint;
	value: unknown;
	entities: string[];
	name_total: bigint;
	value_total: unknown;
};

/** A grouped-name row with the value columns defaulted, so tests state only what they test. */
const nameRow = (row: Partial<NameRow> & { name: string }): NameRow => ({
	lines: 1n,
	value: 0,
	entities: ["quote"],
	name_total: 1n,
	value_total: 0,
	...row,
});
type CatalogRow = { id: string; name: string; sku: string | null; alt_ids: string[] };

function setRows(counts: CountRow[], names: NameRow[]) {
	mockDb.$queryRaw.mockResolvedValueOnce(counts).mockResolvedValueOnce(names);
}

function setCatalog(rows: CatalogRow[]) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mockDb.inventory_item.findMany.mockResolvedValue(rows as any);
}

describe("getLinkageAudit", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setCatalog([]);
	});

	it("converts bigint linked/unmapped counts to numbers and sums total", async () => {
		setRows(
			[
				{ entity: "quote", linked: 3n, unmapped: 2n },
				{ entity: "job", linked: 0n, unmapped: 7n },
			],
			[],
		);

		const result = await getLinkageAudit(ORG);

		expect(result.counts).toEqual([
			{ entity: "quote", linked: 3, unmapped: 2, total: 5 },
			{ entity: "job", linked: 0, unmapped: 7, total: 7 },
		]);
	});

	it("maps a grouped name row into a candidate, passing entities through from ARRAY_AGG", async () => {
		setRows([], [
			nameRow({ name: "Capacitor", lines: 4n, value: 132.5, entities: ["quote", "job"] }),
		]);

		const result = await getLinkageAudit(ORG);

		expect(result.candidates).toEqual([
			{
				name: "Capacitor",
				entities: ["quote", "job"],
				lines: 4,
				value: 132.5,
				match: null,
			},
		]);
	});

	describe("match tiers", () => {
		it("hits exact when the name matches a catalog item verbatim", async () => {
			setRows([], [nameRow({ name: "Capacitor" })]);
			setCatalog([{ id: "item-1", name: "Capacitor", sku: "CAP-1", alt_ids: [] }]);

			const result = await getLinkageAudit(ORG);

			expect(result.candidates![0]!.match).toEqual({
				inventory_item_id: "item-1",
				name: "Capacitor",
				sku: "CAP-1",
				tier: "exact",
			});
		});

		it("falls back to case_insensitive when only casing differs", async () => {
			setRows([], [nameRow({ name: "CAPACITOR" })]);
			setCatalog([{ id: "item-1", name: "Capacitor", sku: null, alt_ids: [] }]);

			const result = await getLinkageAudit(ORG);

			expect(result.candidates![0]!.match).toEqual({
				inventory_item_id: "item-1",
				name: "Capacitor",
				sku: null,
				tier: "case_insensitive",
			});
		});

		it("falls back to code via sku when name matches nothing", async () => {
			setRows([], [nameRow({ name: "CAP-1" })]);
			setCatalog([{ id: "item-1", name: "Capacitor", sku: "CAP-1", alt_ids: [] }]);

			const result = await getLinkageAudit(ORG);

			expect(result.candidates![0]!.match).toEqual({
				inventory_item_id: "item-1",
				name: "Capacitor",
				sku: "CAP-1",
				tier: "code",
			});
		});

		it("falls back to code via alt_ids when name and sku both miss", async () => {
			setRows([], [nameRow({ name: "ALT-CODE" })]);
			setCatalog([{ id: "item-1", name: "Capacitor", sku: null, alt_ids: ["alt-code"] }]);

			const result = await getLinkageAudit(ORG);

			expect(result.candidates![0]!.match).toEqual({
				inventory_item_id: "item-1",
				name: "Capacitor",
				sku: null,
				tier: "code",
			});
		});

		it("returns match: null when nothing in the catalog matches", async () => {
			setRows([], [nameRow({ name: "Mystery Part" })]);
			setCatalog([{ id: "item-1", name: "Capacitor", sku: null, alt_ids: [] }]);

			const result = await getLinkageAudit(ORG);

			expect(result.candidates![0]!.match).toBeNull();
		});

		it("prefers exact over a case-insensitive or code hit on the same catalog", async () => {
			setRows([], [nameRow({ name: "Capacitor" })]);
			// "capacitor-lc" folds to the same key a case-insensitive lookup would
			// use, and carries a sku equal to the searched name too — both weaker
			// tiers could claim this row. The exact-name row must still win.
			setCatalog([
				{ id: "fold-or-code-item", name: "capacitor", sku: "Capacitor", alt_ids: [] },
				{ id: "exact-item", name: "Capacitor", sku: null, alt_ids: [] },
			]);

			const result = await getLinkageAudit(ORG);

			expect(result.candidates![0]!.match).toEqual({
				inventory_item_id: "exact-item",
				name: "Capacitor",
				sku: null,
				tier: "exact",
			});
		});
	});

	it("takes candidate_total from the first row's name_total window column", async () => {
		setRows(
			[],
			[
				nameRow({ name: "A", lines: 5n, name_total: 42n }),
				nameRow({ name: "B", lines: 3n, name_total: 42n }),
			],
		);

		const result = await getLinkageAudit(ORG);

		expect(result.candidate_total).toBe(42);
	});

	it("carries the summed line value per name, and the uncapped total from the window", async () => {
		setRows(
			[],
			[
				nameRow({ name: "Compressor", value: 2400, name_total: 9n, value_total: 2711.5 }),
				nameRow({ name: "Grommet", value: 36, name_total: 9n, value_total: 2711.5 }),
			],
		);

		const result = await getLinkageAudit(ORG);

		expect(result.candidates!.map((c) => [c.name, c.value])).toEqual([
			["Compressor", 2400],
			["Grommet", 36],
		]);
		// Value of EVERY unmapped name, not just the two shown — the queue
		// discloses truncation with it.
		expect(result.candidate_value_total).toBe(2711.5);
	});

	it("reads a Decimal value column as a number", async () => {
		// numeric(10,2) arrives as a Prisma Decimal, which JSON.stringify would
		// render as a string while every client type declares number.
		setRows([], [nameRow({ name: "Contactor", value: new Prisma.Decimal("18.75") })]);

		const result = await getLinkageAudit(ORG);

		expect(result.candidates![0]!.value).toBe(18.75);
	});

	it("treats a NULL value sum as zero rather than NaN", async () => {
		setRows([], [nameRow({ name: "Contactor", value: null, value_total: null })]);

		const result = await getLinkageAudit(ORG);

		expect(result.candidates![0]!.value).toBe(0);
		expect(result.candidate_value_total).toBe(0);
	});

	it("candidate_total is 0 when there are no unmapped names", async () => {
		setRows([], []);

		const result = await getLinkageAudit(ORG);

		expect(result.candidate_total).toBe(0);
		expect(result.candidate_value_total).toBe(0);
	});

	describe("SQL scoping — live documents only (hole 7)", () => {
		beforeEach(() => setRows([], []));

		it("scopes the counts query to live documents and binds org id as a parameter", async () => {
			await getLinkageAudit(ORG);

			const sql = mockDb.$queryRaw.mock.calls[0]![0] as unknown as SqlLike;
			const text = sql.strings.join("");

			expect(text).toContain("NOT IN ('Rejected', 'Expired', 'Cancelled')"); // quote
			expect(text).toContain("NOT IN ('Completed', 'Cancelled')"); // recurring_plan
			// job (1) + job_visit (2: visit status and job status) = 3 occurrences.
			expect(text.match(/<> 'Cancelled'/g) ?? []).toHaveLength(3);

			const branches = text.split("UNION ALL");
			const invoiceBranch = branches.find((b) => b.includes("invoice_line_item"));
			expect(invoiceBranch).toBeDefined();
			expect(invoiceBranch).not.toMatch(/status/i);

			expect(text).not.toContain(ORG);
			expect(sql.values).toContain(ORG);
		});

		it("scopes the candidate query the same way and adds the review-queue LIMIT", async () => {
			await getLinkageAudit(ORG);

			const countsSql = mockDb.$queryRaw.mock.calls[0]![0] as unknown as SqlLike;
			const namesSql = mockDb.$queryRaw.mock.calls[1]![0] as unknown as SqlLike;
			const text = namesSql.strings.join("");

			expect(text).toContain("NOT IN ('Rejected', 'Expired', 'Cancelled')");
			expect(text).toContain("NOT IN ('Completed', 'Cancelled')");
			expect(text.match(/<> 'Cancelled'/g) ?? []).toHaveLength(3);

			const branches = text.split("UNION ALL");
			const invoiceBranch = branches.find((b) => b.includes("invoice_line_item"));
			expect(invoiceBranch).toBeDefined();
			expect(invoiceBranch).not.toMatch(/status/i);

			expect(text).not.toContain(ORG);
			expect(namesSql.values).toContain(ORG);

			expect(text).toContain("LIMIT");
			expect(namesSql.values).toContain(200);
			// Ranked by money, not by how many times a name was typed.
			expect(text).toContain("ORDER BY SUM(value) DESC");
			// The exhaustive counts half never truncates — only the review queue does.
			expect(countsSql.strings.join("")).not.toContain("LIMIT");
		});

		it("excludes dismissed names from both halves, with the org id still bound", async () => {
			await getLinkageAudit(ORG);

			for (const call of [0, 1]) {
				const sql = mockDb.$queryRaw.mock.calls[call]![0] as unknown as SqlLike;
				const text = sql.strings.join("");
				expect(text).toContain("unmapped_part_decision");
				expect(text).toContain("lower(trim(li.name))");
				// One bound org id per union branch, plus one per dismissal
				// subquery — never interpolated into the statement text.
				expect(text).not.toContain(ORG);
				expect(sql.values.filter((v) => v === ORG)).toHaveLength(10);
			}
		});
	});

	it("returns a friendly error without throwing when $queryRaw rejects", async () => {
		mockDb.$queryRaw.mockRejectedValueOnce(new Error("connection lost"));

		const result = await getLinkageAudit(ORG);

		expect(result).toEqual({ err: "Failed to build inventory linkage audit" });
	});
});
