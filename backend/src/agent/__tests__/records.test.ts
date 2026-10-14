import { beforeEach, describe, expect, it, vi } from "vitest";

const { getScopedDb, loaderGet, loaderList } = vi.hoisted(() => ({
	getScopedDb: vi.fn(() => ({})),
	// Return/param types are spelled out so call assertions below stay indexable.
	loaderGet: vi.fn(async (_db: unknown, _id: string): Promise<unknown> => ({ id: "x" })),
	loaderList: vi.fn(
		async (_db: unknown, _filters: Record<string, unknown>) => ({ rows: [{ id: "x" }], total: 7 }),
	),
}));

vi.mock("../../lib/context.js", () => ({ getScopedDb }));
vi.mock("../../services/logger.js", () => ({ logActivity: vi.fn() }));
vi.mock("../../services/appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../records.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../records.js")>();
	return {
		...actual,
		RECORD_LOADERS: Object.fromEntries(
			actual.RECORD_TYPES.map((t) => [t, { get: loaderGet, list: loaderList }]),
		),
	};
});

import { executeTool } from "../execute.js";
import { READ_ONLY_POLICY } from "../policy.js";
import "../tools/records.js";
import type { AgentContext } from "../types.js";

const ctxWith = (...permissions: string[]): AgentContext => ({
	userId: "u",
	role: "dispatcher",
	organizationId: "org-1",
	permissions,
	actorType: "dispatcher",
	surface: "assistant",
});

const ID = "11111111-1111-4111-8111-111111111111";

describe("get_record", () => {
	beforeEach(() => {
		loaderGet.mockClear();
		loaderGet.mockResolvedValue({ id: "x" });
	});

	it("returns the record when the caller may read that type", async () => {
		const r = await executeTool("get_record", { type: "client", id: ID }, ctxWith("view_clients"), READ_ONLY_POLICY);
		expect(r).toMatchObject({ ok: true, data: { id: "x" } });
	});

	it("re-checks permission per type, not just once for the tool", async () => {
		// The registry gate is ANY-OF across every record type's permission, so it
		// passes for a caller holding only view_inventory. Without the per-type
		// re-check inside the handler, that caller could read client records.
		const r = await executeTool("get_record", { type: "client", id: ID }, ctxWith("view_inventory"), READ_ONLY_POLICY);
		expect(r).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
		expect(loaderGet).not.toHaveBeenCalled();
	});

	it.each([
		["job", "view_assigned_jobs"],
		["job", "view_all_jobs"],
		["visit", "view_visits"],
		["technician", "view_team_schedule"],
	])("accepts any of the permissions that cover %s (%s)", async (type, permission) => {
		const r = await executeTool("get_record", { type, id: ID }, ctxWith(permission), READ_ONLY_POLICY);
		expect(r).toMatchObject({ ok: true });
	});

	it("reports a miss without revealing whether the id exists in another org", async () => {
		loaderGet.mockResolvedValue(null);
		const r = await executeTool("get_record", { type: "job", id: ID }, ctxWith("view_jobs"), READ_ONLY_POLICY);
		expect(r).toMatchObject({ ok: true, data: { found: false, message: expect.stringContaining("organization") } });
	});

	it("rejects an id that is not a uuid", async () => {
		const r = await executeTool("get_record", { type: "job", id: "42" }, ctxWith("view_jobs"), READ_ONLY_POLICY);
		expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
	});

	it("rejects an unknown record type", async () => {
		const r = await executeTool("get_record", { type: "spaceship", id: ID }, ctxWith("view_jobs"), READ_ONLY_POLICY);
		expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
	});
});

