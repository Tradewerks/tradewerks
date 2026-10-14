/**
 * Both row kinds from one call, ranked by money rather than by how many
 * times a name was typed. A dismissed name leaves the queue AND coverage,
 * because the point of the terminal state is that the number can reach 100%.
 *
 * Harness mirrors linkageBackfill.test.ts: full db.js mock, $transaction
 * runs the callback, assertions on what reached Prisma.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	getReconcileQueue,
	dismissUnmappedName,
	restoreUnmappedName,
	approveProvisionalItem,
} from "../inventoryController.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		inventory_item: {
			findFirst: vi.fn(),
			findMany: vi.fn(),
			updateMany: vi.fn(),
			create: vi.fn(),
			delete: vi.fn(),
		},
		unmapped_part_decision: {
			upsert: vi.fn(),
			deleteMany: vi.fn(),
			findMany: vi.fn().mockResolvedValue([]),
		},
		// The queue asks which field purchases put these parts here; no receipt
		// behind a row is the ordinary case, so the default is empty.
		field_purchase_line: { findMany: vi.fn().mockResolvedValue([]) },
		$queryRaw: vi.fn(),
		$transaction: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

// Async factory, not `require`: this file is ESM under vitest, so a CJS require
// throws — silently, until something in the module under test actually called
// getScopedDb and the error came back as a generic "failed to build".
vi.mock("../../lib/context.js", async () => {
	const { db } = await import("../../db.js");
	return { getScopedDb: vi.fn(() => db) };
});

const mockLogActivity = vi.fn().mockResolvedValue(undefined);
vi.mock("../../services/logger.js", () => ({
	logActivity: (...args: unknown[]) => mockLogActivity(...args),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../../services/lowStockAlerts.js", () => ({
	sendLowStockAlert: vi.fn().mockResolvedValue(undefined),
}));

const mockRecordMovements = vi.fn().mockResolvedValue({ lowStockItemIds: [] });
vi.mock("../../services/stockMovements.js", () => ({
	recordMovements: (...args: unknown[]) => mockRecordMovements(...args),
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
const DISPATCHER = "disp-1";

/** Shape enough of Prisma.Sql to inspect what actually reached $queryRaw. */
type SqlLike = { strings: string[]; values: unknown[] };

type ProvisionalRow = {
	id: string;
	name: string;
	origin: string;
	cost: number | null;
	unit_price: number | null;
	unit: string;
	low_stock_threshold: number | null;
	created_at: Date;
	created_by_tech: { id: string; name: string } | null;
	vehicle_stocks: { qty_on_hand: number; vehicle: { id: string; name: string } }[];
};

const provisionalRow = (
	row: Partial<ProvisionalRow> & { id: string; name: string },
): ProvisionalRow => ({
	origin: "dispatch_quick_add",
	cost: null,
	unit_price: null,
	unit: "each",
	low_stock_threshold: null,
	created_at: new Date("2026-08-01T00:00:00Z"),
	created_by_tech: null,
	vehicle_stocks: [],
	...row,
});

/** Audit counts, audit candidate names, then per-provisional line totals. */
function setQueue(opts: {
	counts?: { entity: string; linked: bigint; unmapped: bigint }[];
	names?: {
		name: string;
		lines: bigint;
		value: number;
		entities: string[];
		name_total: bigint;
		value_total: number;
	}[];
	provisional?: ProvisionalRow[];
	itemTotals?: { item_id: string; lines: bigint; value: number }[];
}) {
	mockDb.$queryRaw
		.mockResolvedValueOnce(opts.counts ?? [])
		.mockResolvedValueOnce(opts.names ?? [])
		.mockResolvedValueOnce(opts.itemTotals ?? []);
	// Keyed on `where`, not on call order: the provisional half reads
	// inventory_item twice - once for the ids it ranks, once to hydrate the page -
	// on top of the audit's catalog read, so an ordered mock hands the later calls
	// undefined.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mockDb.inventory_item.findMany.mockImplementation((async (args: any) => {
		const where = args?.where ?? {};
		// Only the audit's catalog read asks for non-provisional rows.
		if (where.provisional === false) return [];
		const rows = opts.provisional ?? [];
		const ids: string[] | undefined = where.id?.in;
		// Answered in table order rather than in id order, because an SQL `IN`
		// makes no promise about matching the list it was given.
		return ids ? rows.filter((r) => ids.includes(r.id)) : rows;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	}) as any);
}

