import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import { handlePostmarkWebhook } from "../postmarkWebhook.js";
import { db } from "../../db.js";

vi.mock("../../db.js", () => {
	const mockDb = {
		followup_send: {
			findUnique: vi.fn(),
			update: vi.fn().mockResolvedValue({}),
		},
		customer_message: { findUnique: vi.fn().mockResolvedValue(null) },
		followup_enrollment: {
			update: vi.fn().mockResolvedValue({}),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
	};
	return { db: mockDb };
});

vi.mock("../appLogger.js", () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const mockMsgUpdateMany = vi.hoisted(() => vi.fn().mockResolvedValue({ count: 1 }));
vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => ({ customer_message: { updateMany: mockMsgUpdateMany } })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../logger.js", () => ({ logActivity: mockLogActivity }));

const mockNotify = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock("../../controllers/notificationsController.js", () => ({ notifyDispatchers: mockNotify }));

const mockUnsub = vi.hoisted(() => vi.fn().mockResolvedValue(1));
vi.mock("../consentService.js", () => ({ unsubscribeByEmail: mockUnsub }));

const mockDb = db as unknown as {
	followup_send: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
	followup_enrollment: { update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
};

function makeRes() {
	const res: any = {};
	res.statusCode = 0;
	res.body = undefined;
	res.status = vi.fn().mockImplementation((code: number) => {
		res.statusCode = code;
		return res;
	});
	res.json = vi.fn().mockImplementation((b: unknown) => {
		res.body = b;
		return res;
	});
	return res;
}

function makeReq(body: unknown, opts?: { secret?: string; auth?: string }): any {
	return {
		body,
		query: opts?.secret ? { secret: opts.secret } : {},
		headers: opts?.auth ? { authorization: opts.auth } : {},
	};
}

const SECRET = "sekret";

beforeEach(() => {
	vi.clearAllMocks();
	process.env.POSTMARK_WEBHOOK_SECRET = SECRET;
});

describe("handlePostmarkWebhook — auth", () => {
	it("rejects a request with a wrong/missing secret", async () => {
		const res = makeRes();
		await handlePostmarkWebhook(makeReq({ RecordType: "Open", MessageID: "m1" }), res);
		expect(res.statusCode).toBe(401);
		expect(mockDb.followup_send.findUnique).not.toHaveBeenCalled();
	});

	it("accepts a valid query secret", async () => {
		mockDb.followup_send.findUnique.mockResolvedValue(null);
		const res = makeRes();
		await handlePostmarkWebhook(makeReq({ RecordType: "Open", MessageID: "m1" }, { secret: SECRET }), res);
		expect(res.statusCode).toBe(200);
	});

	it("accepts Basic auth where the password equals the secret", async () => {
		mockDb.followup_send.findUnique.mockResolvedValue(null);
		const res = makeRes();
		const auth = "Basic " + Buffer.from(`postmark:${SECRET}`).toString("base64");
		await handlePostmarkWebhook(makeReq({ RecordType: "Open", MessageID: "m1" }, { auth }), res);
		expect(res.statusCode).toBe(200);
	});
});

describe("handlePostmarkWebhook — Open", () => {
	const orgSend = (opened_at: Date | null) => ({
		id: "s1",
		organization_id: "org-1",
		enrollment_id: "e1",
		recipient_email: "harper@example.com",
		opened_at,
		enrollment: {
			status: "active",
			sequence: { stop_on_open: false, name: "Quote Chase" },
			client: { name: "Harper Residence" },
		},
	});

	it("notifies dispatchers on the first open only", async () => {
		mockDb.followup_send.findUnique.mockResolvedValue(orgSend(null));
		await handlePostmarkWebhook(makeReq({ RecordType: "Open", MessageID: "m1" }, { secret: SECRET }), makeRes());
		expect(mockNotify).toHaveBeenCalledWith(
			expect.objectContaining({ type: "followup_email_opened", title: "Harper Residence opened a follow-up" }),
			"org-1",
		);

		mockNotify.mockClear();
		mockDb.followup_send.findUnique.mockResolvedValue(orgSend(new Date("2026-07-01T00:00:00Z")));
		await handlePostmarkWebhook(makeReq({ RecordType: "Open", MessageID: "m1" }, { secret: SECRET }), makeRes());
		expect(mockNotify).not.toHaveBeenCalled();
	});

	it("first open sets opened_at, increments count, and completes when stop_on_open", async () => {
		mockDb.followup_send.findUnique.mockResolvedValue({
			id: "s1",
			enrollment_id: "e1",
			opened_at: null,
			enrollment: { status: "active", sequence: { stop_on_open: true } },
		});
		const res = makeRes();
		await handlePostmarkWebhook(
			makeReq({ RecordType: "Open", MessageID: "m1", ReceivedAt: "2026-07-08T12:00:00Z" }, { secret: SECRET }),
			res,
		);

		const updateArg = mockDb.followup_send.update.mock.calls[0][0];
		expect(updateArg.data.open_count).toEqual({ increment: 1 });
		expect(updateArg.data.opened_at).toBeInstanceOf(Date);
		expect(mockDb.followup_enrollment.update).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "e1" }, data: expect.objectContaining({ status: "completed" }) }),
		);
	});

	it("does NOT complete the enrollment when stop_on_open is false", async () => {
		mockDb.followup_send.findUnique.mockResolvedValue({
			id: "s1",
			enrollment_id: "e1",
			opened_at: null,
			enrollment: { status: "active", sequence: { stop_on_open: false } },
		});
		const res = makeRes();
		await handlePostmarkWebhook(makeReq({ RecordType: "Open", MessageID: "m1" }, { secret: SECRET }), res);
		expect(mockDb.followup_send.update).toHaveBeenCalled();
		expect(mockDb.followup_enrollment.update).not.toHaveBeenCalled();
	});

	it("an Open webhook does not complete an active enrollment whose sequence trigger is visit_scheduled", async () => {
		mockDb.followup_send.findUnique.mockResolvedValue({
			id: "s1",
			enrollment_id: "e1",
			opened_at: null,
			enrollment: {
				status: "active",
				sequence: { stop_on_open: true, trigger_type: "visit_scheduled" },
			},
		});
		await handlePostmarkWebhook(makeReq({ RecordType: "Open", MessageID: "m1" }, { secret: SECRET }), makeRes());
		expect(mockDb.followup_send.update).toHaveBeenCalled();
		expect(mockDb.followup_enrollment.update).not.toHaveBeenCalled();
	});

	it("duplicate open increments count but does not reset opened_at or re-complete", async () => {
		mockDb.followup_send.findUnique.mockResolvedValue({
			id: "s1",
			enrollment_id: "e1",
			opened_at: new Date("2026-07-01T00:00:00Z"),
			enrollment: { status: "active", sequence: { stop_on_open: true } },
		});
		const res = makeRes();
		await handlePostmarkWebhook(makeReq({ RecordType: "Open", MessageID: "m1" }, { secret: SECRET }), res);

		const updateArg = mockDb.followup_send.update.mock.calls[0][0];
		expect(updateArg.data.open_count).toEqual({ increment: 1 });
		expect(updateArg.data.opened_at).toBeUndefined();
		expect(mockDb.followup_enrollment.update).not.toHaveBeenCalled();
	});

	it("unknown MessageID is a no-op", async () => {
		mockDb.followup_send.findUnique.mockResolvedValue(null);
		const res = makeRes();
		await handlePostmarkWebhook(makeReq({ RecordType: "Open", MessageID: "nope" }, { secret: SECRET }), res);
		expect(res.statusCode).toBe(200);
		expect(mockDb.followup_send.update).not.toHaveBeenCalled();
	});
});

