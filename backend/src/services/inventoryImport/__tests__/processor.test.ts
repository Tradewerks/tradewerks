import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: {
		inventory_import_candidate: {
			findMany: vi.fn(),
			update: vi.fn(),
		},
	},
	duplicates: { add: vi.fn() },
}));

vi.mock("../../../db.js", () => ({ db: mocks.db }));
vi.mock("../../metricsService.js", () => ({
	inventoryImportDuplicatesPrevented: mocks.duplicates,
	inventoryImportDuration: { record: vi.fn() },
	inventoryImportEvents: { add: vi.fn() },
}));

import { markWithinImportDuplicates } from "../processor.js";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("cross-source duplicate reconciliation", () => {
	it("marks stable identities as one conflict group even when they came from different files", async () => {
		mocks.db.inventory_import_candidate.findMany.mockResolvedValue([
			{
				id: "candidate-a",
				normalized_proposal: { sku: "CAP-100", name: "Capacitor" },
				matching_evidence: { tier: "no_match", source_id: "source-a" },
			},
			{
				id: "candidate-b",
				normalized_proposal: { sku: "cap-100", name: "Capacitor duplicate" },
				matching_evidence: { tier: "exact_sku", source_id: "source-b" },
			},
		]);
		mocks.db.inventory_import_candidate.update.mockResolvedValue({});

		await markWithinImportDuplicates("import-1", "org-1");

		expect(mocks.db.inventory_import_candidate.findMany).toHaveBeenCalledWith(expect.objectContaining({
			where: { import_id: "import-1", organization_id: "org-1" },
		}));
		expect(mocks.db.inventory_import_candidate.update).toHaveBeenCalledTimes(2);
		for (const call of mocks.db.inventory_import_candidate.update.mock.calls) {
			expect(call[0].data).toMatchObject({
				proposed_action: "conflict",
				duplicate_group: "sku:cap 100",
				matching_evidence: expect.objectContaining({
					tier: "within_import",
					candidate_ids: ["candidate-a", "candidate-b"],
				}),
			});
		}
		expect(mocks.duplicates.add).toHaveBeenCalledWith(2, { kind: "within_import" });
	});
});