describe("getReconcileQueue", () => {
	beforeEach(() => {
		// mockReset, not just clearAllMocks: setQueue queues per-call values with
		// mockResolvedValueOnce, and clearAllMocks leaves an unconsumed queue
		// behind for the next test to read in the wrong order.
		vi.clearAllMocks();
		mockDb.$queryRaw.mockReset();
		mockDb.inventory_item.findMany.mockReset();
		mockDb.unmapped_part_decision.findMany.mockReset().mockResolvedValue([]);
	});

	it("returns both row kinds from one call", async () => {
		setQueue({
			counts: [{ entity: "quote", linked: 8n, unmapped: 2n }],
			names: [
				{
					name: "Mystery Coil",
					lines: 2n,
					value: 480,
					entities: ["quote"],
					name_total: 1n,
					value_total: 480,
				},
			],
			provisional: [provisionalRow({ id: "item-1", name: "Field Compressor" })],
			itemTotals: [{ item_id: "item-1", lines: 3n, value: 2400 }],
		});

		const result = await getReconcileQueue(ORG);

		expect(result.queue!.unmapped.map((u) => u.name)).toEqual(["Mystery Coil"]);
		expect(result.queue!.provisional.map((p) => [p.name, p.lines, p.value])).toEqual([
			["Field Compressor", 3, 2400],
		]);
	});

	it("ranks provisional rows by summed line value, not by age", async () => {
		setQueue({
			provisional: [
				provisionalRow({
					id: "cheap",
					name: "Grommet",
					created_at: new Date("2026-08-19T00:00:00Z"),
				}),
				provisionalRow({
					id: "dear",
					name: "Compressor",
					created_at: new Date("2026-08-01T00:00:00Z"),
				}),
			],
			itemTotals: [
				{ item_id: "cheap", lines: 9n, value: 36 },
				{ item_id: "dear", lines: 1n, value: 2400 },
			],
		});

		const result = await getReconcileQueue(ORG);

		// Nine cheap lines must not outrank one expensive one.
		expect(result.queue!.provisional.map((p) => p.name)).toEqual(["Compressor", "Grommet"]);
	});

	it("falls back to newest first when two provisional rows bill nothing yet", async () => {
		setQueue({
			provisional: [
				provisionalRow({
					id: "old",
					name: "Older",
					created_at: new Date("2026-08-01T00:00:00Z"),
				}),
				provisionalRow({
					id: "new",
					name: "Newer",
					created_at: new Date("2026-08-19T00:00:00Z"),
				}),
			],
		});

		const result = await getReconcileQueue(ORG);

		expect(result.queue!.provisional.map((p) => p.name)).toEqual(["Newer", "Older"]);
	});

	it("reports the whole provisional backlog, not the page it returned", async () => {
		setQueue({
			provisional: [
				provisionalRow({ id: "a", name: "A" }),
				provisionalRow({ id: "b", name: "B" }),
				provisionalRow({ id: "c", name: "C" }),
			],
			itemTotals: [
				{ item_id: "a", lines: 1n, value: 300 },
				{ item_id: "b", lines: 1n, value: 200 },
				{ item_id: "c", lines: 1n, value: 100 },
			],
		});

		const result = await getReconcileQueue(ORG, { limit: 2 });

		// The count and the money are what the dispatcher acts on; capping them to
		// the page under-reports off-catalog spend without saying so.
		expect(result.queue!.provisional).toHaveLength(2);
		expect(result.queue!.provisional_total).toBe(3);
		expect(result.queue!.provisional_value).toBe(600);
	});

	it("ranks the whole backlog before it takes a page, and holds that order through the hydrate", async () => {
		setQueue({
			// Neither value order nor the order the hydrate answers in.
			provisional: [
				provisionalRow({ id: "c", name: "C" }),
				provisionalRow({ id: "b", name: "B" }),
				provisionalRow({ id: "a", name: "A" }),
			],
			itemTotals: [
				{ item_id: "a", lines: 1n, value: 300 },
				{ item_id: "b", lines: 1n, value: 200 },
				{ item_id: "c", lines: 1n, value: 100 },
			],
		});

		const result = await getReconcileQueue(ORG, { limit: 2, sort: "value_desc" });

		// Slicing first would have kept C and B; trusting the hydrate's own order
		// would have put B before A.
		expect(result.queue!.provisional.map((p) => p.item_id)).toEqual(["a", "b"]);
	});

	it("breaks a dead-even tie on id so the page cannot reshuffle between requests", async () => {
		setQueue({
			provisional: [
				provisionalRow({ id: "z", name: "Same" }),
				provisionalRow({ id: "a", name: "Same" }),
			],
		});

		const result = await getReconcileQueue(ORG);

		// Equal value and equal age: with no last resort the order is whatever the
		// database felt like returning, and row 50 lands on two different pages.
		expect(result.queue!.provisional.map((p) => p.item_id)).toEqual(["a", "z"]);
	});

	it("reports a provisional row with no lines pointing at it as zero, not undefined", async () => {
		setQueue({ provisional: [provisionalRow({ id: "item-1", name: "Orphan" })] });

		const result = await getReconcileQueue(ORG);

		expect(result.queue!.provisional[0]).toMatchObject({ lines: 0, value: 0 });
	});

	it("skips the line-totals query entirely when there are no provisional rows", async () => {
		setQueue({ counts: [{ entity: "quote", linked: 1n, unmapped: 0n }] });

		await getReconcileQueue(ORG);

		// Two audit queries only — no third round trip for an empty id list.
		expect(mockDb.$queryRaw).toHaveBeenCalledTimes(2);
	});

	it("computes coverage from the audit counts", async () => {
		setQueue({
			counts: [
				{ entity: "quote", linked: 3n, unmapped: 1n },
				{ entity: "invoice", linked: 5n, unmapped: 1n },
			],
		});

		const result = await getReconcileQueue(ORG);

		expect(result.queue!.coverage).toEqual({ linked: 8, unmapped: 2, total: 10, pct: 80 });
	});

	// An org that has never billed a material line is at 100%, not 0%: there is
	// nothing unmapped, and reading 0% would send someone hunting for a backlog
	// that doesn't exist.
	it("reads an org with no material lines as fully covered", async () => {
		setQueue({});

		const result = await getReconcileQueue(ORG);

		expect(result.queue!.coverage).toEqual({ linked: 0, unmapped: 0, total: 0, pct: 100 });
	});

	it("excludes dismissed names from coverage by scoping the counts query", async () => {
		setQueue({ counts: [{ entity: "quote", linked: 4n, unmapped: 0n }] });

		const result = await getReconcileQueue(ORG);

		const countsSql = mockDb.$queryRaw.mock.calls[0]![0] as unknown as SqlLike;
		expect(countsSql.strings.join("")).toContain("unmapped_part_decision");
		// A dismissed name contributes nothing to either side of the ratio, so
		// the queue can actually reach empty.
		expect(result.queue!.coverage.pct).toBe(100);
	});

	it("withholds the dismissed list unless it is asked for", async () => {
		setQueue({});

		const result = await getReconcileQueue(ORG);

		expect(result.queue!.dismissed).toEqual([]);
		expect(mockDb.unmapped_part_decision.findMany).not.toHaveBeenCalled();
	});

	it("returns who dismissed each name and when, on request", async () => {
		setQueue({});
		mockDb.unmapped_part_decision.findMany.mockResolvedValue([
			{
				folded_name: "trip charge",
				decided_at: new Date("2026-08-20T12:00:00Z"),
				reason: "Never stocked",
				decided_by: { id: DISPATCHER, name: "Dana" },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any,
		]);

		const result = await getReconcileQueue(ORG, { includeDismissed: true });

		expect(result.queue!.dismissed).toEqual([
			{
				folded_name: "trip charge",
				decided_at: new Date("2026-08-20T12:00:00Z"),
				decided_by: { id: DISPATCHER, name: "Dana" },
				reason: "Never stocked",
			},
		]);
	});

	it("filters provisional rows by origin, bound as a where clause", async () => {
		setQueue({
			provisional: [
				provisionalRow({ id: "item-1", name: "Tech Part", origin: "tech_submission" }),
			],
		});

		await getReconcileQueue(ORG, { origin: "tech_submission" });

		expect(mockDb.inventory_item.findMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					organization_id: ORG,
					provisional: true,
					origin: "tech_submission",
				}),
			}),
		);
	});

	it("rejects an origin that isn't in the enum instead of querying with it", async () => {
		const result = await getReconcileQueue(ORG, { origin: "'; DROP TABLE inventory_item; --" });

		expect(result.err).toContain("unknown origin");
		expect(mockDb.$queryRaw).not.toHaveBeenCalled();
	});

	it("binds the org id in the provisional line-totals query rather than interpolating it", async () => {
		setQueue({
			provisional: [provisionalRow({ id: "item-1", name: "Part" })],
			itemTotals: [{ item_id: "item-1", lines: 1n, value: 5 }],
		});

		await getReconcileQueue(ORG);

		const totalsSql = mockDb.$queryRaw.mock.calls[2]![0] as unknown as SqlLike;
		expect(totalsSql.strings.join("")).not.toContain(ORG);
		expect(totalsSql.values).toContain(ORG);
		expect(totalsSql.values).toContainEqual(["item-1"]);
	});

	it("surfaces an audit failure as its own error rather than a half-built queue", async () => {
		mockDb.$queryRaw.mockRejectedValueOnce(new Error("connection lost"));

		const result = await getReconcileQueue(ORG);

		expect(result.err).toBe("Failed to build inventory linkage audit");
		expect(result.queue).toBeUndefined();
	});
});

