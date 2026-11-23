import { describe, it, expect, vi, beforeEach } from "vitest";
import { countSegments } from "../../sms/segments.js";

// Drives the real sweeper, the real channel registry (email + sms) and the real
// visit model; only the providers, the meter and consent writes are stubbed.
const mocks = await vi.hoisted(async () => {
	const { makeFakeDb } = await import("./fakeOutboxDb.js");
	return {
		fake: makeFakeDb(),
		isModuleOn: vi.fn(async (_o: string, _k: string) => true),
		canSend: vi.fn(async () => true),
		setSmsConsentByPhone: vi.fn(async () => ["k1"]),
		consumeQuota: vi.fn(async () => ({
			allowed: true,
			used: 1,
			limit: 500,
		})),
		smsSend: vi.fn(),
		emailSend: vi.fn(async () => ({ messageId: "pm-email" })),
		logActivity: vi.fn(async () => undefined),
		notifyDispatchers: vi.fn(async () => []),
	};
});
const { fake, isModuleOn, consumeQuota, smsSend, emailSend } = mocks;

vi.mock("../../../db.js", () => ({ db: mocks.fake.db }));
vi.mock("../../../lib/context.js", () => ({
	getScopedDb: () => mocks.fake.db,
}));
vi.mock("../../entitlementService.js", () => ({
	isModuleOn: mocks.isModuleOn,
}));
vi.mock("../../consentService.js", () => ({
	canSend: mocks.canSend,
	setSmsConsentByPhone: mocks.setSmsConsentByPhone,
	findContactsByPhone: vi.fn(async () => []),
}));
vi.mock("../../../lib/entitlements/quota.js", () => ({
	consumeQuota: mocks.consumeQuota,
}));
vi.mock("../../sms/provider.js", () => ({
	smsProvider: { send: mocks.smsSend },
}));
vi.mock("../../emailService.js", () => ({
	sendRenderedTracked: mocks.emailSend,
}));
vi.mock("../../emailBranding.js", () => ({
	getOrgBrand: vi.fn(async () => ({ name: "Cool Air Co", reply_to: null })),
	getOrgBrandModel: vi.fn(async () => ({
		brand: { name: "Cool Air Co", phone: null },
	})),
}));
vi.mock("../../logger.js", () => ({ logActivity: mocks.logActivity }));
vi.mock("../../../controllers/notificationsController.js", () => ({
	notifyDispatchers: mocks.notifyDispatchers,
}));
vi.mock("../../../lib/publicLink.js", () => ({
	issueLink: vi.fn(async () => ({
		url: "https://app.test/app/c/tok",
		token: "tok",
	})),
	issueMessageLink: vi.fn(async () => "https://app.test/app/c/visit-tok"),
	linkExpiry: () => null,
	unsubscribeHeaders: () => [],
}));
vi.mock("../../appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SendRejected } from "../channels/types.js";
import { runOutboxSweep } from "../outboxSweeper.js";
import { redactLinks } from "../../../lib/redactLinks.js";

const START = new Date("2026-03-08T15:00:00Z");
const T0 = new Date("2026-03-07T15:00:00Z");
const PHONE = "(512) 555-0100";
const E164 = "+15125550100";
const STOP = " Reply STOP to opt out.";

let seq = 0;
function queue(over: Record<string, unknown> = {}) {
	const row = {
		id: `m${++seq}`,
		organization_id: "org1",
		direction: "out",
		event: "visit_reminder",
		channel: "sms",
		client_id: "c1",
		contact_id: "k1",
		recipient: E164,
		entity_type: "job_visit",
		entity_id: "v1",
		dedupe_key: `visit_reminder:v1:24:${seq}`,
		status: "queued",
		skip_reason: null,
		send_after: T0,
		claimed_at: null,
		attempts: 0,
		provider_message_id: null,
		error: null,
		...over,
	};
	fake.state.rows.push(row);
	return row;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("BACKEND_PUBLIC_URL", "https://api.test");
	fake.state.rows.length = 0;
	fake.state.settings.clear();
	fake.state.settings.set("visit_reminder", {
		email_enabled: true,
		sms_enabled: true,
	});
	fake.state.visits.clear();
	fake.state.visits.set("v1", {
		id: "v1",
		status: "Scheduled",
		job_id: "j1",
		scheduled_start_at: START,
		arrival_constraint: "at",
		arrival_time: null,
		arrival_window_start: null,
		arrival_window_end: null,
		job: { name: "Tune-up", address: "1 Main St" },
		visit_techs: [],
		arrivals: [],
		drives: [],
	} as never);
	fake.state.contacts.clear();
	fake.state.contacts.set("k1", {
		id: "k1",
		email: "k1@x.test",
		phone: PHONE,
		is_active: true,
		type: "customer",
	});
	fake.state.smsAccount = {
		status: "active",
		subaccount_sid: "AC1",
		auth_token_enc: "enc",
		messaging_service_sid: "MG1",
	};
	isModuleOn.mockResolvedValue(true);
	consumeQuota.mockResolvedValue({ allowed: true, used: 1, limit: 500 });
	smsSend.mockImplementation(async () => ({
		providerMessageId: `SM${seq}`,
		segments: 1,
	}));
});

