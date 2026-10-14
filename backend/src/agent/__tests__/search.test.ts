import { beforeEach, describe, expect, it, vi } from "vitest";

const { searchRecords, getScopedDb } = vi.hoisted(() => ({
	searchRecords: vi.fn(
		async (_orgId: string, _options: { query: string; types?: readonly string[]; limit?: number }) => ({
			hits: [],
			truncated: false,
			types: [] as string[],
		}),
	),
	getScopedDb: vi.fn(() => ({})),
}));

vi.mock("../../lib/context.js", () => ({ getScopedDb }));
vi.mock("../../services/logger.js", () => ({ logActivity: vi.fn() }));
vi.mock("../../services/appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../services/searchService.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../services/searchService.js")>()),
	searchRecords,
}));

import { allowedSearchTypes, SEARCHABLE_TYPES } from "../../services/searchService.js";
import { executeTool } from "../execute.js";
import { READ_ONLY_POLICY } from "../policy.js";
import "../tools/search.js";
import type { AgentContext } from "../types.js";

const ctxWith = (...permissions: string[]): AgentContext => ({
	userId: "u",
	role: "dispatcher",
	organizationId: "org-1",
	permissions,
	actorType: "dispatcher",
	surface: "assistant",
});

const typesPassedToService = () => searchRecords.mock.calls[0]?.[1]?.types;

describe("allowedSearchTypes", () => {
	it("maps a permission to only the types it covers", () => {
		expect(allowedSearchTypes(["view_inventory"])).toEqual(["inventory_item"]);
		expect(allowedSearchTypes(["view_quotes"])).toEqual(["quote"]);
	});

	it("gives view_clients both clients and their contacts", () => {
		expect(allowedSearchTypes(["view_clients"]).sort()).toEqual(["client", "contact"]);
	});

	it("returns nothing for no permissions", () => {
		expect(allowedSearchTypes([])).toEqual([]);
	});

	it("covers every searchable type when every permission is held", () => {
		const all = allowedSearchTypes([
			"view_clients",
			"view_jobs",
			"view_quotes",
			"view_requests",
			"view_invoices",
			"view_technicians",
			"view_projects",
			"view_inventory",
		]);
		expect(all.sort()).toEqual([...SEARCHABLE_TYPES].sort());
	});
});

describe("search_records tool", () => {
	beforeEach(() => searchRecords.mockClear());

	it("searches only the types the caller may see", async () => {
		await executeTool("search_records", { query: "acme" }, ctxWith("view_clients"), READ_ONLY_POLICY);
		expect([...(typesPassedToService() ?? [])].sort()).toEqual(["client", "contact"]);
	});

	it("narrows to the requested types", async () => {
		await executeTool(
			"search_records",
			{ query: "acme", types: ["client"] },
			ctxWith("view_clients", "view_jobs"),
			READ_ONLY_POLICY,
		);
		expect(typesPassedToService()).toEqual(["client"]);
	});

	it("never widens access through the types argument", async () => {
		// A model asking for invoices without view_invoices must not get them,
		// even though it named the type explicitly.
		await executeTool(
			"search_records",
			{ query: "acme", types: ["invoice", "client"] },
			ctxWith("view_clients"),
			READ_ONLY_POLICY,
		);
		expect(typesPassedToService()).toEqual(["client"]);
	});

	it("explains itself instead of erroring when nothing is visible", async () => {
		const r = await executeTool(
			"search_records",
			{ query: "acme", types: ["invoice"] },
			ctxWith("view_clients"),
			READ_ONLY_POLICY,
		);
		expect(r).toMatchObject({ ok: true, data: { hits: [], total: 0, note: expect.stringContaining("requested") } });
		expect(searchRecords).not.toHaveBeenCalled();
	});

	it("rejects a query shorter than the minimum", async () => {
		const r = await executeTool("search_records", { query: "a" }, ctxWith("view_clients"), READ_ONLY_POLICY);
		expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
	});

	it("refuses a caller holding no view permission at all", async () => {
		const r = await executeTool("search_records", { query: "acme" }, ctxWith(), READ_ONLY_POLICY);
		expect(r).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
	});
});
