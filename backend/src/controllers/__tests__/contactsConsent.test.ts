import { describe, it, expect, vi, beforeEach } from "vitest";

const scoped = vi.hoisted(() => ({
	contact: { findFirst: vi.fn() },
	contact_consent: { findFirst: vi.fn() },
}));
const setConsent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../lib/context.js", () => ({ getScopedDb: () => scoped }));
vi.mock("../../services/consentService.js", () => ({ setConsent }));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn(),
	buildChanges: vi.fn(),
}));
vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { setContactConsent } from "../contactsController.js";

beforeEach(() => {
	vi.clearAllMocks();
	scoped.contact.findFirst.mockResolvedValue({
		id: "ct1",
		email: "a@x.com",
	});
	scoped.contact_consent.findFirst.mockResolvedValue(null);
});

describe("setContactConsent", () => {
	it("a dispatcher cannot set consent for a contact in another org (404)", async () => {
		scoped.contact.findFirst.mockResolvedValue(null);
		const r = await setContactConsent(
			"ct-other",
			{ channel: "sms", status: "subscribed" },
			"org1",
			{ dispatcherId: "d1" } as never,
		);
		expect(r).toMatchObject({ code: 404 });
		expect(setConsent).not.toHaveBeenCalled();
	});

	it("re-subscribing a contact whose email source is bounce is refused with 409 until the email address changes", async () => {
		scoped.contact_consent.findFirst.mockResolvedValue({
			status: "unsubscribed",
			source: "bounce",
			source_detail: "Postmark HardBounce <a@x.com>",
		});
		const body = { channel: "email", status: "subscribed" };
		const refused = await setContactConsent("ct1", body, "org1", {
			dispatcherId: "d1",
		} as never);
		expect(refused).toMatchObject({ code: 409 });
		expect(setConsent).not.toHaveBeenCalled();

		// same address, different case, is still the dead address
		scoped.contact.findFirst.mockResolvedValue({
			id: "ct1",
			email: "A@X.com",
		});
		expect(
			await setContactConsent("ct1", body, "org1", {
				dispatcherId: "d1",
			} as never),
		).toMatchObject({ code: 409 });

		scoped.contact.findFirst.mockResolvedValue({
			id: "ct1",
			email: "new@x.com",
		});
		const ok = await setContactConsent("ct1", body, "org1", {
			dispatcherId: "d1",
		} as never);
		expect(ok).toMatchObject({ err: "" });
		expect(setConsent).toHaveBeenCalledWith("org1", {
			contactId: "ct1",
			channel: "email",
			status: "subscribed",
			source: "dispatcher",
			dispatcherId: "d1",
		});
	});

	it("a suppression row with no recorded address can be re-subscribed", async () => {
		scoped.contact_consent.findFirst.mockResolvedValue({
			status: "unsubscribed",
			source: "bounce",
			source_detail: "Postmark HardBounce",
		});
		const r = await setContactConsent(
			"ct1",
			{ channel: "email", status: "subscribed" },
			"org1",
		);
		expect(r).toMatchObject({ err: "" });
		expect(setConsent).toHaveBeenCalled();
	});

	it("a customer's own email unsubscribe cannot be overridden by a dispatcher (409)", async () => {
		scoped.contact_consent.findFirst.mockResolvedValue({
			status: "unsubscribed",
			source: "unsubscribe_link",
			source_detail: null,
		});
		const r = await setContactConsent(
			"ct1",
			{ channel: "email", status: "subscribed" },
			"org1",
		);
		expect(r).toMatchObject({ code: 409 });
		expect(setConsent).not.toHaveBeenCalled();
	});

	it("SMS opted out by the customer (STOP reply or link) cannot be re-subscribed by a dispatcher", async () => {
		for (const source of ["sms_keyword", "unsubscribe_link"]) {
			scoped.contact_consent.findFirst.mockResolvedValue({
				status: "unsubscribed",
				source,
				source_detail: null,
			});
			const r = await setContactConsent(
				"ct1",
				{ channel: "sms", status: "subscribed" },
				"org1",
			);
			expect(r).toMatchObject({
				code: 409,
				errorCode: "SMS_OPTED_OUT_BY_CUSTOMER",
			});
		}
		expect(setConsent).not.toHaveBeenCalled();

		scoped.contact_consent.findFirst.mockResolvedValue({
			status: "unsubscribed",
			source: "dispatcher",
			source_detail: null,
		});
		expect(
			await setContactConsent(
				"ct1",
				{ channel: "sms", status: "subscribed" },
				"org1",
			),
		).toMatchObject({ err: "" });
	});

	it("rejects an invalid channel or status with 400", async () => {
		const r = await setContactConsent(
			"ct1",
			{ channel: "fax", status: "subscribed" },
			"org1",
		);
		expect(r).toMatchObject({ code: 400 });
	});
});
