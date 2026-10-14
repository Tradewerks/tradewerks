import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { executeTool } = vi.hoisted(() => ({ executeTool: vi.fn() }));

vi.mock("../../agent/execute.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../agent/execute.js")>()),
	executeTool,
}));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => ({})) }));
vi.mock("../../services/logger.js", () => ({ logActivity: vi.fn() }));
vi.mock("../../services/appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { READ_ONLY_POLICY, WRITE_POLICY } from "../../agent/policy.js";
import { defineTool } from "../../agent/registry.js";
import type { AgentContext } from "../../agent/types.js";
import { createMcpServer, MCP_SERVER_INFO, policyFromEnv, visibleTools } from "../server.js";

const ctxWith = (...permissions: string[]): AgentContext => ({
	userId: "u1",
	role: "dispatcher",
	organizationId: "org-1",
	permissions,
	actorType: "dispatcher",
	surface: "mcp",
	userName: "Dana Reyes",
});

const auditDescriptor = () => ({
	event_type: "job.updated",
	action: "updated",
	entity_type: "job",
	entity_id: "j1",
});

defineTool({
	name: "mcp_read",
	title: "Read something",
	description: "A read tool used by the MCP adapter tests.",
	risk: "read",
	permissions: ["view_jobs"],
	input: z.object({ id: z.string().uuid() }),
	handler: async () => ({ ok: true }),
});

defineTool({
	name: "mcp_write",
	title: "Write something",
	description: "A write tool used by the MCP adapter tests.",
	risk: "write",
	requiresApproval: true,
	permissions: ["edit_jobs"],
	input: z.object({}),
	handler: async () => ({ ok: true }),
	audit: auditDescriptor,
});

/** A connected client/server pair over the SDK's in-memory transport. */
async function connect(options: Parameters<typeof createMcpServer>[0]) {
	const server = createMcpServer(options);
	const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, server };
}

describe("policyFromEnv", () => {
	const original = { ...process.env };
	afterEach(() => {
		process.env = { ...original };
	});

	it("is read-only unless writes are explicitly enabled", () => {
		delete process.env.MCP_WRITES_ENABLED;
		expect(policyFromEnv()).toEqual({ policy: READ_ONLY_POLICY, allowGatedWrites: false });
	});

	it("enables writes when asked", () => {
		process.env.MCP_WRITES_ENABLED = "true";
		expect(policyFromEnv().policy).toBe(WRITE_POLICY);
	});

	it("keeps gated writes off even when writes are on", () => {
		// Two switches, because "may propose a draft" and "may move a visit
		// without this server seeing an approval" are different amounts of trust.
		process.env.MCP_WRITES_ENABLED = "true";
		delete process.env.MCP_ALLOW_GATED_WRITES;
		expect(policyFromEnv().allowGatedWrites).toBe(false);
	});

	it("cannot enable gated writes without enabling writes", () => {
		delete process.env.MCP_WRITES_ENABLED;
		process.env.MCP_ALLOW_GATED_WRITES = "true";
		expect(policyFromEnv()).toEqual({ policy: READ_ONLY_POLICY, allowGatedWrites: false });
	});

	it.each(["false", "1", "yes", ""])("treats %o as not enabled", (value) => {
		process.env.MCP_WRITES_ENABLED = value;
		expect(policyFromEnv().policy).toBe(READ_ONLY_POLICY);
	});
});

describe("visibleTools", () => {
	it("advertises only what the caller's permissions and policy allow", () => {
		const names = visibleTools({
			ctx: ctxWith("view_jobs", "edit_jobs"),
			policy: READ_ONLY_POLICY,
			allowGatedWrites: false,
		}).map((t) => t.name);
		expect(names).toContain("mcp_read");
		expect(names).not.toContain("mcp_write");
	});
});

