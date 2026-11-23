import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
	fake: undefined as any,
	notifyDispatchers: vi.fn(async () => []),
	logActivity: vi.fn(async () => {}),
}));

vi.mock("../../../db.js", async () => {
	const { createCommsFakeDb } = await import("./commsFakeDb.js");
	h.fake = createCommsFakeDb();
	return { db: h.fake.db };
});
vi.mock("../../appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../logger.js", () => ({ logActivity: h.logActivity }));
vi.mock("../../../controllers/notificationsController.js", () => ({
	notifyDispatchers: h.notifyDispatchers,
}));

import { classifyKeyword, handleInboundSms } from "../inbound.js";

const ORG_A = "org-a";
const ORG_B = "org-b";
const NUMBER = "+15125550100";

function seed() {
	const s = h.fake.store;
	for (const k of Object.keys(s)) s[k].length = 0;
	s.client.push(
		{ id: "client-1", organization_id: ORG_A, name: "Smith Residence" },
		{ id: "client-2", organization_id: ORG_A, name: "Smith Rental" },
		{ id: "client-b", organization_id: ORG_B, name: "Other Org Client" },
	);
	s.contact.push(
		// Same number, formatted differently, on two clients in org A.
		{
			id: "c-a1",
			organization_id: ORG_A,
			phone: "(512) 555-0100",
			email: null,
		},
		{
			id: "c-a2",
			organization_id: ORG_A,
			phone: "512.555.0100 ext 4",
			email: null,
		},
		{
			id: "c-a3",
			organization_id: ORG_A,
			phone: "(512) 555-0199",
			email: null,
		},
		// Same number in another org: must never be touched.
		{
			id: "c-b1",
			organization_id: ORG_B,
			phone: "+1 512 555 0100",
			email: null,
		},
	);
	s.client_contact.push(
		{ client_id: "client-1", contact_id: "c-a1", is_primary: true },
		{ client_id: "client-2", contact_id: "c-a2", is_primary: true },
		{ client_id: "client-b", contact_id: "c-b1", is_primary: true },
	);
	for (const id of ["c-a1", "c-a2", "c-a3", "c-b1"]) {
		s.contact_consent.push({
			organization_id: id === "c-b1" ? ORG_B : ORG_A,
			contact_id: id,
			channel: "sms",
			status: "subscribed",
			source: "dispatcher",
		});
	}
}

const sms = (
	body: string,
	sid = "SM-1",
	extra: Record<string, string> = {},
) => ({
	MessageSid: sid,
	From: NUMBER,
	To: "+15125559999",
	Body: body,
	...extra,
});

const consentOf = (id: string) =>
	h.fake.store.contact_consent.find(
		(c: any) => c.contact_id === id && c.channel === "sms",
	);

beforeEach(() => {
	vi.clearAllMocks();
	seed();
});

describe("classifyKeyword", () => {
	it("matches the opt-out, opt-in and help words, case-insensitive and trimmed", () => {
		for (const w of [
			"STOP",
			"stopall",
			" Unsubscribe ",
			"CANCEL",
			"end",
			"QUIT",
			"revoke",
			"OptOut",
		])
			expect(classifyKeyword(w)).toBe("stop");
		for (const w of ["START", "yes", " Unstop"])
			expect(classifyKeyword(w)).toBe("start");
		expect(classifyKeyword("HELP")).toBe("help");
		expect(classifyKeyword("")).toBeNull();
	});

	it('"Stop by at 3?" is not treated as STOP', async () => {
		expect(classifyKeyword("Stop by at 3?")).toBeNull();
		expect(classifyKeyword("please stop")).toBeNull();
		await handleInboundSms(ORG_A, sms("Stop by at 3?"));
		expect(consentOf("c-a1").status).toBe("subscribed");
		expect(consentOf("c-a2").status).toBe("subscribed");
		expect(h.notifyDispatchers).toHaveBeenCalledWith(
			expect.objectContaining({ type: "customer_sms_reply" }),
			ORG_A,
		);
	});
});