describe("dismissUnmappedName", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.unmapped_part_decision.upsert.mockResolvedValue({
			id: "dec-1",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any);
	});

	it("folds the name the same way the matcher does, and attributes the decision", async () => {
		await dismissUnmappedName(
			{ name: "  Trip Charge  ", reason: "Never stocked" },
			ORG,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			{ dispatcherId: DISPATCHER } as any,
		);

		expect(mockDb.unmapped_part_decision.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					organization_id_folded_name: {
						organization_id: ORG,
						folded_name: "trip charge",
					},
				},
				create: expect.objectContaining({
					folded_name: "trip charge",
					decided_by_id: DISPATCHER,
					reason: "Never stocked",
				}),
			}),
		);
	});

	// Upsert rather than create: clicking twice re-stamps who decided instead of
	// failing on the unique index.
	it("re-stamps the decision on a second dismissal of the same name", async () => {
		await dismissUnmappedName({ name: "Trip Charge" }, ORG);

		const call = mockDb.unmapped_part_decision.upsert.mock.calls[0]![0] as {
			update: Record<string, unknown>;
		};
		expect(call.update).toMatchObject({ decided_by_id: null, reason: null });
		expect(call.update.decided_at).toBeInstanceOf(Date);
	});

	it("logs the dismissal so a waved-through name is auditable", async () => {
		await dismissUnmappedName({ name: "Trip Charge" }, ORG);

		expect(mockLogActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "unmapped_part.dismissed",
				entity_type: "unmapped_part_decision",
				entity_id: "dec-1",
				organization_id: ORG,
			}),
		);
	});

	it("refuses an empty name", async () => {
		const result = await dismissUnmappedName({ name: "   " }, ORG);

		expect(result.err).toContain("Validation failed");
		expect(mockDb.unmapped_part_decision.upsert).not.toHaveBeenCalled();
	});
});

