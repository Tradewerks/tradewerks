import z from "zod";
import { authed, envelope, errorEnvelope, json, moduleOff } from "./shared.js";

// ===============================================================================================================================
// Disputes
// ===============================================================================================================================

const openDispute = z
	.object({
		dispute_id: z.uuid(),
		kind: z.enum(["quote", "invoice"]),
		document_id: z.uuid(),
		document_number: z.string(),
		client: z.object({ id: z.uuid(), name: z.string() }).nullable(),
		amount: z
			.number()
			.describe("Quote total, or the invoice's balance due"),
		contested_amount: z
			.number()
			.nullable()
			.describe(
				"Sum of the contested lines; null when the whole document is contested",
			),
		reason: z.string(),
		opened_at: z.iso.datetime(),
		opened_by: z.object({ id: z.uuid(), name: z.string() }).nullable(),
		can_resolve: z.boolean(),
	})
	.meta({ id: "OpenDispute" });

authed(
	"get",
	"/disputes/open",
	"Disputes",
	"view_quotes or view_invoices",
	{
		summary: "List open disputes",
		description:
			"Requires `view_quotes` or `view_invoices`; only disputes on document kinds the caller can view are listed. Oldest first, at most 50. `meta.count` is the number of items returned.",
		request: {
			query: z.object({
				client_id: z
					.uuid()
					.optional()
					.describe("Only disputes on this client's documents"),
			}),
		},
		responses: {
			200: json(
				envelope(
					z.object({
						items: z.array(openDispute),
						counts: z.object({
							quote: z.number(),
							invoice: z.number(),
						}),
						total: z.number(),
					}),
				),
				"Open disputes",
			),
			400: json(
				errorEnvelope,
				"`client_id` is not a UUID (`VALIDATION_ERROR`)",
			),
		},
	},
	moduleOff("disputes"),
);
