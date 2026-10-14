import { describe, it, expect, vi, beforeEach } from "vitest";
import { handlePostmarkWebhook } from "../postmarkWebhook.js";
import { db } from "../../db.js";

vi.mock("../../db.js", () => {
	const mockDb = {
		followup_send: {
			findUnique: vi.fn(),
			update: vi.fn().mockResolvedValue({}),
		},
		followup_enrollment: {
			update: vi.fn().mockResolvedValue({}),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
	};
	return { db: mockDb };
});

vi.mock("../appLogger.js", () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const mockNotify = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock("../../controllers/notificationsController.js", () => ({ notifyDispatchers: mockNotify }));

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

describe("handlePostmarkWebhook — other record types", () => {
	it("ignores unrelated record types with 200", async () => {
		const res = makeRes();
		await handlePostmarkWebhook(makeReq({ RecordType: "Delivery", MessageID: "m1" }, { secret: SECRET }), res);
		expect(res.statusCode).toBe(200);
		expect(mockDb.followup_send.findUnique).not.toHaveBeenCalled();
	});
});
