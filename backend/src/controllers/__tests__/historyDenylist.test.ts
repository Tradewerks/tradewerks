import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => {
	const { createFakeDb } = await import("../../routes/__tests__/harness.js");
	return { db: createFakeDb() };
});

import { db } from "../../db.js";
import { redactSensitiveChanges, getActorHistory, getEntityHistory } from "../logsController.js";
import { leaves, notClauses, makeLogRow as row, type FakeDb } from "../../routes/__tests__/harness.js";

const fake = db as unknown as FakeDb;

beforeEach(() => {
	vi.clearAllMocks();
	fake.log.findMany.mockResolvedValue([]);
	fake.log.count.mockResolvedValue(0);
});

describe("redactSensitiveChanges (review B3 / L1)", () => {
	it("strips password/token/secret/otp/mfa keys and keeps the rest", () => {
		const r = redactSensitiveChanges(
			row({
				changes: {
					name: { old: "a", new: "b" },
					password: { old: "$2a$10$x", new: "$2a$10$y" },
					password_reset_token: { old: null, new: "t" },
					api_secret: { old: 1, new: 2 },
					otp_code: { old: 1, new: 2 },
					mfa_enabled: { old: false, new: true },
				},
			}),
		);
		expect(r.changes).toEqual({ name: { old: "a", new: "b" } });
	});

	it("returns the same row object when nothing is sensitive or changes is null", () => {
		const plain = row();
		expect(redactSensitiveChanges(plain)).toBe(plain);
		const nul = row({ changes: null });
		expect(redactSensitiveChanges(nul)).toBe(nul);
	});
});

describe("getActorHistory — read-side denylist (review B3 / L1)", () => {
	it("excludes password/auth/mfa/oauth events in the query and strips sensitive keys from results", async () => {
		fake.log.findMany.mockResolvedValue([
			row({ id: "1", event_type: "dispatcher.updated", changes: { name: { old: "a", new: "b" }, password_reset_token: { old: "x", new: "y" } } }),
		]);
		fake.log.count.mockResolvedValue(1);

		const result = await getActorHistory("org-1", "dispatcher", "disp-1", 20);
		expect(result.err).toBe("");
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0].changes).toEqual({ name: { old: "a", new: "b" } });

		const where = fake.log.findMany.mock.calls[0][0].where;
		expect(notClauses(where)).toEqual(
			expect.arrayContaining([
				{ event_type: { startsWith: "auth." } },
				{ event_type: { startsWith: "mfa." } },
				{ event_type: { startsWith: "oauth" } },
				{ event_type: { contains: ".password." } },
			]),
		);
		// still org-scoped and actor-scoped
		expect(leaves(where)).toEqual(expect.arrayContaining([{ organization_id: "org-1" }, { actor_id: "disp-1" }]));
		// count uses the same filter so total stays consistent with the page
		expect(fake.log.count.mock.calls[0][0].where).toEqual(where);
	});

	it("computes hasMore from limit+1 and slices the page", async () => {
		fake.log.findMany.mockResolvedValue([row({ id: "1" }), row({ id: "2" }), row({ id: "3" })]);
		fake.log.count.mockResolvedValue(7);
		const r = await getActorHistory("org-1", "dispatcher", "disp-1", 2);
		expect(r.rows.map((x) => x.id)).toEqual(["1", "2"]);
		expect(r.hasMore).toBe(true);
		expect(r.total).toBe(7);
		expect(fake.log.findMany.mock.calls[0][0].take).toBe(3);
	});

	it("accepts dispatcher, admin and agent actor types for dispatchers", async () => {
		// "agent" rows record the HUMAN in actor_id, so pairing the widened type
		// list with the actor_id filter keeps results scoped to this one person —
		// it surfaces what their assistant did for them, not anyone else's.
		await getActorHistory("org-1", "dispatcher", "disp-1", 5);
		expect(leaves(fake.log.findMany.mock.calls[0][0].where)).toEqual(
			expect.arrayContaining([{ actor_type: { in: ["dispatcher", "admin", "agent"] } }]),
		);
	});

	it("scopes agent rows to the actor they were run for", async () => {
		await getActorHistory("org-1", "dispatcher", "disp-1", 5);
		const where = JSON.stringify(fake.log.findMany.mock.calls[0][0].where);
		expect(where).toContain('"actor_id":"disp-1"');
	});
});

describe("getEntityHistory — same denylist and redaction (review B3 / L1)", () => {
	it("applies the sensitive-event filter and strips secret keys on entity history too", async () => {
		fake.job_visit.findMany.mockResolvedValue([]);
		fake.job_line_item.findMany.mockResolvedValue([]);
		fake.job_note.findMany.mockResolvedValue([]);
		fake.log.findMany.mockResolvedValue([
			row({ id: "1", changes: { name: { old: "a", new: "b" }, qb_token: { old: "x", new: "y" } } }),
		]);
		fake.log.count.mockResolvedValue(1);

		const r = await getEntityHistory("org-1", "job", "job-1", 20);
		expect(r.rows[0].changes).toEqual({ name: { old: "a", new: "b" } });
		const where = fake.log.findMany.mock.calls.at(-1)![0].where;
		expect(notClauses(where)).toEqual(expect.arrayContaining([{ event_type: { contains: ".password." } }]));
		expect(leaves(where)).toEqual(expect.arrayContaining([{ organization_id: "org-1" }, { entity_type: "job" }]));
	});
});
