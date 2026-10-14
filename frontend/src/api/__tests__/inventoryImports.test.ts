import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));

vi.mock("../axiosClient", () => ({
	api: mockApi,
	queryParams: (value: Record<string, unknown>) => value,
}));

import {
	approveInventoryImportFinancials,
	commitInventoryImport,
	createInventoryImport,
	getInventoryImportCandidates,
	patchInventoryImportCandidate,
} from "../inventoryImports";

const ok = <T>(data: T, meta?: Record<string, unknown>) => ({ data: { success: true, data, error: null, meta } });

beforeEach(() => vi.clearAllMocks());

describe("inventory import API", () => {
	it("uploads every selected source under files[]", async () => {
		mockApi.post.mockResolvedValue(ok({ id: "import-1", status: "uploaded", revision: 1 }));
		const files = [new File(["a"], "a.csv"), new File(["b"], "invoice.pdf")];
		await createInventoryImport(files);
		const form = mockApi.post.mock.calls[0][1] as FormData;
		expect(mockApi.post.mock.calls[0][0]).toBe("/inventory/imports");
		expect(form.getAll("files[]")).toEqual(files);
	});

	it("keeps candidate filtering and server pagination in the API", async () => {
		mockApi.get.mockResolvedValue(ok([], { total: 73, page: 2, pageSize: 25, hasMore: true }));
		const result = await getInventoryImportCandidates("import-1", { page: 2, page_size: 25, action: "conflict" });
		expect(mockApi.get).toHaveBeenCalledWith("/inventory/imports/import-1/candidates", { params: { page: 2, page_size: 25, action: "conflict" } });
		expect(result).toMatchObject({ total: 73, page: 2, pageSize: 25, hasMore: true });
	});

	it("sends candidate revisions and separate financial approval", async () => {
		mockApi.patch.mockResolvedValue(ok({ id: "candidate-1" }));
		mockApi.post.mockResolvedValue(ok({ approved_count: 1, revision: 3, approved_at: "2026-09-23T00:00:00Z" }));
		await patchInventoryImportCandidate("import-1", "candidate-1", { revision: 4, proposed_action: "update", existing_item_id: "item-1" });
		await approveInventoryImportFinancials("import-1", 2, ["candidate-1"]);
		expect(mockApi.patch).toHaveBeenCalledWith("/inventory/imports/import-1/candidates/candidate-1", expect.objectContaining({ revision: 4 }));
		expect(mockApi.post).toHaveBeenCalledWith("/inventory/imports/import-1/financial-approval", { revision: 2, candidate_ids: ["candidate-1"] });
	});

	it("commits with the reviewed import revision", async () => {
		mockApi.post.mockResolvedValue(ok({ id: "import-1", status: "committed", item_ids: [], undo_expires_at: "2026-09-23T00:30:00Z" }));
		await commitInventoryImport("import-1", 9);
		expect(mockApi.post).toHaveBeenCalledWith("/inventory/imports/import-1/commit", { revision: 9 });
	});

	it("surfaces the backend's actionable commit conflict message", async () => {
		mockApi.post.mockRejectedValue({
			response: {
				data: {
					success: false,
					data: null,
					error: { code: "STOCK_CHANGED_SINCE_REVIEW", message: "On-hand quantity changed after review" },
				},
			},
		});
		await expect(commitInventoryImport("import-1", 9))
			.rejects.toThrow("On-hand quantity changed after review");
	});
});