describe("handlePostmarkWebhook — Bounce / SpamComplaint", () => {
	it("bounce marks the send failed and stops the enrollment", async () => {
		mockDb.followup_send.findUnique.mockResolvedValue({ id: "s1", enrollment_id: "e1" });
		const res = makeRes();
		await handlePostmarkWebhook(makeReq({ RecordType: "Bounce", MessageID: "m1" }, { secret: SECRET }), res);

		expect(mockDb.followup_send.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "failed", error: "bounce" }) }),
		);
		expect(mockDb.followup_enrollment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "e1", status: "active" },
				data: expect.objectContaining({ status: "stopped", stop_reason: "bounce" }),
			}),
		);
	});

	it("spam complaint uses reason spam_complaint", async () => {
		mockDb.followup_send.findUnique.mockResolvedValue({ id: "s1", enrollment_id: "e1" });
		const res = makeRes();
		await handlePostmarkWebhook(makeReq({ RecordType: "SpamComplaint", MessageID: "m1" }, { secret: SECRET }), res);
		expect(mockDb.followup_enrollment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ stop_reason: "spam_complaint" }) }),
		);
	});
});

describe("handlePostmarkWebhook — consent suppression", () => {
	const send = { id: "s1", enrollment_id: "e1", organization_id: "org-1", recipient_email: "h@x.com" };
	const post = async (event: Record<string, unknown>) => {
		const res = makeRes();
		await handlePostmarkWebhook(makeReq({ MessageID: "m1", ...event }, { secret: SECRET }), res);
		return res;
	};

	it('a Bounce webhook with Type "HardBounce" unsubscribes the matching contact in the send\'s org only; a soft bounce does not', async () => {
		mockDb.followup_send.findUnique.mockResolvedValue(send);
		await post({ RecordType: "Bounce", Type: "HardBounce", Email: "H@x.com" });
		expect(mockUnsub).toHaveBeenCalledTimes(1);
		expect(mockUnsub).toHaveBeenCalledWith("org-1", "H@x.com", "bounce", expect.any(String));

		mockUnsub.mockClear();
		await post({ RecordType: "Bounce", Type: "SoftBounce", Email: "H@x.com" });
		expect(mockUnsub).not.toHaveBeenCalled();
	});

	it("a SpamComplaint unsubscribes with source spam_complaint", async () => {
		mockDb.followup_send.findUnique.mockResolvedValue(send);
		await post({ RecordType: "SpamComplaint", Email: "h@x.com" });
		expect(mockUnsub).toHaveBeenCalledWith("org-1", "h@x.com", "spam_complaint", expect.any(String));
	});

	it("a SubscriptionChange with SuppressSending true unsubscribes; with false does nothing", async () => {
		mockDb.followup_send.findUnique.mockResolvedValue(send);
		await post({ RecordType: "SubscriptionChange", SuppressSending: true, Recipient: "h@x.com" });
		expect(mockUnsub).toHaveBeenCalledWith("org-1", "h@x.com", "provider", expect.any(String));

		mockUnsub.mockClear();
		await post({ RecordType: "SubscriptionChange", SuppressSending: false, Recipient: "h@x.com" });
		expect(mockUnsub).not.toHaveBeenCalled();
	});

	it("does nothing when the MessageID matches no send", async () => {
		mockDb.followup_send.findUnique.mockResolvedValue(null);
		const res = await post({ RecordType: "Bounce", Type: "HardBounce", Email: "h@x.com" });
		expect(res.statusCode).toBe(200);
		expect(mockUnsub).not.toHaveBeenCalled();
	});

	it("a BadEmailAddress bounce unsubscribes; Transient and SpamNotification do not", async () => {
		mockDb.followup_send.findUnique.mockResolvedValue(send);
		await post({ RecordType: "Bounce", Type: "BadEmailAddress", Email: "h@x.com" });
		expect(mockUnsub).toHaveBeenCalledTimes(1);
		mockUnsub.mockClear();
		await post({ RecordType: "Bounce", Type: "Transient", Email: "h@x.com" });
		await post({ RecordType: "Bounce", Type: "SpamNotification", Email: "h@x.com" });
		expect(mockUnsub).not.toHaveBeenCalled();
	});

	it("a hard bounce still unsubscribes when followup bookkeeping throws", async () => {
		mockDb.followup_send.findUnique.mockResolvedValue(send);
		mockDb.followup_send.update.mockRejectedValueOnce(new Error("db down"));
		const res = await post({ RecordType: "Bounce", Type: "HardBounce", Email: "h@x.com" });
		expect(res.statusCode).toBe(200);
		expect(mockUnsub).toHaveBeenCalledTimes(1);
	});

	it("bookkeeping still runs when suppression throws", async () => {
		mockDb.followup_send.findUnique.mockResolvedValue(send);
		mockUnsub.mockRejectedValueOnce(new Error("consent down"));
		await post({ RecordType: "Bounce", Type: "HardBounce", Email: "h@x.com" });
		expect(mockDb.followup_enrollment.updateMany).toHaveBeenCalled();
	});

	it("looks the send up once per Bounce event", async () => {
		mockDb.followup_send.findUnique.mockResolvedValue(send);
		await post({ RecordType: "Bounce", Type: "HardBounce", Email: "h@x.com" });
		expect(mockDb.followup_send.findUnique).toHaveBeenCalledTimes(1);
	});

	it("webhook secret comparison uses timingSafeEqual and rejects a wrong secret of the same length", async () => {
		const spy = vi.spyOn(crypto, "timingSafeEqual");
		const res = makeRes();
		await handlePostmarkWebhook(makeReq({ RecordType: "Open", MessageID: "m1" }, { secret: "sekreT" }), res);
		expect(res.statusCode).toBe(401);
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});
});

