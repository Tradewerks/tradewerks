import z from "zod";
import {
	createInventoryItemSchema,
	updateInventoryItemSchema,
	adjustStockSchema,
	updateThresholdSchema,
	createTagSchema,
	updateTagSchema,
	setItemTagsSchema,
	usageQuerySchema,
	consumptionTrendQuerySchema,
	forecastQuerySchema,
	valueHistoryQuerySchema,
	priceHistoryQuerySchema,
	movementsQuerySchema,
} from "../lib/validate/inventory.js";
import {
	receiveInventorySchema,
	toggleTrackingSchema,
	listSerialsQuerySchema,
	listBatchesQuerySchema,
	updateBatchSchema,
	updateSerialSchema,
} from "../lib/validate/inventoryTracking.js";
import {
	authed,
	decimal,
	envelope,
	errorEnvelope,
	idName,
	json,
	moduleOff,
} from "./shared.js";

export {
	idNameNullable,
	inventoryItem,
	inventoryOff,
	itemParams,
	itemNotFound,
	viewInv,
	viewInvText,
	manageInvText,
	badQuery,
};

// ===============================================================================================================================
// Inventory
// ===============================================================================================================================

const inventoryItem = z
	.object({
		id: z.uuid(),
		name: z.string(),
		description: z.string(),
		location: z.string().nullable(),
		quantity: z.number(),
		unit: z.string(),
		unit_price: decimal.nullable(),
		cost: decimal.nullable(),
		sku: z.string().nullable(),
		barcode: z.string().nullable(),
		category: z.string().nullable(),
		taxable: z.boolean(),
		is_active: z.boolean(),
		is_serialized: z.boolean(),
		is_batch_tracked: z.boolean(),
		provisional: z.boolean(),
		low_stock_threshold: z.number().nullable(),
		stock_status: z.enum(["sufficient", "low", "out_of_stock"]).nullable(),
		image_urls: z
			.array(z.string())
			.describe("Signed, short-lived image URLs"),
		alt_ids: z.array(z.string()),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		tags: z
			.array(z.object({ id: z.uuid(), label: z.string() }))
			.optional()
			.describe("Not included with `low_stock=true`"),
		_count: z
			.object({ visit_line_items: z.number().int() })
			.optional()
			.describe("Not included with `low_stock=true`"),
	})
	.meta({ id: "InventoryItem" });

authed(
	"get",
	"/inventory",
	"Inventory",
	"view_inventory or manage_inventory",
	{
		summary: "List inventory items",
		description:
			"Requires `view_inventory` or `manage_inventory`. Active, non-provisional items. With `low_stock=true`, active items at or below their threshold (provisional ones included), out of stock first.",
		request: {
			query: z.object({
				low_stock: z
					.enum(["true"])
					.optional()
					.describe(
						"Only low and out-of-stock items; `sort` is ignored",
					),
				sort: z
					.enum([
						"name",
						"quantity_asc",
						"quantity_desc",
						"recently_added",
						"most_used",
					])
					.optional()
					.describe("Defaults to `name`"),
			}),
		},
		responses: {
			200: json(
				envelope(z.array(inventoryItem)),
				"Items (empty array if none)",
			),
		},
	},
	moduleOff("inventory"),
);

authed(
	"get",
	"/inventory/{id}",
	"Inventory",
	"view_inventory or manage_inventory",
	{
		summary: "Get an inventory item",
		description:
			"Requires `view_inventory` or `manage_inventory`. Inactive and provisional items are returned too.",
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: json(envelope(inventoryItem), "Item"),
			404: json(errorEnvelope, "Item not found (`NOT_FOUND`)"),
		},
	},
	moduleOff("inventory"),
);

authed(
	"post",
	"/inventory",
	"Inventory",
	"manage_inventory",
	{
		summary: "Create an inventory item",
		description: "Requires the `manage_inventory` permission.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: createInventoryItemSchema.meta({
							id: "CreateInventoryItem",
						}),
					},
				},
			},
		},
		responses: {
			201: json(envelope(inventoryItem), "Item created"),
			400: json(
				errorEnvelope,
				"Validation failed, supplier not found, SKU or barcode already in use, or the insert failed (`VALIDATION_ERROR`)",
			),
		},
	},
	moduleOff("inventory"),
);

authed(
	"patch",
	"/inventory/{id}",
	"Inventory",
	"manage_inventory",
	{
		summary: "Update an inventory item",
		description:
			"Requires the `manage_inventory` permission. Changing `unit` while stock is on hand needs `acknowledge_unit_change: true`.",
		request: {
			params: z.object({ id: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: updateInventoryItemSchema.meta({
							id: "UpdateInventoryItem",
						}),
					},
				},
			},
		},
		responses: {
			200: json(envelope(inventoryItem), "Item updated"),
			400: json(
				errorEnvelope,
				"Validation failed, unit change not acknowledged, SKU or barcode already in use, or the update failed (`VALIDATION_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"Item or supplier not found (`VALIDATION_ERROR`)",
			),
		},
	},
	moduleOff("inventory"),
);

