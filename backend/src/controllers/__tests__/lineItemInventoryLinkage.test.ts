/**
 * A dispatch edit reconciles visit lines by full replacement. Tech-consumed
 * lines already have a stock_movement pointing at them and are not rendered
 * by the dispatch form, so without an explicit guard every save would wipe
 * them and orphan the ledger.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { updateJobVisit } from "../jobVisitsController.js";
import { db } from "../../db.js";
import type { Request } from "express";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		job_visit: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
		tax_group: { findMany: vi.fn().mockResolvedValue([]) },
		inventory_item: { findMany: vi.fn() },
		$transaction: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../lib/recomputeDocumentTotals.js", () => ({
	recomputeVisitTotals: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../inventoryController.js", () => ({
	deductInventoryForVisit: vi.fn().mockResolvedValue({ lowStockItemIds: [] }),
}));

vi.mock("../../services/lowStockAlerts.js", () => ({
	fireLowStockAlerts: vi.fn().mockResolvedValue(undefined),
	sendLowStockAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/followupTriggers.js", () => ({
	onVisitScheduled: vi.fn().mockResolvedValue(undefined),
	onVisitRescheduled: vi.fn().mockResolvedValue(undefined),
	onVisitCancelled: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/socketService.js", () => ({
	getSocket: vi.fn().mockReturnValue(null),
	emitToOrg: vi.fn(),
}));

vi.mock("../notificationsController.js", () => ({
	createNotification: vi.fn().mockResolvedValue(undefined),
	notifyDispatchers: vi.fn().mockResolvedValue([]),
}));

const ORG = "org-1";
const mockDb = vi.mocked(db);

type ExistingLine = {
	id: string;
	fulfillment_status: "planned" | "used" | "voided" | null;
	inventory_item_id: string | null;
};

function makeRequest(body: object): Request {
	return { params: { id: "visit-1" }, body } as unknown as Request;
}

function setup(existingLines: ExistingLine[], catalogIds: string[] = []) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mockDb.job_visit.findFirst.mockResolvedValue({
		id: "visit-1",
		job_id: "job-1",
		status: "Scheduled",
		name: "Visit 1",
		line_items: existingLines,
		job: { id: "job-1", status: "Scheduled", organization_id: ORG },
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any);

	// The ownership guard runs before the transaction, on the scoped client —
	// same placement as the tax-group guard it mirrors.
	mockDb.inventory_item.findMany.mockResolvedValue(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		catalogIds.map((id) => ({ id })) as any,
	);

	const mockTx = {
		job_visit: {
			update: vi.fn().mockResolvedValue({ id: "visit-1", status: "Scheduled" }),
			findMany: vi.fn().mockResolvedValue([{ id: "visit-1", status: "Scheduled" }]),
			findFirst: vi.fn().mockResolvedValue({
				id: "visit-1",
				status: "Scheduled",
				job: { id: "job-1", client: {} },
				visit_techs: [],
				line_items: [],
				notes: [],
			}),
		},
		job: { update: vi.fn().mockResolvedValue(undefined) },
		// New lines read their inventory item's default tax category.
		inventory_item: { findMany: vi.fn().mockResolvedValue([]) },
		job_visit_line_item: {
			delete: vi.fn().mockResolvedValue(undefined),
			update: vi.fn().mockResolvedValue(undefined),
			create: vi.fn().mockResolvedValue({ id: "new-line" }),
		},
	};
	mockDb.$transaction.mockImplementation(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		async (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
	);
	return mockTx;
}

const line = (over: Record<string, unknown> = {}) => ({
	name: "Capacitor",
	quantity: 2,
	unit_price: 30,
	item_type: "material" as const,
	...over,
});

describe("updateJobVisit — tech-consumed lines are immune to dispatch edits", () => {
	beforeEach(() => vi.clearAllMocks());

	it("does not delete a used line that the payload omits", async () => {
		const tx = setup([
			{ id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", fulfillment_status: "used", inventory_item_id: "e1111111-1111-4111-8111-111111111111" },
			{ id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", fulfillment_status: "planned", inventory_item_id: "e2222222-2222-4222-8222-222222222222" },
		]);

		// Dispatch resubmits with only the planned line — the used one is not
		// rendered by the form, so it is absent from every real payload.
		await updateJobVisit(
			makeRequest({ line_items: [line({ id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" })] }),
			ORG,
		);

		const deleted = tx.job_visit_line_item.delete.mock.calls.map(
			(c) => (c[0] as { where: { id: string } }).where.id,
		);
		expect(deleted).not.toContain("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
	});

	it("does not re-price a used line even when the payload contains it", async () => {
		const tx = setup([
			{ id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", fulfillment_status: "used", inventory_item_id: "e1111111-1111-4111-8111-111111111111" },
		]);

		await updateJobVisit(
			makeRequest({
				line_items: [line({ id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", unit_price: 999, quantity: 1 })],
			}),
			ORG,
		);

		expect(tx.job_visit_line_item.update).not.toHaveBeenCalled();
	});

	it("still deletes an unconsumed line the payload drops", async () => {
		const tx = setup([
			{ id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", fulfillment_status: "planned", inventory_item_id: "e2222222-2222-4222-8222-222222222222" },
		]);

		await updateJobVisit(makeRequest({ line_items: [] }), ORG);

		expect(tx.job_visit_line_item.delete).toHaveBeenCalledWith({
			where: { id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" },
		});
	});
});

describe("updateJobVisit — plan lifecycle stamping", () => {
	beforeEach(() => vi.clearAllMocks());

	it("stamps planned + qty_planned when dispatch attaches a catalog item", async () => {
		const tx = setup([], ["e9999999-9999-4999-8999-999999999999"]);

		await updateJobVisit(
			makeRequest({
				line_items: [line({ inventory_item_id: "e9999999-9999-4999-8999-999999999999", quantity: 3 })],
			}),
			ORG,
		);

		expect(tx.job_visit_line_item.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					inventory_item_id: "e9999999-9999-4999-8999-999999999999",
					fulfillment_status: "planned",
					qty_planned: 3,
				}),
			}),
		);
	});

	it("leaves a freetext line outside the fulfillment lifecycle", async () => {
		const tx = setup([]);

		await updateJobVisit(
			makeRequest({ line_items: [line({ item_type: "labor", name: "Diagnostic" })] }),
			ORG,
		);

		expect(tx.job_visit_line_item.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					inventory_item_id: null,
					fulfillment_status: null,
					qty_planned: null,
				}),
			}),
		);
	});

	it("does not resurrect a voided line when the edit leaves its link alone", async () => {
		const tx = setup(
			[{ id: "cccccccc-3333-4333-8333-cccccccccccc", fulfillment_status: "voided", inventory_item_id: "e3333333-3333-4333-8333-333333333333" }],
			["e3333333-3333-4333-8333-333333333333"],
		);

		await updateJobVisit(
			makeRequest({
				line_items: [
					line({ id: "cccccccc-3333-4333-8333-cccccccccccc", inventory_item_id: "e3333333-3333-4333-8333-333333333333", quantity: 5 }),
				],
			}),
			ORG,
		);

		const call = tx.job_visit_line_item.update.mock.calls[0]![0] as {
			data: Record<string, unknown>;
		};
		expect(call.data).not.toHaveProperty("fulfillment_status");
		expect(call.data.quantity).toBe(5);
	});

	it("re-stamps planned when the edit actually changes the link", async () => {
		const tx = setup(
			[{ id: "dddddddd-4444-4444-8444-dddddddddddd", fulfillment_status: "planned", inventory_item_id: "e3333333-3333-4333-8333-333333333333" }],
			["e4444444-4444-4444-8444-444444444444"],
		);

		await updateJobVisit(
			makeRequest({
				line_items: [line({ id: "dddddddd-4444-4444-8444-dddddddddddd", inventory_item_id: "e4444444-4444-4444-8444-444444444444", quantity: 1 })],
			}),
			ORG,
		);

		const call = tx.job_visit_line_item.update.mock.calls[0]![0] as {
			data: Record<string, unknown>;
		};
		expect(call.data.inventory_item_id).toBe("e4444444-4444-4444-8444-444444444444");
		expect(call.data.fulfillment_status).toBe("planned");
		expect(call.data.qty_planned).toBe(1);
	});
});

describe("updateJobVisit — cross-org catalog ids", () => {
	beforeEach(() => vi.clearAllMocks());

	it("rejects an inventory_item_id owned by another organization", async () => {
		// Catalog lookup scoped to ORG returns nothing for the supplied id.
		const tx = setup([], []);

		const result = await updateJobVisit(
			makeRequest({
				line_items: [line({ inventory_item_id: "11111111-1111-4111-8111-111111111111" })],
			}),
			ORG,
		);

		expect(result.err).toContain("unknown inventory item");
		expect(tx.job_visit_line_item.create).not.toHaveBeenCalled();
	});
});

describe("updateJobVisit — line taxability on existing lines", () => {
	beforeEach(() => vi.clearAllMocks());

	it("an existing catalog line that omits taxable keeps its stored value; a new one takes the item default", async () => {
		const inv = "e5555555-5555-4555-8555-555555555555";
		const lineId = "cccccccc-3333-4333-8333-cccccccccccc";
		const tx = setup([{ id: lineId, fulfillment_status: "planned", inventory_item_id: inv }], [inv]);
		tx.inventory_item.findMany.mockResolvedValue([{ id: inv, taxable: false }]);

		await updateJobVisit(
			makeRequest({
				line_items: [line({ id: lineId, inventory_item_id: inv }), line({ inventory_item_id: inv })],
			}),
			ORG,
		);

		const updateData = (
			tx.job_visit_line_item.update.mock.calls[0]![0] as { data: Record<string, unknown> }
		).data;
		expect(updateData).not.toHaveProperty("tax_category");
		expect(updateData).not.toHaveProperty("taxable");
		expect(tx.job_visit_line_item.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ taxable: false }),
			}),
		);
	});

	// The technician parts editor full-replaces lines without tax_group_id.
	it("an existing line that omits tax_group_id keeps its group", async () => {
		const lineId = "dddddddd-4444-4444-8444-dddddddddddd";
		const tx = setup([{ id: lineId, fulfillment_status: null, inventory_item_id: null }]);

		await updateJobVisit(makeRequest({ line_items: [line({ id: lineId })] }), ORG);

		const updateData = (
			tx.job_visit_line_item.update.mock.calls[0]![0] as { data: Record<string, unknown> }
		).data;
		expect(updateData).not.toHaveProperty("tax_group_id");
	});
});
