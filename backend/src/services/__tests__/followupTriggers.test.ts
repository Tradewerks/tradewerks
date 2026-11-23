import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";
import {
	onQuoteSent,
	onVisitScheduled,
	onVisitRescheduled,
	onVisitCancelled,
} from "../followupTriggers.js";

const { scoped, isModuleOn, canSend } = vi.hoisted(() => ({
	scoped: {
		followup_sequence: { findMany: vi.fn() },
		client: { findFirst: vi.fn() },
		quote: { findFirst: vi.fn() },
		invoice: { findFirst: vi.fn() },
		request: { findFirst: vi.fn() },
		job_visit: { findFirst: vi.fn() },
		followup_enrollment: {
			create: vi.fn().mockResolvedValue({}),
			findMany: vi.fn().mockResolvedValue([]),
			update: vi.fn().mockResolvedValue({}),
			updateMany: vi.fn().mockResolvedValue({ count: 0 }),
		},
	},
	isModuleOn: vi.fn(),
	canSend: vi.fn(),
}));

vi.mock("../../lib/context.js", () => ({ getScopedDb: () => scoped }));
vi.mock("../entitlementService.js", () => ({ isModuleOn }));
vi.mock("../consentService.js", () => ({ canSend }));
vi.mock("../appLogger.js", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const DAY = 24 * 60 * 60 * 1000;

function enable(on: boolean) {
	isModuleOn.mockResolvedValue(on);
}
function withContact(email: string) {
	scoped.client.findFirst.mockResolvedValue({ contacts: [{ is_primary: true, contact: { email } }] });
}

beforeEach(() => {
	vi.clearAllMocks();
	canSend.mockResolvedValue(true);
	scoped.followup_enrollment.create.mockResolvedValue({});
	scoped.followup_enrollment.findMany.mockResolvedValue([]);
});

describe("onQuoteSent", () => {
	it("does nothing when followups are disabled for the org", async () => {
		enable(false);
		scoped.quote.findFirst.mockResolvedValue({ client_id: "c1" });
		await onQuoteSent("q1", "org1");
		expect(scoped.followup_sequence.findMany).not.toHaveBeenCalled();
		expect(scoped.followup_enrollment.create).not.toHaveBeenCalled();
	});

	it("enrollForTrigger does not enroll an unsubscribed contact", async () => {
		enable(true);
		scoped.client.findFirst.mockResolvedValue({
			contacts: [
				{
					is_primary: true,
					contact_id: "ct1",
					contact: { email: "client@x.com", is_active: true, type: "customer" },
				},
			],
		});
		canSend.mockResolvedValue(false);
		scoped.quote.findFirst.mockResolvedValue({ client_id: "c1" });
		scoped.followup_sequence.findMany.mockResolvedValue([
			{
				id: "seq1",
				trigger_type: "quote_sent",
				stop_on_open: true,
				steps: [{ step_order: 1, delay_amount: 2, delay_unit: "days", condition: "if_previous_not_opened" }],
			},
		]);

		await onQuoteSent("q1", "org1");

		expect(canSend).toHaveBeenCalledWith(scoped, "ct1", "email");
		expect(scoped.followup_enrollment.create).not.toHaveBeenCalled();
	});

	it("enrolls into active quote_sent sequences with after-base timing", async () => {
		enable(true);
		withContact("client@x.com");
		scoped.quote.findFirst.mockResolvedValue({ client_id: "c1" });
		scoped.followup_sequence.findMany.mockResolvedValue([
			{
				id: "seq1",
				trigger_type: "quote_sent",
				stop_on_open: true,
				steps: [{ step_order: 1, delay_amount: 2, delay_unit: "days", email_template_id: "t1", condition: "if_previous_not_opened" }],
			},
		]);

		const before = Date.now();
		await onQuoteSent("q1", "org1");

		expect(scoped.followup_enrollment.create).toHaveBeenCalledTimes(1);
		const data = scoped.followup_enrollment.create.mock.calls[0][0].data;
		expect(data).toMatchObject({
			organization_id: "org1",
			sequence_id: "seq1",
			client_id: "c1",
			recipient_email: "client@x.com",
			status: "active",
			anchor_entity_type: "quote",
			anchor_entity_id: "q1",
			enrolled_by_dispatcher_id: null,
		});
		// after-base: ~ now + 2 days
		const delta = data.next_send_at.getTime() - before;
		expect(delta).toBeGreaterThanOrEqual(2 * DAY - 1000);
		expect(delta).toBeLessThanOrEqual(2 * DAY + 5000);
	});

	it("skips (does not throw) on a duplicate-active unique violation", async () => {
		enable(true);
		withContact("client@x.com");
		scoped.quote.findFirst.mockResolvedValue({ client_id: "c1" });
		scoped.followup_sequence.findMany.mockResolvedValue([
			{ id: "seq1", trigger_type: "quote_sent", stop_on_open: true, steps: [{ step_order: 1, delay_amount: 0, delay_unit: "days", email_template_id: "t1", condition: "always" }] },
		]);
		scoped.followup_enrollment.create.mockRejectedValue(
			new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "7" }),
		);
		await expect(onQuoteSent("q1", "org1")).resolves.toBeUndefined();
	});

	it("does not re-enroll when an active enrollment already exists for the anchor", async () => {
		enable(true);
		withContact("client@x.com");
		scoped.quote.findFirst.mockResolvedValue({ client_id: "c1" });
		scoped.followup_sequence.findMany.mockResolvedValue([
			{ id: "seq1", trigger_type: "quote_sent", stop_on_open: true, steps: [{ step_order: 1, delay_amount: 0, delay_unit: "days", email_template_id: "t1", condition: "always" }] },
		]);
		scoped.followup_enrollment.findMany.mockResolvedValue([{ sequence_id: "seq1", status: "active", stop_reason: null }]);
		await onQuoteSent("q1", "org1");
		expect(scoped.followup_enrollment.create).not.toHaveBeenCalled();
	});

	it("does not re-enroll against an address a prior enrollment stopped for a bounce", async () => {
		enable(true);
		withContact("client@x.com");
		scoped.quote.findFirst.mockResolvedValue({ client_id: "c1" });
		scoped.followup_sequence.findMany.mockResolvedValue([
			{ id: "seq1", trigger_type: "quote_sent", stop_on_open: true, steps: [{ step_order: 1, delay_amount: 0, delay_unit: "days", email_template_id: "t1", condition: "always" }] },
		]);
		scoped.followup_enrollment.findMany.mockResolvedValue([{ sequence_id: "seq1", status: "stopped", stop_reason: "bounce" }]);
		await onQuoteSent("q1", "org1");
		expect(scoped.followup_enrollment.create).not.toHaveBeenCalled();
	});

	it("does not enroll when the client has no contact email", async () => {
		enable(true);
		scoped.client.findFirst.mockResolvedValue({ contacts: [] });
		scoped.quote.findFirst.mockResolvedValue({ client_id: "c1" });
		scoped.followup_sequence.findMany.mockResolvedValue([
			{ id: "seq1", trigger_type: "quote_sent", stop_on_open: true, steps: [{ step_order: 1, delay_amount: 0, delay_unit: "days", email_template_id: "t1", condition: "always" }] },
		]);
		await onQuoteSent("q1", "org1");
		expect(scoped.followup_enrollment.create).not.toHaveBeenCalled();
	});
});