authed(
	"delete",
	"/inventory/{id}",
	"Inventory",
	"manage_inventory",
	{
		summary: "Delete an inventory item",
		description:
			"Requires the `manage_inventory` permission. A soft delete: the item is marked inactive, its SKU and barcode are cleared so they can be reused, and its QuickBooks mappings are removed.",
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: json(
				envelope(z.object({ message: z.string() })),
				"Item deleted",
			),
			400: json(errorEnvelope, "The delete failed (`VALIDATION_ERROR`)"),
			404: json(errorEnvelope, "Item not found (`VALIDATION_ERROR`)"),
		},
	},
	moduleOff("inventory"),
);

const inventoryOff = moduleOff("inventory");
const itemParams = z.object({ id: z.uuid() });
const codeQuery = z.object({ code: z.string().min(1).max(200) });
const xlsx = (description: string) => ({
	description,
	content: {
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
			schema: z.string().meta({ format: "binary" }),
		},
	},
});
const itemNotFound = json(errorEnvelope, "Item not found (`NOT_FOUND`)");
const inventoryTag = z
	.object({
		id: z.uuid(),
		organization_id: z.uuid(),
		label: z.string(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
	})
	.meta({ id: "InventoryTag" });
const tagParams = z.object({ tagId: z.uuid() });

authed(
	"get",
	"/inventory/scan",
	"Inventory",
	"view_inventory or manage_inventory",
	{
		summary: "Look up an item by code",
		description:
			"Requires `view_inventory` or `manage_inventory`. Matches an active, non-provisional item by exact barcode (UPC-A and EAN-13 forms of the same code match each other), then exact SKU, then alternate IDs.",
		request: { query: codeQuery },
		responses: {
			200: json(envelope(inventoryItem), "Item"),
			400: json(
				errorEnvelope,
				"`code` missing or empty (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "No item has this code (`NOT_FOUND`)"),
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/resolve",
	"Inventory",
	"view_inventory or manage_inventory",
	{
		summary: "Resolve a scanned code",
		description:
			"Requires `view_inventory` or `manage_inventory`. Like `GET /inventory/scan`, but also finds serial units and batches. `SN:` or `SN-` codes match a serial unit's label code, `LOT:` or `LOT-` codes a batch's; anything else is tried as an item code, then a serial number, then a batch number. Serial and batch matches return their item even if it is inactive.",
		request: { query: codeQuery },
		responses: {
			200: json(
				envelope(
					z.discriminatedUnion("type", [
						z.object({
							type: z.literal("item"),
							item: inventoryItem,
						}),
						z.object({
							type: z.literal("serial"),
							code: z.string(),
							serialUnitId: z.uuid(),
							status: z.string(),
							item: inventoryItem,
						}),
						z.object({
							type: z.literal("batch"),
							code: z.string(),
							batchId: z.uuid(),
							batchNumber: z.string(),
							item: inventoryItem,
						}),
					]),
				),
				"What the code matched",
			),
			400: json(
				errorEnvelope,
				"`code` missing or empty (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Nothing matches the code (`NOT_FOUND`)"),
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/search",
	"Inventory",
	"view_inventory or use_inventory or request_field_purchase",
	{
		summary: "Search inventory items",
		description:
			"Requires any of `view_inventory`, `use_inventory` or `request_field_purchase`. Active items whose name or SKU contains `q` (case-insensitive) or with `q` as an alternate ID, by name; provisional items last. Returns a short summary of each item, cost included.",
		request: {
			query: z.object({
				q: z
					.string()
					.optional()
					.describe("Omit to list from the start"),
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
	"patch",
	"/inventory/{id}/stock",
	"Inventory",
	"manage_inventory or use_inventory",
	{
		summary: "Adjust an item's stock",
		description:
			"Requires `manage_inventory` or `use_inventory`. A positive `delta` adds warehouse stock (not allowed for serial- or batch-tracked items; use `POST /inventory/{id}/receive`). A negative `delta` records a loss; tracked items must say which units (`serial_unit_ids`) or lots (`batch_picks`) were lost. Stock can't go below zero.",
		request: {
			params: itemParams,
			body: {
				content: {
					"application/json": {
						schema: adjustStockSchema.meta({ id: "AdjustStock" }),
						example: { delta: -2 },
					},
				},
			},
		},
		responses: {
			200: json(envelope(inventoryItem), "Item, with the new quantity"),
			400: json(
				errorEnvelope,
				"Validation failed, a positive delta on a tracked item, not enough stock, wrong serials or lots, or the update failed (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Item not found (`VALIDATION_ERROR`)"),
		},
	},
	inventoryOff,
);

authed(
	"post",
	"/inventory/{id}/receive",
	"Inventory",
	"manage_inventory or use_inventory",
	{
		summary: "Receive stock",
		description:
			"Requires `manage_inventory` or `use_inventory`. Adds `qty` to warehouse stock. Serialized items need one `serial_numbers` entry per unit (whole quantities only), or `auto_serial: true` to generate them. Batch-tracked items need a new `batch` or an existing `batch_id` (not both); a `batch` with an existing number adds to that lot. `supplier_id` or `supplier_name` records where it came from.",
		request: {
			params: itemParams,
			body: {
				content: {
					"application/json": {
						schema: receiveInventorySchema.meta({
							id: "ReceiveInventory",
						}),
						example: { qty: 10, unit_cost: 12.5 },
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(
					z.object({
						item: inventoryItem,
						created_serials: z
							.array(
								z.object({
									id: z.uuid(),
									code: z.string(),
									serial_number: z.string(),
									status: z.string(),
								}),
							)
							.optional()
							.describe("Serialized items only"),
						batch: z
							.object({
								id: z.uuid(),
								code: z.string(),
								batch_number: z.string(),
							})
							.optional()
							.describe("Batch-tracked items only"),
					}),
				),
				"Received",
			),
			400: json(
				errorEnvelope,
				"Validation failed, serial count doesn't match `qty`, no batch given for a batch-tracked item, or the update failed (`VALIDATION_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"Item, `batch_id` or supplier not found (`NOT_FOUND`)",
			),
			409: json(
				errorEnvelope,
				"A serial number already exists for this item (`CONFLICT`)",
			),
		},
	},
	inventoryOff,
);

authed(
	"patch",
	"/inventory/{id}/threshold",
	"Inventory",
	"manage_inventory",
	{
		summary: "Set an item's low-stock threshold",
		description:
			"Requires the `manage_inventory` permission. `null` clears it.",
		request: {
			params: itemParams,
			body: {
				content: {
					"application/json": {
						schema: updateThresholdSchema.meta({
							id: "UpdateThreshold",
						}),
						example: { low_stock_threshold: 5 },
					},
				},
			},
		},
		responses: {
			200: json(envelope(inventoryItem), "Item updated"),
			400: json(
				errorEnvelope,
				"Validation failed, or the update failed (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Item not found (`VALIDATION_ERROR`)"),
		},
	},
	inventoryOff,
);

authed(
	"post",
	"/inventory/{id}/ensure-code",
	"Inventory",
	"manage_inventory",
	{
		summary: "Give an item a barcode",
		description:
			"Requires the `manage_inventory` permission. For label printing: if the item has no `barcode`, assigns a generated `ITM-…` code. An existing barcode is left alone.",
		request: { params: itemParams },
		responses: {
			200: json(envelope(inventoryItem), "Item, with its barcode"),
			400: json(
				errorEnvelope,
				"A code couldn't be assigned, or the update failed (`VALIDATION_ERROR`)",
			),
			404: itemNotFound,
		},
	},
	inventoryOff,
);

authed(
	"patch",
	"/inventory/{id}/tracking",
	"Inventory",
	"manage_inventory",
	{
		summary: "Turn serial or batch tracking on or off",
		description:
			"Requires the `manage_inventory` permission. Send `is_serialized` and/or `is_batch_tracked`. Only allowed with no stock on hand in the warehouse or any vehicle, and, when turning tracking off or switching, no serial unit or lot still holding stock. `GET /inventory/{itemId}/tracking-eligibility` says whether it's allowed. Provisional items can't be tracked.",
		request: {
			params: itemParams,
			body: {
				content: {
					"application/json": {
						schema: toggleTrackingSchema.meta({
							id: "ToggleTracking",
						}),
						example: { is_serialized: true },
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(inventoryItem),
				"Item updated (unchanged if nothing differs)",
			),
			400: json(
				errorEnvelope,
				"Validation failed, stock is on hand, the item is provisional, or the update failed (`VALIDATION_ERROR`)",
			),
			404: itemNotFound,
		},
	},
	inventoryOff,
);

authed(
	"put",
	"/inventory/{id}/tags",
	"Inventory",
	"manage_inventory",
	{
		summary: "Set an item's tags",
		description:
			"Requires the `manage_inventory` permission. Replaces the item's tags with `tag_ids`; an empty array removes them all. Active items only. Unlike the other item routes, `image_urls` come back as stored (not signed) and there's no `stock_status`.",
		request: {
			params: itemParams,
			body: {
				content: {
					"application/json": {
						schema: setItemTagsSchema.meta({ id: "SetItemTags" }),
						example: {
							tag_ids: ["3f6c2a1e-8b4d-4c2a-9e1f-1a2b3c4d5e6f"],
						},
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(
					inventoryItem.omit({ stock_status: true, _count: true }),
				),
				"Item, with `tags`",
			),
			400: json(
				errorEnvelope,
				"Validation failed, or the update failed (`VALIDATION_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"Item not found or inactive, or a tag isn't in the organization (`VALIDATION_ERROR`)",
			),
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/tags",
	"Inventory",
	"manage_inventory",
	{
		summary: "List inventory tags",
		description: "Requires the `manage_inventory` permission. By label.",
		responses: {
			200: json(
				envelope(z.array(inventoryTag)),
				"Tags (empty array if none)",
			),
		},
	},
	inventoryOff,
);

authed(
	"post",
	"/inventory/tags",
	"Inventory",
	"manage_inventory",
	{
		summary: "Create an inventory tag",
		description:
			"Requires the `manage_inventory` permission. Labels are unique per organization, ignoring case.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: createTagSchema.meta({
							id: "CreateInventoryTag",
						}),
						example: { label: "Refrigerant" },
					},
				},
			},
		},
		responses: {
			201: json(envelope(inventoryTag), "Tag created"),
			400: json(
				errorEnvelope,
				"Validation failed, the label is taken, or the insert failed (`VALIDATION_ERROR`)",
			),
		},
	},
	inventoryOff,
);

authed(
	"patch",
	"/inventory/tags/{tagId}",
	"Inventory",
	"manage_inventory",
	{
		summary: "Rename an inventory tag",
		description:
			"Requires the `manage_inventory` permission. Labels are unique per organization, ignoring case.",
		request: {
			params: tagParams,
			body: {
				content: {
					"application/json": {
						schema: updateTagSchema.meta({
							id: "UpdateInventoryTag",
						}),
					},
				},
			},
		},
		responses: {
			200: json(envelope(inventoryTag), "Tag updated"),
			400: json(
				errorEnvelope,
				"Validation failed, the label is taken, or the update failed (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Tag not found (`VALIDATION_ERROR`)"),
		},
	},
	inventoryOff,
);

authed(
	"delete",
	"/inventory/tags/{tagId}",
	"Inventory",
	"manage_inventory",
	{
		summary: "Delete an inventory tag",
		description:
			"Requires the `manage_inventory` permission. Removes it from every item.",
		request: { params: tagParams },
		responses: {
			200: json(
				envelope(z.object({ message: z.string() })),
				"Tag deleted",
			),
			404: json(errorEnvelope, "Tag not found (`VALIDATION_ERROR`)"),
		},
	},
	inventoryOff,
);

authed(
	"post",
	"/inventory/upload-image",
	"Inventory",
	"manage_inventory",
	{
		summary: "Upload an item image",
		description:
			"Requires the `manage_inventory` permission. Stores one image and returns its URLs; it isn't attached to anything until an item is created or updated with the URL in `image_urls`. JPEG, PNG or WebP, up to 5 MB.",
		request: {
			body: {
				content: {
					"multipart/form-data": {
						schema: z.object({
							image: z
								.string()
								.meta({ format: "binary" })
								.describe("The image file"),
						}),
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(
					z.object({
						url: z
							.string()
							.describe("Signed, short-lived URL for display"),
						raw_url: z.string().describe("Storage URL"),
					}),
				),
				"Uploaded",
			),
			400: json(
				errorEnvelope,
				"No `image` file, or the file is over 5 MB (the message says 15MB) (`VALIDATION_ERROR`)",
			),
			500: json(
				errorEnvelope,
				"The file isn't JPEG, PNG or WebP, or the upload failed (`SERVER_ERROR`)",
			),
		},
	},
	inventoryOff,
);

authed(
	"post",
	"/inventory/import",
	"Inventory",
	"manage_inventory",
	{
		summary: "Import items from a spreadsheet",
		description:
			"Requires the `manage_inventory` permission. Creates one item per row of the first sheet, using the columns of `GET /inventory/template`; `name` is required. Tags named in a `tags` column (comma-separated) are created if missing. Bad rows are skipped and reported; nothing is updated, only created. Retired (410) when the server has AI imports enabled; use `/inventory/imports` there.",
		request: {
			body: {
				content: {
					"multipart/form-data": {
						schema: z.object({
							file: z
								.string()
								.meta({ format: "binary" })
								.describe("XLSX, XLS or CSV"),
						}),
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(
					z.object({
						imported: z.number().int(),
						skipped: z.array(
							z.object({
								row: z.number().int(),
								reason: z.string(),
							}),
						),
						warnings: z
							.array(
								z.object({
									row: z.number().int(),
									message: z.string(),
								}),
							)
							.describe(
								"Rows imported, but not exactly as written (e.g. an unknown unit)",
							),
					}),
				),
				"Import finished; `row` is the spreadsheet row number",
			),
			400: json(
				errorEnvelope,
				"No `file`, or the file is over 10 MB (the message says 15MB) (`VALIDATION_ERROR`)",
			),
			410: json(
				errorEnvelope,
				"Direct imports are retired on this server (`BAD_REQUEST`)",
			),
			500: json(
				errorEnvelope,
				"The file isn't a spreadsheet, or couldn't be read (`SERVER_ERROR`)",
			),
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/export/low-stock",
	"Inventory",
	"view_inventory",
	{
		summary: "Download the low-stock report",
		description:
			"Requires the `view_inventory` permission (`manage_inventory` alone isn't enough). The items from `GET /inventory?low_stock=true` as `low-stock-report.xlsx`, with name, SKU, location, quantity, unit, threshold, stock status, unit price and cost.",
		responses: { 200: xlsx("The spreadsheet") },
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/template",
	"Inventory",
	null,
	{
		summary: "Download the import template",
		description:
			"Needs no permission beyond being signed in. A blank `inventory-import-template.xlsx` with the columns `POST /inventory/import` reads.",
		responses: { 200: xlsx("The spreadsheet") },
	},
	inventoryOff,
);

const viewInv = "view_inventory or manage_inventory";
const viewInvText = "Requires `view_inventory` or `manage_inventory`.";
const manageInvText = "Requires the `manage_inventory` permission.";
const itemIdParams = z.object({ itemId: z.uuid() });
const badQuery = json(
	errorEnvelope,
	"Invalid query parameter (`VALIDATION_ERROR`)",
);
const unitBasis = z
	.object({
		units: z.array(z.string()),
		unit: z.string().nullable(),
		mixed: z
			.boolean()
			.describe(
				"Movements were recorded in more than one unit; totals are withheld (null)",
			),
	})
	.meta({ id: "UnitBasis" });
const idNameNullable = idName.nullable();
const visitRef = z
	.object({
		id: z.uuid(),
		name: z.string().nullable(),
		job: z.object({
			id: z.uuid(),
			job_number: z.string(),
			name: z.string(),
		}),
	})
	.nullable();
const serialUnit = z
	.object({
		id: z.uuid(),
		organization_id: z.uuid(),
		inventory_item_id: z.uuid(),
		serial_number: z.string(),
		code: z.string().describe("Label code; scan as `SN:{code}`"),
		status: z.enum([
			"in_warehouse",
			"on_vehicle",
			"consumed",
			"lost",
			"returned",
		]),
		current_vehicle_id: z.uuid().nullable(),
		consumed_at: z.iso.datetime().nullable(),
		consumed_visit_id: z.uuid().nullable(),
		consumed_line_item_id: z.uuid().nullable(),
		client_id: z.uuid().nullable(),
		batch_id: z.uuid().nullable(),
		received_at: z.iso.datetime(),
		note: z.string().nullable(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
	})
	.meta({ id: "SerialUnit" });
const batchSummary = z.object({
	id: z.uuid(),
	code: z.string().describe("Label code; scan as `LOT:{code}`"),
	batch_number: z.string(),
	expires_at: z.iso.datetime().nullable(),
	supplier: z.string().nullable(),
	recalled_at: z.iso.datetime().nullable(),
	qty_received: z.number(),
	qty_in_warehouse: z.number(),
});
const stockMovement = z
	.record(z.string(), z.unknown())
	.describe(
		"A ledger row: `qty`, `unit`, `reason`, `from_location_type`/`to_location_type` (warehouse, vehicle, external, consumed, adjustment…), `from_vehicle`/`to_vehicle` (`id`, `name`), `visit_id`, `note`, `actor_type`, `created_at` and more",
	);

authed(
	"get",
	"/inventory/{id}/serials",
	"Inventory",
	viewInv,
	{
		summary: "List an item's serial units",
		description: `${viewInvText} Newest received first, \`limit\` per page (default 25). Pass the previous page's \`nextCursor\` as \`cursor\` for the next.`,
		request: { params: itemParams, query: listSerialsQuerySchema },
		responses: {
			200: json(
				envelope(
					z.object({
						serials: z.array(serialUnit),
						nextCursor: z
							.uuid()
							.nullable()
							.describe("Null on the last page"),
					}),
				),
				"A page of serial units",
			),
			400: badQuery,
			404: itemNotFound,
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/{id}/batches",
	"Inventory",
	viewInv,
	{
		summary: "List an item's batches",
		description: `${viewInvText} Every lot, oldest first (the order stock is used in), with how much each vehicle holds.`,
		request: { params: itemParams, query: listBatchesQuerySchema },
		responses: {
			200: json(
				envelope(
					z.object({
						batches: z.array(
							batchSummary.extend({
								vehicles: z.array(
									z.object({
										vehicle_id: z.uuid(),
										vehicle_name: z.string(),
										qty_on_hand: z.number(),
									}),
								),
							}),
						),
					}),
				),
				"Batches (empty array if none)",
			),
			400: badQuery,
			404: itemNotFound,
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/serials/{id}/history",
	"Inventory",
	viewInv,
	{
		summary: "Get a serial unit's history",
		description: `${viewInvText} The unit, with its item, vehicle, batch and where it was used, plus every movement it was part of, oldest first.`,
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: json(
				envelope(
					z.object({
						serial: z.object({
							id: z.uuid(),
							code: z.string(),
							serial_number: z.string(),
							status: serialUnit.shape.status,
							item: idName,
							current_vehicle: idNameNullable,
							batch: z
								.object({
									id: z.uuid(),
									batch_number: z.string(),
									code: z.string(),
								})
								.nullable(),
							received_at: z.iso.datetime(),
							consumed_at: z.iso.datetime().nullable(),
							client: idNameNullable,
							consumed_visit: visitRef,
							note: z.string().nullable(),
						}),
						timeline: z.array(
							z.object({
								id: z.uuid(),
								reason: z.string(),
								from_location_type: z.string(),
								from_vehicle: idNameNullable,
								to_location_type: z.string(),
								to_vehicle: idNameNullable,
								note: z.string().nullable(),
								actor_type: z.string().nullable(),
								created_at: z.iso.datetime(),
								visit: visitRef,
							}),
						),
					}),
				),
				"Serial unit and timeline",
			),
			404: json(errorEnvelope, "Serial unit not found (`NOT_FOUND`)"),
		},
	},
	inventoryOff,
);

authed(
	"patch",
	"/inventory/serials/{serialId}",
	"Inventory",
	"manage_inventory",
	{
		summary: "Update a serial unit",
		description: `${manageInvText} Set \`status\` to \`lost\` (written off) or \`returned\` (sent back to the supplier), which takes it out of warehouse stock; only units in the warehouse can change status. \`note\` can be set on any unit.`,
		request: {
			params: z.object({ serialId: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: updateSerialSchema.meta({
							id: "UpdateSerialUnit",
						}),
						example: {
							status: "lost",
							note: "Dropped off the lift",
						},
					},
				},
			},
		},
		responses: {
			200: json(envelope(serialUnit), "Serial unit updated"),
			400: json(
				errorEnvelope,
				"Validation failed, the unit isn't in the warehouse, or the update failed (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Serial unit not found (`NOT_FOUND`)"),
		},
	},
	inventoryOff,
);

authed(
	"delete",
	"/inventory/serials/{serialId}",
	"Inventory",
	"manage_inventory",
	{
		summary: "Delete a serial unit",
		description: `${manageInvText} For units entered by mistake: only units still in the warehouse that have never moved since being received. Warehouse stock goes down by one.`,
		request: { params: z.object({ serialId: z.uuid() }) },
		responses: {
			200: json(envelope(z.null()), "Deleted (`data` is null)"),
			400: json(
				errorEnvelope,
				"The unit has moved or left the warehouse, or the delete failed (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Serial unit not found (`NOT_FOUND`)"),
		},
	},
	inventoryOff,
);

authed(
	"patch",
	"/inventory/batches/{batchId}",
	"Inventory",
	"manage_inventory",
	{
		summary: "Update a batch",
		description: `${manageInvText} Edits the lot's number, expiry, supplier text and note, and \`recalled\` sets or clears the recall flag (a recalled lot isn't picked for new usage). Quantities can't be changed here. A \`note\` change isn't recorded in history.`,
		request: {
			params: z.object({ batchId: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: updateBatchSchema.meta({ id: "UpdateBatch" }),
						example: { recalled: true },
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(batchSummary.extend({ note: z.string().nullable() })),
				"Batch updated",
			),
			400: json(
				errorEnvelope,
				"Validation failed, or the batch number is already used for this item (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Batch not found (`NOT_FOUND`)"),
		},
	},
	inventoryOff,
);

authed(
	"delete",
	"/inventory/batches/{batchId}",
	"Inventory",
	"manage_inventory",
	{
		summary: "Delete a batch",
		description: `${manageInvText} Only empty lots that were never used: no stock in the warehouse or on any vehicle, no serial units, and no movement history.`,
		request: { params: z.object({ batchId: z.uuid() }) },
		responses: {
			200: json(envelope(z.null()), "Deleted (`data` is null)"),
			400: json(
				errorEnvelope,
				"The batch holds stock, has serial units or movement history, or the delete failed (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Batch not found (`NOT_FOUND`)"),
		},
	},
	inventoryOff,
);

const batchImpact = z.object({
	batch: z.object({
		id: z.uuid(),
		code: z.string(),
		batch_number: z.string(),
		item_id: z.uuid(),
		item_name: z.string(),
		supplier: z.string().nullable(),
		expires_at: z.iso.datetime().nullable(),
		recalled_at: z.iso.datetime().nullable(),
	}),
	remaining: z.object({
		warehouse: z.number(),
		vehicles: z.array(
			z.object({
				vehicle_id: z.uuid(),
				vehicle_name: z.string(),
				qty_on_hand: z.number(),
			}),
		),
		total: z.number(),
	}),
	affected_serials: z
		.array(
			z.object({
				id: z.uuid(),
				code: z.string(),
				serial_number: z.string(),
				consumed_at: z.iso.datetime().nullable(),
				client: idNameNullable,
				visit: visitRef,
			}),
		)
		.describe("Serialized items only: units from this lot that were used"),
	affected_jobs: z
		.array(
			z.object({
				visit_line_item_id: z.uuid(),
				line_item_name: z.string(),
				visit_id: z.uuid(),
				visit_name: z.string().nullable(),
				job_id: z.uuid(),
				job_number: z.string(),
				job_name: z.string(),
				client_id: z.uuid(),
				client_name: z.string(),
				consumed_qty: z.number(),
				reversed_qty: z.number(),
				net_qty: z.number(),
				fully_reversed: z.boolean(),
			}),
		)
		.describe("Visit line items that used stock from this lot"),
});

authed(
	"get",
	"/inventory/batches/{batchId}/impact",
	"Inventory",
	viewInv,
	{
		summary: "Get a batch's recall report",
		description: `${viewInvText} Where the lot's stock is now, and which jobs, visits and clients received it.`,
		request: { params: z.object({ batchId: z.uuid() }) },
		responses: {
			200: json(envelope(batchImpact), "Recall report"),
			404: json(errorEnvelope, "Batch not found (`NOT_FOUND`)"),
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/batches/{batchId}/export",
	"Inventory",
	viewInv,
	{
		summary: "Download a batch's recall report",
		description: `${viewInvText} The affected jobs and serial units from \`GET /inventory/batches/{batchId}/impact\` as \`batch-recall-report.xlsx\`.`,
		request: { params: z.object({ batchId: z.uuid() }) },
		responses: {
			200: xlsx("The spreadsheet"),
			404: json(errorEnvelope, "Batch not found (`NOT_FOUND`)"),
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/tracking/reconciliation",
	"Inventory",
	"manage_inventory",
	{
		summary: "Check tracked stock for drift",
		description: `${manageInvText} For active serial- and batch-tracked items, lists every place where the item's stock count disagrees with its serial units or lots (\`drifts\`), and the 50 most recent movements recorded without the units or lots they should have named (\`gaps\`).`,
		responses: {
			200: json(
				envelope(
					z.object({
						drifts: z.array(
							z.object({
								item_id: z.uuid(),
								item_name: z.string(),
								scope: z.enum(["warehouse", "vehicle"]),
								vehicle_id: z.uuid().optional(),
								vehicle_name: z.string().optional(),
								expected: z
									.number()
									.describe("The stock count"),
								actual: z
									.number()
									.describe("The serial or lot total"),
							}),
						),
						gaps: z.array(
							z.object({
								id: z.uuid(),
								item: idName,
								qty: z.number(),
								reason: z.string(),
								note: z.string().nullable(),
								created_at: z.iso.datetime(),
								visit: visitRef,
							}),
						),
					}),
				),
				"Drifts and gaps (empty arrays if none)",
			),
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/{itemId}/tracking-summary",
	"Inventory",
	viewInv,
	{
		summary: "Get an item's serial and batch totals",
		description: `${viewInvText} Serial unit counts by status and lot totals.`,
		request: { params: itemIdParams },
		responses: {
			200: json(
				envelope(
					z.object({
						serials: z.object({
							in_warehouse: z.number().int(),
							on_vehicle: z.number().int(),
							consumed: z.number().int(),
							lost: z.number().int(),
							returned: z.number().int(),
						}),
						batches: z.object({
							lots: z.number().int(),
							qty_in_warehouse: z.number(),
							qty_on_vehicles: z.number(),
						}),
					}),
				),
				"Totals",
			),
			404: itemNotFound,
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/{itemId}/vehicle-stock",
	"Inventory",
	viewInv,
	{
		summary: "List the vehicles holding an item",
		description: `${viewInvText} Vehicles with this item on board, most first, with one of the technicians assigned to each.`,
		request: { params: itemIdParams },
		responses: {
			200: json(
				envelope(
					z.object({
						rows: z.array(
							z.object({
								vehicle_id: z.uuid(),
								vehicle_name: z.string(),
								vehicle_status: z.string(),
								technician_name: z.string().nullable(),
								qty_on_hand: z.number(),
							}),
						),
					}),
				),
				"Vehicles (empty array if none)",
			),
			404: itemNotFound,
		},
	},
	`${moduleOff("inventory")}; or the \`vehicle_stock\` module is off`,
);

authed(
	"get",
	"/inventory/{itemId}/tracking-eligibility",
	"Inventory",
	viewInv,
	{
		summary: "Check whether tracking can be changed",
		description: `${viewInvText} The same checks \`PATCH /inventory/{id}/tracking\` applies. \`can_enable\` covers turning tracking on; \`can_disable\` covers turning it off or switching type, and \`blockers\` explains what's in the way.`,
		request: { params: itemIdParams },
		responses: {
			200: json(
				envelope(
					z.object({
						provisional: z.boolean(),
						is_serialized: z.boolean(),
						is_batch_tracked: z.boolean(),
						qty_warehouse: z.number(),
						qty_on_vehicles: z.number(),
						vehicle_count: z.number().int(),
						live_serials: z.number().int(),
						live_lots: z.number().int(),
						history_serials: z.number().int(),
						history_lots: z.number().int(),
						can_enable: z.boolean(),
						can_disable: z.boolean(),
						blockers: z.array(z.string()),
					}),
				),
				"Eligibility",
			),
			404: itemNotFound,
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/{id}/movements",
	"Inventory",
	viewInv,
	{
		summary: "List an item's stock movements",
		description: `${viewInvText} Newest first, \`limit\` per page (default 25). Pass the previous page's \`nextCursor\` as \`cursor\` for the next.`,
		request: { params: itemParams, query: movementsQuerySchema },
		responses: {
			200: json(
				envelope(
					z.object({
						movements: z.array(stockMovement),
						nextCursor: z
							.uuid()
							.nullable()
							.describe("Null on the last page"),
					}),
				),
				"A page of movements",
			),
			400: badQuery,
			404: itemNotFound,
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/{id}/usage",
	"Inventory",
	viewInv,
	{
		summary: "List the jobs that used an item",
		description: `${viewInvText} Net quantity used per job (reversals subtracted, fully reversed jobs left out), most recent first. Offset paging: \`limit\` (default 20) and \`offset\`.`,
		request: { params: itemParams, query: usageQuerySchema },
		responses: {
			200: json(
				envelope(
					z.object({
						usage: z.array(
							z.object({
								jobId: z.uuid(),
								jobNumber: z.string(),
								jobName: z.string(),
								clientId: z.uuid(),
								clientName: z.string(),
								qtyConsumed: z
									.number()
									.nullable()
									.describe("Null when units are mixed"),
								unitBasis,
								lastConsumedAt: z.iso.datetime(),
							}),
						),
						unitBasis,
						hasMore: z.boolean(),
					}),
				),
				"Usage",
			),
			400: badQuery,
			404: itemNotFound,
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/{id}/consumption-trend",
	"Inventory",
	viewInv,
	{
		summary: "Get an item's usage over time",
		description: `${viewInvText} Net quantity used per week or month, one point per period including empty ones. \`range\` is the number of periods back: default 26 weeks or 12 months, at most 104 weeks or 36 months.`,
		request: { params: itemParams, query: consumptionTrendQuerySchema },
		responses: {
			200: json(
				envelope(
					z.object({
						bucket: z.enum(["week", "month"]),
						unitBasis,
						points: z.array(
							z.object({
								periodStart: z.iso.datetime(),
								qtyConsumed: z
									.number()
									.nullable()
									.describe("Null when units are mixed"),
							}),
						),
					}),
				),
				"Trend",
			),
			400: badQuery,
			404: itemNotFound,
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/{id}/forecast",
	"Inventory",
	viewInv,
	{
		summary: "Get an item's reorder forecast",
		description: `${viewInvText} Average use over the last \`lookbackDays\` and when stock is expected to run out. \`forecast\` is null with a \`reason\` when the item is inactive or there's nothing to forecast.`,
		request: { params: itemParams, query: forecastQuerySchema },
		responses: {
			200: json(
				envelope(
					z.object({
						forecast: z
							.record(z.string(), z.unknown())
							.nullable()
							.describe(
								"The item's row from the reorder forecast report",
							),
						reason: z
							.enum(["inactive", "no_forecast_row"])
							.nullable(),
					}),
				),
				"Forecast",
			),
			400: badQuery,
			404: itemNotFound,
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/{id}/value-history",
	"Inventory",
	viewInv,
	{
		summary: "Get an item's stock value over time",
		description: `${viewInvText} Warehouse quantity and value after each movement. Value uses the average price paid on receipts (\`costBasis: paid\`), or the item's cost when no receipt recorded one (\`configured\`). Mixed units return no points. At most the 2,000 newest movements are replayed (\`truncated\`).`,
		request: { params: itemParams, query: valueHistoryQuerySchema },
		responses: {
			200: json(
				envelope(
					z.object({
						currentCost: z.number().nullable(),
						costUsed: z.number().nullable(),
						costBasis: z.enum(["paid", "configured"]).nullable(),
						unitBasis,
						points: z.array(
							z.object({
								date: z.iso.datetime(),
								quantity: z.number(),
								value: z.number().nullable(),
							}),
						),
						truncated: z.boolean(),
						openingQuantity: z.number().nullable(),
						windowStart: z.iso.datetime().nullable(),
						hasNegative: z.boolean(),
					}),
				),
				"Value history",
			),
			400: badQuery,
			404: itemNotFound,
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/{id}/price-history",
	"Inventory",
	viewInv,
	{
		summary: "Get an item's cost and price history",
		description: `${viewInvText} Changes to the item's cost (\`cost\`) and list price (\`price\`); prices actually charged on invoices per week or month (\`charged\`), with each sale and the client; receipts with what was paid, totals by supplier, and the weighted average cost (\`wac\`). \`created_after\` limits the cost and price series; \`bucket\` and \`range\` work as in \`consumption-trend\`.`,
		request: { params: itemParams, query: priceHistoryQuerySchema },
		responses: {
			200: json(
				envelope(
					z.object({
						cost: z.object({
							current: z.number().nullable(),
							points: z.array(
								z.object({
									at: z.iso.datetime(),
									value: z.number().nullable(),
								}),
							),
						}),
						price: z.object({
							current: z.number().nullable(),
							points: z.array(
								z.object({
									at: z.iso.datetime(),
									value: z.number().nullable(),
								}),
							),
						}),
						charged: z.record(z.string(), z.unknown()),
						recentSales: z.array(z.record(z.string(), z.unknown())),
						receipts: z.array(z.record(z.string(), z.unknown())),
						bySupplier: z.array(z.record(z.string(), z.unknown())),
						wac: z.unknown(),
						unitBasis,
						costCoverage: z.object({
							receipts: z.number().int(),
							withCost: z.number().int(),
							wacBasisReceipts: z.number().int(),
							withSupplier: z.number().int(),
						}),
						chargedWindowStart: z.iso.datetime(),
						chargedTruncated: z.boolean(),
						coverageStart: z.iso.datetime().nullable(),
						itemCreatedAt: z.iso.datetime(),
					}),
				),
				"Cost and price history",
			),
			400: badQuery,
			404: itemNotFound,
		},
	},
	inventoryOff,
);
