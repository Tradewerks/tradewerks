import { describe, expect, it } from "vitest";
import { vi } from "vitest";

// The write tools reach the visit/job controllers, which transitively import
// lowStockAlerts -> emailService — and emailService throws at import when no
// Postmark env is set. Mocked out the way the vehicle suites already do it.
vi.mock("../../services/lowStockAlerts.js", () => ({
	fireLowStockAlerts: vi.fn().mockResolvedValue(undefined),
	sendLowStockAlert: vi.fn().mockResolvedValue(undefined),
}));

// The catalog imports every tool, which transitively pulls in controllers that
// reach for the Prisma client at module load. The route harness's fake covers
// that without a database.
vi.mock("../../db.js", async () => ({
	db: (await import("../../routes/__tests__/harness.js")).createFakeDb(),
	generateJobNumber: vi.fn(),
	generateQuoteNumber: vi.fn(),
	generateInvoiceNumber: vi.fn(),
	generateProjectNumber: vi.fn(),
	SECRET_FIELD_OMIT: {},
}));

import "../index.js";
import { AGENT_PERMISSION_CEILING } from "../policy.js";
import { toolRequiresApproval } from "../execute.js";
import { describeTools, listTools } from "../registry.js";
import { toolInputSchema } from "../schema.js";

/** The whole catalog. A tool added without a line here fails this test on purpose. */
const EXPECTED = [
	// reads
	"search_records",
	"get_record",
	"list_records",
	"get_schedule",
	"get_technician_availability",
	"get_arrival_status",
	"get_on_time_performance",
	"get_inventory_levels",
	"run_report",
	"get_entity_history",
	// writes
	"propose_draft",
	"schedule_visit",
	"reschedule_visit",
	"assign_technician",
	"update_job_status",
	"add_job_note",
].sort();

/** Writes that change live state and must never run unattended. */
const MUST_REQUIRE_APPROVAL = ["schedule_visit", "reschedule_visit", "assign_technician", "update_job_status"];

describe("Phase 1 tool catalog", () => {
	it("registers exactly the expected tools", () => {
		expect(listTools().map((t) => t.name).sort()).toEqual(EXPECTED);
	});

	it("ships nothing destructive", () => {
		// Deletes, client emails and invoice issuance are not things this system
		// lets an agent do, whoever is asking.
		expect(listTools().every((t) => t.risk !== "destructive")).toBe(true);
	});

	it.each(MUST_REQUIRE_APPROVAL)("gates %s behind human approval", (name) => {
		const tool = listTools().find((t) => t.name === name);
		expect(tool, `${name} is not registered`).toBeDefined();
		expect(toolRequiresApproval(tool!)).toBe(true);
	});

	it("never gates a read behind approval", () => {
		// An approval prompt for a lookup would train people to click through them.
		for (const tool of listTools().filter((t) => t.risk === "read")) {
			expect(toolRequiresApproval(tool), tool.name).toBe(false);
		}
	});

	it("requires an audit descriptor on every write", () => {
		for (const tool of listTools().filter((t) => t.risk !== "read")) {
			expect(tool.audit, tool.name).toBeTypeOf("function");
		}
	});

	it("only requires permissions the ceiling can actually grant", () => {
		// A tool gated on a permission outside AGENT_PERMISSION_CEILING is
		// unreachable by construction: resolveAgentPermissions can never produce
		// it, so every call would 403. Catch that here rather than in production.
		for (const tool of listTools()) {
			for (const permission of tool.permissions) {
				expect(
					AGENT_PERMISSION_CEILING.has(permission),
					`${tool.name} requires "${permission}", which the ceiling never grants`,
				).toBe(true);
			}
		}
	});

	it("gives every tool a usable JSON Schema", () => {
		for (const tool of listTools()) {
			const schema = toolInputSchema(tool.input);
			expect(schema.type, tool.name).toBe("object");
			expect(schema, tool.name).not.toHaveProperty("$schema");
		}
	});

	it("advertises the parameters each tool actually takes", () => {
		// `type: "object"` alone is not enough — an empty properties map satisfies
		// it while telling the model the tool takes nothing, which is precisely how
		// propose_draft shipped broken. Every tool here has required inputs.
		for (const tool of listTools()) {
			const schema = toolInputSchema(tool.input);
			expect(Object.keys(schema.properties as object).length, `${tool.name} advertises no parameters`).
				toBeGreaterThan(0);
		}
	});

	it("lets a model see how to fill in propose_draft", () => {
		const schema = toolInputSchema(listTools().find((t) => t.name === "propose_draft")!.input);
		const props = schema.properties as Record<string, Record<string, unknown>>;
		expect(props.form_type.enum).toContain("quote");
		expect((props.payload.anyOf as unknown[]).length).toBe(5);
	});

	it("describes every tool for the model in more than a few words", () => {
		for (const tool of listTools()) {
			expect(tool.description.length, tool.name).toBeGreaterThan(60);
			expect(tool.title.length, tool.name).toBeGreaterThan(0);
		}
	});

	it("hides every write tool under the read-only policy", () => {
		const names = describeTools({
			permissions: [...AGENT_PERMISSION_CEILING],
			allowWrites: false,
			allowDestructive: false,
		}).map((t) => t.name);

		for (const write of ["propose_draft", ...MUST_REQUIRE_APPROVAL, "add_job_note"]) {
			expect(names, `${write} must not be advertised read-only`).not.toContain(write);
		}
	});

	it("advertises writes to a caller holding the permission under a write policy", () => {
		const names = describeTools({
			permissions: [...AGENT_PERMISSION_CEILING],
			allowWrites: true,
			allowDestructive: false,
		}).map((t) => t.name);

		expect(names).toContain("propose_draft");
		expect(names).toContain("reschedule_visit");
	});

	it("shows a dispatcher only the tools their permissions reach", () => {
		const names = describeTools({
			permissions: ["view_inventory"],
			allowWrites: false,
			allowDestructive: false,
		}).map((t) => t.name);

		expect(names).toContain("get_inventory_levels");
		expect(names).toContain("search_records");
		// search_records and the record tools accept view_inventory as one of their
		// ANY-OF permissions; reports and scheduling do not.
		expect(names).not.toContain("run_report");
		expect(names).not.toContain("get_schedule");
		expect(names).not.toContain("get_technician_availability");
	});

	it("shows a caller with no permissions nothing at all", () => {
		expect(describeTools({ permissions: [], allowWrites: false, allowDestructive: false })).toEqual([]);
	});
});
