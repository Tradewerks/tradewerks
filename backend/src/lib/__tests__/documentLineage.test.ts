import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted, not a module-scope object: vitest's ESM mock factory below is
// hoisted above plain module scope and cannot see a const declared here.
const { mockDb } = vi.hoisted(() => {
	const mockDb = {
		$queryRaw: vi.fn(),
		invoice: {
			findFirst: vi.fn(),
			findMany: vi.fn(),
		},
	};
	return { mockDb };
});

vi.mock("../context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
}));

import { shapeLineage, resolveDocumentLineage } from "../documentLineage.js";

const node = (v: number, status = "Sent") => ({
	id: `q${v}`,
	number: `QUO-100${v}`,
	version: v,
	status,
});

describe("shapeLineage", () => {
	it("places the viewed document in a chain and names the tail", () => {
		const result = shapeLineage(
			"quote",
			"q2",
			[
				node(1, "Revised"),
				node(2, "Revised"),
				node(3, "Revised"),
				node(4),
			],
			null,
			[],
		);

		expect(result).not.toBeNull();
		expect(result!.self_version).toBe(2);
		expect(result!.latest_version).toBe(4);
		expect(result!.successor!.id).toBe("q3");
		expect(result!.final.id).toBe("q4");
		expect(result!.final_is_live).toBe(true);
		expect(result!.truncated_before).toBe(false);
	});

	it("sorts rows by version rather than trusting arrival order", () => {
		const result = shapeLineage(
			"quote",
			"q1",
			[node(3), node(1), node(2)],
			null,
			[],
		);

		expect(result!.chain.map((n) => n.version)).toEqual([1, 2, 3]);
		expect(result!.successor!.version).toBe(2);
	});

	it("reports the tail as itself and has no successor when self is the tail", () => {
		const result = shapeLineage(
			"quote",
			"q3",
			[node(1), node(2), node(3)],
			null,
			[],
		);

		expect(result!.final.id).toBe("q3");
		expect(result!.successor).toBeNull();
	});

	// A deleted head SetNulls the successor's pointer, so the walk legitimately
	// starts above version 1. The band must say so instead of implying v3 is v1.
	it("flags a chain whose oldest resolved hop is not version 1", () => {
		const result = shapeLineage(
			"quote",
			"q3",
			[node(3), node(4)],
			null,
			[],
		);

		expect(result!.truncated_before).toBe(true);
		expect(result!.self_version).toBe(3);
		expect(result!.latest_version).toBe(4);
	});

	it("marks a terminal tail as not live, per document kind", () => {
		const quote = shapeLineage(
			"quote",
			"q1",
			[node(1), node(2, "Cancelled")],
			null,
			[],
		);
		expect(quote!.final_is_live).toBe(false);

		const invoice = shapeLineage(
			"invoice",
			"i1",
			[
				{ id: "i1", number: "INV-1001", version: 1, status: "Sent" },
				{ id: "i2", number: "INV-1002", version: 2, status: "Void" },
			],
			null,
			[],
		);
		expect(invoice!.final_is_live).toBe(false);
	});

	// "Cancelled" is terminal for a quote but is not an invoice status at all;
	// one shared dead-status list would wrongly kill a live invoice.
	it("does not apply the quote terminal list to invoices", () => {
		const result = shapeLineage(
			"invoice",
			"i1",
			[
				{ id: "i1", number: "INV-1001", version: 1, status: "Sent" },
				{
					id: "i2",
					number: "INV-1002",
					version: 2,
					status: "PartiallyPaid",
				},
			],
			null,
			[],
		);

		expect(result!.final_is_live).toBe(true);
	});

	it("returns null when the viewed document is absent from the rows", () => {
		expect(
			shapeLineage("quote", "q9", [node(1), node(2)], null, []),
		).toBeNull();
	});

	it("carries the adjustment axis through untouched", () => {
		const root = {
			id: "i1",
			number: "INV-1001",
			version: 1,
			status: "Sent",
		};
		const adj = {
			id: "i9",
			number: "INV-1009",
			version: 1,
			status: "Sent",
		};
		const result = shapeLineage("invoice", "i9", [adj], root, []);

		expect(result!.adjusts).toEqual(root);
		expect(result!.adjustments).toEqual([]);
		expect(result!.final.id).toBe("i9");
	});
});

