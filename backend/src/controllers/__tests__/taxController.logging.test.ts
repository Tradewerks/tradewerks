import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => {
	const { createFakeDb } = await import("../../routes/__tests__/harness.js");
	return { db: createFakeDb() };
});
vi.mock("../../services/logger.js", async (importActual) => ({
	...(await importActual<typeof import("../../services/logger.js")>()),
	logActivity: vi.fn(async () => undefined),
}));

import { db } from "../../db.js";
import { logActivity } from "../../services/logger.js";
import { updateTaxGroup, deleteTaxRate } from "../taxController.js";
import type { FakeDb } from "../../routes/__tests__/harness.js";

const fake = db as unknown as FakeDb;
const ctx = { dispatcherId: "disp-1" };
const R1 = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";

beforeEach(() => vi.clearAllMocks());

describe("tax controller activity logging", () => {
	it("logs a group update with the changed fields and rate list", async () => {
		fake.tax_group.findFirst.mockResolvedValue({
			id: "g1",
			name: "County",
			description: null,
			is_default: false,
			is_active: true,
			rates: [{ tax_rate_id: R1 }],
		});
		fake.tax_rate.findMany.mockResolvedValue([{ id: R1 }, { id: R2 }]);
		fake.tax_group.update.mockResolvedValue({
			id: "g1",
			name: "County+",
			rates: [],
		});

		const r = await updateTaxGroup(
			"g1",
			{ name: "County+", rate_ids: [R1, R2] },
			"org-1",
			ctx,
		);

		expect(r).toMatchObject({ ok: true });
		expect(logActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "tax_group.updated",
				entity_id: "g1",
				organization_id: "org-1",
				actor_type: "dispatcher",
				actor_id: "disp-1",
				changes: {
					name: { old: "County", new: "County+" },
					rate_ids: { old: [R1], new: [R1, R2] },
				},
			}),
		);
	});

	it("skips the log when nothing changed", async () => {
		fake.tax_group.findFirst.mockResolvedValue({
			id: "g1",
			name: "County",
			description: null,
			is_default: false,
			is_active: true,
			rates: [],
		});
		fake.tax_group.update.mockResolvedValue({
			id: "g1",
			name: "County",
			rates: [],
		});

		await updateTaxGroup("g1", { name: "County" }, "org-1", ctx);

		expect(logActivity).not.toHaveBeenCalled();
	});

	it("doesn't log a delete that was refused", async () => {
		fake.tax_rate.findFirst.mockResolvedValue({ id: "r1", name: "State" });
		fake.tax_group_rate.count.mockResolvedValue(2);

		const r = await deleteTaxRate("r1", "org-1", ctx);

		expect(r).toMatchObject({ ok: false, code: "CONFLICT" });
		expect(logActivity).not.toHaveBeenCalled();
	});

	it("logs a delete with the rate's name", async () => {
		fake.tax_rate.findFirst.mockResolvedValue({ id: "r1", name: "State" });
		fake.tax_group_rate.count.mockResolvedValue(0);

		const r = await deleteTaxRate("r1", "org-1", ctx);

		expect(r).toEqual({ ok: true, item: { id: "r1" } });
		expect(logActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "tax_rate.deleted",
				changes: { name: { old: "State", new: null } },
			}),
		);
	});
});
