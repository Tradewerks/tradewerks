import z from "zod";
import { authed, envelope, errorEnvelope, json } from "./shared.js";

// ===============================================================================================================================
// Search
// ===============================================================================================================================

const searchType = z.enum([
	"client",
	"job",
	"quote",
	"request",
	"invoice",
	"visit",
	"technician",
	"contact",
	"project",
	"inventory_item",
]);

const searchHit = z
	.object({
		id: z.uuid(),
		type: searchType,
		label: z
			.string()
			.describe("What a person would recognise the record by"),
		sublabel: z
			.string()
			.optional()
			.describe("Client name, address or similar"),
		status: z.string().optional(),
		route: z
			.string()
			.describe("Path of the record in the TradeWerks web app"),
	})
	.meta({ id: "SearchHit" });

authed("get", "/search", "Search", null, {
	summary: "Search across record types",
	description:
		"Any signed-in user. Each type needs its own view permission (`client`/`contact`: `view_clients`, `quote`: `view_quotes`, `request`: `view_requests`, `job`: `view_jobs`, `view_all_jobs` or `view_assigned_jobs`, and so on). Types the caller can't see, or whose module is off, are dropped silently instead of returning 403. `limit` applies per type. `meta.hasMore` matches `data.truncated`.",
	request: {
		query: z.object({
			q: z
				.string()
				.min(2)
				.describe("Search text, at least 2 characters after trimming"),
			types: z
				.string()
				.optional()
				.describe(
					"Comma-separated types to search, e.g. `client,job`. Narrows the types the caller may see, never widens them. Default: all of them.",
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(50)
				.optional()
				.describe("Hits per type, 1-50. Default 10."),
		}),
	},
	responses: {
		200: json(
			envelope(
				z.object({
					hits: z.array(searchHit),
					truncated: z
						.boolean()
						.describe("A type hit its limit, so there may be more"),
					types: z
						.array(searchType)
						.describe("Types actually searched"),
				}),
			),
			"Search results (empty `hits` if the caller can't see any requested type)",
		),
		400: json(
			errorEnvelope,
			"`q` under 2 characters, `limit` not an integer from 1 to 50, or an unknown type in `types` (`VALIDATION_ERROR`)",
		),
	},
});