describe("resolveDocumentLineage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.$queryRaw.mockResolvedValue([]);
		mockDb.invoice.findFirst.mockResolvedValue({ adjusts_invoice: null });
		mockDb.invoice.findMany.mockResolvedValue([]);
	});

	// getScopedDb rewrites `where` on model operations only — it does NOT touch
	// $queryRaw. Every term of the recursion must carry the predicate itself, or
	// one organization can walk another's chain.
	it("puts an organization_id predicate in every term of the recursion", async () => {
		await resolveDocumentLineage("quote", "q2", "org1");

		const [strings, ...values] = mockDb.$queryRaw.mock.calls[0];
		const sql = (strings as unknown as string[]).join("?");
		// Per fragment, not a whole-query count: a count can't tell a
		// predicate dropped from the recursive term apart from a redundant
		// mention elsewhere that happens to keep the total the same.
		const fragments = sql.split("UNION ALL");
		expect(fragments.length).toBeGreaterThanOrEqual(3);
		for (const fragment of fragments) {
			expect(fragment).toMatch(/organization_id/);
		}
		expect(
			values.filter((v) => v === "org1").length,
		).toBeGreaterThanOrEqual(4);
	});

	it("caps the recursion so a self-referencing row cannot loop forever", async () => {
		await resolveDocumentLineage("quote", "q2", "org1");

		const [strings] = mockDb.$queryRaw.mock.calls[0];
		expect((strings as unknown as string[]).join("?")).toMatch(
			/depth < 50/,
		);
	});

	it("queries the quote table for a quote and the invoice table for an invoice", async () => {
		await resolveDocumentLineage("quote", "q2", "org1");
		expect(
			(mockDb.$queryRaw.mock.calls[0][0] as unknown as string[]).join(
				"?",
			),
		).toMatch(/FROM quote/);

		vi.clearAllMocks();
		mockDb.$queryRaw.mockResolvedValue([]);
		mockDb.invoice.findFirst.mockResolvedValue({ adjusts_invoice: null });
		mockDb.invoice.findMany.mockResolvedValue([]);

		await resolveDocumentLineage("invoice", "i2", "org1");
		expect(
			(mockDb.$queryRaw.mock.calls[0][0] as unknown as string[]).join(
				"?",
			),
		).toMatch(/FROM invoice/);
	});

	it("resolves both adjustment directions for an invoice", async () => {
		mockDb.$queryRaw.mockResolvedValue([
			{ id: "i1", number: "INV-1001", version: 1, status: "Sent" },
		]);
		mockDb.invoice.findFirst.mockResolvedValue({
			adjusts_invoice: {
				id: "i0",
				invoice_number: "INV-1000",
				version: 1,
				status: "Sent",
			},
		});
		mockDb.invoice.findMany.mockResolvedValue([
			{
				id: "i5",
				invoice_number: "INV-1005",
				version: 1,
				status: "Sent",
			},
		]);

		const result = await resolveDocumentLineage("invoice", "i1", "org1");

		expect(result!.adjusts).toEqual({
			id: "i0",
			number: "INV-1000",
			version: 1,
			status: "Sent",
		});
		expect(result!.adjustments).toEqual([
			{ id: "i5", number: "INV-1005", version: 1, status: "Sent" },
		]);
	});

	it("does not touch the invoice table when resolving a quote", async () => {
		await resolveDocumentLineage("quote", "q2", "org1");

		expect(mockDb.invoice.findFirst).not.toHaveBeenCalled();
		expect(mockDb.invoice.findMany).not.toHaveBeenCalled();
	});

	it("returns null when the document does not exist", async () => {
		mockDb.$queryRaw.mockResolvedValue([]);

		expect(
			await resolveDocumentLineage("quote", "nope", "org1"),
		).toBeNull();
	});
});