describe("list_records", () => {
	beforeEach(() => loaderList.mockClear());

	it("tells the model when it is seeing a subset", async () => {
		const r = await executeTool(
			"list_records",
			{ type: "job", limit: 1 },
			ctxWith("view_jobs"),
			READ_ONLY_POLICY,
		);
		expect(r).toMatchObject({ ok: true, data: { returned: 1, total: 7, truncated: true } });
	});

	it("passes filters through to the loader", async () => {
		await executeTool(
			"list_records",
			{ type: "job", status: "Scheduled", client_id: ID, since: "2026-01-01", limit: 5 },
			ctxWith("view_jobs"),
			READ_ONLY_POLICY,
		);
		expect(loaderList.mock.calls[0][1]).toMatchObject({
			limit: 5,
			status: "Scheduled",
			clientId: ID,
			since: new Date("2026-01-01"),
		});
	});

	describe("status validation is per type", () => {
		it("accepts a status valid for that type", async () => {
			const r = await executeTool(
				"list_records",
				{ type: "quote", status: "Approved" },
				ctxWith("view_quotes"),
				READ_ONLY_POLICY,
			);
			expect(r).toMatchObject({ ok: true });
		});

		it("rejects a status borrowed from a different type", async () => {
			// "Approved" is a quote status; jobs have no such state. Catching it in
			// validation gives the model the valid list back instead of a 500 from Prisma.
			const r = await executeTool(
				"list_records",
				{ type: "job", status: "Approved" },
				ctxWith("view_jobs"),
				READ_ONLY_POLICY,
			);
			expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
			if (r.ok) throw new Error("expected failure");
			expect(JSON.stringify(r.error.details)).toContain("Unscheduled");
		});

		it("rejects a status filter on a type that has no status", async () => {
			const r = await executeTool(
				"list_records",
				{ type: "client", status: "Active" },
				ctxWith("view_clients"),
				READ_ONLY_POLICY,
			);
			expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
		});
	});

	describe("filters that do not apply to the type are rejected, not ignored", () => {
		it("rejects client_id on technicians", async () => {
			// Ignoring it would return every technician as if they were that client's.
			const r = await executeTool(
				"list_records",
				{ type: "technician", client_id: ID },
				ctxWith("view_technicians"),
				READ_ONLY_POLICY,
			);
			expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
			if (r.ok) throw new Error("expected failure");
			expect(JSON.stringify(r.error.details)).toContain("client_id");
		});

		it("rejects a date range on inventory items", async () => {
			const r = await executeTool(
				"list_records",
				{ type: "inventory_item", since: "2026-01-01" },
				ctxWith("view_inventory"),
				READ_ONLY_POLICY,
			);
			expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
		});

		it("still accepts them on a type that supports them", async () => {
			const r = await executeTool(
				"list_records",
				{ type: "job", client_id: ID, since: "2026-01-01" },
				ctxWith("view_jobs"),
				READ_ONLY_POLICY,
			);
			expect(r).toMatchObject({ ok: true });
		});
	});

	it("names the column a date filter applied to", async () => {
		// "jobs since March" bounds created_at; "visits since March" bounds
		// scheduled_start_at. Reporting which one keeps the answer interpretable.
		const jobs = await executeTool(
			"list_records",
			{ type: "job", since: "2026-01-01" },
			ctxWith("view_jobs"),
			READ_ONLY_POLICY,
		);
		expect(jobs).toMatchObject({ ok: true, data: { date_filter_field: "created_at" } });

		const visits = await executeTool(
			"list_records",
			{ type: "visit", since: "2026-01-01" },
			ctxWith("view_visits"),
			READ_ONLY_POLICY,
		);
		expect(visits).toMatchObject({ ok: true, data: { date_filter_field: "scheduled_start_at" } });
	});

	it("rejects an unparseable date", async () => {
		const r = await executeTool(
			"list_records",
			{ type: "job", since: "last Tuesday" },
			ctxWith("view_jobs"),
			READ_ONLY_POLICY,
		);
		expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
	});

	it("caps the limit", async () => {
		const r = await executeTool(
			"list_records",
			{ type: "job", limit: 5000 },
			ctxWith("view_jobs"),
			READ_ONLY_POLICY,
		);
		expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
	});
});
