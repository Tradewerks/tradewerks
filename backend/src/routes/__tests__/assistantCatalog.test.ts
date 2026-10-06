import { describe, expect, it, vi } from "vitest";

vi.mock("../../services/lowStockAlerts.js", () => ({
	fireLowStockAlerts: vi.fn().mockResolvedValue(undefined),
	sendLowStockAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
	generateJobNumber: vi.fn(),
	generateQuoteNumber: vi.fn(),
	generateInvoiceNumber: vi.fn(),
	generateProjectNumber: vi.fn(),
	SECRET_FIELD_OMIT: {},
}));

vi.mock("../../assistant/config.js", async (orig) => ({
	...(await orig<typeof import("../../assistant/config.js")>()),
	isAssistantEnabled: () => true,
}));
const consume = vi.hoisted(() => vi.fn());
vi.mock("../../lib/entitlements/quota.js", () => ({ consumeQuota: consume }));

// Imported for its side effects, exactly as the Express app does.
import "../assistant.js";
import assistantRouter from "../assistant.js";
import { describeTools, listTools } from "../../agent/registry.js";
import { AGENT_PERMISSION_CEILING } from "../../agent/policy.js";
import { callRoute } from "./harness.js";

/**
 * Regression: the assistant shipped non-functional because tools register by
 * side-effect import and nothing in the HTTP process performed it. Every unit
 * test passed — they each import `agent/index.js` directly — while the running
 * server saw an empty catalog, reported `enabled: false`, and the panel hid
 * itself. The symptom is indistinguishable from "this user has no permissions",
 * which is why it survived review.
 */
describe("the assistant routes populate the tool catalog", () => {
	it("registers tools merely by importing the router", () => {
		expect(listTools().length).toBeGreaterThan(0);
	});

	it("offers a real dispatcher a usable set of tools", () => {
		const tools = describeTools({
			permissions: [...AGENT_PERMISSION_CEILING],
			allowWrites: true,
			allowDestructive: false,
		});
		expect(tools.length).toBeGreaterThan(0);
		expect(tools.map((t) => t.name)).toContain("get_schedule");
	});
});

describe("POST /assistant/stream â€” monthly meter (build plan 2)", () => {
	it("returns 429 QUOTA_EXCEEDED when the month's limit is used up", async () => {
		consume.mockResolvedValue({ allowed: false, used: 500, limit: 500 });
		const r = await callRoute(assistantRouter, "post", "/stream", {
			user: { uid: "disp-1", role: "admin", organization_id: "org-1", permissions: null },
			body: { message: "hello" },
		});
		expect(consume).toHaveBeenCalledWith("org-1", "ai_calls_month");
		expect(r.status).toBe(429);
		expect(r.body.error).toEqual({
			code: "QUOTA_EXCEEDED",
			message: "Monthly AI assistant limit reached. It resets on the 1st (UTC).",
		});
	});
});
