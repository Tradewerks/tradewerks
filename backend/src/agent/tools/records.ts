/**
 * `get_record` and `list_records` — the two tools that carry most of the
 * catalog's retrieval weight.
 *
 * They are type-discriminated rather than split into twenty `get_job` /
 * `get_quote` variants. Twenty near-identical tool descriptions crowd the
 * model's context and make selection harder, not easier: the model has to
 * distinguish `get_job` from `get_visit` from `get_recurring_plan` on
 * description alone, when the real decision is just "which type".
 */

import { z } from "zod";
import { defineTool } from "../registry.js";
import {
	RECORD_DATE_FIELD,
	RECORD_FILTERS,
	RECORD_LOADERS,
	RECORD_PERMISSIONS,
	RECORD_STATUSES,
	RECORD_TYPES,
	type RecordType,
} from "../records.js";
import { AgentErrorCodes, AgentToolError, type AgentContext } from "../types.js";

const recordType = z.enum(RECORD_TYPES);

/** Every permission any record type could require, so the registry gate lets the call through. */
const ALL_RECORD_PERMISSIONS = [...new Set(Object.values(RECORD_PERMISSIONS).flat())];

/**
 * The registry's ANY-OF gate only proves the caller can read *something*. Each
 * type carries its own requirement, so re-check against the specific type asked
 * for — otherwise `view_inventory` alone would open up client records.
 */
function assertMayRead(ctx: AgentContext, type: RecordType): void {
	const needed = RECORD_PERMISSIONS[type];
	const held = new Set(ctx.permissions);
	if (!needed.some((p) => held.has(p))) {
		throw new AgentToolError(
			AgentErrorCodes.FORBIDDEN,
			`Not permitted to read ${type}; needs one of: ${needed.join(", ")}`,
		);
	}
}

export const getRecord = defineTool({
	name: "get_record",
	title: "Get record",
	description:
		"Fetch one record in full by its id, including its related records — a job with its visits and line items, " +
		"a client with its contacts, an invoice with its payments. Use this once you know the id. " +
		"To find an id from a name, number, or address, use search_records first.",
	risk: "read",
	permissions: ALL_RECORD_PERMISSIONS,
	input: z.object({
		type: recordType.describe("Which kind of record to fetch."),
		id: z.string().uuid().describe("The record's UUID."),
	}),
	async handler({ input, ctx, db }) {
		assertMayRead(ctx, input.type);
		const record = await RECORD_LOADERS[input.type].get(db, input.id);
		if (!record) {
			// Same message whichever the cause. `getScopedDb` folds the org filter
			// into the query, so a record in another organization is indistinguishable
			// from one that does not exist — and telling them apart would be a leak.
			return { found: false, message: `No ${input.type} with that id in this organization` };
		}
		return record;
	},
});

export const listRecords = defineTool({
	name: "list_records",
	title: "List records",
	description:
		"List records of one type, newest first, with optional filters. Returns compact summaries — call get_record " +
		"for the full detail of any row. Always reports the total number of matches, so you can tell when you are " +
		"seeing a subset. Prefer get_schedule for questions about who is working when.",
	risk: "read",
	permissions: ALL_RECORD_PERMISSIONS,
	input: z
		.object({
			type: recordType.describe("Which kind of record to list."),
			status: z
				.string()
				.optional()
				.describe("Filter by status. Valid values depend on type; an invalid value is rejected."),
			client_id: z.string().uuid().optional().describe("Only records belonging to this client."),
			since: z
				.string()
				.optional()
				.describe(
					"ISO 8601 date or datetime, inclusive lower bound. Filters created_at for most types, " +
						"scheduled_start_at for visits and starts_at for recurring plans. Not supported for technicians or inventory.",
				),
			until: z.string().optional().describe("ISO 8601 date or datetime. Upper bound."),
			limit: z.number().int().min(1).max(100).default(25).describe("Rows to return, 1-100."),
		})
		.superRefine((value, ctx) => {
			// Status vocabularies are per-type, so validity can only be judged once
			// the type is known — which is why this is a whole-object refinement
			// rather than a field-level enum.
			if (value.status) {
				const allowed = RECORD_STATUSES[value.type];
				if (!allowed.length) {
					ctx.addIssue({
						code: "custom",
						path: ["status"],
						message: `${value.type} records have no status field`,
					});
				} else if (!allowed.includes(value.status)) {
					ctx.addIssue({
						code: "custom",
						path: ["status"],
						message: `Invalid status for ${value.type}. Expected one of: ${allowed.join(", ")}`,
					});
				}
			}
			const supports = RECORD_FILTERS[value.type];

			if (value.client_id && !supports.client) {
				// Silently ignoring this would answer a different question than the one
				// asked — every technician returned as if they belonged to one client.
				ctx.addIssue({
					code: "custom",
					path: ["client_id"],
					message: `${value.type} records do not belong to a client; drop client_id`,
				});
			}

			for (const key of ["since", "until"] as const) {
				const raw = value[key];
				if (!raw) continue;
				if (!supports.dates) {
					ctx.addIssue({
						code: "custom",
						path: [key],
						message: `${value.type} records cannot be filtered by date`,
					});
					continue;
				}
				if (Number.isNaN(Date.parse(raw))) {
					ctx.addIssue({ code: "custom", path: [key], message: `${key} is not a valid ISO 8601 date` });
				}
			}
		}),
	async handler({ input, ctx, db }) {
		assertMayRead(ctx, input.type);
		const { rows, total } = await RECORD_LOADERS[input.type].list(db, {
			limit: input.limit,
			status: input.status,
			clientId: input.client_id,
			since: input.since ? new Date(input.since) : undefined,
			until: input.until ? new Date(input.until) : undefined,
		});
		return {
			type: input.type,
			rows,
			returned: rows.length,
			total,
			truncated: total > rows.length,
			// Name the column the date bounds applied to. "Jobs since March" means
			// created_at; "visits since March" means scheduled_start_at, and the
			// difference changes what the answer means.
			...(input.since || input.until ? { date_filter_field: RECORD_DATE_FIELD[input.type] } : {}),
		};
	},
});
