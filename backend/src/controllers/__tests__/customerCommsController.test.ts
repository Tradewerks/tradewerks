import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => ({
	db: (await import("../../routes/__tests__/harness.js")).createFakeDb(),
}));

const smsActive = vi.hoisted(() => vi.fn(async () => false));
const smsModuleOn = vi.hoisted(() => vi.fn(() => true));
vi.mock("../../services/sms/smsAvailability.js", () => ({
	isSmsActive: smsActive,
	smsUnavailableReason: async () =>
		!smsModuleOn()
			? "sms_module_off"
			: (await smsActive())
				? null
				: "sms_not_active",
}));

import { db } from "../../db.js";
import router from "../../routes/customerComms.js";
import followupsRouter from "../../routes/followups.js";
import orgRouter from "../../routes/org.js";
import { callRoute } from "../../routes/__tests__/harness.js";

const fake = db as any;

beforeEach(() => {
	vi.clearAllMocks();
	smsActive.mockResolvedValue(false);
	smsModuleOn.mockReturnValue(true);
	fake.customer_notification_setting.findMany.mockResolvedValue([]);
	fake.customer_notification_setting.upsert.mockResolvedValue({});
});

const put = (
	event: string,
	body: unknown,
	user: Record<string, unknown> = {},
) =>
	callRoute(router, "put", "/settings/:event", {
		params: { event },
		body,
		user,
	});

describe("customer comms settings API", () => {
	it("PUT refuses sms_enabled: true with 409 SMS_NOT_ACTIVE while the org has no active sms account", async () => {
		const r = await put("visit_confirmed", { sms_enabled: true });
		expect(r.status).toBe(409);
		expect(r.body.error.code).toBe("SMS_NOT_ACTIVE");
		expect(
			fake.customer_notification_setting.upsert,
		).not.toHaveBeenCalled();
	});

	it("PUT allows sms_enabled: true once the sms account is active", async () => {
		smsActive.mockResolvedValue(true);
		const r = await put("visit_confirmed", { sms_enabled: true });
		expect(r.status).toBe(200);
		expect(
			fake.customer_notification_setting.upsert.mock.calls[0][0].update,
		).toEqual({ sms_enabled: true });
	});

	it("sms_available needs the sms module as well as an active account; PUT sms_enabled is refused while the module is off", async () => {
		smsActive.mockResolvedValue(true);
		const on = await callRoute(router, "get", "/settings", {});
		expect(on.body.data.events[0].sms_available).toBe(true);

		smsModuleOn.mockReturnValue(false);
		const off = await callRoute(router, "get", "/settings", {});
		expect(off.body.data.events[0].sms_available).toBe(false);
		const r = await put("visit_confirmed", { sms_enabled: true });
		expect(r.status).toBe(409);
	});

	it("PUT with lead_hours [0] or four entries returns 400", async () => {
		const zero = await put("visit_reminder", {
			config: { lead_hours: [0] },
		});
		const four = await put("visit_reminder", {
			config: { lead_hours: [1, 2, 3, 4] },
		});
		const over = await put("visit_reminder", {
			config: { lead_hours: [169] },
		});
		expect([zero.status, four.status, over.status]).toEqual([
			400, 400, 400,
		]);
		expect(
			fake.customer_notification_setting.upsert,
		).not.toHaveBeenCalled();
	});

	it("PUT saves valid lead_hours and GET defaults the reminder to [24]", async () => {
		const ok = await put("visit_reminder", {
			email_enabled: true,
			config: { lead_hours: [48, 2] },
		});
		expect(ok.status).toBe(200);
		const get = await callRoute(router, "get", "/settings", {});
		const reminder = get.body.data.events.find(
			(e: any) => e.event === "visit_reminder",
		);
		expect(reminder.config).toEqual({ lead_hours: [24] });
		expect(get.body.data.events).toHaveLength(8);
		expect(reminder.sms_available).toBe(false);
	});

	it("a dispatcher without manage_customer_comms gets 403 on PUT and 200 on GET", async () => {
		const user = {
			role: "dispatcher",
			permissions: ["view_customer_comms"],
		};
		const putRes = await put(
			"visit_confirmed",
			{ email_enabled: true },
			user,
		);
		const getRes = await callRoute(router, "get", "/settings", { user });
		expect(putRes.status).toBe(403);
		expect(getRes.status).toBe(200);
	});
});

