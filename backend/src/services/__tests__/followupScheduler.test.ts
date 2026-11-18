import { describe, it, expect, vi, beforeEach } from "vitest";
import { runDueFollowups } from "../followupScheduler.js";

// ── Mocks ────────────────────────────────────────────────────────────────────
const { rootDb, scoped, sendMock, brandMock, templateMock, canSendMock } = vi.hoisted(() => {
	const tx = {
		followup_send: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
		followup_enrollment: {
			update: vi.fn().mockResolvedValue({}),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
	};
	return {
		rootDb: {
			_tx: tx,
			followup_enrollment: {
				findMany: vi.fn(),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
				update: vi.fn().mockResolvedValue({}),
			},
			followup_send: {
				create: vi.fn().mockResolvedValue({ id: "fs1" }),
				update: vi.fn().mockResolvedValue({}),
				count: vi.fn().mockResolvedValue(0),
			},
			organization: { findUnique: vi.fn().mockResolvedValue({ timezone: "America/Chicago" }) },
			$transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
		},
		scoped: {
			followup_sequence: { findFirst: vi.fn() },
			followup_send: { findFirst: vi.fn().mockResolvedValue(null) },
			client: { findFirst: vi.fn().mockResolvedValue({ name: "Acme" }) },
			contact: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
			quote: { findUnique: vi.fn() },
			invoice: { findUnique: vi.fn() },
			request: { findUnique: vi.fn() },
			job_visit: { findUnique: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
		},
		canSendMock: vi.fn().mockResolvedValue(true),
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
const { issueLinkMock } = vi.hoisted(() => ({
	issueLinkMock: vi.fn().mockResolvedValue({
		url: "https://app.test/app/c/tok-1",
		token: "tok-1",
	}),
}));
vi.mock("../../lib/publicLink.js", async (orig) => ({
	...(await orig<typeof import("../../lib/publicLink.js")>()),
	issueLink: issueLinkMock,
}));
vi.mock("../consentService.js", () => ({ canSend: canSendMock }));
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
	rootDb.followup_send.create.mockResolvedValue({ id: "fs1" });
	rootDb.followup_send.update.mockResolvedValue({});
	rootDb.$transaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
	scoped.followup_send.findFirst.mockResolvedValue(null);
	scoped.client.findFirst.mockResolvedValue({ name: "Acme" });
	scoped.contact.findFirst.mockResolvedValue(null);
	scoped.contact.findMany.mockResolvedValue([]);
	scoped.job_visit.findFirst.mockResolvedValue(null);
	rootDb.organization.findUnique.mockResolvedValue({ timezone: "America/Chicago" });
	sendMock.mockResolvedValue({ messageId: "pm-1" });
	canSendMock.mockResolvedValue(true);
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
		// the row written before the send becomes "sent" with the message id
		expect(tx.followup_send.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "fs1" },
				data: expect.objectContaining({ status: "sent", postmark_message_id: "pm-1" }),
			}),
		);
		expect(rootDb.followup_send.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "sending", step_id: "s1", template_alias: "followup" }),
			}),
		);
		// completed (no next step)
		expect(tx.followup_enrollment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "completed", current_step_order: 1 }) }),
		);
	});

	it("followup send passes the org name as From display name and the org email as ReplyTo", async () => {
		brandMock.mockResolvedValueOnce({
			brand: { name: "Acme HVAC", color: "#111111", reply_to: "office@acme.com" },
		});
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment()]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1)]));

		await runDueFollowups();

		expect(sendMock).toHaveBeenCalledWith(
			"client@x.com",
			expect.any(String),
			expect.any(String),
			null,
			expect.objectContaining({ fromName: "Acme HVAC", replyTo: "office@acme.com" }),
		);
	});

	it("followup emails carry List-Unsubscribe and List-Unsubscribe-Post headers and a footer link", async () => {
		templateMock.mockResolvedValueOnce({
			subject: "Hi",
			html: '<a href="{{unsubscribe_url}}">Unsubscribe</a>',
			text: "Unsubscribe: {{unsubscribe_url}}",
		});
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment({ contact_id: "c1" })]);
		scoped.contact.findFirst.mockResolvedValue({
			email: "client@x.com",
			is_active: true,
			type: "customer",
		});
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1)]));

		await runDueFollowups();

		expect(issueLinkMock).toHaveBeenCalledWith("org1", {
			purpose: "unsubscribe",
			entityId: "c1",
			contactId: "c1",
		});
		const [, , html, text, opts] = sendMock.mock.calls[0];
		expect(html).toContain("https://app.test/app/c/tok-1");
		expect(text).toContain("https://app.test/app/c/tok-1");
		expect(opts.headers).toEqual([
			{
				Name: "List-Unsubscribe",
				Value: expect.stringMatching(/^<.+\/public\/unsubscribe\/one-click\?t=tok-1>$/),
			},
			{ Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
		]);
	});

	it("the scheduler records a skipped send with error \"unsubscribed\" and stops the enrollment when canSend is false", async () => {
		canSendMock.mockResolvedValue(false);
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment({ contact_id: "c1" })]);
		scoped.contact.findFirst.mockResolvedValue({
			email: "client@x.com",
			is_active: true,
			type: "customer",
		});
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1)]));

		await runDueFollowups();

		expect(canSendMock).toHaveBeenCalledWith(scoped, "c1", "email");
		expect(sendMock).not.toHaveBeenCalled();
		expect(rootDb.followup_send.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "skipped",
					error: "unsubscribed",
					step_id: "s1",
				}),
			}),
		);
		expect(rootDb.followup_enrollment.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "e1" },
				data: expect.objectContaining({
					status: "stopped",
					stop_reason: "unsubscribed",
				}),
			}),
		);
	});

	it("an enrollment with no contact is skipped when a contact with that address is unsubscribed", async () => {
		scoped.contact.findMany.mockResolvedValue([{ id: "k1" }, { id: "k2" }]);
		canSendMock.mockImplementation(async (_s: unknown, id: string) => id !== "k2");
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment({ contact_id: null })]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1)]));

		await runDueFollowups();

		expect(scoped.contact.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { email: { equals: "client@x.com", mode: "insensitive" } },
			}),
		);
		expect(sendMock).not.toHaveBeenCalled();
		expect(rootDb.followup_send.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "skipped", error: "unsubscribed" }),
			}),
		);
	});

	it("multi-step: advances to the next step with a computed next_send_at (not completed)", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment()]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1), step(2)]));

		await runDueFollowups();

		const updateData = tx.followup_enrollment.updateMany.mock.calls[0][0].data;
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
		expect(rootDb.followup_send.create).not.toHaveBeenCalled();
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

		expect(rootDb.followup_send.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "fs1" },
				data: expect.objectContaining({ status: "failed", error: "postmark down" }),
			}),
		);
		// retry scheduled: next_send_at pushed forward, status left active
		const retryUpdate = rootDb.followup_enrollment.update.mock.calls.at(-1)![0];
		expect(retryUpdate.data.next_send_at).toBeInstanceOf(Date);
		expect(retryUpdate.data.status).toBeUndefined();
	});

	it('a followup_send row with status "sending" is written before the Postmark call', async () => {
		const order: string[] = [];
		rootDb.followup_send.create.mockImplementation(async () => {
			order.push("insert");
			return { id: "fs1" };
		});
		sendMock.mockImplementation(async () => {
			order.push("send");
			return { messageId: "pm-1" };
		});
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment()]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1)]));

		await runDueFollowups();

		expect(order).toEqual(["insert", "send"]);
		expect(rootDb.followup_send.create.mock.calls[0][0].data.status).toBe("sending");
	});

	it('on success the row becomes "sent" with the message id, in the same transaction as the enrollment advance', async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment()]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1), step(2)]));

		await runDueFollowups();

		expect(rootDb.$transaction).toHaveBeenCalledTimes(1);
		expect(tx.followup_send.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "fs1" },
				data: expect.objectContaining({ status: "sent", postmark_message_id: "pm-1" }),
			}),
		);
		expect(tx.followup_enrollment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ current_step_order: 1 }) }),
		);
	});

	it('on a thrown send error the row becomes "failed" and the step is retried', async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment()]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1), step(2)]));
		sendMock.mockRejectedValue(new Error("boom"));

		await runDueFollowups();

		expect(rootDb.followup_send.update).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "fs1" }, data: expect.objectContaining({ status: "failed" }) }),
		);
		const retry = rootDb.followup_enrollment.update.mock.calls.at(-1)![0];
		expect(retry.data.current_step_order).toBeUndefined();
		expect(retry.data.next_send_at).toBeInstanceOf(Date);
		expect(rootDb.$transaction).not.toHaveBeenCalled();
	});

	it('when a "sending" row already exists for the next step (crash recovery), the step is not sent again; the row is marked sent with error "outcome_unknown" and the enrollment advances', async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment()]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1), step(2)]));
		scoped.followup_send.findFirst.mockImplementation(async (args: { where: { status?: { in: string[] } } }) =>
			args.where.status?.in ? { id: "fs-old", status: "sending" } : null,
		);

		await runDueFollowups();

		expect(sendMock).not.toHaveBeenCalled();
		expect(rootDb.followup_send.create).not.toHaveBeenCalled();
		expect(tx.followup_send.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "fs-old" },
				data: expect.objectContaining({ status: "sent", error: "outcome_unknown" }),
			}),
		);
		expect(tx.followup_enrollment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ current_step_order: 1 }) }),
		);
	});

	it("when a sent row already exists for this step and anchor, the step is not sent again and the enrollment advances", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment()]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1), step(2)]));
		scoped.followup_send.findFirst.mockImplementation(async (args: { where: { status?: { in: string[] } } }) =>
			args.where.status?.in ? { id: "fs-sent", status: "sent" } : null,
		);

		await runDueFollowups();

		expect(sendMock).not.toHaveBeenCalled();
		expect(rootDb.followup_send.create).not.toHaveBeenCalled();
		expect(tx.followup_send.update).not.toHaveBeenCalled();
		expect(tx.followup_enrollment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ current_step_order: 1 }) }),
		);
	});

	it("when the sending insert hits the unique index, the step is not sent and the enrollment advances over the live row", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment()]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1), step(2)]));
		rootDb.followup_send.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
		let lookups = 0;
		scoped.followup_send.findFirst.mockImplementation(async (args: { where: { status?: { in: string[] } } }) =>
			args.where.status?.in && ++lookups === 2 ? { id: "fs-sent", status: "sent" } : null,
		);

		await runDueFollowups();

		expect(sendMock).not.toHaveBeenCalled();
		expect(tx.followup_enrollment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ current_step_order: 1 }) }),
		);
	});

	it("the post-send advance is guarded on the lease value this worker set", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment()]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1), step(2)]));

		await runDueFollowups();

		const lease = rootDb.followup_enrollment.updateMany.mock.calls[0][0].data.next_send_at;
		expect(tx.followup_enrollment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "e1", next_send_at: lease } }),
		);
		expect(tx.followup_send.update.mock.calls[0][0].data.error).toBeNull();
	});

	it("still schedules the retry when recording the failed row throws", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment()]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1), step(2)]));
		sendMock.mockRejectedValue(new Error("boom"));
		rootDb.followup_send.update.mockRejectedValue(new Error("db down"));

		await runDueFollowups();

		const retry = rootDb.followup_enrollment.update.mock.calls.at(-1)![0];
		expect(retry.data.next_send_at).toBeInstanceOf(Date);
	});

	it("a rescheduled visit can send the same step again for the new anchor", async () => {
		const newAnchor = new Date(Date.now() + 72 * 3600_000);
		rootDb.followup_enrollment.findMany.mockResolvedValue([
			baseEnrollment({
				anchor_entity_type: "job_visit",
				anchor_entity_id: "v1",
				anchor_at: newAnchor,
			}),
		]);
		scoped.job_visit.findUnique.mockResolvedValue({ status: "Scheduled" });
		scoped.job_visit.findFirst.mockResolvedValue({
			id: "v1",
			scheduled_start_at: newAnchor,
			arrival_constraint: "at",
			arrival_time: "08:00",
			arrival_window_start: null,
			arrival_window_end: null,
			job: { name: "Tune-up", address: "1 Main St" },
			visit_techs: [],
			arrivals: [],
			drives: [],
		});
		scoped.followup_sequence.findFirst.mockResolvedValue(
			sequence([step(1, { category: "reminder", delay_amount: 1, delay_unit: "days", condition: "always" })], {
				trigger_type: "visit_scheduled",
				stop_on_open: false,
			}),
		);

		await runDueFollowups();

		expect(sendMock).toHaveBeenCalledTimes(1);
		expect(rootDb.followup_send.create.mock.calls[0][0].data.anchor_at).toEqual(newAnchor);
		expect(scoped.followup_send.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ status: { in: ["sending", "sent"] }, anchor_at: newAnchor }),
			}),
		);
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

	it("a single-step reminder whose send time passed more than 10 minutes ago is skipped with reminder_window_passed, not sent", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([
			baseEnrollment({
				anchor_entity_type: "job_visit",
				anchor_entity_id: "v1",
				anchor_at: new Date(Date.now() + 2 * 60 * 60 * 1000),
			}),
		]);
		scoped.job_visit.findUnique.mockResolvedValue({ status: "Scheduled" });
		scoped.followup_sequence.findFirst.mockResolvedValue(
			sequence([step(1, { delay_amount: 1, delay_unit: "days", condition: "always" })], {
				trigger_type: "visit_scheduled",
				stop_on_open: false,
			}),
		);

		await runDueFollowups();

		expect(sendMock).not.toHaveBeenCalled();
		expect(tx.followup_send.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "skipped", error: "reminder_window_passed" }),
			}),
		);
		expect(tx.followup_enrollment.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "completed", next_send_at: null }),
			}),
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


	describe("visit variables", () => {
		const visitRow = {
			id: "v1",
			scheduled_start_at: new Date("2026-11-18T14:00:00Z"),
			arrival_constraint: "at",
			arrival_time: "08:00",
			arrival_window_start: null,
			arrival_window_end: null,
			job: { name: "Tune-up", address: "1 Main St" },
			visit_techs: [{ tech: { name: "Ann Lee" } }],
			arrivals: [],
			drives: [],
		};
		const setup = () => {
			rootDb.followup_enrollment.findMany.mockResolvedValue([
				baseEnrollment({
					anchor_entity_type: "job_visit",
					anchor_entity_id: "v1",
					anchor_at: new Date(Date.now() + 48 * 3600_000),
				}),
			]);
			scoped.job_visit.findUnique.mockResolvedValue({ status: "Scheduled" });
			scoped.job_visit.findFirst.mockResolvedValue(visitRow);
			scoped.followup_sequence.findFirst.mockResolvedValue(
				sequence([step(1, { category: "reminder", condition: "always" })], {
					trigger_type: "visit_scheduled",
					stop_on_open: false,
				}),
			);
		};

		it("a reminder for a job_visit anchor renders visit.date and visit.window into subject and body", async () => {
			setup();
			templateMock.mockResolvedValue({
				subject: "Visit {{visit.date}}",
				html: "<p>{{visit.window}} with {{visit.tech_first_name}}</p>",
				text: null,
			});
			await runDueFollowups();
			expect(sendMock).toHaveBeenCalledWith(
				"client@x.com",
				"Visit Wednesday, November 18",
				"<p>at 8:00 AM with Ann</p>",
				null,
				expect.anything(),
			);
		});

		it("a job_visit reminder whose visit no longer exists is skipped and not sent", async () => {
			setup();
			scoped.job_visit.findFirst.mockResolvedValue(null);
			await runDueFollowups();
			expect(sendMock).not.toHaveBeenCalled();
			expect(rootDb.followup_send.create).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ status: "skipped", error: "visit_not_found" }),
				}),
			);
			expect(rootDb.followup_enrollment.update).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ status: "stopped", stop_reason: "visit_not_found" }),
				}),
			);
		});

		it("the text/plain body is rendered with escape:false", async () => {
			setup();
			brandMock.mockResolvedValueOnce({ brand: { name: "Smith & Sons" } });
			templateMock.mockResolvedValue({
				subject: "s",
				html: "<p>x</p>",
				text: "From {{brand.name}}",
			});
			await runDueFollowups();
			expect(sendMock.mock.calls[0][3]).toBe("From Smith & Sons");
		});
	});
});

