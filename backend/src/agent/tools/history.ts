/**
 * `get_entity_history` — the change log for one record.
 *
 * Answers "who changed this, when, and from what". Reuses
 * `logsController.getEntityHistory`, which already walks a record's children
 * (a job's history includes its visits and notes) and redacts sensitive change
 * keys — reimplementing either here would be a way to get them subtly wrong.
 */

import { z } from "zod";
import {
	DEFAULT_HISTORY_LIMIT,
	MAX_HISTORY_LIMIT,
	getEntityHistory,
	type entity,
} from "../../controllers/logsController.js";
import { defineTool } from "../registry.js";
import { AgentErrorCodes, AgentToolError } from "../types.js";

/** Types `ENTITY_GROUPS` in logsController knows how to walk. */
const HISTORY_TYPES = ["job", "quote", "request", "invoice", "client", "project"] as const;

const PERMISSION_FOR: Record<(typeof HISTORY_TYPES)[number], readonly string[]> = {
	job: ["view_jobs", "view_assigned_jobs", "view_all_jobs"],
	quote: ["view_quotes"],
	request: ["view_requests"],
	invoice: ["view_invoices"],
	client: ["view_clients"],
	project: ["view_projects"],
};

export const getEntityHistoryTool = defineTool({
	name: "get_entity_history",
	title: "Get record history",
	description:
		"The change log for one record: who changed what, when, and the before/after values. Includes changes to the " +
		"record's children — a job's history covers its visits and notes. Use it for questions about how a record " +
		"reached its current state, or who last touched it.",
	risk: "read",
	permissions: [...new Set(Object.values(PERMISSION_FOR).flat())],
	input: z.object({
		type: z.enum(HISTORY_TYPES).describe("Which kind of record."),
		id: z.string().uuid().describe("The record's UUID."),
		limit: z
			.number()
			.int()
			.min(1)
			.max(MAX_HISTORY_LIMIT)
			.default(DEFAULT_HISTORY_LIMIT)
			.describe(`Entries to return, newest first. 1-${MAX_HISTORY_LIMIT}.`),
	}),
	async handler({ input, ctx }) {
		const needed = PERMISSION_FOR[input.type];
		const held = new Set(ctx.permissions);
		if (!needed.some((p) => held.has(p))) {
			throw new AgentToolError(
				AgentErrorCodes.FORBIDDEN,
				`Not permitted to read ${input.type} history; needs one of: ${needed.join(", ")}`,
			);
		}

		const result = await getEntityHistory(ctx.organizationId, input.type as entity, input.id, input.limit);
		if (result.err) {
			throw new AgentToolError(AgentErrorCodes.VALIDATION_ERROR, result.err);
		}

		return {
			type: input.type,
			id: input.id,
			total: result.total,
			has_more: result.hasMore,
			entries: result.rows.map((row) => ({
				at: row.timestamp.toISOString(),
				event: row.event_type,
				action: row.action,
				entity_type: row.entity_type,
				actor: row.actor_name ?? row.actor_type,
				changes: row.changes ?? undefined,
				reason: row.reason ?? undefined,
			})),
		};
	},
});