describe("handleInboundSms keywords", () => {
	it("STOP unsubscribes every contact in this org with that number and none in another org that has the same number", async () => {
		await handleInboundSms(ORG_A, sms("  stop "));
		expect(consentOf("c-a1")).toMatchObject({
			status: "unsubscribed",
			source: "sms_keyword",
		});
		expect(consentOf("c-a2")).toMatchObject({
			status: "unsubscribed",
			source: "sms_keyword",
		});
		expect(consentOf("c-a3").status).toBe("subscribed");
		expect(consentOf("c-b1").status).toBe("subscribed");
	});

	it("a keyword text tells the office in its own words: CANCEL means texts stopped, YES means back on", async () => {
		await handleInboundSms(ORG_A, sms(" cancel ", "SM-1"));
		expect(h.notifyDispatchers).toHaveBeenLastCalledWith(
			{
				type: "customer_sms_reply",
				title: "Smith Residence texted CANCEL",
				body: "Texts to this number are now stopped. If they meant the visit, call them.",
				actionUrl: "/dispatch/clients/client-1",
			},
			ORG_A,
		);
		await handleInboundSms(ORG_A, sms("Yes", "SM-2"));
		expect(h.notifyDispatchers).toHaveBeenLastCalledWith(
			{
				type: "customer_sms_reply",
				title: "Smith Residence texted YES",
				body: "Texts to this number are back on.",
				actionUrl: "/dispatch/clients/client-1",
			},
			ORG_A,
		);
		// A replayed keyword is not announced twice.
		await handleInboundSms(ORG_A, sms("Yes", "SM-2"));
		expect(h.notifyDispatchers).toHaveBeenCalledTimes(2);
	});

	it("a text from an unknown number is stored against the phone and notifies without a link", async () => {
		await handleInboundSms(ORG_A, {
			MessageSid: "SM-x",
			From: "+15125550142",
			Body: "Who is this?",
		});
		const row = h.fake.store.customer_message.find(
			(m: any) => m.provider_message_id === "SM-x",
		);
		expect(row).toMatchObject({
			organization_id: ORG_A,
			direction: "in",
			entity_type: "phone",
			entity_id: "+15125550142",
			client_id: null,
			contact_id: null,
		});
		expect(h.notifyDispatchers).toHaveBeenCalledWith(
			{
				type: "customer_sms_reply",
				title: "Text from (512) 555-0142",
				body: "Who is this?",
				actionUrl: undefined,
			},
			ORG_A,
		);
	});

	it('STOP from a number shared by two clients\' contacts stops queued sms rows for both (skipped, "unsubscribed")', async () => {
		const base = {
			organization_id: ORG_A,
			direction: "out",
			channel: "sms",
			event: "visit_reminder",
			entity_type: "job_visit",
			entity_id: "v1",
			status: "queued",
			skip_reason: null,
		};
		h.fake.store.customer_message.push(
			{
				...base,
				id: "m1",
				client_id: "client-1",
				contact_id: "c-a1",
				recipient: "(512) 555-0100",
				dedupe_key: "k1",
			},
			{
				...base,
				id: "m2",
				client_id: "client-2",
				contact_id: "c-a2",
				recipient: "512.555.0100 ext 4",
				dedupe_key: "k2",
			},
			{
				...base,
				id: "m3",
				client_id: "client-1",
				contact_id: "c-a3",
				recipient: "(512) 555-0199",
				dedupe_key: "k3",
			},
			{
				...base,
				id: "m4",
				client_id: "client-1",
				contact_id: "c-a1",
				recipient: "(512) 555-0100",
				dedupe_key: "k4",
				status: "sent",
			},
			{
				...base,
				id: "m5",
				client_id: "client-1",
				contact_id: "c-a1",
				recipient: "a@b.test",
				dedupe_key: "k5",
				channel: "email",
			},
			{
				...base,
				id: "mb",
				organization_id: ORG_B,
				client_id: "client-b",
				contact_id: "c-b1",
				recipient: "+1 512 555 0100",
				dedupe_key: "kb",
			},
		);
		await handleInboundSms(ORG_A, sms("STOP"));
		const row = (id: string) =>
			h.fake.store.customer_message.find((m: any) => m.id === id);
		expect(row("m1")).toMatchObject({
			status: "skipped",
			skip_reason: "unsubscribed",
		});
		expect(row("m2")).toMatchObject({
			status: "skipped",
			skip_reason: "unsubscribed",
		});
		expect(row("m3").status).toBe("queued");
		expect(row("m4").status).toBe("sent");
		expect(row("m5").status).toBe("queued");
		expect(row("mb").status).toBe("queued");
	});

	it("START re-subscribes with source sms_keyword", async () => {
		await handleInboundSms(ORG_A, sms("STOP", "SM-1"));
		await handleInboundSms(ORG_A, sms("Start", "SM-2"));
		expect(consentOf("c-a1")).toMatchObject({
			status: "subscribed",
			source: "sms_keyword",
		});
		expect(consentOf("c-a2")).toMatchObject({
			status: "subscribed",
			source: "sms_keyword",
		});
		expect(consentOf("c-b1").source).toBe("dispatcher");
	});

	it("Twilio's OptOutType wins over the text so our consent matches Twilio's block list", async () => {
		await handleInboundSms(
			ORG_A,
			sms("arret", "SM-1", { OptOutType: "STOP" }),
		);
		expect(consentOf("c-a1").status).toBe("unsubscribed");
	});

	it("HELP changes no consent and notifies nobody", async () => {
		await handleInboundSms(ORG_A, sms("help"));
		expect(consentOf("c-a1").status).toBe("subscribed");
		expect(h.notifyDispatchers).not.toHaveBeenCalled();
	});
});