describe("onVisitScheduled", () => {
	it("does not schedule a reminder for a visit already in the past", async () => {
		enable(true);
		scoped.job_visit.findFirst.mockResolvedValue({
			scheduled_start_at: new Date(Date.now() - DAY),
			status: "Scheduled",
			job: { client_id: "c1" },
		});
		await onVisitScheduled("v1", "org1");
		expect(scoped.followup_sequence.findMany).not.toHaveBeenCalled();
		expect(scoped.followup_enrollment.create).not.toHaveBeenCalled();
	});

	it("enrolls a future visit with before-anchor timing (start - offset)", async () => {
		enable(true);
		withContact("client@x.com");
		const start = new Date(Date.now() + 3 * DAY);
		scoped.job_visit.findFirst.mockResolvedValue({
			scheduled_start_at: start,
			status: "Scheduled",
			job: { client_id: "c1" },
		});
		scoped.followup_sequence.findMany.mockResolvedValue([
			{ id: "rem1", trigger_type: "visit_scheduled", stop_on_open: false, steps: [{ step_order: 1, delay_amount: 1, delay_unit: "days", email_template_id: "t1", condition: "always" }] },
		]);
		await onVisitScheduled("v1", "org1");

		const data = scoped.followup_enrollment.create.mock.calls[0][0].data;
		expect(data.anchor_entity_type).toBe("job_visit");
		expect(data.anchor_at.getTime()).toBe(start.getTime());
		expect(data.next_send_at.getTime()).toBe(start.getTime() - DAY);
	});
});

