import z from "zod";
import {
	authed,
	decimal,
	envelope,
	errorEnvelope,
	idName,
	json,
} from "./shared.js";
import {
	idNameNullable,
	inventoryItem,
	inventoryOff,
	itemNotFound,
	itemParams,
	manageInvText,
} from "./inventory.js";

// Reconcile: billed line items that name a part but aren't linked to a catalog item.
const linkageEntity = z.enum([
	"quote",
	"job",
	"job_visit",
	"recurring_plan",
	"invoice",
]);
const linkageCounts = z.array(
	z.object({
		entity: linkageEntity,
		linked: z.number().int(),
		unmapped: z.number().int(),
		total: z.number().int(),
	}),
);
const linkageCandidate = z.object({
	name: z.string(),
	entities: z.array(linkageEntity),
	lines: z.number().int(),
	value: z.number().describe("Summed line value"),
	match: z
		.object({
			inventory_item_id: z.uuid(),
			name: z.string(),
			sku: z.string().nullable(),
			tier: z.enum(["exact", "case_insensitive", "code"]),
		})
		.nullable()
		.describe("Suggested catalog item"),
	field_purchases: z.array(z.record(z.string(), z.unknown())).optional(),
});
const linkName = z.object({
	name: z.string().min(1),
	inventory_item_id: z.uuid(),
});
const updatedByEntity = z
	.record(linkageEntity, z.number().int())
	.describe("Lines linked, per document type");
const dismissBody = z.object({
	name: z.string().min(1).max(200),
	reason: z.string().max(500).optional(),
});

authed(
	"get",
	"/inventory/linkage-audit",
	"Inventory",
	"manage_inventory",
	{
		summary: "Audit line item links to the catalog",
		description: `${manageInvText} For live quotes, jobs, visits, recurring plans and invoices: how many material and equipment lines are linked to a catalog item, and the most valuable unlinked part names (up to 200), with a suggested match where one is found.`,
		responses: {
			200: json(
				envelope(
					z.object({
						counts: linkageCounts,
						candidates: z.array(linkageCandidate),
						candidate_total: z.number().int(),
					}),
				),
				"Audit",
			),
			400: json(errorEnvelope, "The audit failed (`VALIDATION_ERROR`)"),
		},
	},
	inventoryOff,
);

