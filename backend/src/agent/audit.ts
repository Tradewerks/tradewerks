/**
 * Audit trail for agent activity.
 *
 * Two destinations, on purpose:
 *
 *   · The `log` table (via `logActivity`) records mutations only. It is the
 *     product's audit trail and the source of the activity feed — writing a row
 *     for every read would bury real events under thousands of lookups and make
 *     the feed useless.
 *
 *   · The pino stream records every call, read or write. Volume is fine there,
 *     and "what did the agent look at before it did that" is exactly the
 *     question an incident review asks.
 *
 * Agent rows use `actor_type: "agent"` with `actor_id` set to the HUMAN the
 * agent acted for. That pairing is what lets `getActorHistory` surface agent
 * activity under the person responsible for it, while still allowing a query
 * for "everything any agent did" that a human-actor row would not match.
 */

import { logActivity } from "../services/logger.js";
import { log } from "../services/appLogger.js";
import { agentToolCalls, agentToolDuration } from "../services/metricsService.js";
import type { AgentContext, RiskClass, ToolResult } from "./types.js";

export interface ToolCallRecord {
	tool: string;
	risk: RiskClass;
	ctx: AgentContext;
	input: unknown;
	result: ToolResult;
	durationMs: number;
	audit?: {
		event_type: string;
		action: string;
		entity_type: string;
		entity_id: string;
		reason?: string;
	} | null;
}

/** How an agent row identifies itself in the activity feed. */
export function agentActorName(ctx: AgentContext): string {
	return ctx.userName ? `Assistant · ${ctx.userName}` : "Assistant";
}

/**
 * Record one tool call. Never throws — an audit failure must not take down the
 * call it was describing, and `logActivity` already swallows its own errors.
 */
export async function recordToolCall(record: ToolCallRecord): Promise<void> {
	const { tool, risk, ctx, result, durationMs } = record;

	// Structured so a Loki query can answer "what failed, for whom, and why"
	// without joining anything: evt is the stable selector, code is the reason.
	log.info(
		{
			evt: "agent.tool_call",
			tool,
			risk,
			surface: ctx.surface,
			org: ctx.organizationId,
			user: ctx.userId,
			role: ctx.role,
			ok: result.ok,
			code: result.ok ? undefined : result.error.code,
			// The input is what makes a validation failure diagnosable — without it
			// you can see that a call was rejected but not what the model sent.
			input: result.ok ? undefined : record.input,
			detail: result.ok ? undefined : result.error.message,
			ms: durationMs,
		},
		"Agent tool call",
	);

	// Cardinality note: tool and code are bounded (a fixed catalog, a fixed error
	// enum), so these are safe as labels. Organization deliberately is not — it
	// is unbounded and belongs in logs, not in a metric series.
	const labels = {
		tool,
		risk,
		surface: ctx.surface,
		outcome: result.ok ? "ok" : "error",
		code: result.ok ? "none" : result.error.code,
	};
	agentToolCalls.add(1, labels);
	agentToolDuration.record(durationMs / 1000, { tool, surface: ctx.surface });

	// Reads never reach the audit table; failures never do either — a refused or
	// invalid call changed nothing, and recording it as an event would imply it did.
	if (risk === "read" || !result.ok || !record.audit) return;

	await logActivity({
		event_type: record.audit.event_type,
		action: record.audit.action,
		entity_type: record.audit.entity_type,
		entity_id: record.audit.entity_id,
		organization_id: ctx.organizationId,
		actor_type: "agent",
		actor_id: ctx.userId,
		actor_name: agentActorName(ctx),
		reason: record.audit.reason ?? `via ${tool} (${ctx.surface})`,
		ip_address: ctx.ipAddress,
		user_agent: ctx.userAgent,
	});
}
