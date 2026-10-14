import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => {
	const { createFakeDb } = await import("../../routes/__tests__/harness.js");
	return { db: createFakeDb() };
});

import { db } from "../../db.js";
import { redactFeedRow, recentActivityRoute } from "../logsController.js";
import { callHandlers, leaves, makeLogRow as row, type FakeDb } from "../../routes/__tests__/harness.js";

const fake = db as unknown as FakeDb;

beforeEach(() => {
	vi.clearAllMocks();
	fake.log.findMany.mockResolvedValue([]);
});

describe("redactFeedRow (review P1-3 / S4)", () => {
	it("drops technician PII from technician.updated only", () => {
		const tech = row({
			event_type: "technician.updated",
			entity_type: "technician",
			changes: {
				status: { old: "Offline", new: "Available" },
				email: { old: "a@x", new: "b@x" },
				phone: { old: "1", new: "2" },
				coords: { old: {}, new: { lat: 1 } },
				hire_date: { old: "2020", new: "2021" },
			},
		});
		expect(redactFeedRow(tech).changes).toEqual({ status: { old: "Offline", new: "Available" } });

		const other = row({ event_type: "job.updated", changes: { email: { old: "a", new: "b" } } });
		expect(redactFeedRow(other)).toBe(other);
	});

	// The reason on a failed send is the email provider's own rejection text. It
	// names the sending domain, the recipient's domain and whether the account is
	// approved, and logActivity pushes every feed event to org:<id> — a room the
	// technician sockets are in. Same treatment as a dispute reason.
	it("drops the provider message from a failed send", () => {
		for (const event_type of ["quote.send_failed", "invoice.send_failed"]) {
			const failed = row({
				event_type,
				entity_type: event_type.split(".")[0],
				reason: "While your account is pending approval, all recipient addresses must share the same domain as the 'From' address.",
			});
			expect(redactFeedRow(failed).reason).toBeNull();
		}
	});

	// Redaction is for the broadcast, not the record: the row itself keeps the
	// provider text so the detail page can still show it behind view_*.
	it("leaves a send that did not fail alone", () => {
		const sent = row({ event_type: "quote.updated", reason: "status change" });
		expect(redactFeedRow(sent)).toBe(sent);
	});
});

describe("GET /logs/recent access + redaction (review P1-3 / S4)", () => {
	it("denies technicians the unfiltered org feed", async () => {
		const r = await callHandlers(recentActivityRoute, { user: { uid: "tech-1", role: "technician", permissions: ["view_visits"] } });
		expect(r.status).toBe(403);
		expect(r.body).toMatchObject({ success: false, error: { code: "INVALID_CREDENTIALS" } });
		expect(fake.log.findMany).not.toHaveBeenCalled();
	});

	it("lets a technician read their own activity via userId", async () => {
		const r = await callHandlers(recentActivityRoute, {
			user: { uid: "tech-1", role: "technician", permissions: [] },
			query: { userId: "tech-1" },
		});
		expect(r.status).toBe(200);
		expect(r.body.success).toBe(true);
		const where = fake.log.findMany.mock.calls[0][0].where;
		expect(leaves(where)).toEqual(expect.arrayContaining([{ actor_id: "tech-1" }, { entity_id: "tech-1" }, { organization_id: "org-1" }]));
	});

	it("denies a technician another user's activity", async () => {
		const r = await callHandlers(recentActivityRoute, {
			user: { uid: "tech-1", role: "technician", permissions: [] },
			query: { userId: "tech-2" },
		});
		expect(r.status).toBe(403);
	});

	it("denies a dispatcher without view_* another user's activity, allows with view_technicians", async () => {
		const denied = await callHandlers(recentActivityRoute, {
			user: { uid: "disp-1", role: "dispatcher", permissions: ["view_jobs"] },
			query: { userId: "tech-2" },
		});
		expect(denied.status).toBe(403);
		const ok = await callHandlers(recentActivityRoute, {
			user: { uid: "disp-1", role: "dispatcher", permissions: ["view_technicians"] },
			query: { userId: "tech-2" },
		});
		expect(ok.status).toBe(200);
	});

	it("lets dispatchers and admins read the org feed", async () => {
		const disp = await callHandlers(recentActivityRoute, { user: { uid: "disp-1", role: "dispatcher", permissions: [] } });
		expect(disp.status).toBe(200);
		const admin = await callHandlers(recentActivityRoute, { user: { uid: "adm-1", role: "admin", permissions: [] } });
		expect(admin.status).toBe(200);
	});

	it("redacts technician.updated PII, caps the limit at 50 and honours the cursor", async () => {
		fake.log.findMany.mockResolvedValue([
			row({ event_type: "technician.updated", entity_type: "technician", changes: { status: { old: "Offline", new: "Available" }, email: { old: "a", new: "b" }, coords: { old: {}, new: {} } } }),
		]);
		const r = await callHandlers(recentActivityRoute, {
			user: { uid: "disp-1", role: "dispatcher", permissions: [] },
			query: { limit: "500", cursor: "2026-08-01T00:00:00.000Z" },
		});
		expect(r.status).toBe(200);
		expect(r.body.data[0].changes).toEqual({ status: { old: "Offline", new: "Available" } });
		expect(r.body.meta).toMatchObject({ count: 1, hasMore: false });
		const args = fake.log.findMany.mock.calls[0][0];
		expect(args.take).toBe(50);
		expect(leaves(args.where)).toEqual(expect.arrayContaining([{ timestamp: { lt: new Date("2026-08-01T00:00:00.000Z") } }]));
	});
});

describe("dispute feed events (dispute attention surfaces §6.2)", () => {
	const DISPUTE_EVENTS = [
		"quote.dispute_opened",
		"quote.dispute_resolved",
		"invoice.dispute_opened",
		"invoice.dispute_resolved",
	];

	it("strips reason from all four dispute events", () => {
		for (const event_type of DISPUTE_EVENTS) {
			const r = row({ event_type, reason: "Billed 2 hours, tech was there 1" });
			expect(redactFeedRow(r).reason).toBeNull();
		}
	});

	it("leaves reason (and row identity) alone on every other event", () => {
		const other = row({ event_type: "quote.updated", reason: "kept" });
		expect(redactFeedRow(other)).toBe(other);
	});

	it("technician PII redaction is unchanged", () => {
		const tech = row({
			event_type: "technician.updated",
			changes: { status: { old: "Offline", new: "Available" }, email: { old: "a", new: "b" } },
		});
		expect(redactFeedRow(tech).changes).toEqual({ status: { old: "Offline", new: "Available" } });
	});

	it("GET /logs/recent asks for the dispute events", async () => {
		await callHandlers(recentActivityRoute, {
			user: { uid: "disp-1", role: "dispatcher", permissions: [] },
		});
		const where = fake.log.findMany.mock.calls[0][0].where;
		const eventLeaf = leaves(where).find((l) => "event_type" in l) as
			| { event_type: { in: string[] } }
			| undefined;
		expect(eventLeaf?.event_type.in).toEqual(expect.arrayContaining(DISPUTE_EVENTS));
	});
});
