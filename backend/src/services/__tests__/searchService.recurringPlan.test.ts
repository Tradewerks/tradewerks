import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, namesWithModuleOn } = vi.hoisted(() => ({
	findMany: vi.fn(async (_args: unknown) => [
		{
			id: "p1",
			name: "Quarterly tune-up",
			address: "1 Main St",
			status: "Active",
			client: { name: "Acme" },
		},
	]),
	namesWithModuleOn: vi.fn(async (_org: string, names: readonly string[]) => [...names]),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: () => ({ recurring_plan: { findMany } }),
}));
vi.mock("../../lib/entitlements/ownership.js", () => ({
	ENTITY_MODULE: { recurring_plan: "recurring_plans" },
	namesWithModuleOn,
}));

import { allowedSearchTypes, searchRecords } from "../searchService.js";

describe("recurring_plan search type", () => {
	beforeEach(() => {
		findMany.mockClear();
		namesWithModuleOn.mockClear();
	});

	it("is gated on view_recurring_plans", () => {
		expect(allowedSearchTypes(["view_recurring_plans"])).toEqual(["recurring_plan"]);
		expect(allowedSearchTypes(["view_clients"])).not.toContain("recurring_plan");
	});

	it("is filtered through the recurring_plans module check", async () => {
		await searchRecords("org-1", { query: "tune", types: ["recurring_plan"] });
		expect(namesWithModuleOn).toHaveBeenCalledWith(
			"org-1",
			["recurring_plan"],
			expect.objectContaining({ recurring_plan: "recurring_plans" }),
		);
	});

	it("returns plan hits that deep-link to the plan page", async () => {
		const out = await searchRecords("org-1", { query: "tune", types: ["recurring_plan"] });
		expect(out.hits).toEqual([
			{
				id: "p1",
				type: "recurring_plan",
				label: "Quarterly tune-up",
				sublabel: "Acme · 1 Main St",
				status: "Active",
				route: "/dispatch/recurring-plans/p1",
			},
		]);
	});
});