const row = (over: Record<string, unknown> = {}) => ({
	category: "visit_confirmed",
	name: "Visit confirmed",
	subject: "S",
	html: "<p>H</p>",
	text: null,
	sms_body: "{{brand.name}}: hi",
	updated_at: new Date("2026-11-16"),
	...over,
});

describe("customer message templates API", () => {
	const get = (event: string) =>
		callRoute(router, "get", "/templates/:event", { params: { event } });

	it("GET returns the built-in message with a text body when nothing is saved", async () => {
		fake.email_template.findUnique.mockResolvedValue(null);
		const r = await get("visit_confirmed");
		expect(r.status).toBe(200);
		expect(r.body.data.is_customized).toBe(false);
		expect(r.body.data.sms_body).toMatch(/^\{\{brand\.name\}\}:/);
	});

	it("GET returns the saved row when one exists", async () => {
		fake.email_template.findUnique.mockResolvedValue(row());
		const r = await get("visit_confirmed");
		expect(r.body.data).toMatchObject({
			is_customized: true,
			subject: "S",
		});
	});

	it("PUT saves subject, html and sms_body, blank sms_body becoming null", async () => {
		fake.email_template.upsert.mockResolvedValue(row());
		const r = await callRoute(router, "put", "/templates/:event", {
			params: { event: "visit_confirmed" },
			body: { subject: "S", html: "<p>H</p>", sms_body: "  " },
		});
		expect(r.status).toBe(200);
		expect(
			fake.email_template.upsert.mock.calls[0][0].update,
		).toMatchObject({
			subject: "S",
			sms_body: null,
		});
	});

	it("PUT with an empty subject returns 400", async () => {
		const r = await callRoute(router, "put", "/templates/:event", {
			params: { event: "visit_confirmed" },
			body: { subject: "", html: "<p>H</p>" },
		});
		expect(r.status).toBe(400);
	});

	it("POST reset deletes the override and returns the built-in message", async () => {
		const r = await callRoute(router, "post", "/templates/:event/reset", {
			params: { event: "visit_confirmed" },
		});
		expect(r.status).toBe(200);
		expect(fake.email_template.deleteMany).toHaveBeenCalled();
		expect(r.body.data.is_customized).toBe(false);
	});

	it("an unknown event returns 404 on every event route", async () => {
		const params = { event: "nope" };
		const results = await Promise.all([
			callRoute(router, "get", "/templates/:event", { params }),
			callRoute(router, "put", "/templates/:event", { params, body: {} }),
			callRoute(router, "post", "/templates/:event/reset", { params }),
			put("nope", { email_enabled: true }),
		]);
		expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404]);
	});

	it("a followup template rejects sms_body with 400", async () => {
		const r = await callRoute(
			followupsRouter,
			"put",
			"/templates/:category",
			{
				params: { category: "followup" },
				body: { subject: "S", html: "<p>H</p>", sms_body: "text" },
			},
		);
		expect(r.status).toBe(400);
		expect(fake.email_template.upsert).not.toHaveBeenCalled();
	});

	it("PUT rejects duplicate reminder times", async () => {
		const r = await put("visit_reminder", {
			config: { lead_hours: [24, 24] },
		});
		expect(r.status).toBe(400);
	});
});

