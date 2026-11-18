import z from "zod";
import {
	listSuppliersQuerySchema,
	createSupplierSchema,
	updateSupplierSchema,
	mergeSupplierSchema,
} from "../lib/validate/suppliers.js";
import {
	upsertSupplierItemSchema,
	updateSupplierItemSchema,
	listSupplierItemsQuerySchema,
} from "../lib/validate/supplierItems.js";
import {
	authed,
	decimal,
	envelope,
	errorEnvelope,
	json,
	moduleOff,
} from "./shared.js";

// ===============================================================================================================================
// Suppliers
// ===============================================================================================================================

const supplier = z
	.object({
		id: z.uuid(),
		name: z.string(),
		account_number: z.string().nullable(),
		contact_name: z.string().nullable(),
		phone: z.string().nullable(),
		email: z.string().nullable(),
		notes: z.string().nullable(),
		is_active: z.boolean(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		_count: z
			.object({ movements: z.number().int(), batches: z.number().int() })
			.optional()
			.describe("Only with `include_usage=true`"),
	})
	.meta({ id: "Supplier" });

const supplierConflict = errorEnvelope.extend({
	error: z.object({
		code: z.literal("CONFLICT"),
		message: z.string(),
		details: supplier.describe("The supplier that already has this name"),
	}),
});

authed(
	"get",
	"/suppliers",
	"Suppliers",
	"view_inventory or manage_inventory",
	{
		summary: "List suppliers",
		description:
			"Requires `view_inventory` or `manage_inventory`. Sorted by name. Active only unless `active` says otherwise.",
		request: { query: listSuppliersQuerySchema },
		responses: {
			200: json(
				envelope(z.array(supplier)),
				"Suppliers (empty array if none)",
			),
			400: json(errorEnvelope, "Invalid query (`VALIDATION_ERROR`)"),
		},
	},
	moduleOff("inventory"),
);

authed(
	"post",
	"/suppliers",
	"Suppliers",
	"manage_inventory",
	{
		summary: "Create a supplier",
		description:
			"Requires the `manage_inventory` permission. Names are matched ignoring case and spacing; blank optional fields are stored as null.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: createSupplierSchema.meta({
							id: "CreateSupplier",
						}),
						example: { name: "Ferguson", phone: "555-0100" },
					},
				},
			},
		},
		responses: {
			201: json(envelope(supplier), "Supplier created"),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
			409: json(
				supplierConflict,
				"A supplier with this name exists; `error.details` holds it (`CONFLICT`)",
			),
		},
	},
	moduleOff("inventory"),
);

authed(
	"patch",
	"/suppliers/{id}",
	"Suppliers",
	"manage_inventory",
	{
		summary: "Update a supplier",
		description:
			"Requires the `manage_inventory` permission. Deactivating a supplier also clears it as the preferred vendor on every item.",
		request: {
			params: z.object({ id: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: updateSupplierSchema.meta({
							id: "UpdateSupplier",
						}),
						example: { is_active: false },
					},
				},
			},
		},
		responses: {
			200: json(envelope(supplier), "Supplier updated"),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
			404: json(errorEnvelope, "Supplier not found (`NOT_FOUND`)"),
			409: json(
				supplierConflict,
				"Another supplier has this name; `error.details` holds it (`CONFLICT`)",
			),
		},
	},
	moduleOff("inventory"),
);

authed(
	"get",
	"/suppliers/{id}",
	"Suppliers",
	"view_inventory or manage_inventory",
	{
		summary: "Get a supplier",
		description:
			"Requires `view_inventory` or `manage_inventory`. Also includes `_count` with the number of stock `movements` and `batches` naming this supplier.",
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: json(envelope(supplier), "Supplier"),
			404: json(errorEnvelope, "Supplier not found (`NOT_FOUND`)"),
		},
	},
	moduleOff("inventory"),
);

const invOff = moduleOff("inventory");
const supplierParams = z.object({ id: z.uuid() });
const supplierNotFound = json(
	errorEnvelope,
	"Supplier not found (`NOT_FOUND`)",
);

authed(
	"get",
	"/suppliers/{id}/movements",
	"Suppliers",
	"view_inventory or manage_inventory",
	{
		summary: "List stock received from a supplier",
		description:
			"Requires `view_inventory` or `manage_inventory`. Stock movements attributed to the supplier, newest first, `limit` per page (default 25). Pass `nextCursor` as `cursor` for the next page.",
		request: {
			params: supplierParams,
			query: z.object({
				cursor: z.string().optional(),
				limit: z.coerce.number().int().optional(),
			}),
		},
		responses: {
			200: json(
				envelope(
					z.object({
						movements: z.array(
							z
								.record(z.string(), z.unknown())
								.describe("A ledger row"),
						),
						nextCursor: z.string().nullable(),
					}),
				),
				"A page of movements",
			),
			404: supplierNotFound,
		},
	},
	invOff,
);

