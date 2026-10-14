import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineTool, describeTools, getTool, listTools } from "../registry.js";

const noop = async () => ({});

const base = {
	title: "Test",
	description: "A tool used only by tests.",
	risk: "read" as const,
	permissions: ["view_jobs"],
	input: z.object({}),
	handler: noop,
};

describe("tool registry", () => {
	it("registers and returns a tool", () => {
		defineTool({ ...base, name: "reg_ok" });
		expect(getTool("reg_ok")?.name).toBe("reg_ok");
		expect(listTools().map((t) => t.name)).toContain("reg_ok");
	});

	it("refuses a tool that declares no permissions", () => {
		// An unguarded tool is how an agent ends up doing something nobody
		// authorised, so this must fail at boot rather than at call time.
		expect(() => defineTool({ ...base, name: "reg_unguarded", permissions: [] })).toThrow(/no permissions/);
		expect(getTool("reg_unguarded")).toBeUndefined();
	});

	it("refuses a duplicate name", () => {
		defineTool({ ...base, name: "reg_dupe" });
		expect(() => defineTool({ ...base, name: "reg_dupe" })).toThrow(/Duplicate/);
	});

	it.each(["Bad_Name", "x", "has spaces", "trailing-"])("refuses the malformed name %o", (name) => {
		expect(() => defineTool({ ...base, name })).toThrow(/Invalid tool name/);
	});

	it("refuses a write or destructive tool with no audit descriptor", () => {
		expect(() => defineTool({ ...base, name: "reg_write", risk: "write" })).toThrow(/audit descriptor/);
		expect(() => defineTool({ ...base, name: "reg_destroy", risk: "destructive" })).toThrow(/audit descriptor/);
	});

	it("refuses a destructive tool that opts out of approval", () => {
		// An irreversible action that skips approval is not a configuration this
		// system offers, whatever the reason seemed to be at the time.
		expect(() =>
			defineTool({
				...base,
				name: "reg_destroy_ungated",
				risk: "destructive",
				requiresApproval: false,
				audit: () => ({ event_type: "e", action: "a", entity_type: "t", entity_id: "i" }),
			}),
		).toThrow(/cannot opt out of approval/);
	});

	it("accepts a write tool that declares one", () => {
		expect(() =>
			defineTool({
				...base,
				name: "reg_write_ok",
				risk: "write",
				audit: () => ({
					event_type: "job.created",
					action: "created",
					entity_type: "job",
					entity_id: "x",
				}),
			}),
		).not.toThrow();
	});

	describe("describeTools", () => {
		it("hides tools the caller has no permission for", () => {
			defineTool({ ...base, name: "desc_jobs", permissions: ["view_jobs"] });
			defineTool({ ...base, name: "desc_money", permissions: ["view_invoices"] });

			const names = describeTools({
				permissions: ["view_jobs"],
				allowWrites: false,
				allowDestructive: false,
			}).map((t) => t.name);

			expect(names).toContain("desc_jobs");
			expect(names).not.toContain("desc_money");
		});

		it("hides write tools when the policy forbids writes", () => {
			defineTool({
				...base,
				name: "desc_write",
				risk: "write",
				audit: () => ({ event_type: "e", action: "a", entity_type: "t", entity_id: "i" }),
			});

			const readOnly = describeTools({ permissions: ["view_jobs"], allowWrites: false, allowDestructive: false });
			expect(readOnly.map((t) => t.name)).not.toContain("desc_write");

			const writable = describeTools({ permissions: ["view_jobs"], allowWrites: true, allowDestructive: false });
			expect(writable.map((t) => t.name)).toContain("desc_write");
		});

		it("emits an object JSON Schema for every advertised tool", () => {
			defineTool({
				...base,
				name: "desc_schema",
				input: z.object({ id: z.string().uuid(), limit: z.number().int().default(10) }),
			});
			const described = describeTools({
				permissions: ["view_jobs"],
				allowWrites: false,
				allowDestructive: false,
			}).find((t) => t.name === "desc_schema");

			expect(described?.inputSchema).toMatchObject({
				type: "object",
				properties: { id: { type: "string", format: "uuid" }, limit: { type: "integer" } },
				required: ["id"],
			});
			// The uuid regex is stripped — it is pure token cost on every request.
			expect(JSON.stringify(described?.inputSchema)).not.toContain("pattern");
		});
	});
});