describe("onVisitRescheduled", () => {
	it("recomputes anchor_at + next_send_at for each active reminder", async () => {
		scoped.followup_enrollment.findMany.mockResolvedValue([
			{
				id: "e1",
				current_step_order: 0,
				sequence: {
					trigger_type: "visit_scheduled",
					stop_on_open: false,
					steps: [{ step_order: 1, delay_amount: 1, delay_unit: "days" }],
				},
			},
		]);
		const newStart = new Date(Date.now() + 5 * DAY);
		await onVisitRescheduled("v1", "org1", newStart);

		expect(scoped.followup_enrollment.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "e1" },
				data: { anchor_at: newStart, next_send_at: new Date(newStart.getTime() - DAY) },
			}),
		);
	});
});

describe("onVisitRescheduled after every step was sent", () => {
	const sentEnrollment = {
		id: "e1",
		current_step_order: 1,
		sequence: {
			trigger_type: "visit_scheduled",
			stop_on_open: false,
			steps: [{ step_order: 1, delay_amount: 1, delay_unit: "days" }],
		},
	};

	it("rescheduling to a future time when every step is already sent resets current_step_order to 0 and sets next_send_at for step 1", async () => {
		scoped.followup_enrollment.findMany.mockResolvedValue([sentEnrollment]);
		const newStart = new Date(Date.now() + 5 * DAY);
		await onVisitRescheduled("v1", "org1", newStart);

		expect(scoped.followup_enrollment.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "e1" },
				data: {
					anchor_at: newStart,
					current_step_order: 0,
					next_send_at: new Date(newStart.getTime() - DAY),
				},
			}),
		);
	});

	it("rescheduling a fully-sent 3-day/1-day chain to 2 days out re-arms the 1-day step", async () => {
		scoped.followup_enrollment.findMany.mockResolvedValue([
			{
				id: "e1",
				current_step_order: 2,
				sequence: {
					trigger_type: "visit_scheduled",
					stop_on_open: false,
					steps: [
						{ step_order: 1, delay_amount: 3, delay_unit: "days" },
						{ step_order: 2, delay_amount: 1, delay_unit: "days" },
					],
				},
			},
		]);
		const newStart = new Date(Date.now() + 2 * DAY);
		await onVisitRescheduled("v1", "org1", newStart);

		expect(scoped.followup_enrollment.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "e1" },
				data: {
					anchor_at: newStart,
					current_step_order: 1,
					next_send_at: new Date(newStart.getTime() - DAY),
				},
			}),
		);
	});

	it("rescheduling never leaves an active enrollment with next_send_at null", async () => {
		scoped.followup_enrollment.findMany.mockResolvedValue([sentEnrollment]);
		// Step 1 would have to send a day before a start that is only 2h away.
		const newStart = new Date(Date.now() + 2 * 60 * 60 * 1000);
		await onVisitRescheduled("v1", "org1", newStart);

		const data = scoped.followup_enrollment.update.mock.calls[0][0].data;
		expect(data).toMatchObject({
			status: "completed",
			stop_reason: "rescheduled_too_late",
			next_send_at: null,
		});
		expect(data.completed_at).toBeInstanceOf(Date);
	});
});

describe("onVisitCancelled", () => {
	it("stops active reminders for the visit", async () => {
		await onVisitCancelled("v1", "org1");
		expect(scoped.followup_enrollment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { anchor_entity_type: "job_visit", anchor_entity_id: "v1", status: "active" },
				data: expect.objectContaining({ status: "stopped", stop_reason: "visit_cancelled" }),
			}),
		);
	});
});
