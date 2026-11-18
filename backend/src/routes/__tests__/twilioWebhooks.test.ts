import {
	describe,
	it,
	expect,
	vi,
	beforeEach,
	beforeAll,
	afterAll,
} from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import twilio from "twilio";

const h = vi.hoisted(() => ({
	fake: undefined as any,
	notifyDispatchers: vi.fn(async () => []),
	logActivity: vi.fn(async () => {}),
	reportMessageOutcome: vi.fn(async () => {}),
}));

vi.mock("../../db.js", async () => {
	const { createCommsFakeDb } =
		await import("../../services/sms/__tests__/commsFakeDb.js");
	h.fake = createCommsFakeDb();
	return { db: h.fake.db };
});
vi.mock("../../services/appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../services/logger.js", () => ({ logActivity: h.logActivity }));
vi.mock("../../controllers/notificationsController.js", () => ({
	notifyDispatchers: h.notifyDispatchers,
}));
vi.mock("../../services/customerComms/failureReport.js", () => ({
	reportMessageOutcome: h.reportMessageOutcome,
}));

import { encryptSecret } from "../../services/crypto.js";
import router from "../twilioWebhooks.js";

const KEY_HEX = "ab".repeat(32);
const KEY = Buffer.from(KEY_HEX, "hex");
const PUBLIC = "https://api.tradewerks.test";
const TOKEN_A = "token-for-org-a-000000000000000";
const TOKEN_B = "token-for-org-b-000000000000000";
const SID_A = "AC" + "a".repeat(32);
const SID_B = "AC" + "b".repeat(32);

let server: Server;
let base: string;

