import { describe, it, expect, vi, beforeEach } from "vitest";

const scoped = vi.hoisted(() => ({
	contact: { findFirst: vi.fn(), findMany: vi.fn() },
	contact_consent: { findFirst: vi.fn(), upsert: vi.fn() },
}));
const logActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../lib/context.js", () => ({ getScopedDb: () => scoped }));
vi.mock("../logger.js", () => ({ logActivity }));
vi.mock("../appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { canSend, setConsent, unsubscribeByEmail } from "../consentService.js";

beforeEach(() => {
	vi.clearAllMocks();
	scoped.contact.findFirst.mockResolvedValue({ id: "c1", email: "a@x.com" });
	scoped.contact_consent.upsert.mockResolvedValue({});
});

describe("consentService", () => {
	it("canSend: email with no row → true; sms with no row → false", async () => {
		scoped.contact_consent.findFirst.mockResolvedValue(null);
		expect(await canSend(scoped as never, "c1", "email")).toBe(true);
		expect(await canSend(scoped as never, "c1", "sms")).toBe(false);
		scoped.contact_consent.findFirst.mockResolvedValue({
			status: "unsubscribed",
		});
		expect(await canSend(scoped as never, "c1", "email")).toBe(false);
		scoped.contact_consent.findFirst.mockResolvedValue({
			status: "subscribed",
		});
		expect(await canSend(scoped as never, "c1", "sms")).toBe(true);
	});

	it("a bounce suppression records the address in source_detail; other sources do not", async () => {
		scoped.contact_consent.findFirst.mockResolvedValue(null);
		const base = { contactId: "c1", channel: "email" as const, status: "unsubscribed" as const };
		await setConsent("org-1", { ...base, source: "bounce", detail: "Postmark HardBounce" });
		expect(scoped.contact_consent.upsert.mock.calls[0][0].create.source_detail).toBe(
			"Postmark HardBounce <a@x.com>",
		);
		await setConsent("org-1", { ...base, source: "unsubscribe_link", detail: "link" });
		expect(scoped.contact_consent.upsert.mock.calls[1][0].create.source_detail).toBe("link");
	});

	it("setConsent writes one log row per real change and none for a repeat", async () => {
		const p = {
			contactId: "c1",
			channel: "email" as const,
			status: "unsubscribed" as const,
			source: "dispatcher" as const,
		};
		scoped.contact_consent.findFirst.mockResolvedValueOnce(null);
		await setConsent("org-1", p);
		expect(logActivity).toHaveBeenCalledTimes(1);
		expect(logActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "contact.consent_changed",
				organization_id: "org-1",
			}),
		);
		expect(scoped.contact_consent.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({ organization_id: "org-1" }),
			}),
		);

		scoped.contact_consent.findFirst.mockResolvedValueOnce({
			status: "unsubscribed",
		});
		await setConsent("org-1", p);
		expect(logActivity).toHaveBeenCalledTimes(1);
		expect(scoped.contact_consent.upsert).toHaveBeenCalledTimes(1);
	});

	it("setConsent ignores a contact that is not in the org", async () => {
		scoped.contact.findFirst.mockResolvedValue(null);
		await setConsent("org-1", {
			contactId: "other",
			channel: "email",
			status: "unsubscribed",
			source: "dispatcher",
		});
		expect(scoped.contact_consent.upsert).not.toHaveBeenCalled();
	});

	it("unsubscribeByEmail returns the count of contacts actually changed", async () => {
		scoped.contact.findMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
		scoped.contact_consent.findFirst
			.mockResolvedValueOnce(null) // c1 pre-check
			.mockResolvedValueOnce(null) // c1 inside setConsent
			.mockResolvedValueOnce({ status: "unsubscribed" }); // c2 pre-check
		const n = await unsubscribeByEmail("org-1", "A@x.com", "bounce");
		expect(n).toBe(1);
		expect(scoped.contact.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { email: { equals: "A@x.com", mode: "insensitive" } },
			}),
		);
	});

	it("unsubscribeByEmail continues past a contact that throws and counts only real changes", async () => {
		scoped.contact.findMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
		scoped.contact_consent.findFirst.mockResolvedValue(null);
		scoped.contact_consent.upsert
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce({});
		const n = await unsubscribeByEmail("org-1", "a@x.com", "bounce");
		expect(n).toBe(1);
		expect(scoped.contact_consent.upsert).toHaveBeenCalledTimes(2);
	});
});
