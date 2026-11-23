import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = await vi.hoisted(async () => {
	const { makeFakeDb } = await import("./fakeOutboxDb.js");
	return {
		fake: makeFakeDb(),
		isModuleOn: vi.fn(async () => true),
		canSend: vi.fn(async () => true),
		send: vi.fn(),
		logActivity: vi.fn(async () => undefined),
		notifyDispatchers: vi.fn(async () => []),
	};
});
const { fake, isModuleOn, canSend, send, logActivity, notifyDispatchers } =
	mocks;

vi.mock("../../../db.js", () => ({ db: mocks.fake.db }));
vi.mock("../../../lib/context.js", () => ({
	getScopedDb: () => mocks.fake.db,
}));
vi.mock("../../entitlementService.js", () => ({
	isModuleOn: mocks.isModuleOn,
}));
vi.mock("../../consentService.js", () => ({ canSend: mocks.canSend }));
vi.mock("../channels/index.js", () => ({
	getChannelAdapter: (c: string) =>
		c === "email" ? { channel: "email", send: mocks.send } : null,
}));
vi.mock("../../logger.js", () => ({ logActivity: mocks.logActivity }));
vi.mock("../../../controllers/notificationsController.js", () => ({
	notifyDispatchers: mocks.notifyDispatchers,
}));
vi.mock("../../emailBranding.js", () => ({
	getOrgBrandModel: vi.fn(async () => ({
		brand: { name: "Cool Air Co", phone: null },
	})),
}));
vi.mock("../../visitMessageModel.js", () => ({
	buildVisitModel: vi.fn(async () => ({
		visit: {
			date: "Thursday, June 11",
			window: "between 8:00 AM and 10:00 AM",
			address: "1 Main St",
			job_title: "Tune-up",
			tech_names: "Sam",
			tech_first_name: "Sam",
		},
	})),
}));
vi.mock("../../../lib/publicLink.js", () => ({
	issueLink: vi.fn(async () => ({
		url: "https://app.test/app/c/tok",
		token: "tok",
	})),
	issueMessageLink: vi.fn(async () => "https://app.test/app/c/visit-tok"),
	linkExpiry: () => null,
	unsubscribeHeaders: (t: string) => [
		{ Name: "List-Unsubscribe", Value: `<https://api.test/u?t=${t}>` },
	],
}));
vi.mock("../../appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SendRejected } from "../channels/types.js";
import { runOutboxSweep } from "../outboxSweeper.js";
import { issueMessageLink } from "../../../lib/publicLink.js";
import { log } from "../../appLogger.js";

const T0 = new Date("2026-06-10T15:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

function queue(over: Record<string, unknown> = {}) {
	fake.state.rows.push({
		id: `m${fake.state.rows.length + 1}`,
		organization_id: "org1",
		event: "visit_reminder",
		channel: "email",
		client_id: "c1",
		contact_id: "k1",
		recipient: "k1@x.test",
		entity_type: "job_visit",
		entity_id: "v1",
		dedupe_key: "visit_reminder:v1:24",
		status: "queued",
		skip_reason: null,
		send_after: T0,
		claimed_at: null,
		attempts: 0,
		provider_message_id: null,
		error: null,
		...over,
	});
	return fake.state.rows[fake.state.rows.length - 1];
}

beforeEach(() => {
	vi.clearAllMocks();
	fake.state.rows.length = 0;
	fake.state.settings.clear();
	fake.state.settings.set("visit_reminder", {
		email_enabled: true,
		sms_enabled: false,
	});
	fake.state.visits.clear();
	fake.state.visits.set("v1", { status: "Scheduled", job_id: "j1" });
	fake.state.contacts.clear();
	fake.state.contacts.set("k1", {
		id: "k1",
		email: "k1@x.test",
		phone: null,
		is_active: true,
		type: "customer",
	});
	isModuleOn.mockResolvedValue(true);
	canSend.mockResolvedValue(true);
	send.mockResolvedValue({ providerMessageId: "pm-1" });
});

describe("runOutboxSweep", () => {
	it("sends a due row, records it and logs customer_message.sent on the visit", async () => {
		const row = queue();
		await runOutboxSweep(T0);

		expect(send).toHaveBeenCalledTimes(1);
		const msg = send.mock.calls[0][0];
		expect(msg.to).toBe("k1@x.test");
		expect(msg.messageRowId).toBe(row.id);
		expect(msg.subject).toContain("Cool Air Co");
		expect(msg.html).toContain("Thursday, June 11");
		expect(row).toMatchObject({
			status: "sent",
			provider_message_id: "pm-1",
			attempts: 1,
		});
		expect(logActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "customer_message.sent",
				entity_type: "job_visit",
				entity_id: "v1",
			}),
		);
		expect(notifyDispatchers).not.toHaveBeenCalled();
	});

	it("leaves a row whose send_after is in the future", async () => {
		const row = queue({ send_after: minutes(1) });
		await runOutboxSweep(T0);
		expect(row.status).toBe("queued");
		expect(send).not.toHaveBeenCalled();
	});

	it('the sweeper skips a reminder whose visit is now Cancelled, with skip_reason "visit_cancelled"', async () => {
		fake.state.visits.set("v1", { status: "Cancelled", job_id: "j1" });
		const row = queue();
		await runOutboxSweep(T0);
		expect(row).toMatchObject({
			status: "skipped",
			skip_reason: "visit_cancelled",
		});
		expect(send).not.toHaveBeenCalled();
	});

	it("a reschedule notice due at or after the visit start is skipped with visit_started", async () => {
		fake.state.settings.set("visit_rescheduled", {
			email_enabled: true,
			sms_enabled: false,
		});
		const visit = {
			status: "Scheduled",
			job_id: "j1",
			scheduled_start_at: T0,
		};
		fake.state.visits.set("v1", visit);
		const row = queue({
			event: "visit_rescheduled",
			dedupe_key: "visit_rescheduled:v1:1",
			send_after: T0,
		});
		await runOutboxSweep(T0);

		expect(send).not.toHaveBeenCalled();
		expect(row).toMatchObject({
			status: "skipped",
			skip_reason: "visit_started",
		});
	});

	it("a reminder deferred past the visit start is skipped with reminder_window_passed", async () => {
		const visit = {
			status: "Scheduled",
			job_id: "j1",
			scheduled_start_at: T0,
		};
		fake.state.visits.set("v1", visit);
		const row = queue({ send_after: T0 });
		await runOutboxSweep(T0);

		expect(send).not.toHaveBeenCalled();
		expect(row).toMatchObject({
			status: "skipped",
			skip_reason: "reminder_window_passed",
		});
	});

	it("skips when the module is off or the event was switched off after queueing", async () => {
		isModuleOn.mockResolvedValueOnce(false);
		const a = queue();
		await runOutboxSweep(T0);
		expect(a.skip_reason).toBe("module_off");

		fake.state.settings.set("visit_reminder", {
			email_enabled: false,
			sms_enabled: false,
		});
		const b = queue({ dedupe_key: "other" });
		await runOutboxSweep(T0);
		expect(b.skip_reason).toBe("event_disabled");
		expect(send).not.toHaveBeenCalled();
	});

	it("the sweeper re-checks consent at send time", async () => {
		canSend.mockResolvedValue(false);
		const row = queue();
		await runOutboxSweep(T0);
		expect(canSend).toHaveBeenCalledWith(fake.db, "k1", "email");
		expect(row).toMatchObject({
			status: "skipped",
			skip_reason: "unsubscribed",
		});
		expect(send).not.toHaveBeenCalled();
	});

	it("a retryable SendRejected is retried 3 times then failed", async () => {
		send.mockRejectedValue(new SendRejected("rate limited", true));
		const row = queue();

		await runOutboxSweep(T0);
		expect(row).toMatchObject({ status: "queued", attempts: 1 });
		expect(row.send_after).toEqual(minutes(5));

		await runOutboxSweep(minutes(5));
		expect(row).toMatchObject({ status: "queued", attempts: 2 });

		await runOutboxSweep(minutes(10));
		expect(row).toMatchObject({
			status: "failed",
			attempts: 3,
			error: "rate limited",
		});

		await runOutboxSweep(minutes(30));
		expect(send).toHaveBeenCalledTimes(3);
		expect(logActivity).toHaveBeenCalledWith(
			expect.objectContaining({ event_type: "customer_message.failed" }),
		);
		expect(notifyDispatchers).toHaveBeenCalledTimes(1);
		expect(notifyDispatchers).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "customer_message_failed",
				actionUrl: "/dispatch/jobs/j1/visits/v1",
			}),
			"org1",
		);
	});

	it("a non-retryable SendRejected fails at once", async () => {
		send.mockRejectedValue(new SendRejected("inactive recipient", false));
		const row = queue();
		await runOutboxSweep(T0);
		expect(row).toMatchObject({ status: "failed", attempts: 1 });
		expect(notifyDispatchers).toHaveBeenCalledTimes(1);
	});

	it("a non-SendRejected throw marks the row unknown and it is never claimed again", async () => {
		send.mockRejectedValue(new Error("socket hang up"));
		const row = queue();

		await runOutboxSweep(T0);
		expect(row).toMatchObject({
			status: "unknown",
			error: "socket hang up",
		});

		await runOutboxSweep(minutes(15));
		await runOutboxSweep(minutes(60));
		expect(send).toHaveBeenCalledTimes(1);
		expect(row.status).toBe("unknown");
		expect(logActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "customer_message.unknown",
				entity_type: "job_visit",
				entity_id: "v1",
			}),
		);
		expect(notifyDispatchers).toHaveBeenCalledTimes(1);
	});

	it("a row left in sending for 11 minutes becomes unknown and notifies dispatchers", async () => {
		const stale = queue({
			status: "sending",
			claimed_at: minutes(-12),
			send_started_at: minutes(-11),
			attempts: 1,
		});
		const fresh = queue({
			dedupe_key: "fresh",
			status: "sending",
			claimed_at: minutes(-12),
			send_started_at: minutes(-5),
			attempts: 1,
		});

		await runOutboxSweep(T0);

		expect(stale.status).toBe("unknown");
		expect(fresh.status).toBe("sending");
		expect(send).not.toHaveBeenCalled();
		expect(notifyDispatchers).toHaveBeenCalledTimes(1);
		expect(notifyDispatchers).toHaveBeenCalledWith(
			expect.objectContaining({ type: "customer_message_failed" }),
			"org1",
		);
		expect(logActivity).toHaveBeenCalledWith(
			expect.objectContaining({ event_type: "customer_message.unknown" }),
		);
	});

	it("a row claimed 11 minutes ago whose provider call never started is requeued and sent once, not marked unknown", async () => {
		const waiting = queue({
			status: "sending",
			claimed_at: minutes(-11),
			send_started_at: null,
			attempts: 1,
		});
		await runOutboxSweep(T0);
		expect(waiting.status).toBe("sent");
		expect(send).toHaveBeenCalledTimes(1);
		expect(notifyDispatchers).not.toHaveBeenCalled();
	});

	it("a batch row re-claimed by another sweep while it waited is not sent by the first", async () => {
		const row = queue();
		canSend.mockImplementationOnce(async () => {
			// Another sweep requeued and re-claimed it meanwhile.
			row.claimed_at = minutes(1);
			return true;
		});
		await runOutboxSweep(T0);
		expect(send).not.toHaveBeenCalled();
		expect(row.status).toBe("sending");
		expect(row.send_started_at ?? null).toBeNull();
	});

	it("a stale sweep whose row was re-claimed meanwhile writes nothing over it, even on prepare_failed", async () => {
		const row = queue();
		const reclaimedAt = minutes(11);
		const startedAt = minutes(11);
		isModuleOn.mockImplementationOnce(async () => {
			// Sweep B requeued, re-claimed and started sending it.
			Object.assign(row, {
				claimed_at: reclaimedAt,
				send_started_at: startedAt,
			});
			throw new Error("db blip");
		});
		await runOutboxSweep(T0);
		expect(row).toMatchObject({
			status: "sending",
			claimed_at: reclaimedAt,
			send_started_at: startedAt,
			error: null,
		});

		const skipped = queue({ dedupe_key: "s" });
		isModuleOn.mockImplementationOnce(async () => {
			skipped.claimed_at = minutes(11);
			return false;
		});
		await runOutboxSweep(T0);
		expect(skipped.status).toBe("sending");
		expect(skipped.skip_reason).toBeNull();
	});

	it("an orphan requeue gives back the attempt it never used and is logged", async () => {
		const waiting = queue({
			status: "sending",
			claimed_at: minutes(-11),
			send_started_at: null,
			attempts: 1,
		});
		send.mockRejectedValueOnce(new SendRejected("busy", true));
		await runOutboxSweep(T0);
		// Requeued (attempts back to 0), re-claimed (1), retried once.
		expect(waiting).toMatchObject({ status: "queued", attempts: 1 });
		expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
			{ messageIds: [waiting.id] },
			expect.stringContaining("requeued"),
		);
	});

	it("the provider call stamps send_started_at", async () => {
		const row = queue();
		await runOutboxSweep(T0);
		expect(row.send_started_at).toBeInstanceOf(Date);
	});

	it("a visit message is skipped with job_cancelled once the visit's job is Cancelled", async () => {
		fake.state.visits.set("v1", {
			status: "Scheduled",
			job_id: "j1",
			job: { status: "Cancelled" },
		} as never);
		const row = queue();
		await runOutboxSweep(T0);
		expect(row).toMatchObject({
			status: "skipped",
			skip_reason: "job_cancelled",
		});
		expect(send).not.toHaveBeenCalled();
	});

	it("a reminder queued for a start the visit no longer has is skipped with start_moved", async () => {
		const queuedFor = minutes(24 * 60);
		fake.state.visits.set("v1", {
			status: "Scheduled",
			job_id: "j1",
			scheduled_start_at: minutes(30 * 60),
		} as never);
		const moved = queue({
			dedupe_key: `visit_reminder:v1:24:${queuedFor.toISOString()}`,
		});
		const current = queue({
			dedupe_key: `visit_reminder:v1:6:${minutes(30 * 60).toISOString()}`,
		});
		await runOutboxSweep(T0);
		expect(moved).toMatchObject({
			status: "skipped",
			skip_reason: "start_moved",
		});
		expect(current.status).toBe("sent");
	});

	it("a failure before the provider call is retried, not marked unknown", async () => {
		isModuleOn.mockRejectedValueOnce(new Error("db blip"));
		const row = queue();
		await runOutboxSweep(T0);
		expect(row).toMatchObject({
			status: "queued",
			error: "prepare_failed",
		});
		expect(send).not.toHaveBeenCalled();
	});

	it('skips with "address_changed" when the contact\'s address was edited after queueing; case alone is not a change', async () => {
		fake.state.contacts.set("k1", {
			id: "k1",
			email: "K1@X.test",
			phone: null,
			is_active: true,
			type: "customer",
		});
		const same = queue();
		await runOutboxSweep(T0);
		expect(same.status).toBe("sent");

		fake.state.contacts.set("k1", {
			id: "k1",
			email: "new@x.test",
			phone: null,
			is_active: true,
			type: "customer",
		});
		const edited = queue({ dedupe_key: "other" });
		await runOutboxSweep(T0);
		expect(edited).toMatchObject({
			status: "skipped",
			skip_reason: "address_changed",
		});
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('a row with no contact is skipped as "contact_ineligible"', async () => {
		const row = queue({ contact_id: null });
		await runOutboxSweep(T0);
		expect(row).toMatchObject({
			status: "skipped",
			skip_reason: "contact_ineligible",
		});
		expect(send).not.toHaveBeenCalled();
	});

	it("does not send when the claim was lost before the provider call", async () => {
		const row = queue();
		canSend.mockImplementationOnce(async () => {
			// The stale check of another sweep wrote the row off meanwhile.
			row.status = "unknown";
			return true;
		});
		await runOutboxSweep(T0);
		expect(send).not.toHaveBeenCalled();
		expect(row.status).toBe("unknown");
		expect(logActivity).not.toHaveBeenCalled();
		expect(notifyDispatchers).not.toHaveBeenCalled();
	});

	it("reports nothing when the outcome write loses to the stale check", async () => {
		const sent = queue();
		send.mockImplementationOnce(async () => {
			sent.status = "unknown";
			return { providerMessageId: "pm-late" };
		});
		await runOutboxSweep(T0);
		expect(sent.status).toBe("unknown");
		expect(sent.provider_message_id).toBeNull();

		const failed = queue({ dedupe_key: "f" });
		send.mockImplementationOnce(async () => {
			failed.status = "unknown";
			throw new SendRejected("inactive recipient", false);
		});
		await runOutboxSweep(T0);
		expect(failed.status).toBe("unknown");

		expect(logActivity).not.toHaveBeenCalled();
		expect(notifyDispatchers).not.toHaveBeenCalled();
	});

	it("an early delivered callback is not overwritten by the sent write; what was sent is still recorded", async () => {
		const row = queue();
		send.mockImplementationOnce(async () => {
			// The status webhook found the row by the id in its callback URL.
			Object.assign(row, {
				status: "delivered",
				provider_message_id: "pm-early",
				delivered_at: new Date(),
			});
			return { providerMessageId: "pm-early", segments: 1 };
		});
		await runOutboxSweep(T0);
		expect(row).toMatchObject({
			status: "delivered",
			provider_message_id: "pm-early",
			segments: 1,
		});
		expect(row.body).toEqual(expect.stringContaining("Thursday, June 11"));
		expect(row.sent_at).toBeInstanceOf(Date);
		expect(logActivity).toHaveBeenCalledWith(
			expect.objectContaining({ event_type: "customer_message.sent" }),
		);
	});

	it("sends List-Unsubscribe from the body's link and stores the text part actually sent", async () => {
		vi.spyOn(fake.db.email_template, "findFirst").mockResolvedValueOnce({
			subject: "S",
			html: "<p>Hi {{client_name}}</p><p>{{{unsubscribe_url}}}</p>",
			text: null,
			sms_body: null,
		} as never);
		const row = queue();
		await runOutboxSweep(T0);
		const msg = send.mock.calls[0][0];
		expect(msg.headers).toEqual([
			{ Name: "List-Unsubscribe", Value: "<https://api.test/u?t=tok>" },
		]);
		expect(msg.html).toContain("https://app.test/app/c/tok");
		expect(msg.text).toBe("Hi Acme Homes\n\nhttps://app.test/app/c/tok");
		expect(row.body).toBe("Hi Acme Homes\n\nhttps://app.test/app/c/…");
	});

	it("confirmation, reminder and on-my-way messages render {{link.visit}}", async () => {
		const events = ["visit_confirmed", "visit_reminder", "tech_on_the_way"];
		for (const event of events) {
			fake.state.settings.set(event, {
				email_enabled: true,
				sms_enabled: false,
			});
			queue({ event, dedupe_key: `${event}:v1` });
		}
		await runOutboxSweep(T0);
		expect(send).toHaveBeenCalledTimes(3);
		for (const [msg] of send.mock.calls) {
			expect(msg.html).toContain(
				'href="https://app.test/app/c/visit-tok"',
			);
			expect(msg.text).toContain("https://app.test/app/c/visit-tok");
		}
		expect(issueMessageLink).toHaveBeenCalledWith(
			"org1",
			expect.objectContaining({
				purpose: "visit",
				entityId: "v1",
				contactId: "k1",
			}),
		);
	});
});
