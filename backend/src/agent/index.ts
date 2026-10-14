/**
 * Public surface of the agent tool layer.
 *
 * Import this (not the individual modules) to get a fully populated registry —
 * the `tools/index.js` import below is what registers every tool.
 */

import "./tools/index.js";

export { buildAgentContext, AgentContextError, type AgentClaims } from "./context.js";
export { executeTool, toolRequiresApproval, type ExecuteOptions } from "./execute.js";
export { describeTools, getTool, listTools } from "./registry.js";
export { toolInputSchema } from "./schema.js";
export {
	AGENT_PERMISSION_CEILING,
	READ_ONLY_POLICY,
	WRITE_POLICY,
	actorTypeForRole,
	expandUserPermissions,
	resolveAgentPermissions,
} from "./policy.js";
export {
	AgentErrorCodes,
	AgentToolError,
	type AgentContext,
	type AgentErrorCode,
	type AgentPolicy,
	type AgentSurface,
	type RiskClass,
	type ToolDefinition,
	type ToolResult,
} from "./types.js";