describe("recipient resolution at send time", () => {
	it("the scheduler sends to the contact's current email when it changed after enrollment", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment({ contact_id: "ct1" })]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1)]));
		scoped.contact.findFirst.mockResolvedValue({ email: "new@x.com", is_active: true, type: "customer" });

		await runDueFollowups();

		expect(sendMock).toHaveBeenCalledWith("new@x.com", expect.any(String), expect.any(String), null, expect.anything());
	});

	it("the scheduler falls back to the stored recipient_email when contact_id is null", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment({ contact_id: null })]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1)]));

		await runDueFollowups();

		expect(scoped.contact.findFirst).not.toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: expect.anything() } }),
		);
		expect(sendMock).toHaveBeenCalledWith("client@x.com", expect.any(String), expect.any(String), null, expect.anything());
	});

	it("an enrollment with no contact issues the unsubscribe link from the org contact matching the recipient", async () => {
		templateMock.mockResolvedValueOnce({
			subject: "Hi",
			html: '<a href="{{unsubscribe_url}}">Unsubscribe</a>',
			text: null,
		});
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment({ contact_id: null })]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1)]));
		scoped.contact.findFirst.mockResolvedValue({ id: "k9" });

		await runDueFollowups();

		expect(scoped.contact.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					email: { equals: "client@x.com", mode: "insensitive" },
					is_active: true,
				}),
			}),
		);
		expect(issueLinkMock).toHaveBeenCalledWith("org1", {
			purpose: "unsubscribe",
			entityId: "k9",
			contactId: "k9",
		});
		const [, , html, , opts] = sendMock.mock.calls[0];
		expect(html).toContain("https://app.test/app/c/tok-1");
		expect(opts.headers).toHaveLength(2);
	});

	it("fails the enrollment with no_recipient_email when the contact is inactive or deleted", async () => {
		rootDb.followup_enrollment.findMany.mockResolvedValue([baseEnrollment({ contact_id: "ct1" })]);
		scoped.followup_sequence.findFirst.mockResolvedValue(sequence([step(1)]));
		scoped.contact.findFirst.mockResolvedValue({ email: "x@x.com", is_active: false, type: "customer" });
		await runDueFollowups();
		scoped.contact.findFirst.mockResolvedValue(null);
		await runDueFollowups();

		expect(sendMock).not.toHaveBeenCalled();
		expect(rootDb.followup_enrollment.update).toHaveBeenCalledTimes(2);
		expect(rootDb.followup_enrollment.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "failed", stop_reason: "no_recipient_email" }),
			}),
		);
	});
});
