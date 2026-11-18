import z from "zod";
import {
	createPurchaseSchema,
	updatePurchaseSchema,
	cancelPurchaseSchema,
	listPurchasesQuerySchema,
	replaceLinesSchema,
	receivePurchaseSchema,
} from "../lib/validate/purchases.js";
import {
	authed,
	decimal,
	envelope,
	errorEnvelope,
	idName,
	json,
	moduleOff,
} from "./shared.js";

export { allocation };

// ===============================================================================================================================
// Purchases
// ===============================================================================================================================

const purchaseLine = z
	.object({
		id: z.uuid(),
		description: z.string(),
		quantity: decimal,
		unit_price: decimal,
		line_total: decimal,
		inventory_item_id: z.uuid().nullable(),
		disposition: z.enum(["consume", "receive", "non_stock"]).nullable(),
		disposition_location: z.string().nullable(),
		disposition_vehicle_id: z.uuid().nullable(),
		quantity_recieved: z
			.string()
			.describe(
				"Decimal as a string. Field name is misspelled in the API.",
			),
		received_at: z.iso.datetime().nullable(),
		allocation_id: z.uuid().nullable(),
		sort_order: z.number().int(),
	})
	.meta({ id: "PurchaseLine" });

const allocation = z.object({
	id: z.uuid(),
	job_id: z.uuid(),
	job_visit_id: z.uuid().nullable(),
	amount: decimal,
});

const purchase = z
	.object({
		id: z.uuid(),
		status: z.enum([
			"draft",
			"ordered",
			"partially_received",
			"received",
			"cancelled",
		]),
		kind: z.enum(["purchase", "refund"]),
		purchase_number: z.string(),
		vendor_name: z.string().nullable(),
		supplier_id: z.uuid().nullable(),
		purchased_at: z.iso.datetime().nullable(),
		subtotal: decimal,
		tax_group_id: z.uuid().nullable(),
		tax_amount: decimal,
		total: decimal,
		submitted_at: z.iso.datetime().nullable(),
		cancelled_at: z.iso.datetime().nullable(),
		cancellation_reason: z.string().nullable(),
		flags: z.array(z.unknown()),
		qb_purchase_id: z.string().nullable(),
		qb_sync_status: z.enum([
			"not_synced",
			"synced",
			"failed",
			"tax_mismatch",
		]),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		supplier: idName.nullable(),
		tax_group: idName.nullable(),
		lines: z.array(purchaseLine),
		allocations: z.array(allocation),
	})
	.meta({ id: "Purchase" });

const purchaseResult = envelope(z.object({ purchase }));

authed(
	"get",
	"/purchases",
	"Purchases",
	"view_purchases or manage_purchases",
	{
		summary: "List purchases",
		description:
			"Requires `view_purchases` or `manage_purchases`. Planned vendor purchases, newest submitted first by default. `data.total` is the row count before paging.",
		request: { query: listPurchasesQuerySchema },
		responses: {
			200: json(
				envelope(
					z.object({
						purchases: z.array(purchase),
						total: z.number().int(),
						offset: z.number().int(),
					}),
				),
				"One page of purchases",
			),
			400: json(errorEnvelope, "Invalid query (`VALIDATION_ERROR`)"),
		},
	},
	moduleOff("purchasing"),
);

authed(
	"post",
	"/purchases",
	"Purchases",
	"manage_purchases",
	{
		summary: "Create a purchase",
		description:
			"Requires the `manage_purchases` permission. Created as a `draft` with the next purchase number. A line's `job_id` must be one of `allocations` and only works on a `non_stock` line.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: createPurchaseSchema.meta({
							id: "CreatePurchase",
						}),
						example: {
							vendor_name: "Ferguson",
							supplier_id: "3f1c2a9e-8b7d-4c6e-9a1f-2d3e4b5c6d7e",
							lines: [
								{
									description: "1/2in copper elbow",
									quantity: 10,
									unit_price: 1.25,
									disposition: "receive",
								},
							],
						},
					},
				},
			},
		},
		responses: {
			201: json(purchaseResult, "Purchase created"),
			400: json(
				errorEnvelope,
				"Validation failed, duplicate job in `allocations`, or an unknown job, vehicle or supplier (`VALIDATION_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"A referenced inventory item wasn't found (`NOT_FOUND`)",
			),
		},
	},
	moduleOff("purchasing"),
);

authed(
	"patch",
	"/purchases/{id}",
	"Purchases",
	"manage_purchases",
	{
		summary: "Update a draft purchase",
		description:
			"Requires the `manage_purchases` permission. Draft only. Despite PATCH, `vendor_name` and `supplier_id` are required. Lines are not edited here.",
		request: {
			params: z.object({ id: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: updatePurchaseSchema.meta({
							id: "UpdatePurchase",
						}),
						example: {
							vendor_name: "Ferguson",
							supplier_id: "3f1c2a9e-8b7d-4c6e-9a1f-2d3e4b5c6d7e",
							tax_amount: 4.5,
						},
					},
				},
			},
		},
		responses: {
			200: json(purchaseResult, "Purchase updated"),
			400: json(
				errorEnvelope,
				"Validation failed, purchase is no longer a draft, or an unknown supplier or job (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Purchase not found (`NOT_FOUND`)"),
		},
	},
	moduleOff("purchasing"),
);

