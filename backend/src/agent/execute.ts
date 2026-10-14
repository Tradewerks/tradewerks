/**
 * The gate. Every tool call from every transport passes through here.
 *
 * Order matters, and it is cheapest-and-most-decisive first: a caller who is
 * not allowed to run a tool learns that without the input being parsed, and
 * certainly without the database being touched.
 *
 *   1. Does the tool exist?
 *   2. Does policy permit this risk class at all?
 *   3. Is a destructive call carrying its approval?
 *   4. Does the caller hold one of the tool's permissions?
 *   5. Does the input validate?
 *   6. Run it, against an org-scoped client and nothing else.
 *   7. Audit.
 *
 * The function never throws. A model that receives `{ ok: false, error }` can
 * correct itself; an exception just ends the turn with nothing to act on.
 */

import { ZodError, type z } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import { getScopedDb } from "../lib/context.js";
import { InvalidTransitionError } from "../lib/statusTransitions.js";
import { log } from "../services/appLogger.js";
import { recordToolCall } from "./audit.js";
import { READ_ONLY_POLICY } from "./policy.js";
import { getTool } from "./registry.js";
import type { AnyToolDefinition } from "./types.js";

/**
 * Whether this tool needs a human to say yes first. Destructive by default;
 * a tool may opt in explicitly (scheduling writes do) but never out.
 */
export function toolRequiresApproval(tool: AnyToolDefinition): boolean {
	return tool.requiresApproval ?? tool.risk === "destructive";
}
import {
	AgentErrorCodes,
	AgentToolError,
	type AgentContext,
	type AgentErrorCode,
	type AgentPolicy,
	type ToolResult,
} from "./types.js";

export interface ExecuteOptions {
	/**
	 * Set only when a human has explicitly approved this specific call. The model
	 * cannot set it; it is supplied by the approval UI or an MCP elicitation
	 * response, and a destructive tool will not run without it.
	 */
	approved?: boolean;
}

const fail = (code: AgentErrorCode, message: string, details?: unknown): ToolResult => ({
	ok: false,
	error: details === undefined ? { code, message } : { code, message, details },
});

/**
 * Turn a thrown error into something a model can act on.
 *
 * Prisma's P2025 is worth special handling: because `getScopedDb` merges the org
 * filter into `where` as a sibling of the id, a record belonging to another
 * organization raises exactly the same error as a record that does not exist.
 * That is the correct thing to tell the caller — confirming that an id exists
 * in someone else's org would itself be a leak.
 */
function mapError(err: unknown, toolName: string): ToolResult {
	// A handler that named its own failure mode is trusted to have named it well.
	if (err instanceof AgentToolError) {
		return fail(err.code, err.message, err.details);
	}
	if (err instanceof ZodError) {
		return fail(AgentErrorCodes.VALIDATION_ERROR, "Input did not validate", err.issues);
	}
	if (err instanceof InvalidTransitionError) {
		return fail(AgentErrorCodes.CONFLICT, err.message);
	}
	if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
		return fail(AgentErrorCodes.NOT_FOUND, "No such record, or it belongs to another organization");
	}
	if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
		return fail(AgentErrorCodes.CONFLICT, "That value is already taken");
	}
	// Anything unrecognised keeps its detail in the server log and returns a flat
	// message — an internal stack is neither useful to a model nor safe to emit.
	log.error({ err, tool: toolName }, "Agent tool threw");
	return fail(AgentErrorCodes.SERVER_ERROR, "The tool failed unexpectedly");
}

export async function executeTool(
	name: string,
	rawInput: unknown,
	ctx: AgentContext,
	policy: AgentPolicy = READ_ONLY_POLICY,
	options: ExecuteOptions = {},
): Promise<ToolResult> {
	const started = Date.now();
	const tool = getTool(name);

	if (!tool) {
		return fail(AgentErrorCodes.UNKNOWN_TOOL, `No tool named "${name}"`);
	}

	const settle = async (result: ToolResult, auditInput?: unknown, auditResult?: unknown): Promise<ToolResult> => {
		await recordToolCall({
			tool: name,
			risk: tool.risk,
			ctx,
			input: rawInput,
			result,
			durationMs: Date.now() - started,
			audit: result.ok && tool.audit ? tool.audit(auditInput as never, auditResult) : null,
		});
		return result;
	};

	if (tool.risk === "write" && !policy.allowWrites) {
		return settle(fail(AgentErrorCodes.POLICY_DENIED, `"${name}" makes changes, which this session does not permit`));
	}
	if (tool.risk === "destructive" && !policy.allowDestructive) {
		return settle(fail(AgentErrorCodes.POLICY_DENIED, `"${name}" is irreversible and this session does not permit it`));
	}

	// ANY-OF, matching requireAnyPermission. ctx.permissions is already the
	// ceiling-intersected set — see policy.resolveAgentPermissions.
	//
	// Checked BEFORE approval on purpose: asking a person to approve an action
	// that will then be refused wastes their attention and teaches them that
	// approval prompts are noise.
	const held = new Set(ctx.permissions);
	if (!tool.permissions.some((p) => held.has(p))) {
		return settle(
			fail(
				AgentErrorCodes.FORBIDDEN,
				`Not permitted. "${name}" needs one of: ${tool.permissions.join(", ")}`,
			),
		);
	}

	if (toolRequiresApproval(tool) && !options.approved) {
		return settle(
			fail(
				AgentErrorCodes.APPROVAL_REQUIRED,
				`"${name}" changes live data and needs explicit human approval before it runs`,
			),
		);
	}

	let input: z.infer<typeof tool.input>;
	try {
		input = tool.input.parse(rawInput ?? {});
	} catch (err) {
		return settle(mapError(err, name));
	}

	try {
		const data = await tool.handler({
			input,
			ctx,
			db: getScopedDb(ctx.organizationId),
		});

		const result: ToolResult = {
			ok: true,
			data,
			...(tool.invalidates ? { meta: { invalidates: tool.invalidates(input, data) } } : {}),
		};
		return settle(result, input, data);
	} catch (err) {
		return settle(mapError(err, name));
	}
}
