import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const mocks = vi.hoisted(() => {
	const delegate = () => ({
		findFirst: vi.fn(),
		findMany: vi.fn(),
		count: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
	});
	const db = {
		dispatcher: delegate(),
		inventory_import: delegate(),
		inventory_import_source: delegate(),
		inventory_import_candidate: delegate(),
		inventory_item: delegate(),
		$transaction: vi.fn(),
	};
	return {
		db,
		storeImportSource: vi.fn(),
		queueInventoryImport: vi.fn(),
		recomputeImportSummary: vi.fn(),
		logActivity: vi.fn(),
	};
});

vi.mock("../../db.js", () => ({ db: mocks.db }));
vi.mock("../../services/inventoryImport/sourceStorage.js", () => ({
	storeImportSource: mocks.storeImportSource,
}));
vi.mock("../../services/inventoryImport/processor.js", () => ({
	queueInventoryImport: mocks.queueInventoryImport,
	recomputeImportSummary: mocks.recomputeImportSummary,
}));
vi.mock("../../services/inventoryImport/commitInventoryImport.js", () => ({
	commitInventoryImport: vi.fn(),
	undoInventoryImport: vi.fn(),
}));
vi.mock("../../services/logger.js", () => ({ logActivity: mocks.logActivity }));
vi.mock("../../services/metricsService.js", () => ({
	inventoryImportConflicts: { add: vi.fn() },
	inventoryImportEvents: { add: vi.fn() },
	inventoryImportMappingDecisions: { add: vi.fn() },
}));

import {
	createImport,
	getImport,
	patchCandidate,
} from "../inventoryImportsController.js";

const previousFlag = process.env.INVENTORY_AI_IMPORT_ENABLED;

function request(overrides: Partial<Request> = {}): Request {
	return {
		user: {
			uid: "dispatcher-1",
			role: "dispatcher",
			organization_id: "org-1",
			permissions: ["manage_inventory"],
		},
		params: {},
		query: {},
		body: {},
		headers: {},
		...overrides,
	} as unknown as Request;
}

function response() {
	const res = {
		status: vi.fn(),
		json: vi.fn(),
	} as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
	res.status.mockReturnValue(res);
	res.json.mockReturnValue(res);
	return res;
}

beforeEach(() => {
	vi.clearAllMocks();
	process.env.INVENTORY_AI_IMPORT_ENABLED = "true";
	mocks.db.$transaction.mockImplementation(async (callback: (tx: typeof mocks.db) => unknown) => callback(mocks.db));
});

afterEach(() => {
	if (previousFlag === undefined) delete process.env.INVENTORY_AI_IMPORT_ENABLED;
	else process.env.INVENTORY_AI_IMPORT_ENABLED = previousFlag;
});

describe("inventory import controller isolation", () => {
	it("persists only an inert import and source during upload", async () => {
		mocks.db.dispatcher.findFirst.mockResolvedValue({ id: "dispatcher-1" });
		mocks.db.inventory_import.create.mockResolvedValue({ id: "import-1", status: "uploaded", revision: 1 });
		mocks.storeImportSource.mockResolvedValue({ url: "local-import://source.xlsx", key: "source.xlsx" });
		mocks.db.inventory_import_source.create.mockResolvedValue({ id: "source-1" });
		mocks.logActivity.mockResolvedValue(undefined);
		const req = request({
			files: [{
				fieldname: "files[]",
				originalname: "inventory.xlsx",
				encoding: "7bit",
				mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				size: 4,
				buffer: Buffer.from("test"),
			}] as Express.Multer.File[],
		});
		const res = response();
		const next = vi.fn() as unknown as NextFunction;

		await createImport(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(202);
		expect(mocks.db.inventory_import.create).toHaveBeenCalledWith({
			data: { organization_id: "org-1", created_by_id: "dispatcher-1" },
		});
		expect(mocks.db.inventory_item.create).not.toHaveBeenCalled();
		expect(mocks.queueInventoryImport).toHaveBeenCalledWith("import-1");
	});

	it("always scopes an import detail lookup to the caller's organization", async () => {
		mocks.db.inventory_import.findFirst.mockResolvedValue(null);
		const res = response();
		const next = vi.fn() as unknown as NextFunction;

		await getImport(request({ params: { id: "other-org-import" } }), res, next);

		expect(mocks.db.inventory_import.findFirst).toHaveBeenCalledWith(expect.objectContaining({
			where: { id: "other-org-import", organization_id: "org-1" },
		}));
		expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "NOT_FOUND", statusCode: 404 }));
		expect(res.json).not.toHaveBeenCalled();
	});

	it("does not let skipped invalid rows block commit and reports no actionable work", async () => {
		mocks.db.inventory_import.findFirst.mockResolvedValue({
			id: "import-1",
			organization_id: "org-1",
			status: "ready_for_review",
			sources: [],
		});
		mocks.db.inventory_import_candidate.findMany.mockResolvedValue([{
			proposed_action: "skip",
			validation_issues: [{ field: "name", code: "REQUIRED" }],
			requires_financial_approval: true,
			financial_approved_at: null,
			normalized_proposal: { quantity: 2 },
			user_overrides: {},
		}]);
		const res = response();
		const next = vi.fn() as unknown as NextFunction;

		await getImport(request({ params: { id: "import-1" } }), res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.json.mock.calls[0][0].data).toMatchObject({
			blocking_count: 0,
			actionable_count: 0,
			financial_summary: { row_count: 0, unapproved_count: 0 },
		});
	});

	it("returns a typed conflict when a candidate revision is stale", async () => {
		mocks.db.inventory_import.findFirst.mockResolvedValue({ status: "ready_for_review" });
		mocks.db.inventory_import_candidate.findFirst.mockResolvedValue({
			id: "candidate-1",
			normalized_proposal: { name: "Filter", location: "A1" },
			user_overrides: {},
			matching_evidence: {},
			financial_fields: [],
			requires_financial_approval: false,
		});
		mocks.db.inventory_import_candidate.updateMany.mockResolvedValue({ count: 0 });
		const res = response();
		const next = vi.fn() as unknown as NextFunction;

		await patchCandidate(request({
			params: { id: "import-1", candidateId: "candidate-1" },
			body: { revision: 1, selected: false },
		}), res, next);

		expect(mocks.db.inventory_import_candidate.updateMany).toHaveBeenCalledWith(expect.objectContaining({
			where: expect.objectContaining({
				id: "candidate-1",
				import_id: "import-1",
				organization_id: "org-1",
				revision: 1,
			}),
		}));
		expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "STALE_REVISION", statusCode: 409 }));
		expect(mocks.recomputeImportSummary).not.toHaveBeenCalled();
	});
});
