import { describe, it, expect, vi } from "vitest";
import { syncOccurrenceForVisit } from "../recurringOccurrenceSync.js";

function makeTx(count = 1) {
	const updateMany = vi.fn(async () => ({ count }));
	return {
		tx: { recurring_occurrence: { updateMany } } as never,
		updateMany,
	};
}

type Call = {
	where: Record<string, unknown>;
	data: Record<string, unknown>;
};

describe("recurringOccurrenceSync", () => {
	it("completing a generated visit marks its occurrence completed", async () => {
		const { tx, updateMany } = makeTx();
		await syncOccurrenceForVisit("visit-1", "Completed", tx);
		expect(updateMany).toHaveBeenCalledTimes(1);
		const [arg] = updateMany.mock.calls[0] as unknown as [Call];
		expect(arg.where).toMatchObject({ job_visit_id: "visit-1" });
		expect(arg.data).toMatchObject({ status: "completed" });
		expect(arg.data.completed_at).toBeInstanceOf(Date);
	});

	it("cancelling a generated visit marks its occurrence cancelled", async () => {
		const { tx, updateMany } = makeTx();
		await syncOccurrenceForVisit("visit-1", "Cancelled", tx);
		const [arg] = updateMany.mock.calls[0] as unknown as [Call];
		expect(arg.where).toMatchObject({ job_visit_id: "visit-1" });
		expect(arg.data).toMatchObject({
			status: "cancelled",
			skip_reason: "Visit cancelled",
		});
	});

	it("restoring or reopening a visit puts its occurrence back to generated", async () => {
		for (const [from, to] of [
			["Cancelled", "Scheduled"],
			["Completed", "InProgress"],
		]) {
			const { tx, updateMany } = makeTx();
			await syncOccurrenceForVisit("visit-1", to, tx, from);
			expect(updateMany).toHaveBeenCalledTimes(1);
			const [arg] = updateMany.mock.calls[0] as unknown as [Call];
			expect(arg.where).toMatchObject({
				job_visit_id: "visit-1",
				status: { in: ["completed", "cancelled"] },
			});
			expect(arg.data).toEqual({
				status: "generated",
				completed_at: null,
				skip_reason: null,
			});
		}
	});

	it("an open to open transition leaves the occurrence alone", async () => {
		const { tx, updateMany } = makeTx();
		await syncOccurrenceForVisit("visit-1", "Driving", tx, "Scheduled");
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("other statuses leave the occurrence alone", async () => {
		const { tx, updateMany } = makeTx();
		for (const to of ["Scheduled", "InProgress", "Driving", "Paused"]) {
			await syncOccurrenceForVisit("visit-1", to, tx);
		}
		expect(updateMany).not.toHaveBeenCalled();
	});
});
