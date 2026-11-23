import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = await vi.hoisted(async () => {
	const { makeFakeDb } = await import("./fakeOutboxDb.js");
	return {
		fake: makeFakeDb(),
		send: vi.fn(async () => ({ providerMessageId: `p${Math.random()}` })),
		channels: vi.fn(() => ["email"]),
		extendVisitLinks: vi.fn(async () => undefined),
	};
});
const { fake, send, channels } = mocks;

vi.mock("../../../db.js", () => ({ db: mocks.fake.db }));
vi.mock("../../../lib/context.js", () => ({
	getScopedDb: () => mocks.fake.db,
}));
vi.mock("../../entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
}));
vi.mock("../../consentService.js", () => ({
	canSend: vi.fn(async () => true),
}));
vi.mock("../channels/index.js", () => ({
	registeredChannels: mocks.channels,
	getChannelAdapter: (c: string) => ({ channel: c, send: mocks.send }),
}));
vi.mock("../render.js", () => ({
	// Renders the visit's start as it is at send time.
	renderCustomerMessage: vi.fn(async () => ({
		subject: "s",
		html: "<p>h</p>",
		text: (
			mocks.fake.state.visits.get("v1") as unknown as {
				scheduled_start_at: Date;
			}
		).scheduled_start_at.toISOString(),
	})),
}));
vi.mock("../../../lib/entitlements/quota.js", () => ({
	consumeQuota: vi.fn(async () => ({ allowed: true, used: 1, limit: null })),
}));
vi.mock("../failureReport.js", () => ({
	reportMessageOutcome: vi.fn(async () => undefined),
}));
vi.mock("../../../lib/publicLink.js", () => ({
	unsubscribeHeaders: () => [],
	extendVisitLinks: mocks.extendVisitLinks,
	linkExpiry: (_p: string, v: { actual_end_at?: Date | null }) =>
		new Date((v.actual_end_at ?? new Date()).getTime() + 30 * 86_400_000),
}));
vi.mock("../../appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runOutboxSweep } from "../outboxSweeper.js";
import {
	notifyJobCancelled,
	notifyJobCompleted,
	notifyRunningLate,
	notifyTechOnTheWay,
	notifyVisitCancelled,
	notifyVisitCompleted,
	notifyVisitRescheduled,
	notifyVisitScheduled,
	retimeVisitReminders,
} from "../visitEvents.js";

const ORG = "org1";
const HOUR = 3_600_000;
const T0 = new Date("2026-06-11T15:00:00Z");

interface FakeVisit {
	id: string;
	status: string;
	job_id: string;
	scheduled_start_at: Date;
	scheduled_end_at: Date;
	job: { client_id: string; recurring_plan_id: string | null };
}

function visit(start: Date, recurring = false): FakeVisit {
	const v: FakeVisit = {
		id: "v1",
		status: "Scheduled",
		job_id: "j1",
		scheduled_start_at: start,
		scheduled_end_at: new Date(start.getTime() + HOUR),
		job: { client_id: "c1", recurring_plan_id: recurring ? "rp1" : null },
	};
	fake.state.visits.set("v1", v);
	return v;
}

function enable(leadHours: number[]) {
	for (const event of [
		"visit_confirmed",
		"visit_rescheduled",
		"visit_cancelled",
	])
		fake.state.settings.set(event, {
			email_enabled: true,
			sms_enabled: true,
		});
	const reminder = {
		email_enabled: true,
		sms_enabled: true,
		config: { lead_hours: leadHours },
	};
	fake.state.settings.set("visit_reminder", reminder);
}

const at = (d: Date) => vi.setSystemTime(d);
const rowsOf = (event: string) =>
	fake.state.rows.filter((r) => r.event === event);
const sweep = () => runOutboxSweep(new Date());

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.stubEnv("BACKEND_PUBLIC_URL", "https://api.test");
	at(T0);
	fake.state.rows.length = 0;
	fake.state.settings.clear();
	fake.state.visits.clear();
	fake.state.arrivals.length = 0;
	fake.state.contacts.clear();
	fake.state.clientContacts.length = 0;
	fake.state.contacts.set("k1", {
		id: "k1",
		email: "k1@x.test",
		phone: "+15125550100",
		is_active: true,
		type: "customer",
	});
	fake.state.clientContacts.push({
		client_id: "c1",
		contact_id: "k1",
		is_primary: true,
		notify_visits: true,
	});
	channels.mockReturnValue(["email"]);
	send.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("visitEvents", () => {
	it("scheduling a visit queues one confirmation and one reminder per lead_hours entry", async () => {
		enable([48, 24]);
		const start = new Date(T0.getTime() + 72 * HOUR);
		visit(start);

		await notifyVisitScheduled("v1", ORG);

		const confirmations = rowsOf("visit_confirmed");
		expect(confirmations).toHaveLength(1);
		expect(confirmations[0].dedupe_key).toBe("visit_confirmed:v1");
		expect(+confirmations[0].send_after).toBe(+T0);
		const reminders = rowsOf("visit_reminder")
			.map((r) => [r.dedupe_key, +r.send_after])
			.sort();
		const iso = start.toISOString();
		expect(reminders).toEqual(
			[
				[`visit_reminder:v1:24:${iso}`, start.getTime() - 24 * HOUR],
				[`visit_reminder:v1:48:${iso}`, start.getTime() - 48 * HOUR],
			].sort(),
		);
	});

	it("a visit starting in 3 hours with lead_hours [24, 2] queues only the 2-hour reminder", async () => {
		enable([24, 2]);
		const start = new Date(T0.getTime() + 3 * HOUR);
		visit(start);

		await notifyVisitScheduled("v1", ORG);

		expect(rowsOf("visit_reminder").map((r) => r.dedupe_key)).toEqual([
			`visit_reminder:v1:2:${start.toISOString()}`,
		]);
		expect(rowsOf("visit_confirmed")).toHaveLength(1);
	});

	it("three reschedules in a minute then a cancel leave exactly: 0 sent reschedule notices, 0 queued reminders, 1 cancel notice", async () => {
		enable([24]);
		const v = visit(new Date(T0.getTime() + 72 * HOUR));
		await notifyVisitScheduled("v1", ORG);
		await sweep();

		for (let i = 1; i <= 3; i++) {
			at(new Date(T0.getTime() + i * 15_000));
			v.scheduled_start_at = new Date(T0.getTime() + (72 + i) * HOUR);
			await notifyVisitRescheduled("v1", ORG);
			await sweep();
		}
		at(new Date(T0.getTime() + 60_000));
		v.status = "Cancelled";
		await notifyVisitCancelled("v1", ORG);
		at(new Date(T0.getTime() + 10 * 60_000));
		await sweep();

		expect(
			rowsOf("visit_rescheduled").map((r) => [r.status, r.skip_reason]),
		).toEqual([
			["skipped", "visit_rescheduled"],
			["skipped", "visit_rescheduled"],
			["skipped", "visit_cancelled"],
		]);
		expect(
			rowsOf("visit_reminder").filter((r) => r.status === "queued"),
		).toHaveLength(0);
		const cancels = rowsOf("visit_cancelled");
		expect(cancels).toHaveLength(1);
		expect(cancels[0].status).toBe("sent");
	});

	it("three reschedules in a minute with no cancel send exactly one notice, for the final start, and remind only for the final start", async () => {
		enable([24]);
		const v = visit(new Date(T0.getTime() + 72 * HOUR));
		await notifyVisitScheduled("v1", ORG);
		await sweep();

		for (let i = 1; i <= 3; i++) {
			at(new Date(T0.getTime() + i * 15_000));
			v.scheduled_start_at = new Date(T0.getTime() + (72 + i) * HOUR);
			await notifyVisitRescheduled("v1", ORG);
			await sweep();
		}
		at(new Date(T0.getTime() + 10 * 60_000));
		await sweep();

		const finalIso = v.scheduled_start_at.toISOString();
		const sent = rowsOf("visit_rescheduled").filter(
			(r) => r.status === "sent",
		);
		expect(sent).toHaveLength(1);
		expect(sent[0].body).toBe(finalIso);
		const live = rowsOf("visit_reminder").filter(
			(r) => r.status === "queued",
		);
		expect(live.map((r) => r.dedupe_key)).toEqual([
			`visit_reminder:v1:24:${finalIso}`,
		]);
	});

	it("A to B to A to B sends a notice for the final B", async () => {
		enable([24]);
		const A = new Date(T0.getTime() + 72 * HOUR);
		const B = new Date(T0.getTime() + 75 * HOUR);
		const v = visit(A);
		await notifyVisitScheduled("v1", ORG);

		for (const [i, start] of [B, A, B].entries()) {
			at(new Date(T0.getTime() + i * 10 * 60_000));
			v.scheduled_start_at = start;
			await notifyVisitRescheduled("v1", ORG);
			at(new Date(T0.getTime() + (i * 10 + 5) * 60_000));
			await sweep();
		}

		const sent = rowsOf("visit_rescheduled").filter(
			(r) => r.status === "sent",
		);
		expect(sent.map((r) => r.body)).toEqual([
			B.toISOString(),
			A.toISOString(),
			B.toISOString(),
		]);
	});

	it("cancel, un-cancel, cancel sends 2 cancel notices and 1 reschedule notice", async () => {
		enable([24]);
		const v = visit(new Date(T0.getTime() + 72 * HOUR));
		const step = async (min: number, status: string) => {
			at(new Date(T0.getTime() + min * 60_000));
			v.status = status;
			await (status === "Cancelled"
				? notifyVisitCancelled("v1", ORG)
				: notifyVisitRescheduled("v1", ORG));
			at(new Date(T0.getTime() + (min + 5) * 60_000));
			await sweep();
		};
		await step(0, "Cancelled");
		await step(10, "Scheduled");
		await step(20, "Cancelled");

		const sent = (e: string) =>
			rowsOf(e).filter((r) => r.status === "sent").length;
		expect(sent("visit_cancelled")).toBe(2);
		expect(sent("visit_rescheduled")).toBe(1);
	});

	it("rescheduling back to the original time does not re-send a reminder that was already sent for that time", async () => {
		// 08:00 Chicago: the 2-hour sms reminder (06:00) is advanced to 20:00
		// the evening before, so it is sent while its key's time is still ahead.
		channels.mockReturnValue(["email", "sms"]);
		enable([2]);
		const original = new Date("2026-06-12T13:00:00Z");
		const v = visit(original);
		await notifyVisitScheduled("v1", ORG);

		at(new Date("2026-06-12T01:00:00Z"));
		await sweep();
		const key = `visit_reminder:v1:2:${original.toISOString()}`;
		const smsSent = () =>
			rowsOf("visit_reminder").filter(
				(r) =>
					r.channel === "sms" &&
					r.dedupe_key === key &&
					r.status === "sent",
			);
		expect(smsSent()).toHaveLength(1);

		at(new Date("2026-06-12T01:05:00Z"));
		v.scheduled_start_at = new Date("2026-06-12T14:00:00Z");
		await notifyVisitRescheduled("v1", ORG);
		at(new Date("2026-06-12T01:06:00Z"));
		v.scheduled_start_at = original;
		await notifyVisitRescheduled("v1", ORG);
		at(new Date("2026-06-12T11:00:00Z"));
		await sweep();

		const forOriginal = rowsOf("visit_reminder").filter(
			(r) => r.dedupe_key === key,
		);
		expect(forOriginal.filter((r) => r.channel === "sms")).toHaveLength(1);
		expect(smsSent()).toHaveLength(1);
		// The email reminder for the original time never went out before the
		// first reschedule skipped it; moving back re-queues and sends it.
		const email = forOriginal.filter((r) => r.channel === "email");
		expect(email).toHaveLength(1);
		expect(email[0].status).toBe("sent");
	});

	it("an un-cancelled visit at an unchanged time gets its reminder back", async () => {
		enable([24]);
		const start = new Date(T0.getTime() + 72 * HOUR);
		const v = visit(start);
		await notifyVisitScheduled("v1", ORG);

		at(new Date(T0.getTime() + 60_000));
		v.status = "Cancelled";
		await notifyVisitCancelled("v1", ORG);
		at(new Date(T0.getTime() + 2 * 60_000));
		v.status = "Scheduled";
		await notifyVisitRescheduled("v1", ORG);

		const queued = rowsOf("visit_reminder").filter(
			(r) => r.status === "queued",
		);
		expect(queued.map((r) => r.dedupe_key)).toEqual([
			`visit_reminder:v1:24:${start.toISOString()}`,
		]);
	});

	it("a reschedule notice that would send at or after the visit start is not queued", async () => {
		enable([24]);
		const v = visit(new Date(T0.getTime() + 72 * HOUR));
		v.scheduled_start_at = new Date(T0.getTime() + 60_000);
		await notifyVisitRescheduled("v1", ORG);

		expect(rowsOf("visit_rescheduled")).toHaveLength(0);
	});

	it("a confirmation text deferred past the visit start by quiet hours is not queued", async () => {
		channels.mockReturnValue(["email", "sms"]);
		enable([]);
		at(new Date("2026-06-12T03:00:00Z")); // 22:00 CDT
		// 07:00 CDT next morning, before quiet hours lift at 08:00.
		visit(new Date("2026-06-12T12:00:00Z"));

		await notifyVisitScheduled("v1", ORG);

		expect(rowsOf("visit_confirmed").map((r) => r.channel)).toEqual([
			"email",
		]);
	});

	it("a reschedule moves the visit's links to the new end even when the notice is off", async () => {
		enable([24]);
		const v = visit(new Date(T0.getTime() + 72 * HOUR));
		mocks.extendVisitLinks.mockClear();
		v.scheduled_start_at = new Date(T0.getTime() + 96 * HOUR);
		v.scheduled_end_at = new Date(T0.getTime() + 97 * HOUR);

		await retimeVisitReminders("v1", ORG);

		expect(mocks.extendVisitLinks).toHaveBeenCalledWith(
			ORG,
			"v1",
			expect.any(Date),
		);
	});

	it("cancelling a job skips the queued messages of its open visits", async () => {
		enable([24]);
		visit(new Date(T0.getTime() + 72 * HOUR));
		await notifyVisitScheduled("v1", ORG);
		expect(fake.state.rows.every((r) => r.status === "queued")).toBe(true);

		await notifyJobCancelled("j1", ORG);

		expect(fake.state.rows.length).toBeGreaterThan(0);
		expect(fake.state.rows.map((r) => [r.status, r.skip_reason])).toEqual(
			fake.state.rows.map(() => ["skipped", "job_cancelled"]),
		);
	});

	it("a recurring-plan visit queues reminders and no confirmation", async () => {
		enable([24]);
		visit(new Date(T0.getTime() + 72 * HOUR), true);

		await notifyVisitScheduled("v1", ORG);

		expect(rowsOf("visit_confirmed")).toHaveLength(0);
		expect(rowsOf("visit_reminder")).toHaveLength(1);
	});

	it("none of these functions reject when the DB throws", async () => {
		enable([24]);
		visit(new Date(T0.getTime() + 72 * HOUR));
		const spy = vi
			.spyOn(fake.db.job_visit, "findFirst")
			.mockRejectedValue(new Error("db down"));
		const update = vi
			.spyOn(fake.db.customer_message, "updateMany")
			.mockRejectedValue(new Error("db down"));
		try {
			await expect(
				notifyVisitScheduled("v1", ORG),
			).resolves.toBeUndefined();
			await expect(
				notifyVisitRescheduled("v1", ORG),
			).resolves.toBeUndefined();
			await expect(
				notifyVisitCancelled("v1", ORG),
			).resolves.toBeUndefined();
			await expect(
				retimeVisitReminders("v1", ORG),
			).resolves.toBeUndefined();
		} finally {
			spy.mockRestore();
			update.mockRestore();
		}
	});

	describe("tech_running_late", () => {
		const enableLate = (config: Record<string, unknown> = {}) =>
			fake.state.settings.set("tech_running_late", {
				email_enabled: true,
				sms_enabled: false,
				config,
			});
		const eta = () => new Date(T0.getTime() + HOUR);

		it("a delay under the threshold queues nothing", async () => {
			enableLate();
			visit(new Date(T0.getTime() + HOUR));
			await notifyRunningLate("v1", ORG, {
				etaAt: eta(),
				delayMinutes: 19,
			});
			expect(rowsOf("tech_running_late")).toHaveLength(0);
			fake.state.settings.get("tech_running_late")!.config = {
				threshold_minutes: 30,
			};
			await notifyRunningLate("v1", ORG, {
				etaAt: eta(),
				delayMinutes: 25,
			});
			expect(rowsOf("tech_running_late")).toHaveLength(0);
		});

		it("queues once per visit per local day at the default threshold", async () => {
			enableLate();
			visit(new Date(T0.getTime() + HOUR));
			await notifyRunningLate("v1", ORG, {
				etaAt: eta(),
				delayMinutes: 20,
			});
			await notifyRunningLate("v1", ORG, {
				etaAt: eta(),
				delayMinutes: 45,
			});
			const rows = rowsOf("tech_running_late");
			expect(rows).toHaveLength(1);
			expect(rows[0].dedupe_key).toBe("tech_running_late:v1:2026-06-11");
			await sweep();
			expect(send).toHaveBeenCalledTimes(1);
		});

		it("crossing the threshold on a later tick queues one notice; a worse forecast adds none", async () => {
			enableLate();
			visit(new Date(T0.getTime() + HOUR));
			for (const delayMinutes of [6, 25, 40]) {
				await notifyRunningLate("v1", ORG, {
					etaAt: eta(),
					delayMinutes,
				});
			}
			expect(rowsOf("tech_running_late")).toHaveLength(1);
		});

		const arrival = (
			tech: string,
			delayMin: number | null,
			over: Record<string, unknown> = {},
		) => ({
			visit_id: "v1",
			tech_id: tech,
			status: "late",
			delay_seconds: delayMin === null ? null : delayMin * 60,
			computed_at: new Date(),
			...over,
		});

		it("two techs: one on time or already arrived queues nothing; both late queues one", async () => {
			enableLate();
			visit(new Date(T0.getTime() + HOUR));
			const late = { etaAt: eta(), delayMinutes: 30 };
			fake.state.arrivals.push(arrival("t1", 30), arrival("t2", -5));
			await notifyRunningLate("v1", ORG, late);
			fake.state.arrivals.length = 0;
			fake.state.arrivals.push(
				arrival("t1", 30),
				arrival("t2", 0, { status: "arrived" }),
			);
			await notifyRunningLate("v1", ORG, late);
			fake.state.arrivals.length = 0;
			fake.state.arrivals.push(arrival("t1", 30), arrival("t2", null));
			await notifyRunningLate("v1", ORG, late);
			expect(rowsOf("tech_running_late")).toHaveLength(0);
			fake.state.arrivals.length = 0;
			fake.state.arrivals.push(arrival("t1", 30), arrival("t2", 25));
			await notifyRunningLate("v1", ORG, late);
			expect(rowsOf("tech_running_late")).toHaveLength(1);
		});

		it("an arrived tech's old row still blocks the notice", async () => {
			enableLate();
			visit(new Date(T0.getTime() + HOUR));
			fake.state.arrivals.push(
				arrival("t1", 0, {
					status: "arrived",
					computed_at: new Date(T0.getTime() - 30 * 60_000),
				}),
				arrival("t2", 30),
			);
			await notifyRunningLate("v1", ORG, {
				etaAt: eta(),
				delayMinutes: 30,
			});
			expect(rowsOf("tech_running_late")).toHaveLength(0);
		});

		it("an ETA already in the past, or a closed visit, queues nothing", async () => {
			enableLate();
			const v = visit(new Date(T0.getTime() + HOUR));
			await notifyRunningLate("v1", ORG, {
				etaAt: new Date(T0.getTime() - 1),
				delayMinutes: 30,
			});
			v.status = "Completed";
			await notifyRunningLate("v1", ORG, {
				etaAt: eta(),
				delayMinutes: 30,
			});
			expect(rowsOf("tech_running_late")).toHaveLength(0);
		});

		it("does not reject when the DB throws", async () => {
			enableLate();
			visit(new Date(T0.getTime() + HOUR));
			const spy = vi
				.spyOn(fake.db.job_visit, "findFirst")
				.mockRejectedValue(new Error("db down"));
			try {
				await expect(
					notifyRunningLate("v1", ORG, {
						etaAt: eta(),
						delayMinutes: 30,
					}),
				).resolves.toBeUndefined();
			} finally {
				spy.mockRestore();
			}
		});
	});

	describe("tech_on_the_way", () => {
		const enableOtw = () =>
			fake.state.settings.set("tech_on_the_way", {
				email_enabled: true,
				sms_enabled: false,
			});

		it("the drive action queues tech_on_the_way once", async () => {
			enableOtw();
			visit(new Date(T0.getTime() + HOUR));
			await notifyTechOnTheWay("v1", "t1", ORG);
			const rows = rowsOf("tech_on_the_way");
			expect(rows).toHaveLength(1);
			expect(rows[0].dedupe_key).toBe("tech_on_the_way:v1:2026-06-11");
			await sweep();
			expect(send).toHaveBeenCalledTimes(1);
		});

		it("a second tech's drive on the same visit queues nothing new (same dedupe key)", async () => {
			enableOtw();
			visit(new Date(T0.getTime() + HOUR));
			await notifyTechOnTheWay("v1", "t1", ORG);
			await notifyTechOnTheWay("v1", "t2", ORG);
			expect(rowsOf("tech_on_the_way")).toHaveLength(1);
		});

		it("drive, delay, drive again on the same day sends one message", async () => {
			enableOtw();
			const v = visit(new Date(T0.getTime() + 4 * HOUR));
			await notifyTechOnTheWay("v1", "t1", ORG);
			await sweep();
			v.status = "Delayed";
			at(new Date(T0.getTime() + HOUR));
			await notifyTechOnTheWay("v1", "t1", ORG);
			await sweep();
			expect(send).toHaveBeenCalledTimes(1);
		});

		it("the next local day's drive queues a new message", async () => {
			enableOtw();
			visit(new Date(T0.getTime() + 48 * HOUR));
			await notifyTechOnTheWay("v1", "t1", ORG);
			at(new Date(T0.getTime() + 24 * HOUR));
			await notifyTechOnTheWay("v1", "t1", ORG);
			expect(rowsOf("tech_on_the_way")).toHaveLength(2);
		});
	});

	describe("review_request", () => {
		const REVIEW = "https://g.page/r/acme/review";

		beforeEach(() => {
			fake.state.jobs.clear();
			fake.state.jobs.set("j1", {
				id: "j1",
				status: "Completed",
				client_id: "c1",
			});
			fake.state.reviewUrl = REVIEW;
			fake.state.openDisputes = 0;
			fake.state.disputedInvoices = 0;
			fake.state.disputeWheres.length = 0;
			// The render mock reads v1.
			visit(T0);
			fake.state.settings.set("review_request", {
				email_enabled: true,
				sms_enabled: true,
				config: { delay_hours: 2 },
			} as never);
			channels.mockReturnValue(["email", "sms"]);
		});

		it("queues one request per job, delay_hours after completion", async () => {
			await notifyJobCompleted("j1", ORG);
			await notifyJobCompleted("j1", ORG);
			const email = rowsOf("review_request").filter(
				(r) => r.channel === "email",
			);
			expect(email).toHaveLength(1);
			expect(email[0].dedupe_key).toBe("review_request:j1");
			expect(email[0].entity_type).toBe("job");
			expect(email[0].send_after).toEqual(
				new Date(T0.getTime() + 2 * HOUR),
			);
		});

		it("no request is queued when the same client was sent one in the last 180 days", async () => {
			fake.state.jobs.set("j0", {
				id: "j0",
				status: "Completed",
				client_id: "c1",
			});
			await notifyJobCompleted("j0", ORG);
			const prior = rowsOf("review_request");
			for (const r of prior) r.status = "sent";

			at(new Date(T0.getTime() + 179 * 24 * HOUR));
			await notifyJobCompleted("j1", ORG);
			expect(rowsOf("review_request")).toHaveLength(prior.length);

			// A request that was never sent does not hold the next one back.
			for (const r of prior) r.status = "skipped";
			await notifyJobCompleted("j1", ORG);
			expect(
				rowsOf("review_request").filter((r) => r.entity_id === "j1"),
			).toHaveLength(2);
		});

		it("a request sent more than 180 days ago does not block the next one", async () => {
			fake.state.jobs.set("j0", {
				id: "j0",
				status: "Completed",
				client_id: "c1",
			});
			await notifyJobCompleted("j0", ORG);
			for (const r of rowsOf("review_request")) r.status = "sent";
			at(new Date(T0.getTime() + 181 * 24 * HOUR));
			await notifyJobCompleted("j1", ORG);
			expect(
				rowsOf("review_request").filter((r) => r.entity_id === "j1"),
			).toHaveLength(2);
		});

		it("no request is queued when the job has an open dispute or the invoice is Disputed", async () => {
			fake.state.openDisputes = 1;
			await notifyJobCompleted("j1", ORG);
			expect(rowsOf("review_request")).toHaveLength(0);
			const disputeWhere = JSON.stringify(fake.state.disputeWheres[0]);
			expect(disputeWhere).toContain('"status":"Open"');
			expect(disputeWhere).toContain("j1");

			fake.state.openDisputes = 0;
			fake.state.disputedInvoices = 1;
			fake.state.disputeWheres.length = 0;
			await notifyJobCompleted("j1", ORG);
			expect(rowsOf("review_request")).toHaveLength(0);
			expect(JSON.stringify(fake.state.disputeWheres)).toContain(
				'"status":"Disputed"',
			);

			fake.state.disputedInvoices = 0;
			await notifyJobCompleted("j1", ORG);
			expect(rowsOf("review_request")).toHaveLength(2);
		});

		it("no request is queued without a review link or for a job that is not completed", async () => {
			fake.state.reviewUrl = null;
			await notifyJobCompleted("j1", ORG);
			fake.state.reviewUrl = REVIEW;
			fake.state.jobs.get("j1")!.status = "InProgress";
			await notifyJobCompleted("j1", ORG);
			expect(rowsOf("review_request")).toHaveLength(0);
		});

		it("a job completed at 19:30 with delay_hours 2 sends the sms at 08:00 next morning and the email at 21:30", async () => {
			// 2026-06-11 19:30 in Chicago (CDT, UTC-5).
			const done = new Date("2026-06-12T00:30:00Z");
			at(done);
			await notifyJobCompleted("j1", ORG);
			const by = (c: string) =>
				rowsOf("review_request").find((r) => r.channel === c)!;
			expect(by("email").send_after).toEqual(
				new Date("2026-06-12T02:30:00Z"),
			);
			expect(by("sms").send_after).toEqual(
				new Date("2026-06-12T13:00:00Z"),
			);

			at(new Date("2026-06-12T02:30:00Z"));
			await sweep();
			expect(by("email").status).toBe("sent");
			expect(by("sms").status).toBe("queued");

			at(new Date("2026-06-12T13:00:00Z"));
			await sweep();
			expect(by("sms").status).toBe("sent");
		});

		it("a request queued for a job that is reopened before it sends is skipped", async () => {
			await notifyJobCompleted("j1", ORG);
			fake.state.jobs.get("j1")!.status = "InProgress";
			at(new Date(T0.getTime() + 2 * HOUR));
			await sweep();
			expect(send).not.toHaveBeenCalled();
			expect(
				rowsOf("review_request").every(
					(r) => r.skip_reason === "job_not_completed",
				),
			).toBe(true);
		});

		it("two requests queued for the same client send once; the later one is skipped at send time", async () => {
			// Two completions racing past the queue-time check.
			channels.mockReturnValue(["email"]);
			const queued = (jobId: string, createdAt: Date) => ({
				organization_id: ORG,
				event: "review_request",
				channel: "email",
				client_id: "c1",
				contact_id: "k1",
				recipient: "k1@x.test",
				entity_type: "job",
				entity_id: jobId,
				dedupe_key: `review_request:${jobId}`,
				send_after: T0,
				created_at: createdAt,
			});
			fake.state.jobs.set("j0", {
				id: "j0",
				status: "Completed",
				client_id: "c1",
			});
			await fake.db.customer_message.createMany({
				data: [
					queued("j0", T0),
					queued("j1", new Date(T0.getTime() + 1)),
				],
			});
			await sweep();
			const byJob = (j: string) =>
				rowsOf("review_request").find((r) => r.entity_id === j)!;
			expect(byJob("j0").status).toBe("sent");
			expect(byJob("j1").status).toBe("skipped");
			expect(byJob("j1").skip_reason).toBe("review_recently_requested");
			expect(send).toHaveBeenCalledTimes(1);
		});

		it("the email and text of one request both send (the same job never blocks itself)", async () => {
			await notifyJobCompleted("j1", ORG);
			at(new Date(T0.getTime() + 2 * HOUR));
			await sweep();
			expect(rowsOf("review_request").map((r) => r.status)).toEqual([
				"sent",
				"sent",
			]);
		});

		it("notifyJobCompleted never rejects", async () => {
			const spy = vi
				.spyOn(fake.db.job, "findFirst")
				.mockRejectedValue(new Error("db down"));
			try {
				await expect(
					notifyJobCompleted("j1", ORG),
				).resolves.toBeUndefined();
			} finally {
				spy.mockRestore();
			}
		});
	});
	describe("visit_completed", () => {
		beforeEach(() => {
			fake.state.settings.set("visit_completed", {
				email_enabled: true,
				sms_enabled: true,
			});
			channels.mockReturnValue(["email", "sms"]);
			mocks.extendVisitLinks.mockClear();
		});

		it("notifyVisitCompleted queues once per visit and not at all for a visit completed with status Cancelled", async () => {
			const v = visit(new Date(T0.getTime() - 2 * HOUR));
			v.status = "Completed";
			(v as unknown as { actual_end_at: Date }).actual_end_at = T0;
			await notifyVisitCompleted("v1", ORG);
			await notifyVisitCompleted("v1", ORG);
			const rows = rowsOf("visit_completed");
			expect(rows.map((r) => r.channel).sort()).toEqual(["email", "sms"]);
			expect(
				rows.every((r) => r.dedupe_key === "visit_completed:v1"),
			).toBe(true);
			// Held, not exempt: 10:00 CDT is outside quiet hours, so it sends now.
			expect(
				rows.every((r) => r.send_after.getTime() === T0.getTime()),
			).toBe(true);
			expect(mocks.extendVisitLinks).toHaveBeenCalledWith(
				ORG,
				"v1",
				new Date(T0.getTime() + 30 * 24 * HOUR),
			);

			fake.state.rows.length = 0;
			v.status = "Cancelled";
			await notifyVisitCompleted("v1", ORG);
			expect(rowsOf("visit_completed")).toHaveLength(0);
		});

		it("holds the completion text for quiet hours", async () => {
			const late = new Date("2026-06-12T03:30:00Z"); // 22:30 CDT
			at(late);
			const v = visit(new Date(late.getTime() - 2 * HOUR));
			v.status = "Completed";
			await notifyVisitCompleted("v1", ORG);
			const sms = rowsOf("visit_completed").find(
				(r) => r.channel === "sms",
			);
			expect(sms?.send_after.getTime()).toBeGreaterThan(late.getTime());
		});

		it("notifyVisitCompleted never rejects", async () => {
			const spy = vi
				.spyOn(fake.db.job_visit, "findFirst")
				.mockRejectedValue(new Error("db down"));
			try {
				await expect(
					notifyVisitCompleted("v1", ORG),
				).resolves.toBeUndefined();
			} finally {
				spy.mockRestore();
			}
		});
	});
});