describe("handlePostmarkWebhook — other record types", () => {
	it("ignores unrelated record types with 200", async () => {
		const res = makeRes();
		await handlePostmarkWebhook(makeReq({ RecordType: "Delivery", MessageID: "m1" }, { secret: SECRET }), res);
		expect(res.statusCode).toBe(200);
		expect(mockDb.followup_send.findUnique).not.toHaveBeenCalled();
	});
});

describe("handlePostmarkWebhook — customer_message rows", () => {
	const row = {
		id: "cm1",
		organization_id: "org-1",
		event: "quote_sent",
		recipient: "c@example.com",
		entity_type: "quote",
		entity_id: "q1",
	};
	const post = async (event: Record<string, unknown>) => {
		const res = makeRes();
		await handlePostmarkWebhook(makeReq({ MessageID: "pm-1", ...event }, { secret: SECRET }), res);
		return res;
	};
	const cmFind = () => (mockDb as any).customer_message.findUnique as ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockDb.followup_send.findUnique.mockResolvedValue(null);
		cmFind().mockResolvedValue(row);
	});

	it("a Delivery webhook sets delivered_at and status delivered on the matching customer_message", async () => {
		const res = await post({ RecordType: "Delivery", DeliveredAt: "2026-11-16T10:00:00Z" });
		expect(res.statusCode).toBe(200);
		expect(cmFind()).toHaveBeenCalledWith(
			expect.objectContaining({ where: { provider_message_id: "pm-1" } }),
		);
		expect(mockMsgUpdateMany).toHaveBeenCalledWith({
			where: { id: "cm1", status: { in: ["sent", "unknown"] } },
			data: { status: "delivered", delivered_at: new Date("2026-11-16T10:00:00Z") },
		});
	});

	it("a Bounce for a quote email marks the row failed, logs customer_message.failed on the quote, and notifies dispatchers with a link to the quote", async () => {
		await post({ RecordType: "Bounce", Type: "HardBounce", Email: "c@example.com" });
		expect(mockUnsub).toHaveBeenCalledWith("org-1", "c@example.com", "bounce", "Postmark HardBounce");
		expect(mockMsgUpdateMany).toHaveBeenCalledWith({
			where: { id: "cm1", status: { not: "failed" } },
			data: { status: "failed", error: "bounce" },
		});
		expect(mockLogActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "customer_message.failed",
				entity_type: "quote",
				entity_id: "q1",
				organization_id: "org-1",
			}),
		);
		expect(mockNotify).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "customer_message_failed",
				actionUrl: "/dispatch/quotes/q1",
			}),
			"org-1",
		);
	});

	it("a spam complaint on a customer_message unsubscribes without marking it failed", async () => {
		await post({ RecordType: "SpamComplaint", Email: "c@example.com" });
		expect(mockUnsub).toHaveBeenCalled();
		expect(mockMsgUpdateMany).not.toHaveBeenCalled();
	});

	it("an Open sets opened_at once", async () => {
		await post({ RecordType: "Open", ReceivedAt: "2026-11-16T11:00:00Z" });
		expect(mockMsgUpdateMany).toHaveBeenCalledWith({
			where: { id: "cm1", opened_at: null },
			data: { opened_at: new Date("2026-11-16T11:00:00Z") },
		});
	});

	it("an unknown MessageID is still ignored with 200", async () => {
		cmFind().mockResolvedValue(null);
		for (const RecordType of ["Delivery", "Open", "Bounce"]) {
			const res = await post({ RecordType });
			expect(res.statusCode).toBe(200);
		}
		expect(mockMsgUpdateMany).not.toHaveBeenCalled();
		expect(mockNotify).not.toHaveBeenCalled();
	});

	it("a duplicate Bounce notifies dispatchers once", async () => {
		mockMsgUpdateMany
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 0 });
		await post({ RecordType: "Bounce", Type: "HardBounce", Email: "c@example.com" });
		await post({ RecordType: "Bounce", Type: "HardBounce", Email: "c@example.com" });
		expect(mockNotify).toHaveBeenCalledTimes(1);
		expect(mockLogActivity).toHaveBeenCalledTimes(1);
	});

	it("a logActivity failure does not skip the dispatcher notification", async () => {
		mockLogActivity.mockRejectedValueOnce(new Error("log down"));
		await post({ RecordType: "Bounce", Type: "HardBounce", Email: "c@example.com" });
		expect(mockNotify).toHaveBeenCalledTimes(1);
	});

	it("a Delivery after a Bounce does not resurrect the row", async () => {
		await post({ RecordType: "Delivery" });
		const where = mockMsgUpdateMany.mock.calls[0][0].where;
		expect(where.status).toEqual({ in: ["sent", "unknown"] });
	});

	it("an Open after Delivery keeps the delivered status", async () => {
		await post({ RecordType: "Open" });
		const arg = mockMsgUpdateMany.mock.calls[0][0];
		expect(arg.data).not.toHaveProperty("status");
	});
});
