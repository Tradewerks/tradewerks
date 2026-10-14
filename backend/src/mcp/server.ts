/**
 * The MCP adapter.
 *
 * Thin on purpose. Every tool, permission check, tenancy guarantee and audit
 * row already exists in `src/agent/`; this file translates between that registry
 * and MCP's `tools/list` + `tools/call`. It defines no tools and makes no
 * security decisions of its own — if it ever needs to, something is in the wrong
 * layer.
 *
 * The low-level `Server` is used rather than `McpServer` because `describeTools`
 * already produces JSON Schema and a per-caller filtered list; the high-level
 * helper would want Zod schemas re-declared and a static tool set.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { executeTool } from "../agent/execute.js";
import { describeTools } from "../agent/registry.js";
import type { AgentContext, AgentPolicy } from "../agent/types.js";
import { READ_ONLY_POLICY, WRITE_POLICY } from "../agent/policy.js";

/** Package identity reported in the MCP handshake. */
export const MCP_SERVER_INFO = { name: "epicit-dispatch", version: "1.0.0" } as const;

export interface McpServerOptions {
	ctx: AgentContext;
	policy: AgentPolicy;
	/**
	 * Whether tools that normally require an explicit approval may run.
	 *
	 * Off by default. MCP clients such as Claude Desktop do prompt before running
	 * a tool, and that prompt is a real human decision — but it belongs to the
	 * client, not to this server, and assuming every client shows one would be
	 * trusting something we cannot verify. Turning this on is a deliberate
	 * statement that the operator's client asks first.
	 */
	allowGatedWrites: boolean;
}

/**
 * Decide the policy from the environment.
 *
 * Read-only unless writes are explicitly enabled, and gated writes off unless
 * separately enabled on top of that — two switches rather than one, because
 * "may propose a draft" and "may move a visit without this server seeing an
 * approval" are different amounts of trust.
 */
export function policyFromEnv(): { policy: AgentPolicy; allowGatedWrites: boolean } {
	const writesEnabled = process.env.MCP_WRITES_ENABLED === "true";
	return {
		policy: writesEnabled ? WRITE_POLICY : READ_ONLY_POLICY,
		allowGatedWrites: writesEnabled && process.env.MCP_ALLOW_GATED_WRITES === "true",
	};
}

/** Tools this session will advertise, given its policy and what its user may do. */
export function visibleTools(options: McpServerOptions) {
	return describeTools({
		permissions: options.ctx.permissions,
		allowWrites: options.policy.allowWrites,
		allowDestructive: options.policy.allowDestructive,
	});
}

export function createMcpServer(options: McpServerOptions): Server {
	const server = new Server(MCP_SERVER_INFO, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: visibleTools(options).map((tool) => ({
			name: tool.name,
			title: tool.title,
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations: {
				title: tool.title,
				readOnlyHint: tool.risk === "read",
				destructiveHint: tool.risk === "destructive",
				// Reads and lookups can safely be retried; a write may not be.
				idempotentHint: tool.risk === "read",
			},
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const result = await executeTool(
			request.params.name,
			request.params.arguments ?? {},
			options.ctx,
			options.policy,
			{ approved: options.allowGatedWrites },
		);

		if (result.ok) {
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
				structuredContent: asStructured(result.data),
			};
		}

		// isError rather than a thrown exception: the protocol distinguishes "the
		// tool ran and failed" from "the server broke", and a model can act on the
		// first. The message carries the code so it can correct itself.
		return {
			isError: true,
			content: [
				{
					type: "text" as const,
					text: `${result.error.code}: ${result.error.message}${
						result.error.details ? `\n${JSON.stringify(result.error.details, null, 2)}` : ""
					}`,
				},
			],
		};
	});

	return server;
}

/**
 * `structuredContent` must be a JSON object. Tools that return an array or a
 * scalar get wrapped rather than dropped, so a client reading structured output
 * sees the same data the text block carries.
 */
function asStructured(data: unknown): Record<string, unknown> {
	if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
	return { result: data };
}