describe("review request settings", () => {
	const REVIEW = "https://g.page/r/acme/review";

	beforeEach(() => {
		fake.organization.findUnique.mockResolvedValue({ review_url: null });
		fake.organization.update.mockResolvedValue({});
		fake.customer_notification_setting.findFirst.mockResolvedValue(null);
	});

	it("enabling review_request without a review_url is refused with 409 REVIEW_URL_REQUIRED", async () => {
		const email = await put("review_request", { email_enabled: true });
		expect(email.status).toBe(409);
		expect(email.body.error.code).toBe("REVIEW_URL_REQUIRED");
		const blank = await put("review_request", {
			email_enabled: true,
			review_url: "",
		});
		expect(blank.status).toBe(409);
		expect(
			fake.customer_notification_setting.upsert,
		).not.toHaveBeenCalled();
		expect(fake.organization.update).not.toHaveBeenCalled();

		// Clearing the link while the request is on is refused the same way.
		fake.organization.findUnique.mockResolvedValue({ review_url: REVIEW });
		fake.customer_notification_setting.findFirst.mockResolvedValue({
			email_enabled: true,
			sms_enabled: false,
		});
		const clear = await put("review_request", { review_url: null });
		expect(clear.status).toBe(409);
		expect(clear.body.error.code).toBe("REVIEW_URL_REQUIRED");
	});

	it("enabling review_request with a saved or supplied review_url succeeds", async () => {
		const withLink = await put("review_request", {
			email_enabled: true,
			review_url: REVIEW,
		});
		expect(withLink.status).toBe(200);
		expect(fake.organization.update.mock.calls[0][0].data).toEqual({
			review_url: REVIEW,
		});

		fake.organization.findUnique.mockResolvedValue({ review_url: REVIEW });
		const saved = await put("review_request", { sms_enabled: false });
		expect(saved.status).toBe(200);
		const get = await callRoute(router, "get", "/settings", {});
		const review = get.body.data.events.find(
			(e: any) => e.event === "review_request",
		);
		expect(review.review_url).toBe(REVIEW);
		expect(review.config).toEqual({ delay_hours: 2 });
	});

	it("saving the link and the switch writes both in one transaction", async () => {
		const extend = vi.spyOn(fake, "$extends");
		try {
			const r = await put("review_request", {
				email_enabled: true,
				review_url: REVIEW,
			});
			expect(r.status).toBe(200);
			const tx = extend.mock.results
				.map((x) => x.value.$transaction)
				.find((t) => t.mock.calls.length > 0);
			expect(tx).toBeDefined();
			expect(typeof tx.mock.calls[0][0]).toBe("function");
			expect(
				fake.organization.update.mock.invocationCallOrder[0],
			).toBeGreaterThan(tx.mock.invocationCallOrder[0]);
			expect(
				fake.customer_notification_setting.upsert.mock
					.invocationCallOrder[0],
			).toBeGreaterThan(tx.mock.invocationCallOrder[0]);
		} finally {
			extend.mockRestore();
		}
	});

	it("review_url must be https", async () => {
		for (const review_url of [
			"http://g.page/r/acme/review",
			"javascript:alert(1)",
			"g.page/r/acme",
		]) {
			const r = await put("review_request", { review_url });
			expect(r.status).toBe(400);
		}
		const org = await callRoute(orgRouter, "patch", "/", {
			body: { review_url: "http://g.page/r/acme/review" },
		});
		expect(org.status).toBe(400);
		expect(fake.organization.update).not.toHaveBeenCalled();
	});

	it("review_url is only accepted on the review_request event", async () => {
		const r = await put("visit_confirmed", { review_url: REVIEW });
		expect(r.status).toBe(400);
	});

	it("delay_hours must be a whole number from 1 to 72", async () => {
		const results = await Promise.all(
			[0, 73, 1.5].map((delay_hours) =>
				put("review_request", { config: { delay_hours } }),
			),
		);
		expect(results.map((r) => r.status)).toEqual([400, 400, 400]);
		const ok = await put("review_request", { config: { delay_hours: 24 } });
		expect(ok.status).toBe(200);
	});
});

describe("customer message log API", () => {
	it("GET /messages filters by entity and clamps the limit", async () => {
		fake.customer_message.findMany.mockResolvedValue([{ id: "m1" }]);
		const r = await callRoute(router, "get", "/messages", {
			query: { entity_type: "job_visit", entity_id: "v1", limit: "20" },
		});
		expect(r.status).toBe(200);
		const args = fake.customer_message.findMany.mock.calls[0][0];
		expect(args.take).toBe(20);
		const where = JSON.stringify(args.where);
		expect(where).toContain('"entity_id":"v1"');
		expect(where).toContain('"entity_type":"job_visit"');
		const over = await callRoute(router, "get", "/messages", {
			query: { limit: "500" },
		});
		expect(over.status).toBe(400);
	});

	it("GET /messages never returns a live link token, even from a queued row", async () => {
		fake.customer_message.findMany.mockResolvedValue([
			{
				id: "m1",
				status: "queued",
				body: "Details: https://app.test/app/c/abcDEF_123-x. Reply STOP",
			},
			{ id: "m2", status: "sent", body: null },
		]);
		const r = await callRoute(router, "get", "/messages", { query: {} });
		expect(r.status).toBe(200);
		const text = JSON.stringify(r.body);
		expect(text).not.toContain("abcDEF_123-x");
		expect(r.body.data[0].body).toBe(
			"Details: https://app.test/app/c/… Reply STOP",
		);
		expect(r.body.data[1].body).toBeNull();
	});
});
