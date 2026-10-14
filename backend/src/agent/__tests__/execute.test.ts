import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// vi.mock factories are hoisted above every other statement in the file, so the
// doubles they close over have to be created inside vi.hoisted().
const { scopedDb, getScopedDb, logActivity } = vi.hoisted(() => {
	const scoped = { marker: "scoped" };
	return {
		scopedDb: scoped,
		getScopedDb: vi.fn(() => scoped),
		// Typed parameters so `mock.calls[n][m]` is indexable — an untyped vi.fn()
		// infers a zero-length tuple and every call assertion becomes a type error.
		logActivity: vi.fn(async (_params: Record<string, unknown>) => undefined),
	};
});

vi.mock("../../lib/context.js", () => ({ getScopedDb }));
vi.mock("../../services/logger.js", () => ({ logActivity }));
vi.mock("../../services/appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { Prisma } from "../../../generated/prisma/client.js";
import { InvalidTransitionError } from "../../lib/statusTransitions.js";
import { executeTool } from "../execute.js";
import { defineTool } from "../registry.js";
import { AgentErrorCodes, AgentToolError, type AgentContext, type AgentPolicy } from "../types.js";

const ctx: AgentContext = {
	userId: "user-1",
	role: "dispatcher",
	organizationId: "org-1",
	permissions: ["view_jobs"],
	actorType: "dispatcher",
	surface: "assistant",
	userName: "Dana Reyes",
};

const READ_ONLY: AgentPolicy = { allowWrites: false, allowDestructive: false, ceiling: new Set(["view_jobs"]) };
const FULL: AgentPolicy = { allowWrites: true, allowDestructive: true, ceiling: new Set(["view_jobs", "edit_jobs"]) };

const auditDescriptor = () => ({
	event_type: "job.updated",
	action: "updated",
	entity_type: "job",
	entity_id: "job-1",
});

const handler = vi.fn(async (_args: { input: unknown; ctx: AgentContext; db: unknown }) => ({ done: true }));

defineTool({
	name: "exec_read",
	title: "Read",
	description: "d",
	risk: "read",
	permissions: ["view_jobs"],
	input: z.object({ id: z.string().uuid() }),
	handler,
});

defineTool({
	name: "exec_write",
	title: "Write",
	description: "d",
	risk: "write",
	permissions: ["edit_jobs"],
	input: z.object({}),
	handler,
	audit: auditDescriptor,
	invalidates: () => ["jobs", "job:job-1"],
});

defineTool({
	name: "exec_gated_write",
	title: "Gated write",
	description: "d",
	risk: "write",
	requiresApproval: true,
	permissions: ["edit_jobs"],
	input: z.object({}),
	handler,
	audit: auditDescriptor,
});

defineTool({
	name: "exec_destructive",
	title: "Destroy",
	description: "d",
	risk: "destructive",
	permissions: ["edit_jobs"],
	input: z.object({}),
	handler,
	audit: auditDescriptor,
});

const throwing = (err: unknown) =>
	defineTool({
		name: `exec_throw_${Math.random().toString(36).slice(2, 8)}`,
		title: "Throws",
		description: "d",
		risk: "read",
		permissions: ["view_jobs"],
		input: z.object({}),
		handler: async () => {
			throw err;
		},
	}).name;

const VALID_ID = "11111111-1111-4111-8111-111111111111";

describe("executeTool — the gate", () => {
	beforeEach(() => {
		handler.mockClear();
		logActivity.mockClear();
		getScopedDb.mockClear();
	});

	it("rejects an unknown tool", async () => {
		const r = await executeTool("does_not_exist", {}, ctx, READ_ONLY);
		expect(r).toEqual({ ok: false, error: { code: AgentErrorCodes.UNKNOWN_TOOL, message: expect.any(String) } });
	});

	it("runs a permitted read and returns its data", async () => {
		const r = await executeTool("exec_read", { id: VALID_ID }, ctx, READ_ONLY);
		expect(r).toEqual({ ok: true, data: { done: true } });
		expect(handler).toHaveBeenCalledOnce();
	});

	it("hands the handler an org-scoped client and nothing else", async () => {
		await executeTool("exec_read", { id: VALID_ID }, ctx, READ_ONLY);
		expect(getScopedDb).toHaveBeenCalledWith("org-1");
		const args = handler.mock.calls[0][0];
		expect(args.db).toBe(scopedDb);
		expect(args.ctx).toBe(ctx);
	});

	describe("policy", () => {
		it("denies a write when the policy forbids writes", async () => {
			const r = await executeTool("exec_write", {}, { ...ctx, permissions: ["edit_jobs"] }, READ_ONLY);
			expect(r).toMatchObject({ ok: false, error: { code: AgentErrorCodes.POLICY_DENIED } });
			expect(handler).not.toHaveBeenCalled();
		});

		it("denies a destructive call when the policy forbids destruction", async () => {
			const r = await executeTool("exec_destructive", {}, { ...ctx, permissions: ["edit_jobs"] }, {
				allowWrites: true,
				allowDestructive: false,
				ceiling: new Set(["edit_jobs"]),
			});
			expect(r).toMatchObject({ ok: false, error: { code: AgentErrorCodes.POLICY_DENIED } });
		});

		it("requires explicit approval for a destructive call even when policy allows it", async () => {
			const r = await executeTool("exec_destructive", {}, { ...ctx, permissions: ["edit_jobs"] }, FULL);
			expect(r).toMatchObject({ ok: false, error: { code: AgentErrorCodes.APPROVAL_REQUIRED } });
			expect(handler).not.toHaveBeenCalled();
		});

		it("requires approval for a write tool that opts in", async () => {
			// Scheduling writes are not destructive, but they change live dispatch
			// state and must not run unattended.
			const r = await executeTool("exec_gated_write", {}, { ...ctx, permissions: ["edit_jobs"] }, FULL);
			expect(r).toMatchObject({ ok: false, error: { code: AgentErrorCodes.APPROVAL_REQUIRED } });
			expect(handler).not.toHaveBeenCalled();
		});

		it("runs a gated write once approved", async () => {
			const r = await executeTool("exec_gated_write", {}, { ...ctx, permissions: ["edit_jobs"] }, FULL, {
				approved: true,
			});
			expect(r).toMatchObject({ ok: true });
		});

		it("runs an ungated write without approval", async () => {
			// propose_draft writes a draft a person then reviews; gating it would
			// ask for the same approval twice.
			const r = await executeTool("exec_write", {}, { ...ctx, permissions: ["edit_jobs"] }, FULL);
			expect(r).toMatchObject({ ok: true });
			expect(handler).toHaveBeenCalledOnce();
		});

		it("refuses a caller who lacks permission BEFORE asking anyone to approve", async () => {
			// Prompting a person to approve an action that will then 403 wastes
			// their attention and teaches them the prompts are noise.
			const r = await executeTool("exec_gated_write", {}, { ...ctx, permissions: [] }, FULL);
			expect(r).toMatchObject({ ok: false, error: { code: AgentErrorCodes.FORBIDDEN } });
		});

		it("runs a destructive call once approved", async () => {
			const r = await executeTool("exec_destructive", {}, { ...ctx, permissions: ["edit_jobs"] }, FULL, {
				approved: true,
			});
			expect(r).toMatchObject({ ok: true });
			expect(handler).toHaveBeenCalledOnce();
		});
	});

	describe("permissions", () => {
		it("refuses a caller who holds none of the tool's permissions", async () => {
			const r = await executeTool("exec_write", {}, { ...ctx, permissions: ["view_jobs"] }, FULL);
			expect(r).toMatchObject({ ok: false, error: { code: AgentErrorCodes.FORBIDDEN } });
			expect(handler).not.toHaveBeenCalled();
		});

		it("checks permission before parsing input, so a refusal never leaks a schema", async () => {
			// Ordering matters: a caller who cannot run a tool should learn that,
			// not receive a field-by-field critique of the payload they sent.
			const r = await executeTool("exec_write", { nonsense: true }, { ...ctx, permissions: [] }, FULL);
			expect(r).toMatchObject({ ok: false, error: { code: AgentErrorCodes.FORBIDDEN } });
		});
	});

	describe("input validation", () => {
		it("returns the field issues so the model can retry precisely", async () => {
			const r = await executeTool("exec_read", { id: "not-a-uuid" }, ctx, READ_ONLY);
			expect(r).toMatchObject({ ok: false, error: { code: AgentErrorCodes.VALIDATION_ERROR } });
			if (r.ok) throw new Error("expected failure");
			expect(Array.isArray(r.error.details)).toBe(true);
		});

		it("treats a missing payload as an empty object rather than crashing", async () => {
			const r = await executeTool("exec_read", undefined, ctx, READ_ONLY);
			expect(r).toMatchObject({ ok: false, error: { code: AgentErrorCodes.VALIDATION_ERROR } });
		});
	});

	describe("error mapping", () => {
		it("passes an AgentToolError through with its own code", async () => {
			const name = throwing(new AgentToolError(AgentErrorCodes.FORBIDDEN, "nope", { why: "test" }));
			const r = await executeTool(name, {}, ctx, READ_ONLY);
			expect(r).toEqual({
				ok: false,
				error: { code: AgentErrorCodes.FORBIDDEN, message: "nope", details: { why: "test" } },
			});
		});

		it("maps Prisma P2025 to NOT_FOUND without revealing whether the row exists elsewhere", async () => {
			const name = throwing(
				new Prisma.PrismaClientKnownRequestError("no", { code: "P2025", clientVersion: "7" }),
			);
			const r = await executeTool(name, {}, ctx, READ_ONLY);
			if (r.ok) throw new Error("expected failure");
			expect(r.error.code).toBe(AgentErrorCodes.NOT_FOUND);
			expect(r.error.message).toMatch(/another organization/);
		});

		it("maps a status transition violation to CONFLICT", async () => {
			const name = throwing(new InvalidTransitionError("Draft", "Paid"));
			const r = await executeTool(name, {}, ctx, READ_ONLY);
			expect(r).toMatchObject({ ok: false, error: { code: AgentErrorCodes.CONFLICT } });
		});

		it("flattens an unexpected error and keeps its detail off the wire", async () => {
			const name = throwing(new Error("connection string postgres://user:hunter2@db/x"));
			const r = await executeTool(name, {}, ctx, READ_ONLY);
			if (r.ok) throw new Error("expected failure");
			expect(r.error.code).toBe(AgentErrorCodes.SERVER_ERROR);
			expect(r.error.message).not.toMatch(/hunter2/);
		});
	});

	describe("audit", () => {
		it("does not write an audit row for a read", async () => {
			await executeTool("exec_read", { id: VALID_ID }, ctx, READ_ONLY);
			expect(logActivity).not.toHaveBeenCalled();
		});

		it("writes an audit row for a successful write, attributed to the human", async () => {
			await executeTool("exec_write", {}, { ...ctx, permissions: ["edit_jobs"] }, FULL);
			expect(logActivity).toHaveBeenCalledOnce();
			expect(logActivity.mock.calls[0][0]).toMatchObject({
				actor_type: "agent",
				actor_id: "user-1",
				actor_name: "Assistant · Dana Reyes",
				organization_id: "org-1",
				entity_type: "job",
			});
		});

		it("writes no audit row when a write is refused", async () => {
			await executeTool("exec_write", {}, { ...ctx, permissions: [] }, FULL);
			expect(logActivity).not.toHaveBeenCalled();
		});

		it("reports the cache keys a successful write invalidated", async () => {
			const r = await executeTool("exec_write", {}, { ...ctx, permissions: ["edit_jobs"] }, FULL);
			expect(r).toMatchObject({ ok: true, meta: { invalidates: ["jobs", "job:job-1"] } });
		});
	});
});