authed(
	"get",
	"/suppliers/{id}/batches",
	"Suppliers",
	"view_inventory or manage_inventory",
	{
		summary: "List lots from a supplier",
		description:
			"Requires `view_inventory` or `manage_inventory`. Batches whose supplier is this one.",
		request: { params: supplierParams },
		responses: {
			200: json(
				envelope(
					z.object({
						batches: z.array(z.record(z.string(), z.unknown())),
					}),
				),
				"Batches",
			),
			404: supplierNotFound,
		},
	},
	invOff,
);

authed(
	"post",
	"/suppliers/{id}/merge",
	"Suppliers",
	"manage_inventory",
	{
		summary: "Merge a supplier into another",
		description:
			"Requires the `manage_inventory` permission. Moves this supplier's stock movements, lots and item prices onto `target_id` (filling gaps in the target's prices from this one), then deactivates this one. Purchase orders, field purchases and QuickBooks links stay on this supplier.",
		request: {
			params: supplierParams,
			body: {
				content: {
					"application/json": {
						schema: mergeSupplierSchema.meta({
							id: "MergeSupplier",
						}),
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(
					z.object({
						moved: z
							.record(z.string(), z.number().int())
							.describe("Rows moved, per kind"),
						target: supplier,
					}),
				),
				"Merged",
			),
			400: json(
				errorEnvelope,
				"Validation failed, merging into itself, or the target is deactivated (`VALIDATION_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"This supplier or the target not found (`NOT_FOUND`)",
			),
		},
	},
	invOff,
);

const supplierItem = z
	.object({
		id: z.uuid(),
		supplier_id: z.uuid(),
		inventory_item_id: z.uuid(),
		vendor_sku: z.string().nullable(),
		contract_price: z.number().nullable().describe("Agreed price"),
		last_price: z
			.number()
			.nullable()
			.describe("What was last paid, from receipts"),
		last_purchased_at: z.iso.datetime().nullable(),
		is_preferred: z.boolean(),
		lead_time_days: z.number().int().nullable(),
		min_order_qty: z.number().nullable(),
		notes: z.string().nullable(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
	})
	.catchall(z.unknown())
	.meta({ id: "SupplierItem" });
const supplierItemParams = z.object({ id: z.uuid() });
const supplierItemNotFound = json(
	errorEnvelope,
	"Supplier item not found (`NOT_FOUND`)",
);

authed(
	"get",
	"/supplier-items",
	"Suppliers",
	"view_inventory or manage_inventory",
	{
		summary: "List supplier prices",
		description:
			"Requires `view_inventory` or `manage_inventory`. What each supplier charges for each item; filter by supplier or item.",
		request: { query: listSupplierItemsQuerySchema },
		responses: {
			200: json(
				envelope(z.array(supplierItem)),
				"Supplier items (empty array if none)",
			),
			400: json(errorEnvelope, "Invalid query (`VALIDATION_ERROR`)"),
		},
	},
	invOff,
);

authed(
	"post",
	"/supplier-items",
	"Suppliers",
	"manage_inventory",
	{
		summary: "Set a supplier's price for an item",
		description:
			"Requires the `manage_inventory` permission. Creates the supplier-item pair, or updates it if it exists. `is_preferred: true` makes this the item's preferred supplier. `last_price` is recorded from receipts and can't be set.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: upsertSupplierItemSchema.meta({
							id: "UpsertSupplierItem",
						}),
						example: {
							supplier_id: "3f6c2a1e-8b4d-4c2a-9e1f-1a2b3c4d5e6f",
							inventory_item_id:
								"9b1d2c3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e",
							contract_price: 42.5,
							vendor_sku: "R410A-25",
						},
					},
				},
			},
		},
		responses: {
			201: json(envelope(supplierItem), "Saved (201 for an update too)"),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
			404: json(
				errorEnvelope,
				"Supplier or inventory item not found (`NOT_FOUND`)",
			),
		},
	},
	invOff,
);

authed(
	"patch",
	"/supplier-items/{id}",
	"Suppliers",
	"manage_inventory",
	{
		summary: "Update a supplier price",
		description: "Requires the `manage_inventory` permission.",
		request: {
			params: supplierItemParams,
			body: {
				content: {
					"application/json": {
						schema: updateSupplierItemSchema.meta({
							id: "UpdateSupplierItem",
						}),
					},
				},
			},
		},
		responses: {
			200: json(envelope(supplierItem), "Updated"),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
			404: supplierItemNotFound,
		},
	},
	invOff,
);

authed(
	"post",
	"/supplier-items/{id}/prefer",
	"Suppliers",
	"manage_inventory",
	{
		summary: "Make a supplier the preferred one for an item",
		description:
			"Requires the `manage_inventory` permission. Clears the flag on the item's other suppliers.",
		request: { params: supplierItemParams },
		responses: {
			200: json(envelope(supplierItem), "Preferred"),
			404: supplierItemNotFound,
		},
	},
	invOff,
);

authed(
	"delete",
	"/supplier-items/{id}",
	"Suppliers",
	"manage_inventory",
	{
		summary: "Remove a supplier price",
		description: "Requires the `manage_inventory` permission.",
		request: { params: supplierItemParams },
		responses: {
			200: json(envelope(z.object({ id: z.uuid() })), "Removed"),
			404: supplierItemNotFound,
		},
	},
	invOff,
);
