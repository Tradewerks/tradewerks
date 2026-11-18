import { describe, it, expect, vi, beforeEach } from "vitest";
import { enroll, stopEnrollment, createSequence, deleteSequence } from "../followupsController.js";

const { scoped } = vi.hoisted(() => ({
	scoped: {
		followup_sequence: { findFirst: vi.fn(), delete: vi.fn() },
		client: { findFirst: vi.fn() },
		followup_enrollment: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
		followup_step: { createMany: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
		$transaction: vi.fn(),
	},
}));

vi.mock("../../lib/context.js", () => ({ getScopedDb: () => scoped }));

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
	vi.clearAllMocks();
	scoped.followup_enrollment.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
		id: "e1",
		...args.data,
	}));
	scoped.$transaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(scoped));
});

function seq(over: Record<string, unknown> = {}) {
	return {
		id: "seq1",
		trigger_type: "quote_sent",
		stop_on_open: true,
		is_active: true,
		steps: [{ step_order: 1, delay_amount: 2, delay_unit: "days" }],
		...over,
	};
}

describe("deleteSequence", () => {
	it("refuses a sequence with enrollments, keeping their send history", async () => {
		scoped.followup_sequence.findFirst.mockResolvedValue({ _count: { enrollments: 1 } });
		await expect(deleteSequence("seq1", "org1")).rejects.toMatchObject({ status: 409 });
		expect(scoped.followup_sequence.delete).not.toHaveBeenCalled();
	});

	it("deletes a sequence that was never used", async () => {
		scoped.followup_sequence.findFirst.mockResolvedValue({ _count: { enrollments: 0 } });
		await expect(deleteSequence("seq1", "org1")).resolves.toEqual({ id: "seq1" });
		expect(scoped.followup_sequence.delete).toHaveBeenCalledWith({ where: { id: "seq1" } });
	});
});

describe("enroll", () => {
	it("rejects an inactive sequence", async () => {
		scoped.followup_sequence.findFirst.mockResolvedValue(seq({ is_active: false }));
		await expect(enroll({ sequence_id: "seq1", client_id: "c1" } as any, "org1", "d1")).rejects.toMatchObject({
			status: 400,
		});
	});

	it("rejects a sequence with no steps", async () => {
		scoped.followup_sequence.findFirst.mockResolvedValue(seq({ steps: [] }));
		await expect(enroll({ sequence_id: "seq1", client_id: "c1" } as any, "org1", "d1")).rejects.toMatchObject({
			status: 400,
		});
	});

	it("404s when the client does not belong to the org", async () => {
		scoped.followup_sequence.findFirst.mockResolvedValue(seq());
		scoped.client.findFirst.mockResolvedValue(null);
		await expect(enroll({ sequence_id: "seq1", client_id: "c1" } as any, "org1", "d1")).rejects.toMatchObject({
			status: 404,
		});
	});

	it("400s when no recipient email can be resolved", async () => {
		scoped.followup_sequence.findFirst.mockResolvedValue(seq());
		scoped.client.findFirst.mockResolvedValue({ contacts: [] });
		await expect(enroll({ sequence_id: "seq1", client_id: "c1" } as any, "org1", "d1")).rejects.toMatchObject({
			status: 400,
		});
	});

	it("falls back to the client's primary contact email and computes after-base timing", async () => {
		scoped.followup_sequence.findFirst.mockResolvedValue(seq());
		scoped.client.findFirst.mockResolvedValue({
			contacts: [
				{ is_primary: false, is_billing: true, contact: { email: "billing@x.com" } },
				{ is_primary: true, is_billing: false, contact: { email: "primary@x.com" } },
			],
		});
		const before = Date.now();
		const created: any = await enroll({ sequence_id: "seq1", client_id: "c1" } as any, "org1", "d1");
		expect(created.recipient_email).toBe("primary@x.com");
		expect(created.enrolled_by_dispatcher_id).toBe("d1");
		const delta = created.next_send_at.getTime() - before;
		expect(delta).toBeGreaterThanOrEqual(2 * DAY - 1000);
		expect(delta).toBeLessThanOrEqual(2 * DAY + 5000);
	});

	it("honors an explicit recipient_email override", async () => {
		scoped.followup_sequence.findFirst.mockResolvedValue(seq());
		scoped.client.findFirst.mockResolvedValue({ contacts: [{ is_primary: true, contact: { email: "primary@x.com" } }] });
		const created: any = await enroll(
			{ sequence_id: "seq1", client_id: "c1", recipient_email: "override@x.com" } as any,
			"org1",
			"d1",
		);
		expect(created.recipient_email).toBe("override@x.com");
	});

	it("date_based: uses scheduled_at as the base so timing is scheduled_at + delay", async () => {
		const scheduledAt = new Date(Date.now() + 10 * DAY);
		scoped.followup_sequence.findFirst.mockResolvedValue(
			seq({ trigger_type: "date_based", steps: [{ step_order: 1, delay_amount: 1, delay_unit: "hours" }] }),
		);
		scoped.client.findFirst.mockResolvedValue({ contacts: [{ is_primary: true, contact: { email: "p@x.com" } }] });
		const created: any = await enroll(
			{ sequence_id: "seq1", client_id: "c1", scheduled_at: scheduledAt } as any,
			"org1",
			"d1",
		);
		expect(created.anchor_at.getTime()).toBe(scheduledAt.getTime());
		expect(created.next_send_at.getTime()).toBe(scheduledAt.getTime() + HOUR);
	});
});

describe("stopEnrollment", () => {
	it("404s on an unknown enrollment", async () => {
		scoped.followup_enrollment.findFirst.mockResolvedValue(null);
		await expect(stopEnrollment("e1", "org1")).rejects.toMatchObject({ status: 404 });
	});

	it("marks the enrollment stopped with reason manual", async () => {
		scoped.followup_enrollment.findFirst.mockResolvedValue({ id: "e1" });
		scoped.followup_enrollment.update.mockResolvedValue({ id: "e1", status: "stopped" });
		await stopEnrollment("e1", "org1");
		expect(scoped.followup_enrollment.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "stopped", stop_reason: "manual", next_send_at: null }) }),
		);
	});
});

describe("createSequence", () => {
	it("creates the sequence and its steps (carrying the category alias) in a transaction", async () => {
		const createdSeq = { id: "seq1", name: "S" };
		const txScoped = {
			followup_sequence: { create: vi.fn().mockResolvedValue(createdSeq) },
			followup_step: { createMany: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([{ step_order: 1 }]) },
		};
		scoped.$transaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(txScoped));

		const input = {
			name: "S",
			trigger_type: "manual",
			stop_on_open: true,
			is_active: true,
			trigger_config: null,
			steps: [{ category: "quote_chase", step_order: 1, delay_amount: 0, delay_unit: "days", condition: "always" }],
		};
		const result: any = await createSequence(input as any, "org1", "d1");
		expect(txScoped.followup_sequence.create).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ organization_id: "org1", created_by_dispatcher_id: "d1" }) }),
		);
		expect(txScoped.followup_step.createMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: [expect.objectContaining({ category: "quote_chase", step_order: 1 })] }),
		);
		expect(result.steps).toEqual([{ step_order: 1 }]);
	});
});