authed(
	"post",
	"/purchases/{id}/cancel",
	"Purchases",
	"manage_purchases",
	{
		summary: "Cancel a purchase",
		description:
			"Requires the `manage_purchases` permission. Only `draft`, `ordered` or `partially_received` purchases can be cancelled.",
		request: {
			params: z.object({ id: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: cancelPurchaseSchema.meta({
							id: "CancelPurchase",
						}),
						example: { cancellation_reason: "Vendor out of stock" },
					},
				},
			},
		},
		responses: {
			200: json(purchaseResult, "Purchase cancelled"),
			400: json(
				errorEnvelope,
				"Validation failed, or the purchase can no longer be cancelled (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Purchase not found (`NOT_FOUND`)"),
		},
	},
	moduleOff("purchasing"),
);

const purchaseEvents = z
	.array(z.record(z.string(), z.unknown()))
	.describe("The purchase's event history, oldest first");

authed(
	"get",
	"/purchases/{id}",
	"Purchases",
	"view_purchases or manage_purchases",
	{
		summary: "Get a purchase",
		description:
			"Requires `view_purchases` or `manage_purchases`. Returns the purchase and its event history.",
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: json(
				envelope(z.object({ purchase, events: purchaseEvents })),
				"Purchase",
			),
			404: json(errorEnvelope, "Purchase not found (`NOT_FOUND`)"),
		},
	},
	moduleOff("purchasing"),
);

authed(
	"delete",
	"/purchases/{id}",
	"Purchases",
	"manage_purchases",
	{
		summary: "Delete a purchase",
		description:
			"Requires the `manage_purchases` permission. Only `draft` purchases can be deleted; cancel others instead.",
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: json(
				envelope(z.object({ deleted: z.literal(true) })),
				"Deleted",
			),
			400: json(
				errorEnvelope,
				"Purchase isn't a draft (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Purchase not found (`NOT_FOUND`)"),
		},
	},
	moduleOff("purchasing"),
);

const poOff = moduleOff("purchasing");
const poParams = z.object({ id: z.uuid() });
const poOut = (text: string) => json(envelope(z.object({ purchase })), text);
const poNotFound = json(errorEnvelope, "Purchase not found (`NOT_FOUND`)");

authed(
	"put",
	"/purchases/{id}/lines",
	"Purchases",
	"manage_purchases",
	{
		summary: "Replace a purchase order's lines",
		description:
			"Requires the `manage_purchases` permission. Drafts only. Replaces every line; only `receive` lines take a destination vehicle, and a line's job must be one the order covers.",
		request: {
			params: poParams,
			body: {
				content: {
					"application/json": {
						schema: replaceLinesSchema.meta({
							id: "ReplacePurchaseLines",
						}),
					},
				},
			},
		},
		responses: {
			200: poOut("Lines replaced"),
			400: json(
				errorEnvelope,
				"Not a draft, validation failed, or another error with its raw message (`VALIDATION_ERROR`)",
			),
			404: poNotFound,
		},
	},
	poOff,
);

authed(
	"post",
	"/purchases/{id}/order",
	"Purchases",
	"manage_purchases",
	{
		summary: "Place a purchase order",
		description:
			"Requires the `manage_purchases` permission. Moves a draft with at least one line to `ordered`, ready to receive.",
		request: { params: poParams },
		responses: {
			200: poOut("Ordered"),
			400: json(
				errorEnvelope,
				"Not a draft, no lines, or another error with its raw message (`VALIDATION_ERROR`)",
			),
			404: poNotFound,
		},
	},
	poOff,
);

authed(
	"post",
	"/purchases/{id}/receive",
	"Purchases",
	"manage_purchases",
	{
		summary: "Receive a purchase order",
		description:
			"Requires the `manage_purchases` permission. Records what arrived on an `ordered` or `partially_received` order: each line's `quantity_received`, and where it goes (a vehicle or a warehouse `location`). Stock is added; the order becomes `partially_received` or `received`. `warnings` lists anything worth checking.",
		request: {
			params: poParams,
			body: {
				content: {
					"application/json": {
						schema: receivePurchaseSchema.meta({
							id: "ReceivePurchase",
						}),
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(z.object({ purchase, warnings: z.array(z.string()) })),
				"Received",
			),
			400: json(
				errorEnvelope,
				"Not ordered, an unknown line, a line with nowhere to receive into, validation failed, or another error with its raw message (`VALIDATION_ERROR`)",
			),
			404: poNotFound,
		},
	},
	poOff,
);

authed(
	"get",
	"/purchases/{id}/pdf",
	"Purchases",
	"view_purchases or manage_purchases",
	{
		summary: "Download a purchase order PDF",
		description:
			"Requires `view_purchases` or `manage_purchases`. Sent as `purchase-{id}.pdf`.",
		request: { params: poParams },
		responses: {
			200: {
				description: "The PDF",
				content: {
					"application/pdf": {
						schema: z.string().meta({ format: "binary" }),
					},
				},
			},
			404: poNotFound,
		},
	},
	poOff,
);
