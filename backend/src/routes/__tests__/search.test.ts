import { beforeEach, describe, expect, it, vi } from "vitest";

const { searchRecords } = vi.hoisted(() => ({
	searchRecords: vi.fn(
		async (_orgId: string, _options: { query: string; types?: readonly string[]; limit?: number }) => ({
			hits: [{ id: "c1", type: "client", label: "Acme", route: "/dispatch/clients/c1" }],
			truncated: false,
			types: ["client"] as string[],
		}),
	),
}));

vi.mock("../../services/searchService.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../services/searchService.js")>()),
	searchRecords,
}));

import searchRouter from "../search.js";
import { callRoute } from "./harness.js";

const user = (role: string, permissions: string[]) => ({
	uid: "u1",
	role,
	organization_id: "org-1",
	permissions,
});

const call = (query: Record<string, unknown>, who = user("dispatcher", ["view_clients"])) =>
	callRoute(searchRouter, "get", "/", { user: who, query });

const typesSearched = () => searchRecords.mock.calls[0]?.[1]?.types;

describe("GET /search", () => {
	beforeEach(() => searchRecords.mockClear());

	it("returns hits for a permitted type", async () => {
		const r = await call({ q: "acme" });
		expect(r.status).toBe(200);
		expect(r.body.success).toBe(true);
		expect(r.body.data.hits).toHaveLength(1);
		expect(r.body.meta.count).toBe(1);
	});

	describe("validation", () => {
		it.each([[""], ["a"], [undefined]])("rejects q=%o as too short", async (q) => {
			const r = await call(q === undefined ? {} : { q });
			expect(r.status).toBe(400);
			expect(r.body.error.field).toBe("q");
		});

		it.each([["0"], ["51"], ["2.5"], ["lots"]])("rejects limit=%o", async (limit) => {
			const r = await call({ q: "acme", limit });
			expect(r.status).toBe(400);
			expect(r.body.error.field).toBe("limit");
		});

		it("accepts a limit inside the range", async () => {
			const r = await call({ q: "acme", limit: "5" });
			expect(r.status).toBe(200);
			expect(searchRecords.mock.calls[0][1].limit).toBe(5);
		});

		it("names the unknown type it rejected", async () => {
			const r = await call({ q: "acme", types: "client,spaceship" });
			expect(r.status).toBe(400);
			expect(r.body.error.message).toContain("spaceship");
		});
	});

	describe("permission scoping", () => {
		it("searches only what the caller may see", async () => {
			await call({ q: "acme" }, user("dispatcher", ["view_clients"]));
			expect([...(typesSearched() ?? [])].sort()).toEqual(["client", "contact"]);
		});

		it("narrows, never widens, when ?types is supplied", async () => {
			// Asking for invoices without view_invoices must not produce invoices.
			await call({ q: "acme", types: "invoice,client" }, user("dispatcher", ["view_clients"]));
			expect(typesSearched()).toEqual(["client"]);
		});

		it("gives an admin every type", async () => {
			await call({ q: "acme" }, user("admin", []));
			expect(typesSearched()).toHaveLength(10);
		});

		it("returns an empty result rather than a 403 when nothing is visible", async () => {
			// Deliberately not a blanket 403: a technician with only view_assigned_jobs
			// should get jobs, and someone with nothing should get an empty list they
			// can act on rather than an error they cannot.
			const r = await call({ q: "acme" }, user("technician", []));
			expect(r.status).toBe(200);
			expect(r.body.data.hits).toEqual([]);
			expect(searchRecords).not.toHaveBeenCalled();
		});

		it("gives a technician with view_assigned_jobs the job and visit types only", async () => {
			await call({ q: "acme" }, user("technician", ["view_assigned_jobs"]));
			expect([...(typesSearched() ?? [])].sort()).toEqual(["job", "visit"]);
		});
	});

	it("scopes the search to the caller's organization", async () => {
		await call({ q: "acme" });
		expect(searchRecords.mock.calls[0][0]).toBe("org-1");
	});
});
