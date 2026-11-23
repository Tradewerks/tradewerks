import { describe, it, expect, vi, beforeEach } from "vitest";

const { fake, isModuleOn, canSend, channels } = await vi.hoisted(async () => {
	const { makeFakeDb } = await import("./fakeOutboxDb.js");
	return {
		fake: makeFakeDb(),
		isModuleOn: vi.fn(async (_o: string, _k: string) => true),
		canSend: vi.fn(async () => true),
		channels: vi.fn(() => ["email", "sms"]),
	};
});

vi.mock("../../../db.js", () => ({ db: fake.db }));
vi.mock("../../../lib/context.js", () => ({ getScopedDb: () => fake.db }));
vi.mock("../../entitlementService.js", () => ({ isModuleOn }));
vi.mock("../../consentService.js", () => ({ canSend }));
vi.mock("../channels/index.js", () => ({ registeredChannels: channels }));
vi.mock("../../appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { cancelQueued, customerNotify } from "../customerNotify.js";

const ORG = "org1";
const base = {
	entityType: "job_visit" as const,
	entityId: "v1",
	clientId: "c1",
};

function contact(
	id: string,
	over: Partial<{
		email: string | null;
		phone: string | null;
		is_active: boolean;
		type: string | null;
		is_primary: boolean;
		notify_visits: boolean;
	}> = {},
) {
	const { is_primary = false, notify_visits = false, ...c } = over;
	fake.state.contacts.set(id, {
		id,
		email: `${id}@x.test`,
		phone: "+15125550100",
		is_active: true,
		type: "customer",
		...c,
	});
	fake.state.clientContacts.push({
		client_id: "c1",
		contact_id: id,
		is_primary,
		notify_visits,
	});
}

beforeEach(() => {
	fake.state.rows.length = 0;
	fake.state.settings.clear();
	fake.state.contacts.clear();
	fake.state.clientContacts.length = 0;
	isModuleOn.mockResolvedValue(true);
	canSend.mockResolvedValue(true);
	channels.mockReturnValue(["email", "sms"]);
	fake.state.smsAccount = { status: "active" };
});

describe("customerNotify", () => {
	it("customerNotify called twice with the same dedupeKey queues one row per channel+recipient", async () => {
		fake.state.settings.set("visit_confirmed", {
			email_enabled: true,
			sms_enabled: true,
		});
		contact("a", { notify_visits: true });
		contact("b", { notify_visits: true, phone: "+15125550101" });
		const p = {
			...base,
			event: "visit_confirmed" as const,
			dedupeKey: "visit_confirmed:v1",
		};

		expect(await customerNotify(ORG, p)).toEqual({ queued: 4 });
		expect(await customerNotify(ORG, p)).toEqual({ queued: 0 });
		expect(fake.state.rows).toHaveLength(4);
		expect(
			fake.state.rows.map((r) => `${r.channel}:${r.recipient}`).sort(),
		).toEqual([
			"email:a@x.test",
			"email:b@x.test",
			"sms:+15125550100",
			"sms:+15125550101",
		]);
	});

	it("customerNotify queues nothing when the event is disabled, the module is off, or no contact is eligible", async () => {
		const p = {
			...base,
			event: "visit_reminder" as const,
			dedupeKey: "r:v1",
		};
		contact("a", { is_primary: true });

		// No setting row: the event is off.
		expect(await customerNotify(ORG, p)).toEqual({ queued: 0 });

		fake.state.settings.set("visit_reminder", {
			email_enabled: true,
			sms_enabled: false,
		});
		isModuleOn.mockResolvedValueOnce(false);
		expect(await customerNotify(ORG, p)).toEqual({ queued: 0 });

		// Only an inactive flagged contact and a vendor primary: nobody eligible.
		fake.state.contacts.clear();
		fake.state.clientContacts.length = 0;
		contact("old", { notify_visits: true, is_active: false });
		contact("ven", { is_primary: true, type: "vendor" });
		expect(await customerNotify(ORG, p)).toEqual({ queued: 0 });

		expect(fake.state.rows).toHaveLength(0);
	});

	it("falls back to the primary contact when nobody is flagged, and skips a contact without consent", async () => {
		fake.state.settings.set("visit_reminder", {
			email_enabled: true,
			sms_enabled: false,
		});
		contact("p", { is_primary: true });
		contact("other");
		expect(
			await customerNotify(ORG, {
				...base,
				event: "visit_reminder",
				dedupeKey: "r1",
			}),
		).toEqual({ queued: 1 });
		expect(fake.state.rows[0].contact_id).toBe("p");

		canSend.mockResolvedValue(false);
		expect(
			await customerNotify(ORG, {
				...base,
				event: "visit_reminder",
				dedupeKey: "r2",
			}),
		).toEqual({ queued: 0 });
	});

	it("only queues channels that have an adapter", async () => {
		channels.mockReturnValue(["email"]);
		fake.state.settings.set("visit_confirmed", {
			email_enabled: true,
			sms_enabled: true,
		});
		contact("a", { is_primary: true });
		await customerNotify(ORG, {
			...base,
			event: "visit_confirmed",
			dedupeKey: "k",
		});
		expect(fake.state.rows.map((r) => r.channel)).toEqual(["email"]);
	});

	it("queues sms under the E.164 number, and no sms while the sms module is off or the account is not active", async () => {
		fake.state.settings.set("visit_confirmed", {
			email_enabled: true,
			sms_enabled: true,
		});
		contact("a", { is_primary: true, phone: "(512) 555-0100" });
		const p = { ...base, event: "visit_confirmed" as const };

		await customerNotify(ORG, { ...p, dedupeKey: "k1" });
		expect(
			fake.state.rows.find((r) => r.channel === "sms")?.recipient,
		).toBe("+15125550100");

		isModuleOn.mockImplementation(async (_o, key) => key !== "sms");
		await customerNotify(ORG, { ...p, dedupeKey: "k2" });
		isModuleOn.mockResolvedValue(true);
		fake.state.smsAccount = { status: "campaign_pending" };
		await customerNotify(ORG, { ...p, dedupeKey: "k3" });
		fake.state.smsAccount = { status: "active" };

		const channelsOf = (k: string) =>
			fake.state.rows
				.filter((r) => r.dedupe_key === k)
				.map((r) => r.channel);
		expect(channelsOf("k2")).toEqual(["email"]);
		expect(channelsOf("k3")).toEqual(["email"]);
	});

	it("an sms row for visit_reminder at 22:30 org-local is moved to 20:00 the same evening; tech_on_the_way is not moved", async () => {
		for (const event of ["visit_reminder", "tech_on_the_way"])
			fake.state.settings.set(event, {
				email_enabled: true,
				sms_enabled: true,
			});
		contact("a", { is_primary: true });
		const at = new Date("2026-06-11T03:30:00Z"); // Jun 10 22:30 CDT

		await customerNotify(ORG, {
			...base,
			event: "visit_reminder",
			dedupeKey: "rem",
			sendAt: at,
			quietMode: "advance",
		});
		await customerNotify(ORG, {
			...base,
			event: "tech_on_the_way",
			dedupeKey: "omw",
			sendAt: at,
		});

		const find = (key: string, channel: string) =>
			fake.state.rows.find(
				(r) => r.dedupe_key === key && r.channel === channel,
			)!.send_after;
		expect(find("rem", "sms").toISOString()).toBe(
			"2026-06-11T01:00:00.000Z",
		);
		// Email is never held.
		expect(find("rem", "email")).toEqual(at);
		expect(find("omw", "sms")).toEqual(at);
	});

	it("an advanced sms reminder whose 20:00 has already passed is deferred to 08:00, not sent inside quiet hours", async () => {
		fake.state.settings.set("visit_reminder", {
			email_enabled: true,
			sms_enabled: true,
		});
		contact("a", { is_primary: true });
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-06-11T04:00:00Z")); // Jun 10 23:00 CDT
		try {
			await customerNotify(ORG, {
				...base,
				event: "visit_reminder",
				dedupeKey: "rem",
				sendAt: new Date("2026-06-11T11:00:00Z"), // Jun 11 06:00 CDT
				quietMode: "advance",
			});
		} finally {
			vi.useRealTimers();
		}
		const sms = fake.state.rows.find((r) => r.channel === "sms")!;
		expect(sms.send_after.toISOString()).toBe("2026-06-11T13:00:00.000Z");
	});

	it("a reminder whose deferred sms time reaches the visit start is not queued for sms", async () => {
		fake.state.settings.set("visit_reminder", {
			email_enabled: true,
			sms_enabled: true,
		});
		contact("a", { is_primary: true });
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-06-11T04:00:00Z")); // Jun 10 23:00 CDT
		try {
			await customerNotify(ORG, {
				...base,
				event: "visit_reminder",
				dedupeKey: "rem",
				sendAt: new Date("2026-06-11T11:00:00Z"), // Jun 11 06:00 CDT
				quietMode: "advance",
				notAfter: new Date("2026-06-11T12:30:00Z"), // 07:30 CDT start
			});
		} finally {
			vi.useRealTimers();
		}
		expect(fake.state.rows.map((r) => r.channel)).toEqual(["email"]);
	});

	it("never throws: a DB error returns queued 0", async () => {
		fake.state.settings.set("visit_confirmed", {
			email_enabled: true,
			sms_enabled: false,
		});
		isModuleOn.mockRejectedValueOnce(new Error("db down"));
		await expect(
			customerNotify(ORG, {
				...base,
				event: "visit_confirmed",
				dedupeKey: "x",
			}),
		).resolves.toEqual({ queued: 0 });
	});
});

describe("cancelQueued", () => {
	it("skips only queued rows of the named events for the entity", async () => {
		fake.state.settings.set("visit_reminder", {
			email_enabled: true,
			sms_enabled: false,
		});
		fake.state.settings.set("visit_confirmed", {
			email_enabled: true,
			sms_enabled: false,
		});
		contact("a", { is_primary: true });
		await customerNotify(ORG, {
			...base,
			event: "visit_reminder",
			dedupeKey: "r",
		});
		await customerNotify(ORG, {
			...base,
			event: "visit_confirmed",
			dedupeKey: "c",
		});

		const n = await cancelQueued(ORG, {
			entityType: "job_visit",
			entityId: "v1",
			events: ["visit_reminder"],
			reason: "visit_cancelled",
		});
		expect(n).toBe(1);
		const byEvent = Object.fromEntries(
			fake.state.rows.map((r) => [r.event, [r.status, r.skip_reason]]),
		);
		expect(byEvent).toEqual({
			visit_reminder: ["skipped", "visit_cancelled"],
			visit_confirmed: ["queued", null],
		});
	});
});
