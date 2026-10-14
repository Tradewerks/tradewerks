import { describe, expect, it, vi } from "vitest";

// The write tools reach the visit/job controllers, which transitively import
// lowStockAlerts -> emailService — and emailService throws at import when no
// Postmark env is set.
vi.mock("../../services/lowStockAlerts.js", () => ({
	fireLowStockAlerts: vi.fn().mockResolvedValue(undefined),
	sendLowStockAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../db.js", async () => ({
	db: (await import("../../routes/__tests__/harness.js")).createFakeDb(),
	generateJobNumber: vi.fn(),
}));

import "../../agent/index.js";
import { READ_ONLY_POLICY, WRITE_POLICY } from "../../agent/policy.js";
import type { AgentContext } from "../../agent/types.js";
import { describeToolCall, parseToolArguments, summariseToolResult, toolsForOpenAI } from "../toolBridge.js";

const ctxWith = (...permissions: string[]): AgentContext => ({
	userId: "u",
	role: "dispatcher",
	organizationId: "org-1",
	permissions,
	actorType: "dispatcher",
	surface: "assistant",
});

describe("toolsForOpenAI", () => {
	it("renders the registry in the Responses API's flat function shape", () => {
		const tools = toolsForOpenAI(ctxWith("view_jobs"), READ_ONLY_POLICY);
		expect(tools.length).toBeGreaterThan(0);
		for (const tool of tools) {
			expect(tool.type).toBe("function");
			expect(typeof tool.name).toBe("string");
			expect(tool.parameters).toMatchObject({ type: "object" });
		}
	});

	it("leaves strict mode off", () => {
		// The Zod-derived schemas do not satisfy strict mode's requirements, and
		// loosening them would advertise a contract the server does not enforce.
		for (const tool of toolsForOpenAI(ctxWith("view_jobs"), READ_ONLY_POLICY)) {
			expect(tool.strict).toBe(false);
		}
	});

	it("advertises only what the caller may call", () => {
		const names = toolsForOpenAI(ctxWith("view_inventory"), READ_ONLY_POLICY).map((t) => t.name);
		expect(names).toContain("get_inventory_levels");
		expect(names).not.toContain("run_report");
	});

	it("advertises nothing to a caller with no permissions", () => {
		expect(toolsForOpenAI(ctxWith(), READ_ONLY_POLICY)).toEqual([]);
	});

	it("hides write tools under the read-only policy", () => {
		const names = toolsForOpenAI(ctxWith("view_jobs", "edit_jobs", "create_jobs"), READ_ONLY_POLICY).map(
			(t) => t.name,
		);
		expect(names).toContain("get_schedule");
		expect(names).not.toContain("reschedule_visit");
		expect(names).not.toContain("propose_draft");
	});

	it("advertises write tools under a write policy", () => {
		const names = toolsForOpenAI(ctxWith("view_jobs", "edit_jobs", "create_quotes"), WRITE_POLICY).map(
			(t) => t.name,
		);
		expect(names).toContain("reschedule_visit");
		expect(names).toContain("propose_draft");
	});
});