authed(
	"post",
	"/inventory/linkage-audit/apply",
	"Inventory",
	"manage_inventory",
	{
		summary: "Link a part name to a catalog item",
		description: `${manageInvText} Points every unlinked material or equipment line named exactly \`name\` at the item, across all document types. Lines already linked are left alone. Lines on completed visits are marked as already used, so stock isn't taken again.`,
		request: {
			body: {
				content: {
					"application/json": {
						schema: linkName.meta({ id: "ApplyLinkage" }),
						example: {
							name: "R-410A refrigerant",
							inventory_item_id:
								"3f6c2a1e-8b4d-4c2a-9e1f-1a2b3c4d5e6f",
						},
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(z.object({ updated: updatedByEntity })),
				"Linked",
			),
			400: json(
				errorEnvelope,
				"Validation failed, or the update failed (`VALIDATION_ERROR`)",
			),
			404: itemNotFound,
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/reconcile",
	"Inventory",
	"manage_inventory",
	{
		summary: "Get the reconcile queue",
		description: `${manageInvText} Everything that needs a catalog decision: unlinked part names (\`unmapped\`, paged by \`offset\`/\`limit\`), provisional items (\`provisional\`), and with \`include_dismissed=true\`, names dismissed earlier. Totals cover the whole backlog, not just the page.`,
		request: {
			query: z.object({
				search: z.string().optional(),
				sort: z
					.enum(["value_desc", "value_asc", "lines_desc", "name_asc"])
					.optional(),
				origin: z
					.string()
					.optional()
					.describe(
						"Only provisional items with this origin, e.g. `field_purchase` or `dispatch_quick_add`",
					),
				include_dismissed: z.enum(["true"]).optional(),
				offset: z.coerce.number().int().optional(),
				limit: z.coerce.number().int().optional(),
			}),
		},
		responses: {
			200: json(
				envelope(
					z.object({
						counts: linkageCounts,
						coverage: z.object({
							linked: z.number().int(),
							unmapped: z.number().int(),
							total: z.number().int(),
							pct: z.number(),
						}),
						unmapped: z.array(linkageCandidate),
						unmapped_total: z.number().int(),
						unmapped_value: z.number(),
						provisional: z.array(z.record(z.string(), z.unknown())),
						provisional_total: z.number().int(),
						provisional_value: z.number(),
						dismissed: z.array(
							z.object({
								folded_name: z.string(),
								decided_at: z.iso.datetime(),
								decided_by: idNameNullable,
								reason: z.string().nullable(),
							}),
						),
					}),
				),
				"Queue",
			),
			400: json(
				errorEnvelope,
				"Unknown `origin` or `sort`, or the lookup failed (`VALIDATION_ERROR`)",
			),
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/reconcile/lines",
	"Inventory",
	"manage_inventory",
	{
		summary: "List the lines behind a queue row",
		description: `${manageInvText} The live document lines (up to 100) for one queue row. Pass \`name\` for an unlinked name (exact match), \`folded_name\` for a dismissed one (any casing), or \`item_id\` for a provisional item.`,
		request: {
			query: z.object({
				name: z.string().optional(),
				folded_name: z.string().optional(),
				item_id: z.uuid().optional(),
			}),
		},
		responses: {
			200: json(
				envelope(
					z.object({
						lines: z.array(
							z.object({
								entity: linkageEntity,
								line_id: z.uuid(),
								document_id: z.uuid(),
								parent_id: z
									.uuid()
									.nullable()
									.describe("The job, for a visit line"),
								document_number: z.string().nullable(),
								document_title: z.string().nullable(),
								client_name: z.string().nullable(),
								occurred_at: z.iso.datetime().nullable(),
								name: z.string(),
								quantity: z.number(),
								unit_price: z.number(),
								value: z.number(),
							}),
						),
						total: z.number().int(),
					}),
				),
				"Lines",
			),
			400: json(
				errorEnvelope,
				"None of `name`, `folded_name` or `item_id` given, or the lookup failed (`VALIDATION_ERROR`)",
			),
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/reconcile/targets",
	"Inventory",
	"manage_inventory",
	{
		summary: "Search items to link to",
		description: `${manageInvText} The same search as \`GET /inventory/search\`, plus \`exclude_id\` to leave one item out (e.g. the provisional item being merged).`,
		request: {
			query: z.object({
				q: z.string().optional(),
				exclude_id: z.uuid().optional(),
				limit: z.coerce
					.number()
					.int()
					.optional()
					.describe("Default 25, clamped to 1–50"),
			}),
		},
		responses: {
			200: json(
				envelope(
					z.array(
						z.object({
							id: z.uuid(),
							name: z.string(),
							sku: z.string().nullable(),
							unit: z.string(),
							cost: z.number().nullable(),
							provisional: z.boolean(),
						}),
					),
				),
				"Items (empty array if none)",
			),
			400: json(errorEnvelope, "The lookup failed (`VALIDATION_ERROR`)"),
		},
	},
	inventoryOff,
);

authed(
	"post",
	"/inventory/reconcile/apply-bulk",
	"Inventory",
	"manage_inventory",
	{
		summary: "Link several part names at once",
		description: `${manageInvText} Runs \`POST /inventory/linkage-audit/apply\` for each pair (at most 200), one after another. A failed pair doesn't stop the rest; check each result's \`err\`.`,
		request: {
			body: {
				content: {
					"application/json": {
						schema: z
							.object({
								pairs: z.array(linkName).min(1).max(200),
							})
							.meta({ id: "ApplyLinkageBulk" }),
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(
					z.object({
						results: z.array(
							z.object({
								name: z.string(),
								lines: z.number().int(),
								err: z.string().optional(),
							}),
						),
						linked: z.number().int().describe("Total lines linked"),
					}),
				),
				"Results, one per pair",
			),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
		},
	},
	inventoryOff,
);

authed(
	"post",
	"/inventory/reconcile/dismiss",
	"Inventory",
	"manage_inventory",
	{
		summary: "Dismiss a part name",
		description: `${manageInvText} Takes an unlinked name out of the queue for good (any casing), e.g. a one-off part that doesn't belong in the catalog. Dismissing it again updates the reason.`,
		request: {
			body: {
				content: {
					"application/json": {
						schema: dismissBody.meta({ id: "DismissPartName" }),
						example: {
							name: "Subcontractor materials",
							reason: "Not stocked",
						},
					},
				},
			},
		},
		responses: {
			201: json(
				envelope(
					z.object({
						id: z.uuid(),
						organization_id: z.uuid(),
						folded_name: z.string(),
						decided_by_id: z.uuid().nullable(),
						decided_at: z.iso.datetime(),
						reason: z.string().nullable(),
					}),
				),
				"Dismissed",
			),
			400: json(
				errorEnvelope,
				"Validation failed, or the update failed (`VALIDATION_ERROR`)",
			),
		},
	},
	inventoryOff,
);

authed(
	"post",
	"/inventory/reconcile/restore",
	"Inventory",
	"manage_inventory",
	{
		summary: "Restore a dismissed part name",
		description: `${manageInvText} Puts a dismissed name back in the queue. \`reason\` is ignored.`,
		request: {
			body: {
				content: {
					"application/json": { schema: dismissBody },
				},
			},
		},
		responses: {
			200: json(envelope(z.null()), "Restored (`data` is null)"),
			400: json(
				errorEnvelope,
				"Validation failed, or the delete failed (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "The name isn't dismissed (`NOT_FOUND`)"),
		},
	},
	inventoryOff,
);

const provisionalRow = inventoryItem
	.omit({ stock_status: true, tags: true, _count: true })
	.describe("The item row; `image_urls` are stored URLs, not signed");

authed(
	"post",
	"/inventory/provisional",
	"Inventory",
	"manage_inventory or edit_quotes or edit_jobs",
	{
		summary: "Quick-add a provisional item",
		description:
			"Requires any of `manage_inventory`, `edit_quotes` or `edit_jobs`. For a part not in the catalog yet, added from a line item form with just a name and price. It stays provisional (out of the item list and scans) until approved. If a provisional item with the same name (any casing) exists, that one is returned instead.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: z
							.object({
								name: z.string().min(1).max(200),
								unit: z.string().max(40).optional(),
								unit_price: z.number().min(0).optional(),
								cost: z.number().min(0).optional(),
							})
							.meta({ id: "CreateProvisionalItem" }),
						example: { name: "1/2 in. ball valve", unit_price: 18 },
					},
				},
			},
		},
		responses: {
			201: json(
				envelope(provisionalRow),
				"Item created, or the existing one",
			),
			400: json(
				errorEnvelope,
				"Validation failed, or the insert failed (`VALIDATION_ERROR`)",
			),
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/provisional",
	"Inventory",
	"manage_inventory",
	{
		summary: "List provisional items",
		description: `${manageInvText} Newest first, at most 200, each with the technician who submitted it (\`created_by_tech\`) and the vehicles holding it.`,
		responses: {
			200: json(
				envelope(
					z.array(
						provisionalRow.extend({
							created_by_tech: idNameNullable,
							vehicle_stocks: z.array(
								z.object({
									qty_on_hand: decimal,
									vehicle: idName,
								}),
							),
						}),
					),
				),
				"Items (empty array if none)",
			),
			404: json(errorEnvelope, "The lookup failed (`NOT_FOUND`)"),
		},
	},
	inventoryOff,
);

authed(
	"post",
	"/inventory/{id}/approve",
	"Inventory",
	"manage_inventory",
	{
		summary: "Approve a provisional item",
		description: `${manageInvText} Adds it to the catalog. A \`cost\` is required unless the item already has one. \`initial_warehouse_qty\` receives that much stock into the warehouse.`,
		request: {
			params: itemParams,
			body: {
				content: {
					"application/json": {
						schema: z
							.object({
								initial_warehouse_qty: z
									.number()
									.int()
									.min(0)
									.optional(),
								cost: z.number().min(0).optional(),
								unit: z.string().max(40).optional(),
								low_stock_threshold: z
									.number()
									.min(0)
									.nullable()
									.optional(),
								location: z
									.string()
									.max(255)
									.nullable()
									.optional(),
							})
							.meta({ id: "ApproveProvisionalItem" }),
						example: { cost: 9.5, initial_warehouse_qty: 4 },
					},
				},
			},
		},
		responses: {
			200: json(envelope(provisionalRow), "Item approved"),
			400: json(
				errorEnvelope,
				"Validation failed, no cost, or the update failed (`VALIDATION_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"No provisional item with this id (`NOT_FOUND`)",
			),
		},
	},
	inventoryOff,
);

authed(
	"post",
	"/inventory/{id}/merge",
	"Inventory",
	"manage_inventory",
	{
		summary: "Merge a provisional item into a catalog item",
		description: `${manageInvText} Moves the provisional item's vehicle stock, movements and every line item pointing at it onto \`target_inventory_item_id\` (a non-provisional item), then deletes it. Its warehouse quantity isn't carried over.`,
		request: {
			params: itemParams,
			body: {
				content: {
					"application/json": {
						schema: z
							.object({ target_inventory_item_id: z.uuid() })
							.meta({ id: "MergeProvisionalItem" }),
					},
				},
			},
		},
		responses: {
			200: json(envelope(z.null()), "Merged (`data` is null)"),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
			404: json(
				errorEnvelope,
				"No provisional item with this id, or the target isn't a catalog item (`VALIDATION_ERROR`)",
			),
			500: json(
				errorEnvelope,
				"The target is the item itself, or the merge failed (`VALIDATION_ERROR`)",
			),
		},
	},
	inventoryOff,
);

authed(
	"post",
	"/inventory/{id}/reject",
	"Inventory",
	"manage_inventory",
	{
		summary: "Reject a provisional item",
		description: `${manageInvText} Marks it inactive. Line items pointing at it keep their link.`,
		request: { params: itemParams },
		responses: {
			200: json(envelope(z.null()), "Rejected (`data` is null)"),
			404: json(
				errorEnvelope,
				"No provisional item with this id, or the update failed (`NOT_FOUND`)",
			),
		},
	},
	inventoryOff,
);
