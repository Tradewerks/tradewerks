import { describe, it, expect, vi, beforeEach } from "vitest";
import { runDueFollowups } from "../followupScheduler.js";

// ── Mocks ────────────────────────────────────────────────────────────────────
const { rootDb, scoped, sendMock, brandMock, templateMock } = vi.hoisted(() => {
	const tx = {
		followup_send: { create: vi.fn().mockResolvedValue({}) },
		followup_enrollment: { update: vi.fn().mockResolvedValue({}) },
	};
	return {
		rootDb: {
			_tx: tx,
			followup_enrollment: {
				findMany: vi.fn(),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
				update: vi.fn().mockResolvedValue({}),
			},
			followup_send: { create: vi.fn().mockResolvedValue({}), count: vi.fn().mockResolvedValue(0) },
			$transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
		},
		scoped: {
			followup_sequence: { findFirst: vi.fn() },
			followup_send: { findFirst: vi.fn().mockResolvedValue(null) },
			client: { findFirst: vi.fn().mockResolvedValue({ name: "Acme" }) },
			quote: { findUnique: vi.fn() },
			invoice: { findUnique: vi.fn() },
			request: { findUnique: vi.fn() },
			job_visit: { findUnique: vi.fn() },
		},
		sendMock: vi.fn().mockResolvedValue({ messageId: "pm-1" }),
		brandMock: vi.fn().mockResolvedValue({ brand: { name: "Acme", color: "#111111" } }),
		templateMock: vi.fn().mockResolvedValue({
			subject: "Hi {{client_name}}",
			html: "<p>Hi {{client_name}}</p>",
			text: null,
		}),
	};
});

// Module gating is not under test here: every module reads as on.
vi.mock("../entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
	getEntitlements: vi.fn(),
}));

const { lastReenabledAt } = vi.hoisted(() => ({ lastReenabledAt: vi.fn() }));
vi.mock("../moduleWindowService.js", () => ({ lastReenabledAt }));

