/**
 * `search_records` — how an agent turns a name into an id.
 *
 * Almost every task starts here: a dispatcher says "the Kowalski job", and the
 * model has a string where it needs a UUID. Without this tool the only way to
 * find anything is to list a type and scan it, which burns context and fails
 * outright once an org has more records than fit in one page.
 */

import { z } from "zod";
import {
	allowedSearchTypes,
	DEFAULT_SEARCH_LIMIT,
	MAX_SEARCH_LIMIT,
	MIN_QUERY_LENGTH,
	searchRecords,
	SEARCHABLE_TYPES,
	SEARCH_TYPE_PERMISSIONS,
} from "../../services/searchService.js";
import { defineTool } from "../registry.js";

export const searchRecordsTool = defineTool({
	name: "search_records",
	title: "Search records",
	description:
		"Find records by name, number, address, email, phone, or SKU across clients, jobs, quotes, requests, " +
		"invoices, visits, technicians, contacts, projects, and inventory. Returns ids plus enough context to pick " +
		"the right hit. This is the normal way to resolve a name a person used into an id you can pass to other tools. " +
		"Matching is case-insensitive substring, not fuzzy — prefer a distinctive fragment over a full sentence.",
	risk: "read",
	permissions: [...new Set(Object.values(SEARCH_TYPE_PERMISSIONS).flat())],
	input: z.object({
		query: z
			.string()
			.min(MIN_QUERY_LENGTH)
			.describe(`What to look for. At least ${MIN_QUERY_LENGTH} characters.`),
		types: z
			.array(z.enum(SEARCHABLE_TYPES))
			.optional()
			.describe("Restrict to these types. Omit to search everything the caller may see."),
		limit: z
			.number()
			.int()
			.min(1)
			.max(MAX_SEARCH_LIMIT)
			.default(DEFAULT_SEARCH_LIMIT)
			.describe(`Hits per type, 1-${MAX_SEARCH_LIMIT}. Total results are at most this times the type count.`),
	}),
	async handler({ input, ctx }) {
		// Start from what this caller may see, then narrow by any explicit request.
		// Intersecting rather than replacing means `types` can never widen access.
		const permitted = allowedSearchTypes(ctx.permissions);
		const wanted = input.types?.length ? new Set<string>(input.types) : null;
		const types = wanted ? permitted.filter((t) => wanted.has(t)) : permitted;

		if (!types.length) {
			return {
				hits: [],
				total: 0,
				note: wanted
					? "None of the requested types are visible with the current permissions"
					: "No searchable types are visible with the current permissions",
			};
		}

		const outcome = await searchRecords(ctx.organizationId, {
			query: input.query,
			types,
			limit: input.limit,
		});

		return {
			hits: outcome.hits,
			total: outcome.hits.length,
			searched_types: outcome.types,
			truncated: outcome.truncated,
		};
	},
});