beforeAll(async () => {
	const app = express();
	// Mounted the way index.ts mounts it.
	app.use(
		"/integrations/twilio",
		express.urlencoded({ extended: false }),
		router,
	);
	server = app.listen(0);
	await new Promise((r) => server.once("listening", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

function seed() {
	const s = h.fake.store;
	for (const k of Object.keys(s)) s[k].length = 0;
	s.org_sms_account.push(
		{
			organization_id: "org-a",
			subaccount_sid: SID_A,
			auth_token_enc: encryptSecret(TOKEN_A, KEY),
			messaging_service_sid: "MG-a",
			status: "active",
		},
		{
			organization_id: "org-b",
			subaccount_sid: SID_B,
			auth_token_enc: encryptSecret(TOKEN_B, KEY),
			messaging_service_sid: "MG-b",
			status: "active",
		},
	);
	s.client.push({
		id: "client-1",
		organization_id: "org-a",
		name: "Smith Residence",
	});
	s.contact.push({
		id: "c-1",
		organization_id: "org-a",
		phone: "(512) 555-0100",
	});
	s.client_contact.push({
		client_id: "client-1",
		contact_id: "c-1",
		is_primary: true,
	});
	s.contact_consent.push({
		organization_id: "org-a",
		contact_id: "c-1",
		channel: "sms",
		status: "subscribed",
		source: "dispatcher",
	});
}

/** Posts form params signed the way Twilio signs them (SDK helper, public URL). */
async function post(
	path: string,
	params: Record<string, string>,
	token: string,
	signature?: string,
) {
	const url = `${PUBLIC}/integrations/twilio${path}`;
	const sig =
		signature ?? twilio.getExpectedTwilioSignature(token, url, params);
	const r = await fetch(`${base}/integrations/twilio${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"x-twilio-signature": sig,
		},
		body: new URLSearchParams(params).toString(),
	});
	return {
		status: r.status,
		text: await r.text(),
		type: r.headers.get("content-type"),
	};
}

const inbound = (over: Record<string, string> = {}) => ({
	AccountSid: SID_A,
	MessageSid: "SM-in-1",
	From: "+15125550100",
	To: "+15125559999",
	Body: "Can you come at 3 instead?",
	NumSegments: "1",
	...over,
});

const inboundRows = () =>
	h.fake.store.customer_message.filter((m: any) => m.direction === "in");

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("SMS_TOKEN_ENCRYPTION_KEY", KEY_HEX);
	vi.stubEnv("BACKEND_PUBLIC_URL", `${PUBLIC}/`);
	seed();
});

describe("POST /integrations/twilio/sms", () => {
	it("a request signed with another org's token is rejected with 403", async () => {
		const r = await post("/sms", inbound({ Body: "STOP" }), TOKEN_B);
		expect(r.status).toBe(403);
		expect(h.fake.store.customer_message).toHaveLength(0);
		expect(h.fake.store.contact_consent[0].status).toBe("subscribed");

		const unsigned = await post("/sms", inbound(), TOKEN_A, "");
		expect(unsigned.status).toBe(403);
		h.fake.delegates.org_sms_account.findUnique.mockClear();
		const malformed = await post(
			"/sms",
			inbound({ AccountSid: "not-a-sid" }),
			TOKEN_A,
		);
		expect(malformed.status).toBe(403);
		expect(
			h.fake.delegates.org_sms_account.findUnique,
		).not.toHaveBeenCalled();
		const unknownAcct = await post(
			"/sms",
			inbound({ AccountSid: "AC" + "c".repeat(32) }),
			TOKEN_A,
		);
		expect(unknownAcct.status).toBe(403);
		expect(h.fake.store.customer_message).toHaveLength(0);
	});

	it('a non-keyword reply is stored as a customer_message with direction "in" and notifies dispatchers (type customer_sms_reply) with a link to the client', async () => {
		const r = await post("/sms", inbound(), TOKEN_A);
		expect(r.status).toBe(200);
		expect(r.type).toMatch(/xml/);
		expect(r.text).toContain("<Response></Response>");
		expect(inboundRows()).toEqual([
			expect.objectContaining({
				organization_id: "org-a",
				direction: "in",
				event: "inbound_sms",
				channel: "sms",
				status: "delivered",
				provider_message_id: "SM-in-1",
				client_id: "client-1",
				contact_id: "c-1",
				recipient: "+15125550100",
				entity_type: "client",
				entity_id: "client-1",
				body: "Can you come at 3 instead?",
			}),
		]);
		expect(h.notifyDispatchers).toHaveBeenCalledTimes(1);
		expect(h.notifyDispatchers).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "customer_sms_reply",
				actionUrl: "/dispatch/clients/client-1",
			}),
			"org-a",
		);
	});

	it("the same inbound MessageSid delivered twice writes one row", async () => {
		expect((await post("/sms", inbound(), TOKEN_A)).status).toBe(200);
		expect((await post("/sms", inbound(), TOKEN_A)).status).toBe(200);
		expect(inboundRows()).toHaveLength(1);
		expect(h.notifyDispatchers).toHaveBeenCalledTimes(1);
	});

	it("STOP through the webhook unsubscribes the contact", async () => {
		const r = await post("/sms", inbound({ Body: "STOP" }), TOKEN_A);
		expect(r.status).toBe(200);
		expect(h.fake.store.contact_consent[0]).toMatchObject({
			status: "unsubscribed",
			source: "sms_keyword",
		});
	});
});

describe("POST /integrations/twilio/status", () => {
	const outRow = (over: Record<string, unknown> = {}) => ({
		id: "m-out",
		organization_id: "org-a",
		direction: "out",
		event: "visit_reminder",
		channel: "sms",
		client_id: "client-1",
		contact_id: "c-1",
		recipient: "+15125550100",
		entity_type: "job_visit",
		entity_id: "v1",
		dedupe_key: "k1",
		status: "sent",
		provider_message_id: "SM-out-1",
		delivered_at: null,
		error: null,
		...over,
	});
	const status = (over: Record<string, string>) => ({
		AccountSid: SID_A,
		MessageSid: "SM-out-1",
		MessageStatus: "delivered",
		...over,
	});

	it('a status callback "delivered" sets delivered_at; "undelivered" sets failed with the error code; an unknown MessageSid returns 200', async () => {
		h.fake.store.customer_message.push(
			outRow(),
			outRow({
				id: "m-out-2",
				provider_message_id: "SM-out-2",
				dedupe_key: "k2",
			}),
		);
		const row = (id: string) =>
			h.fake.store.customer_message.find((m: any) => m.id === id);

		expect((await post("/status", status({}), TOKEN_A)).status).toBe(200);
		expect(row("m-out").status).toBe("delivered");
		expect(row("m-out").delivered_at).toBeInstanceOf(Date);

		const u = await post(
			"/status",
			status({
				MessageSid: "SM-out-2",
				MessageStatus: "undelivered",
				ErrorCode: "30007",
			}),
			TOKEN_A,
		);
		expect(u.status).toBe(200);
		expect(row("m-out-2")).toMatchObject({
			status: "failed",
			error: "twilio 30007",
		});
		expect(h.reportMessageOutcome).toHaveBeenCalledTimes(1);
		expect(h.reportMessageOutcome).toHaveBeenCalledWith(
			expect.objectContaining({ id: "m-out-2", channel: "sms" }),
			"failed",
			expect.objectContaining({ error: "twilio 30007" }),
		);

		// A repeated failure callback is not reported twice.
		await post(
			"/status",
			status({
				MessageSid: "SM-out-2",
				MessageStatus: "failed",
				ErrorCode: "30007",
			}),
			TOKEN_A,
		);
		expect(h.reportMessageOutcome).toHaveBeenCalledTimes(1);

		const unknown = await post(
			"/status",
			status({ MessageSid: "SM-nope" }),
			TOKEN_A,
		);
		expect(unknown.status).toBe(200);
	});

	it("delivered after failed, and undelivered after delivered, leave the row unchanged", async () => {
		h.fake.store.customer_message.push(
			outRow({ status: "failed", error: "twilio 30007" }),
			outRow({
				id: "m-out-2",
				provider_message_id: "SM-out-2",
				dedupe_key: "k2",
				status: "delivered",
			}),
		);
		const row = (id: string) =>
			h.fake.store.customer_message.find((m: any) => m.id === id);
		await post("/status", status({}), TOKEN_A);
		expect(row("m-out")).toMatchObject({
			status: "failed",
			error: "twilio 30007",
			delivered_at: null,
		});
		await post(
			"/status",
			status({
				MessageSid: "SM-out-2",
				MessageStatus: "undelivered",
				ErrorCode: "30003",
			}),
			TOKEN_A,
		);
		expect(row("m-out-2")).toMatchObject({
			status: "delivered",
			error: null,
		});
		expect(h.reportMessageOutcome).not.toHaveBeenCalled();
	});

	it("a delivered callback that beats the outbox's sent write is matched by the row id in the callback URL and kept", async () => {
		h.fake.store.customer_message.push(
			outRow({ status: "sending", provider_message_id: null }),
		);
		const row = h.fake.store.customer_message[0];
		const r = await post("/status?m=m-out", status({}), TOKEN_A);
		expect(r.status).toBe(200);
		expect(row).toMatchObject({
			status: "delivered",
			provider_message_id: "SM-out-1",
		});
		expect(row.delivered_at).toBeInstanceOf(Date);

		// The row id only finds a row that has no other message's sid.
		h.fake.store.customer_message.push(
			outRow({
				id: "m-out-2",
				dedupe_key: "k2",
				provider_message_id: "SM-other",
			}),
		);
		await post(
			"/status?m=m-out-2",
			status({ MessageSid: "SM-new" }),
			TOKEN_A,
		);
		expect(h.fake.store.customer_message[1]).toMatchObject({
			status: "sent",
			provider_message_id: "SM-other",
		});
	});

	it("a callback for another org's MessageSid changes nothing", async () => {
		h.fake.store.customer_message.push(
			outRow({ organization_id: "org-b" }),
		);
		const r = await post("/status", status({}), TOKEN_A);
		expect(r.status).toBe(200);
		expect(h.fake.store.customer_message[0].status).toBe("sent");
	});

	it("a status callback with a bad signature is rejected with 403", async () => {
		h.fake.store.customer_message.push(outRow());
		const r = await post("/status", status({}), TOKEN_B);
		expect(r.status).toBe(403);
		expect(h.fake.store.customer_message[0].status).toBe("sent");
	});
});