vi.mock("../../db.js", () => ({ db: rootDb }));
vi.mock("../../lib/context.js", () => ({ getScopedDb: () => scoped }));
vi.mock("../emailService.js", () => ({ sendRenderedTracked: sendMock }));
vi.mock("../emailBranding.js", () => ({ getOrgBrandModel: brandMock }));
vi.mock("../followupTemplates.js", () => ({ getEffectiveTemplate: templateMock }));
vi.mock("../logger.js", () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../appLogger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const tx = rootDb._tx;

function baseEnrollment(over: Record<string, unknown> = {}) {
	return {
		id: "e1",
		organization_id: "org1",
		sequence_id: "seq1",
		client_id: "c1",
		recipient_email: "client@x.com",
		status: "active",
		current_step_order: 0,
		next_send_at: new Date("2026-07-08T10:00:00Z"),
		anchor_entity_type: null,
		anchor_entity_id: null,
		anchor_at: null,
		...over,
	};
}

function sequence(steps: unknown[], over: Record<string, unknown> = {}) {
	return { id: "seq1", trigger_type: "manual", stop_on_open: true, is_active: true, steps, ...over };
}

const step = (order: number, over: Record<string, unknown> = {}) => ({
	id: `s${order}`,
	step_order: order,
	category: "followup",
	delay_amount: 2,
	delay_unit: "days",
	condition: "if_previous_not_opened",
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	rootDb.followup_enrollment.updateMany.mockResolvedValue({ count: 1 });
	rootDb.followup_send.count.mockResolvedValue(0);
	rootDb.$transaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
	scoped.followup_send.findFirst.mockResolvedValue(null);
	scoped.client.findFirst.mockResolvedValue({ name: "Acme" });
	sendMock.mockResolvedValue({ messageId: "pm-1" });
	lastReenabledAt.mockResolvedValue(null);
	templateMock.mockResolvedValue({
		subject: "Hi {{client_name}}",
		html: "<p>Hi {{client_name}}</p>",
		text: null,
	});
});

describe("runDueFollowups", () => {
	it("no due enrollments → no work", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([]);
		await runDueFollowups();
		expect(sendMock).not.toHaveBeenCalled();
	});

	it("single-step: sends the branded template, records the send, completes the enrollment", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment()]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1)]));

		await runDueFollowups();

		// claimed
		expect(rootDb.followup_enrollment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: expect.objectContaining({ id: "e1", status: "active" }) }),
		);
		// resolved the org's template for the step's category…
		expect(templateMock).toHaveBeenCalledWith("org1", "followup");
		// …and sent the rendered subject + HTML (client_name substituted); text null
		// (auto-generated downstream) with metadata
		expect(sendMock).toHaveBeenCalledWith(
			"client@x.com",
			"Hi Acme",
			"<p>Hi Acme</p>",
			null,
			expect.objectContaining({ metadata: expect.objectContaining({ enrollment_id: "e1" }) }),
		);
		// send row recorded with the template alias
		expect(tx.followup_send.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "sent", postmark_message_id: "pm-1", step_id: "s1", template_alias: "followup" }),
			}),
		);
		// completed (no next step)
		expect(tx.followup_enrollment.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "completed", current_step_order: 1 }) }),
		);
	});

	it("multi-step: advances to the next step with a computed next_send_at (not completed)", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment()]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1), step(2)]));

		await runDueFollowups();

		const updateData = tx.followup_enrollment.update.mock.calls[0][0].data;
		expect(updateData.current_step_order).toBe(1);
		expect(updateData.next_send_at).toBeInstanceOf(Date);
		expect(updateData.status).toBeUndefined();
	});

	it("stops (no send) when the anchor entity has resolved", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([
			baseEnrollment({ anchor_entity_type: "quote", anchor_entity_id: "q1" }),
		]);
		scoped.quote.findUnique.mockResolvedValue({ status: "Approved" });

		await runDueFollowups();

		expect(sendMock).not.toHaveBeenCalled();
		expect(rootDb.followup_enrollment.update).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "e1" }, data: expect.objectContaining({ status: "stopped", stop_reason: "quote_approved" }) }),
		);
	});

	it("does not send when the claim is lost to a concurrent tick (updateMany count 0)", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment()]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1)]));
		rootDb.followup_enrollment.updateMany.mockResolvedValue({ count: 0 });

		await runDueFollowups();

		expect(sendMock).not.toHaveBeenCalled();
		expect(tx.followup_send.create).not.toHaveBeenCalled();
	});

	it("completes without sending when the previous email was opened (stop_on_open)", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment({ current_step_order: 1 })]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1), step(2)]));
		scoped.followup_send.findFirst.mockResolvedValue({ opened_at: new Date() });

		await runDueFollowups();

		expect(sendMock).not.toHaveBeenCalled();
		expect(rootDb.followup_enrollment.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "completed", stop_reason: "recipient_opened" }) }),
		);
	});

	it("stops the sequence when it has been deactivated", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment()]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1)], { is_active: false }));

		await runDueFollowups();

		expect(sendMock).not.toHaveBeenCalled();
		expect(rootDb.followup_enrollment.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "stopped", stop_reason: "sequence_inactive" }) }),
		);
	});

	it("on send failure records a failed send and schedules a retry (below max attempts)", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment()]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1)]));
		sendMock.mockRejectedValue(new Error("postmark down"));
		rootDb.followup_send.count.mockResolvedValue(0); // no prior failures

		await runDueFollowups();

		expect(rootDb.followup_send.create).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }),
		);
		// retry scheduled: next_send_at pushed forward, status left active
		const retryUpdate = rootDb.followup_enrollment.update.mock.calls.at(-1)![0];
		expect(retryUpdate.data.next_send_at).toBeInstanceOf(Date);
		expect(retryUpdate.data.status).toBeUndefined();
	});

	it("marks the enrollment failed after the max send attempts", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment()]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1)]));
		sendMock.mockRejectedValue(new Error("postmark down"));
		rootDb.followup_send.count.mockResolvedValue(2); // this is the 3rd (max) attempt

		await runDueFollowups();

		expect(rootDb.followup_enrollment.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "failed", stop_reason: "max_send_attempts" }) }),
		);
	});

	it("de-bursts reminders: skips an overdue early reminder step when a later one remains", async () => {
		// Anchor (visit) is 2h away; step 1 is "1 day before" → its send time is ~22h past.
		rootDb.followup_enrollment.findMany.mockResolvedValue([
			baseEnrollment({
				anchor_entity_type: "job_visit",
				anchor_entity_id: "v1",
				anchor_at: new Date(Date.now() + 2 * 60 * 60 * 1000),
			}),
		]);
		scoped.job_visit.findUnique.mockResolvedValue({ status: "Scheduled" }); // anchor still open
		scoped.followup_sequence.findFirst.mockResolvedValue(
			sequence(
				[
					step(1, { delay_amount: 1, delay_unit: "days", condition: "always" }),
					step(2, { delay_amount: 1, delay_unit: "hours", condition: "always" }),
				],
				{ trigger_type: "visit_scheduled", stop_on_open: false },
			),
		);

		await runDueFollowups();

		// No email sent; step 1 recorded as skipped (window passed), advanced toward step 2.
		expect(sendMock).not.toHaveBeenCalled();
		expect(tx.followup_send.create).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "skipped", error: "reminder_window_passed" }) }),
		);
	});

	it("skips a step that fell due while Followups was off, and does not send it", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([
			baseEnrollment({ next_send_at: new Date("2026-03-01T10:00:00Z") }),
		]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1), step(2)]));
		lastReenabledAt.mockResolvedValue(new Date("2026-03-05T00:00:00Z"));

		await runDueFollowups();

		expect(lastReenabledAt).toHaveBeenCalledWith("org1", "followups");
		expect(sendMock).not.toHaveBeenCalled();
		expect(tx.followup_send.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "skipped", error: "module_was_off" }),
			}),
		);
		// The next step is timed from now, so the same re-enable cannot skip it again.
		const advanced = tx.followup_enrollment.update.mock.calls[0][0].data;
		expect(advanced.next_send_at.getTime()).toBeGreaterThan(
			new Date("2026-03-05T00:00:00Z").getTime(),
		);
	});

	it("sends a step that fell due after Followups came back on", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([
			baseEnrollment({ next_send_at: new Date("2026-03-05T00:05:00Z") }),
		]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1)]));
		lastReenabledAt.mockResolvedValue(new Date("2026-03-05T00:00:00Z"));

		await runDueFollowups();

		expect(sendMock).toHaveBeenCalledTimes(1);
	});

});