describe("parseToolArguments", () => {
	it("parses well-formed JSON", () => {
		expect(parseToolArguments('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
	});

	it("treats an empty string as no arguments", () => {
		// Models emit "" for a zero-argument tool rather than "{}".
		expect(parseToolArguments("   ")).toEqual({ ok: true, value: {} });
	});

	it("reports malformed JSON instead of throwing", () => {
		// A truncated turn must be recoverable: the model gets told, and retries.
		const result = parseToolArguments('{"a":');
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.message).toContain("not valid JSON");
	});
});

describe("summariseToolResult", () => {
	it.each([
		["search_records", { query: "acme" }, { hits: [1, 2] }, "2 matches"],
		["search_records", { query: "acme" }, { hits: [1] }, "1 match"],
		["list_records", { type: "job" }, { returned: 5, total: 40 }, "Listed 5 of 40 jobs"],
		["get_schedule", {}, { total_visits: 3, unassigned: [1] }, "3 visits, 1 unassigned"],
		["get_technician_availability", {}, { technicians: [1, 2, 3] }, "3 technicians"],
		["get_inventory_levels", {}, { items: [1] }, "1 item"],
		["run_report", {}, { report: "jobs" }, "jobs report"],
		["get_entity_history", {}, { entries: [1, 2] }, "2 history entries"],
		["get_record", { type: "job" }, { found: false }, "not found"],
		["get_record", {}, { type: "job", job_number: "J-1042" }, "Opened job J-1042"],
		[
			"propose_draft",
			{},
			{ status: "saved_as_draft", form_type: "request", label: "Pipe replacement" },
			"Drafted a request — “Pipe replacement”",
		],
	])("summarises %s for a person", (tool, input, data, expected) => {
		expect(summariseToolResult(tool, input, data)).toContain(expected);
	});

	// A write returns ids and a status — too thin a shape to recognise, and the
	// one card in the thread reporting something that actually changed. Left to
	// the shape checks these all read "Ran <tool_name>".
	it.each([
		[
			"schedule_visit",
			{ name: "Follow-up AC check" },
			{ scheduled_start_at: "2026-09-11T15:00:00.000Z", assigned: 1 },
			"Scheduled “Follow-up AC check” for 2026-09-11 15:00 — 1 technician",
		],
		["schedule_visit", { name: "Site survey" }, { assigned: 0 }, "Scheduled “Site survey” — nobody assigned yet"],
		["reschedule_visit", {}, { scheduled_start_at: "2026-09-13T15:00:00.000Z" }, "Moved the visit to 2026-09-13 15:00"],
		["reschedule_visit", {}, { name: "Renamed only" }, "Changed the visit's timing"],
		// Handlers return what Prisma gave them, which is a Date, not a string.
		[
			"reschedule_visit",
			{},
			{ scheduled_start_at: new Date("2026-09-13T15:00:00.000Z") },
			"Moved the visit to 2026-09-13 15:00",
		],
		[
			"schedule_visit",
			{ name: "Follow-up AC check" },
			{ scheduled_start_at: new Date("2026-09-11T15:00:00.000Z"), assigned: 2 },
			"Scheduled “Follow-up AC check” for 2026-09-11 15:00 — 2 technicians",
		],
		["assign_technician", {}, { assigned: 2 }, "Assigned 2 technicians to the visit"],
		["assign_technician", {}, { assigned: 0 }, "Cleared every technician from the visit"],
		["update_job_status", {}, { job_number: "J-0013", status: "InProgress" }, "Set job J-0013 to InProgress"],
		["add_job_note", { content: "Gate code is 4821." }, { id: "n1" }, "Added a note — “Gate code is 4821.”"],
	])("summarises the %s write by what it changed", (tool, input, data, expected) => {
		expect(summariseToolResult(tool, input, data)).toBe(expected);
	});

	it("truncates a long note rather than spilling it into the card", () => {
		const content = "The tenant asked us to call ahead because the loading dock is shared with the bakery next door";
		const summary = summariseToolResult("add_job_note", { content }, { id: "n1" });
		expect(summary).toBe("Added a note — “The tenant asked us to call ahead because the loading dock i…”");
	});

	it("says a draft still needs review, so nobody reads it as created", () => {
		expect(
			summariseToolResult("propose_draft", {}, { status: "saved_as_draft", form_type: "quote", label: "X" }),
		).toContain("needs review before it exists");
	});

	it("falls back to the tool name for an unrecognised shape", () => {
		expect(summariseToolResult("something_new", {}, { odd: true })).toBe("Ran something_new");
	});

	it("survives a null result", () => {
		expect(summariseToolResult("get_record", {}, null)).toBe("Ran get_record");
	});
});

describe("describeToolCall", () => {
	// This is the sentence a dispatcher approves on, so it has to say what will
	// change rather than restate the arguments.
	it("says what scheduling a visit will do, including that nobody is assigned", () => {
		expect(
			describeToolCall("schedule_visit", {
				name: "Spring maintenance",
				scheduled_start_at: "2026-08-25T14:00:00Z",
				tech_ids: [],
			}),
		).toBe("Schedule “Spring maintenance” for 2026-08-25 14:00 — no technician assigned");
	});

	it("counts assigned technicians", () => {
		expect(
			describeToolCall("schedule_visit", {
				name: "Repair",
				scheduled_start_at: "2026-08-25T14:00:00Z",
				tech_ids: ["a", "b"],
			}),
		).toContain("2 technicians");
	});

	it("names the new time when rescheduling", () => {
		expect(describeToolCall("reschedule_visit", { scheduled_start_at: "2026-09-01T09:30:00Z" })).toBe(
			"Move this visit to 2026-09-01 09:30",
		);
	});

	it("describes a timing-only change when no new start is given", () => {
		expect(describeToolCall("reschedule_visit", { name: "renamed" })).toBe("Change this visit's timing");
	});

	it("warns that assigning replaces the current technicians", () => {
		expect(describeToolCall("assign_technician", { tech_ids: ["a"] })).toContain("replacing whoever is on it now");
	});

	it("calls an empty assignment what it is", () => {
		expect(describeToolCall("assign_technician", { tech_ids: [] })).toBe(
			"Remove every technician from this visit",
		);
	});

	it("surfaces the reason when cancelling a job", () => {
		expect(
			describeToolCall("update_job_status", { status: "Cancelled", cancellation_reason: "client rescheduled" }),
		).toBe("Cancel this job — client rescheduled");
	});

	it("falls back to the tool name rather than guessing", () => {
		expect(describeToolCall("something_new", {})).toBe("Run something new");
	});

	it("ignores an unparseable date instead of printing Invalid Date", () => {
		expect(describeToolCall("reschedule_visit", { scheduled_start_at: "next tuesday" })).toBe(
			"Change this visit's timing",
		);
	});
});