describe("sms channel", () => {
	it("the first sms to a number carries the STOP line and later ones do not", async () => {
		const first = queue();
		await runOutboxSweep(T0);
		expect(first.status).toBe("sent");
		const firstBody = smsSend.mock.calls[0][1].body as string;
		expect(firstBody.endsWith(STOP)).toBe(true);
		expect(first.body).toBe(redactLinks(firstBody));
		expect(smsSend.mock.calls[0][1]).toMatchObject({
			to: E164,
			statusCallbackUrl: `https://api.test/integrations/twilio/status?m=${first.id}`,
		});
		expect(smsSend.mock.calls[0][0]).toEqual({
			subaccount_sid: "AC1",
			auth_token_enc: "enc",
			messaging_service_sid: "MG1",
		});

		const second = queue({ event: "visit_reminder" });
		await runOutboxSweep(T0);
		expect(second.status).toBe("sent");
		expect(smsSend.mock.calls[1][1].body).not.toContain("Reply STOP");
	});

	it("a 2-segment body consumes 2 from the meter", async () => {
		vi.spyOn(fake.db.email_template, "findFirst").mockResolvedValueOnce({
			subject: "S",
			html: "<p>x</p>",
			text: null,
			sms_body: `{{brand.name}}: ${"a".repeat(140)}`,
		} as never);
		const row = queue();
		await runOutboxSweep(T0);
		const body = smsSend.mock.calls[0][1].body as string;
		expect(body.length).toBeGreaterThan(160);
		expect(consumeQuota).toHaveBeenCalledTimes(1);
		expect(consumeQuota).toHaveBeenCalledWith(
			"org1",
			"sms_segments_month",
			2,
		);
		// Charged before the provider call.
		expect(consumeQuota.mock.invocationCallOrder[0]).toBeLessThan(
			smsSend.mock.invocationCallOrder[0],
		);
		expect(row.status).toBe("sent");
	});

	it("the visit link goes out unescaped and its length counts toward the segments", async () => {
		vi.spyOn(fake.db.email_template, "findFirst").mockResolvedValueOnce({
			subject: "S",
			html: "<p>x</p>",
			text: null,
			sms_body: `{{brand.name}}: ${"a".repeat(100)} {{link.visit}}`,
		} as never);
		queue();
		await runOutboxSweep(T0);
		const body = smsSend.mock.calls[0][1].body as string;
		expect(body).toContain(" https://app.test/app/c/visit-tok");
		expect(consumeQuota).toHaveBeenCalledWith(
			"org1",
			"sms_segments_month",
			countSegments(body).segments,
		);
		expect(
			countSegments(body.replace("https://app.test/app/c/visit-tok", ""))
				.segments,
		).toBeLessThan(countSegments(body).segments);
	});

	it("when the meter is exhausted the row is skipped and email for the same event still sends", async () => {
		consumeQuota.mockResolvedValue({
			allowed: false,
			used: 500,
			limit: 500,
		});
		const sms = queue({ dedupe_key: "visit_reminder:v1:24" });
		const email = queue({
			dedupe_key: "visit_reminder:v1:24",
			channel: "email",
			recipient: "k1@x.test",
		});
		await runOutboxSweep(T0);
		expect(sms).toMatchObject({
			status: "skipped",
			skip_reason: "sms_limit_reached",
		});
		expect(smsSend).not.toHaveBeenCalled();
		expect(email.status).toBe("sent");
		expect(emailSend).toHaveBeenCalledTimes(1);
	});

	it('a contact with an unparseable phone is skipped with "invalid_phone"', async () => {
		fake.state.contacts.set("k1", {
			id: "k1",
			email: "k1@x.test",
			phone: "555-0100",
			is_active: true,
			type: "customer",
		});
		const row = queue({ recipient: "555-0100" });
		await runOutboxSweep(T0);
		expect(row).toMatchObject({
			status: "skipped",
			skip_reason: "invalid_phone",
		});
		expect(consumeQuota).not.toHaveBeenCalled();
		expect(smsSend).not.toHaveBeenCalled();
	});

	it('the rendered time in an sms uses the org timezone: a visit at 2026-03-08T15:00:00Z for America/Chicago reads "10:00 AM"', async () => {
		fake.state.timezone = "America/Chicago";
		queue();
		await runOutboxSweep(T0);
		const body = smsSend.mock.calls[0][1].body as string;
		expect(body).toContain("Sunday, March 8");
		expect(body).toContain("at 10:00 AM");
	});

	it("recipient_opted_out from the provider sets consent to unsubscribed with source provider", async () => {
		smsSend.mockRejectedValueOnce(
			new SendRejected("recipient_opted_out", false),
		);
		const row = queue();
		await runOutboxSweep(T0);
		expect(mocks.setSmsConsentByPhone).toHaveBeenCalledWith(
			"org1",
			E164,
			"unsubscribed",
			"provider",
			expect.any(String),
		);
		expect(row).toMatchObject({
			status: "failed",
			error: "recipient_opted_out",
		});
	});

	it("a 429 then success charges the meter once and sends the same body", async () => {
		smsSend.mockRejectedValueOnce(new SendRejected("twilio 20429", true));
		const row = queue();
		await runOutboxSweep(T0);
		expect(row).toMatchObject({ status: "queued", attempts: 1 });
		// Kept whole while queued: the retry resends exactly what was charged.
		expect(row.body).toContain("/app/c/visit-tok");
		// A text to the number went out meanwhile; the retry must not drop
		// the STOP line it was charged with.
		queue({ status: "sent", dedupe_key: "other" });
		await runOutboxSweep(new Date(T0.getTime() + 5 * 60_000));
		expect(row.status).toBe("sent");
		expect(consumeQuota).toHaveBeenCalledTimes(1);
		expect(smsSend).toHaveBeenCalledTimes(2);
		const [a, b] = smsSend.mock.calls.map((c) => c[1].body as string);
		expect(b).toBe(a);
		expect(b).toContain("/app/c/visit-tok");
		expect(b.endsWith(STOP)).toBe(true);
		expect(row.body).toBe(redactLinks(a));
		expect(row.body).not.toContain("visit-tok");
	});

	it("with BACKEND_PUBLIC_URL unset the row fails before the meter is charged", async () => {
		vi.stubEnv("BACKEND_PUBLIC_URL", "");
		const row = queue();
		await runOutboxSweep(T0);
		expect(row.status).toBe("failed");
		expect(consumeQuota).not.toHaveBeenCalled();
		expect(smsSend).not.toHaveBeenCalled();

		vi.stubEnv("BACKEND_PUBLIC_URL", "https://api.test");
		fake.state.smsAccount = { status: "active", subaccount_sid: "AC1" };
		const noCreds = queue();
		await runOutboxSweep(T0);
		expect(noCreds.status).toBe("failed");
		expect(consumeQuota).not.toHaveBeenCalled();
	});

	it("a reminder retry that would land in quiet hours is deferred to 08:00 org-local", async () => {
		// 19:58 Chicago (CST) on Mar 7; +5 min is 20:03, inside quiet hours.
		const late = new Date("2026-03-08T01:58:00Z");
		smsSend.mockRejectedValueOnce(new SendRejected("twilio 20429", true));
		const row = queue({ send_after: late });
		await runOutboxSweep(late);
		expect(row.status).toBe("queued");
		// 08:00 CDT on Mar 8 (DST starts at 02:00 that morning).
		expect(row.send_after.toISOString()).toBe("2026-03-08T13:00:00.000Z");
	});

	it("skips while the sms module is off or the account is not active, without charging the meter", async () => {
		isModuleOn.mockImplementation(async (_o, key) => key !== "sms");
		const off = queue();
		await runOutboxSweep(T0);
		expect(off).toMatchObject({
			status: "skipped",
			skip_reason: "sms_module_off",
		});

		isModuleOn.mockResolvedValue(true);
		fake.state.smsAccount = { status: "suspended" };
		const inactive = queue();
		await runOutboxSweep(T0);
		expect(inactive).toMatchObject({
			status: "skipped",
			skip_reason: "sms_not_active",
		});
		expect(consumeQuota).not.toHaveBeenCalled();
		expect(smsSend).not.toHaveBeenCalled();
	});

	it("a phone typed differently but normalizing to the queued number is not an address change", async () => {
		const row = queue();
		await runOutboxSweep(T0);
		expect(row.status).toBe("sent");

		fake.state.contacts.set("k1", {
			id: "k1",
			email: "k1@x.test",
			phone: "512-555-0199",
			is_active: true,
			type: "customer",
		});
		const moved = queue();
		await runOutboxSweep(T0);
		expect(moved).toMatchObject({
			status: "skipped",
			skip_reason: "address_changed",
		});
	});
});