describe("MCP server over a real transport", () => {
	beforeEach(() => executeTool.mockReset());

	it("reports its identity in the handshake", async () => {
		const { client } = await connect({
			ctx: ctxWith("view_jobs"),
			policy: READ_ONLY_POLICY,
			allowGatedWrites: false,
		});
		expect(client.getServerVersion()).toMatchObject({ name: MCP_SERVER_INFO.name });
	});

	describe("tools/list", () => {
		it("returns the catalog with schemas and annotations", async () => {
			const { client } = await connect({
				ctx: ctxWith("view_jobs"),
				policy: READ_ONLY_POLICY,
				allowGatedWrites: false,
			});
			const { tools } = await client.listTools();
			const read = tools.find((t) => t.name === "mcp_read");

			expect(read).toMatchObject({
				title: "Read something",
				inputSchema: { type: "object", properties: { id: { type: "string", format: "uuid" } } },
				annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			});
		});

		it("marks a write tool as neither read-only nor idempotent", async () => {
			const { client } = await connect({
				ctx: ctxWith("edit_jobs"),
				policy: WRITE_POLICY,
				allowGatedWrites: false,
			});
			const { tools } = await client.listTools();
			expect(tools.find((t) => t.name === "mcp_write")?.annotations).toMatchObject({
				readOnlyHint: false,
				idempotentHint: false,
			});
		});

		it("shows nothing to a caller whose permissions reach nothing", async () => {
			const { client } = await connect({ ctx: ctxWith(), policy: READ_ONLY_POLICY, allowGatedWrites: false });
			await expect(client.listTools()).resolves.toMatchObject({ tools: [] });
		});
	});

	describe("tools/call", () => {
		it("returns the tool's data as text and structured content", async () => {
			executeTool.mockResolvedValue({ ok: true, data: { job_number: "J-1042" } });
			const { client } = await connect({
				ctx: ctxWith("view_jobs"),
				policy: READ_ONLY_POLICY,
				allowGatedWrites: false,
			});

			const result = await client.callTool({ name: "mcp_read", arguments: { id: "x" } });

			expect(result.isError).toBeFalsy();
			expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({ job_number: "J-1042" });
			expect(result.structuredContent).toEqual({ job_number: "J-1042" });
		});

		it("wraps a non-object result so structuredContent stays an object", async () => {
			executeTool.mockResolvedValue({ ok: true, data: [1, 2, 3] });
			const { client } = await connect({
				ctx: ctxWith("view_jobs"),
				policy: READ_ONLY_POLICY,
				allowGatedWrites: false,
			});
			const result = await client.callTool({ name: "mcp_read", arguments: {} });
			expect(result.structuredContent).toEqual({ result: [1, 2, 3] });
		});

		it("reports a tool failure as isError rather than a protocol error", async () => {
			// The protocol distinguishes "the tool ran and failed" from "the server
			// broke", and a model can act on the first.
			executeTool.mockResolvedValue({
				ok: false,
				error: { code: "NOT_FOUND", message: "No such job" },
			});
			const { client } = await connect({
				ctx: ctxWith("view_jobs"),
				policy: READ_ONLY_POLICY,
				allowGatedWrites: false,
			});

			const result = await client.callTool({ name: "mcp_read", arguments: {} });

			expect(result.isError).toBe(true);
			expect((result.content as { text: string }[])[0].text).toContain("NOT_FOUND: No such job");
		});

		it("includes validation detail so the model can correct itself", async () => {
			executeTool.mockResolvedValue({
				ok: false,
				error: { code: "VALIDATION_ERROR", message: "bad", details: [{ path: ["id"] }] },
			});
			const { client } = await connect({
				ctx: ctxWith("view_jobs"),
				policy: READ_ONLY_POLICY,
				allowGatedWrites: false,
			});
			const result = await client.callTool({ name: "mcp_read", arguments: {} });
			expect((result.content as { text: string }[])[0].text).toContain('"id"');
		});

		it("passes the session's context and policy through unchanged", async () => {
			executeTool.mockResolvedValue({ ok: true, data: {} });
			const ctx = ctxWith("view_jobs");
			const { client } = await connect({ ctx, policy: READ_ONLY_POLICY, allowGatedWrites: false });

			await client.callTool({ name: "mcp_read", arguments: { id: "x" } });

			expect(executeTool.mock.calls[0][2]).toBe(ctx);
			expect(executeTool.mock.calls[0][3]).toBe(READ_ONLY_POLICY);
		});

		it.each([
			[false, "withholds approval by default"],
			[true, "passes approval when the operator opted in"],
		])("approved=%s — %s", async (allowGatedWrites) => {
			executeTool.mockResolvedValue({ ok: true, data: {} });
			const { client } = await connect({
				ctx: ctxWith("edit_jobs"),
				policy: WRITE_POLICY,
				allowGatedWrites,
			});

			await client.callTool({ name: "mcp_write", arguments: {} });

			expect(executeTool.mock.calls[0][4]).toEqual({ approved: allowGatedWrites });
		});
	});
});