describe("restoreUnmappedName", () => {
	beforeEach(() => vi.clearAllMocks());

	it("deletes the decision for the folded name, scoped to the org", async () => {
		mockDb.unmapped_part_decision.deleteMany.mockResolvedValue({ count: 1 });

		const result = await restoreUnmappedName({ name: "Trip Charge" }, ORG);

		expect(result.err).toBeUndefined();
		expect(mockDb.unmapped_part_decision.deleteMany).toHaveBeenCalledWith({
			where: { organization_id: ORG, folded_name: "trip charge" },
		});
	});

	it("reports a name that was never dismissed as not found", async () => {
		mockDb.unmapped_part_decision.deleteMany.mockResolvedValue({ count: 0 });

		const result = await restoreUnmappedName({ name: "Trip Charge" }, ORG);

		expect(result.err).toBe("Decision not found");
		expect(mockLogActivity).not.toHaveBeenCalled();
	});
});

describe("approveProvisionalItem — adopting needs a cost basis", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockDb.$transaction.mockImplementation(async (cb: any) => cb(mockDb));
		mockDb.inventory_item.updateMany.mockResolvedValue({ count: 1 });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockDb.inventory_item.findFirst.mockResolvedValue({ id: "item-1", cost: null } as any);
	});

	it("refuses to adopt an item with no cost, on the row or in the payload", async () => {
		const result = await approveProvisionalItem("item-1", ORG, {});

		expect(result.err).toBe(
			"Validation failed: cost is required to adopt an item into the catalog",
		);
		// Nothing may be written: a half-adopted item is worse than a queued one.
		expect(mockDb.inventory_item.updateMany).not.toHaveBeenCalled();
	});

	it("accepts a cost supplied at adopt time and writes it alongside the promotion", async () => {
		await approveProvisionalItem("item-1", ORG, {
			cost: 42.5,
			unit: "each",
			low_stock_threshold: 4,
		});

		expect(mockDb.inventory_item.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					provisional: false,
					cost: 42.5,
					unit: "each",
					low_stock_threshold: 4,
				}),
			}),
		);
	});

	it("accepts an item that already carries a cost, with no cost in the payload", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockDb.inventory_item.findFirst.mockResolvedValue({ id: "item-1", cost: 12 } as any);

		const result = await approveProvisionalItem("item-1", ORG, {});

		expect(result.err).toBeUndefined();
		expect(mockDb.inventory_item.updateMany).toHaveBeenCalled();
	});

	it("normalises the adopted unit through the catalog rather than storing freetext", async () => {
		await approveProvisionalItem("item-1", ORG, { cost: 1, unit: "Gallon" });

		const call = mockDb.inventory_item.updateMany.mock.calls[0]![0] as {
			data: { unit?: string };
		};
		expect(call.data.unit).toBe("gal");
	});

	it("still reports a missing provisional row as not found", async () => {
		mockDb.inventory_item.findFirst.mockResolvedValue(null);

		const result = await approveProvisionalItem("item-1", ORG, { cost: 5 });

		expect(result.err).toBe("Provisional item not found");
	});
});
