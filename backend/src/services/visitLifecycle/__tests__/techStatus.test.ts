import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "../../../../generated/prisma/client.js";
import { applyTechStatus } from "../techStatus.js";

const makeTx = (rows: { tech_id: string; tech_status: string }[]) => ({
	job_visit_technician: {
		findMany: vi.fn(async () => rows),
		updateMany: vi.fn(async () => ({ count: 0 })),
	},
	technician: {
		findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
			args.where.id.in.map((id) => ({ id, status: "Available" })),
		),
		update: vi.fn(async () => ({})),
	},
	technician_shift_break: { updateMany: vi.fn() },
});

describe("applyTechStatus on complete", () => {
	it("re-completing a reopened visit leaves an idle Done tech out of WrappingUp", async () => {
		const tx = makeTx([
			{ tech_id: "done-idle", tech_status: "Done" },
			{ tech_id: "done-reclocked", tech_status: "Done" },
			{ tech_id: "onsite", tech_status: "OnSite" },
			{ tech_id: "noshow", tech_status: "Assigned" },
		]);
		const res = await applyTechStatus(
			tx as unknown as Prisma.TransactionClient,
			{
				visitId: "v1",
				action: "complete",
				actingTechIds: [],
				closedTechIds: ["done-reclocked"],
			},
		);
		expect(new Set(res.wrappingUpTechIds)).toEqual(
			new Set(["done-reclocked", "onsite"]),
		);
		expect(tx.job_visit_technician.updateMany).toHaveBeenCalledWith({
			where: {
				visit_id: "v1",
				tech_id: { in: ["done-reclocked", "onsite"] },
			},
			data: { tech_status: "Done" },
		});
	});

	it("an Assigned tech whose entry was just closed counts as having worked", async () => {
		const tx = makeTx([{ tech_id: "late", tech_status: "Assigned" }]);
		const res = await applyTechStatus(
			tx as unknown as Prisma.TransactionClient,
			{
				visitId: "v1",
				action: "complete",
				actingTechIds: [],
				closedTechIds: ["late"],
			},
		);
		expect(res.wrappingUpTechIds).toEqual(["late"]);
	});
});
