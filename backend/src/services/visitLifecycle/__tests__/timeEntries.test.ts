import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/recomputeDocumentTotals.js", () => ({
	recomputeVisitTotals: vi.fn(async () => ({ ok: true })),
}));

import type { Prisma } from "../../../../generated/prisma/client.js";
import { closeOpenTimeEntries } from "../timeEntries.js";
import { recomputeVisitTotals } from "../../../lib/recomputeDocumentTotals.js";

const at = new Date("2027-03-01T17:00:00Z");
const entry = (id: string, techId: string) => ({
	id,
	tech_id: techId,
	clocked_in_at: new Date("2027-03-01T15:00:00Z"),
	tech: { id: techId, name: techId, hourly_rate: 50 },
});

const makeTx = (claimCounts: Record<string, number>) => ({
	visit_tech_time_entry: {
		findMany: vi.fn(async () => [entry("e1", "t1"), entry("e2", "t2")]),
		updateMany: vi.fn(async (args: { where: { id: string } }) => ({
			count: claimCounts[args.where.id] ?? 1,
		})),
		update: vi.fn(async () => ({})),
	},
	job_visit_line_item: {
		create: vi.fn(async () => ({ id: `line-${Math.random()}` })),
	},
});

beforeEach(() => vi.clearAllMocks());

describe("closeOpenTimeEntries", () => {
	it("claims each entry before billing it, with a clocked_out_at null guard", async () => {
		const tx = makeTx({});
		const res = await closeOpenTimeEntries(
			tx as unknown as Prisma.TransactionClient,
			"o1",
			"v1",
			at,
		);
		expect(tx.visit_tech_time_entry.updateMany).toHaveBeenCalledWith({
			where: { id: "e1", clocked_out_at: null },
			data: { clocked_out_at: at, hours_worked: 2 },
		});
		expect(tx.job_visit_line_item.create).toHaveBeenCalledTimes(2);
		expect(res.techIds).toEqual(["t1", "t2"]);
		expect(recomputeVisitTotals).toHaveBeenCalledTimes(1);
	});

	it("skips an entry a concurrent clock-out already closed: no labor line, no overwrite", async () => {
		const tx = makeTx({ e1: 0 });
		const res = await closeOpenTimeEntries(
			tx as unknown as Prisma.TransactionClient,
			"o1",
			"v1",
			at,
		);
		expect(tx.job_visit_line_item.create).toHaveBeenCalledTimes(1);
		expect(tx.visit_tech_time_entry.update).toHaveBeenCalledTimes(1);
		expect(tx.visit_tech_time_entry.update).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "e2" } }),
		);
		expect(res.techIds).toEqual(["t2"]);
	});

	it("recomputes nothing when every entry was already closed", async () => {
		const tx = makeTx({ e1: 0, e2: 0 });
		const res = await closeOpenTimeEntries(
			tx as unknown as Prisma.TransactionClient,
			"o1",
			"v1",
			at,
		);
		expect(tx.job_visit_line_item.create).not.toHaveBeenCalled();
		expect(recomputeVisitTotals).not.toHaveBeenCalled();
		expect(res.techIds).toEqual([]);
	});
});
