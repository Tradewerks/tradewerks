import z from "zod";
import {
	createMaintenanceRecordSchema,
	updateMaintenanceRecordSchema,
	createMaintenanceReminderSchema,
	updateMaintenanceReminderSchema,
	createVehicleSchema,
	updateVehicleSchema,
} from "../lib/validate/vehicles.js";
import {
	authed,
	decimal,
	envelope,
	errorEnvelope,
	historyQuery,
	historyResponses,
	idName,
	json,
	moduleOff,
} from "./shared.js";
import { coords } from "./requestsQuotes.js";

// ===============================================================================================================================
// Vehicles
// ===============================================================================================================================

const vehicle = z
	.object({
		id: z.uuid(),
		name: z.string(),
		type: z.string(),
		license_plate: z.string().nullable(),
		year: z.number().int().nullable(),
		make: z.string().nullable(),
		model: z.string().nullable(),
		status: z.string().describe("`active` or `inactive`"),
		color: z.string().nullable(),
		notes: z.string().nullable(),
		current_odometer_mi: z.number().int().nullable(),
		odometer_updated_at: z.iso.datetime().nullable(),
		stored_at: z.string().nullable(),
		stored_at_coords: coords.nullable(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		current_technicians: z.array(idName),
		stock_items: z
			.array(z.record(z.string(), z.unknown()))
			.describe("Stock rows, each with its full `inventory_item`"),
	})
	.meta({ id: "Vehicle" });

const maintenanceRecord = z
	.object({
		id: z.uuid(),
		vehicle_id: z.uuid(),
		category: z.enum([
			"oil_change",
			"fluids",
			"tire",
			"brake",
			"inspection",
			"registration",
			"repair",
			"other",
		]),
		performed_at: z.iso.datetime(),
		odometer_mi: z.number().int().nullable(),
		interval_miles: z.number().int().nullable(),
		interval_months: z.number().int().nullable(),
		cost: decimal.nullable(),
		vendor_name: z.string().nullable(),
		notes: z.string().nullable(),
		performed_by_id: z
			.uuid()
			.nullable()
			.describe("Dispatcher who logged it"),
		performed_by_tech_id: z
			.uuid()
			.nullable()
			.describe("Technician who logged it"),
		source_purchase_line_id: z.uuid().nullable(),
		source_field_purchase_line_id: z.uuid().nullable(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
	})
	.meta({ id: "MaintenanceRecord" });

authed(
	"get",
	"/vehicles",
	"Vehicles",
	"view_vehicles or manage_vehicles or use_vehicles",
	{
		summary: "List vehicles",
		description:
			"Requires `view_vehicles`, `manage_vehicles` or `use_vehicles`. Sorted by name.",
		request: {
			query: z.object({
				status: z
					.string()
					.optional()
					.describe(
						"Exact match, e.g. `active` or `inactive`. Omit for all.",
					),
			}),
		},
		responses: {
			200: json(
				envelope(z.array(vehicle)),
				"Vehicles (empty array if none)",
			),
		},
	},
	moduleOff("fleet"),
);

authed(
	"get",
	"/vehicles/maintenance-alerts",
	"Vehicles",
	"view_vehicles or manage_vehicles or use_vehicles or stock_own_vehicle",
	{
		summary: "List maintenance alerts",
		description:
			"Requires `view_vehicles`, `manage_vehicles`, `use_vehicles` or `stock_own_vehicle`. Open reminders that are overdue or due soon, unacknowledged first. A technician sees only their current vehicle's, or every vehicle's if they have none.",
		responses: {
			200: json(
				envelope(
					z.array(
						z
							.object({
								reminderId: z.uuid(),
								vehicleId: z.uuid(),
								vehicleName: z.string(),
								category: z.string(),
								title: z.string(),
								status: z.enum(["overdue", "duesoon"]),
								dueAt: z.iso.datetime().nullable(),
								dueOdometerMi: z.number().int().nullable(),
								currentOdometerMi: z.number().int().nullable(),
								acknowledged: z.boolean(),
							})
							.meta({ id: "MaintenanceAlert" }),
					),
				),
				"Alerts (empty array if none)",
			),
		},
	},
	moduleOff("fleet"),
);

authed(
	"post",
	"/vehicles/{id}/maintenance",
	"Vehicles",
	"manage_vehicles or use_vehicles",
	{
		summary: "Log vehicle maintenance",
		description:
			"Requires `manage_vehicles` or `use_vehicles`. Updates the odometer from `odometer_mi`, and resets or completes each reminder in `reminder_ids`. Returns 200, not 201.",
		request: {
			params: z.object({ id: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: createMaintenanceRecordSchema.meta({
							id: "CreateMaintenanceRecord",
						}),
						example: {
							category: "oil_change",
							performed_at: "2026-11-01",
							odometer_mi: 48210,
							cost: 79.99,
						},
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(maintenanceRecord),
				"Maintenance record created",
			),
			404: json(
				errorEnvelope,
				"Vehicle not found, validation failed, or a source purchase line belongs to another vehicle (`NOT_FOUND`)",
			),
		},
	},
	moduleOff("fleet"),
);

const vehicleRow = vehicle.omit({
	current_technicians: true,
	stock_items: true,
});

authed(
	"post",
	"/vehicles",
	"Vehicles",
	"manage_vehicles",
	{
		summary: "Create a vehicle",
		description: "Requires the `manage_vehicles` permission.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: createVehicleSchema.meta({
							id: "CreateVehicle",
						}),
					},
				},
			},
		},
		responses: {
			201: json(envelope(vehicleRow), "Vehicle created"),
			400: json(
				errorEnvelope,
				"Validation failed, or the insert failed (`VALIDATION_ERROR`)",
			),
		},
	},
	moduleOff("fleet"),
);

authed(
	"put",
	"/vehicles/{id}",
	"Vehicles",
	"manage_technicians",
	{
		summary: "Update a vehicle",
		description:
			"Requires the `manage_technicians` permission (not `manage_vehicles`). Send only the fields to change.",
		request: {
			params: z.object({ id: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: updateVehicleSchema.meta({
							id: "UpdateVehicle",
						}),
					},
				},
			},
		},
		responses: {
			200: json(envelope(vehicleRow), "Vehicle updated"),
			400: json(
				errorEnvelope,
				"Validation failed, or the update failed (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Vehicle not found (`VALIDATION_ERROR`)"),
		},
	},
	moduleOff("fleet"),
);

// Vehicle stock: what each vehicle carries, restocking it from the warehouse, and
// technicians' restock requests. All of it also needs the `vehicle_stock` module.
const stockOff = `${moduleOff("fleet")}; or the \`vehicle_stock\` module is off`;
const ownVehicle =
	"Technicians need `{perm}` and can only act on their current vehicle; `manage_inventory` or `manage_technicians` can act on any vehicle.";
const ownOnly = (perm: string) => ownVehicle.replace("{perm}", perm);
const vehicleParams = z.object({ id: z.uuid() });
const stockItemParams = vehicleParams.extend({ itemId: z.uuid() });
const vehicleNotFound = json(errorEnvelope, "Vehicle not found (`NOT_FOUND`)");
const loose = (text: string) =>
	z.record(z.string(), z.unknown()).describe(text);
const stockQty = z.number().min(0);
const trackingPicks = {
	serial_unit_ids: z
		.array(z.uuid())
		.optional()
		.describe("Serialized items: which units"),
	batch_picks: z
		.array(z.object({ batch_id: z.uuid(), qty: z.number().positive() }))
		.optional()
		.describe("Batch-tracked items: which lots"),
};
const lineResult = z.object({
	reason_code: z.string(),
	message: z.string().optional(),
	serial_codes: z.array(z.string()).optional(),
	lot_codes: z.array(z.string()).optional(),
});
const vehicleStockItem = loose(
	"A stock row: `id`, `vehicle_id`, `inventory_item_id`, `qty_on_hand`, `qty_min`, `qty_standard`, and the full `inventory_item` (cost included)",
);

authed(
	"get",
	"/vehicles/stock-conflicts",
	"Vehicles",
	"view_inventory or manage_technicians or use_vehicles or stock_own_vehicle",
	{
		summary: "List upcoming visits short on stock",
		description:
			"Requires any of `view_inventory`, `manage_technicians`, `use_vehicles` or `stock_own_vehicle`. Upcoming visits whose planned parts the assigned vehicle doesn't carry enough of (`severity` `out` or `low`). Technicians see only their current vehicle's visits, or every vehicle's if they have none.",
		responses: {
			200: json(
				envelope(
					z.array(
						z.object({
							visitId: z.uuid(),
							jobId: z.uuid(),
							vehicleId: z.uuid(),
							vehicleName: z.string(),
							techNames: z.array(z.string()),
							visitName: z.string(),
							clientName: z.string(),
							scheduledAt: z.iso.datetime(),
							severity: z.enum(["out", "low"]),
							conflicts: z.array(
								z.object({
									inventoryItemId: z.uuid(),
									itemName: z.string(),
									qtyNeeded: z.number(),
									qtyOnHand: z.number(),
								}),
							),
						}),
					),
				),
				"Conflicts (empty array if none)",
			),
		},
	},
	stockOff,
);

authed(
	"get",
	"/vehicles/restock-requests",
	"Vehicles",
	"view_inventory or manage_technicians",
	{
		summary: "List restock requests",
		description:
			"Requires `view_inventory` or `manage_technicians`. Technicians' requests for more of an item on their vehicle, across the fleet, newest first, at most 100.",
		request: {
			query: z.object({
				status: z
					.enum(["pending", "acknowledged", "resolved", "dismissed"])
					.optional(),
				vehicleId: z.uuid().optional(),
			}),
		},
		responses: {
			200: json(
				envelope(
					z.array(
						loose(
							"A request: `id`, `status`, `qty_requested`, `note`, `created_at`, the `stock_item` with its `inventory_item` and `vehicle`, and the requesting technician",
						),
					),
				),
				"Requests (empty array if none)",
			),
			500: json(errorEnvelope, "The lookup failed (`SERVER_ERROR`)"),
		},
	},
	stockOff,
);

authed(
	"post",
	"/vehicles/restock-requests/{requestId}/acknowledge",
	"Vehicles",
	"manage_inventory or manage_technicians",
	{
		summary: "Acknowledge a restock request",
		description:
			"Requires `manage_inventory` or `manage_technicians`. Marks a `pending` request `acknowledged`. Office users only.",
		request: { params: z.object({ requestId: z.uuid() }) },
		responses: {
			200: json(envelope(loose("The request")), "Acknowledged"),
			400: json(
				errorEnvelope,
				"Not an office user, the request isn't pending, or the update failed (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Request not found (`NOT_FOUND`)"),
		},
	},
	stockOff,
);

authed(
	"post",
	"/vehicles/restock-requests/{requestId}/dismiss",
	"Vehicles",
	"manage_inventory or manage_technicians",
	{
		summary: "Dismiss a restock request",
		description:
			"Requires `manage_inventory` or `manage_technicians`. Dismisses a `pending` or `acknowledged` request.",
		request: { params: z.object({ requestId: z.uuid() }) },
		responses: {
			200: json(envelope(loose("The request")), "Dismissed"),
			400: json(errorEnvelope, "The update failed (`VALIDATION_ERROR`)"),
			404: json(errorEnvelope, "Request not found (`NOT_FOUND`)"),
			409: json(
				errorEnvelope,
				"Already resolved or dismissed (`CONFLICT`)",
			),
		},
	},
	stockOff,
);

authed(
	"get",
	"/vehicles/{id}/stock",
	"Vehicles",
	"view_vehicles or manage_vehicles or use_vehicles or stock_own_vehicle or complete_own_restock",
	{
		summary: "List a vehicle's stock",
		description:
			"Requires any of `view_vehicles`, `manage_vehicles`, `use_vehicles`, `stock_own_vehicle` or `complete_own_restock`. Any vehicle in the organization.",
		request: { params: vehicleParams },
		responses: {
			200: json(
				envelope(z.array(vehicleStockItem)),
				"Stock (empty array if none)",
			),
			404: vehicleNotFound,
		},
	},
	stockOff,
);

authed(
	"post",
	"/vehicles/{id}/stock",
	"Vehicles",
	"stock_own_vehicle",
	{
		summary: "Add an item to a vehicle's stock list",
		description: `${ownOnly("stock_own_vehicle")} Adds an inventory item the vehicle should carry, with its minimum and standard quantities. A starting \`qty_on_hand\` is recorded as an adjustment, not taken from the warehouse.`,
		request: {
			params: vehicleParams,
			body: {
				content: {
					"application/json": {
						schema: z
							.object({
								inventory_item_id: z.uuid(),
								qty_on_hand: stockQty
									.optional()
									.describe("Default 0"),
								qty_min: stockQty
									.optional()
									.describe("Default 0"),
								qty_standard: stockQty.nullable().optional(),
							})
							.meta({ id: "AddVehicleStockItem" }),
						example: {
							inventory_item_id:
								"3f6c2a1e-8b4d-4c2a-9e1f-1a2b3c4d5e6f",
							qty_min: 2,
							qty_standard: 6,
						},
					},
				},
			},
		},
		responses: {
			201: json(envelope(vehicleStockItem), "Added"),
			400: json(
				errorEnvelope,
				"Validation failed, the item is already on the vehicle, or the insert failed (`VALIDATION_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"Vehicle or inventory item not found (`VALIDATION_ERROR`)",
			),
		},
	},
	stockOff,
);

authed(
	"put",
	"/vehicles/{id}/stock/{itemId}",
	"Vehicles",
	"stock_own_vehicle",
	{
		summary: "Update a vehicle stock row",
		description: `${ownOnly("stock_own_vehicle")} \`itemId\` is the stock row's id. Changing \`qty_on_hand\` records the difference as an adjustment, not a warehouse move.`,
		request: {
			params: stockItemParams,
			body: {
				content: {
					"application/json": {
						schema: z
							.object({
								qty_on_hand: stockQty.optional(),
								qty_min: stockQty.optional(),
								qty_standard: stockQty.nullable().optional(),
							})
							.meta({ id: "UpdateVehicleStockItem" }),
					},
				},
			},
		},
		responses: {
			200: json(envelope(vehicleStockItem), "Updated"),
			400: json(
				errorEnvelope,
				"Validation failed, or the update failed (`VALIDATION_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"Stock row not found on this vehicle (`VALIDATION_ERROR`)",
			),
		},
	},
	stockOff,
);

authed(
	"delete",
	"/vehicles/{id}/stock/{itemId}",
	"Vehicles",
	"stock_own_vehicle",
	{
		summary: "Remove an item from a vehicle's stock list",
		description: `${ownOnly("stock_own_vehicle")} Not allowed once the row has usage, restock or adjustment history.`,
		request: { params: stockItemParams },
		responses: {
			200: json(envelope(z.null()), "Removed (`data` is null)"),
			400: json(
				errorEnvelope,
				"The row has history, its quantity doesn't match its movements (run an audit adjustment), or the delete failed (`DELETE_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"Stock row not found on this vehicle (`DELETE_ERROR`)",
			),
		},
	},
	stockOff,
);

const fillLine = z.object({
	inventory_item_id: z.uuid(),
	name: z.string(),
	unit: z.string(),
	on_hand: z.number(),
	target: z.number(),
	suggested_qty: z.number(),
	warehouse_available: z.number(),
});

authed(
	"get",
	"/vehicles/{id}/stock/fill-plan",
	"Vehicles",
	"stock_own_vehicle",
	{
		summary: "Suggest what to load onto a vehicle",
		description: `${ownOnly("stock_own_vehicle")} \`standard\` tops each item up to its standard quantity; \`visits\` covers parts today's visits need that the vehicle is short on. Nothing is moved.`,
		request: { params: vehicleParams },
		responses: {
			200: json(
				envelope(
					z.object({
						standard: z.array(fillLine),
						visits: z.array(fillLine),
					}),
				),
				"Fill plan",
			),
			404: json(
				errorEnvelope,
				"Vehicle not found, or readiness couldn't be loaded (`NOT_FOUND`)",
			),
		},
	},
	stockOff,
);

authed(
	"post",
	"/vehicles/{id}/stock/fill",
	"Vehicles",
	"stock_own_vehicle",
	{
		summary: "Load stock onto a vehicle",
		description: `${ownOnly("stock_own_vehicle")} Moves each line's \`qty\` from the warehouse to the vehicle, adding stock rows as needed. If the warehouse has less, what's there is moved and the rest is reported as \`shortfall\`.`,
		request: {
			params: vehicleParams,
			body: {
				content: {
					"application/json": {
						schema: z
							.object({
								lines: z
									.array(
										z.object({
											inventory_item_id: z.uuid(),
											qty: z.number().int().positive(),
											...trackingPicks,
										}),
									)
									.min(1),
							})
							.meta({ id: "FillVehicle" }),
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(
					z.array(
						lineResult.extend({
							inventory_item_id: z.uuid(),
							qty_moved: z.number(),
							shortfall: z.number(),
						}),
					),
				),
				"What moved, per line",
			),
			400: json(
				errorEnvelope,
				"Validation failed, or the move failed (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Vehicle not found (`VALIDATION_ERROR`)"),
		},
	},
	stockOff,
);

authed(
	"post",
	"/vehicles/{id}/restock",
	"Vehicles",
	"complete_own_restock",
	{
		summary: "Restock a vehicle",
		description: `${ownOnly("complete_own_restock")} Moves \`qty_to_restock\` of each stock row from the warehouse and records a restock. \`mode\` is only stored on the record. Stock moved onto the vehicle resolves its open restock requests for those items.`,
		request: {
			params: vehicleParams,
			body: {
				content: {
					"application/json": {
						schema: z
							.object({
								notes: z
									.string()
									.max(500)
									.nullable()
									.optional(),
								mode: z
									.enum(["restock", "prepare"])
									.optional()
									.describe('Default "restock"'),
								restock_lines: z.array(
									z.object({
										stock_item_id: z.uuid(),
										qty_to_restock: z.number().int().min(0),
										...trackingPicks,
									}),
								),
							})
							.meta({ id: "CompleteRestock" }),
					},
				},
			},
		},
		responses: {
			201: json(
				envelope(
					loose(
						"The restock record (`restock_lines`, `completed_by`/`completed_by_tech`, `completed_at`, …) plus `line_details`",
					).meta({ description: "Restock record" }),
				),
				"Restocked",
			),
			400: json(
				errorEnvelope,
				"Validation failed, duplicate stock rows, or the move failed (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Vehicle not found (`VALIDATION_ERROR`)"),
		},
	},
	stockOff,
);

authed(
	"get",
	"/vehicles/{id}/restock/today",
	"Vehicles",
	"view_inventory or manage_inventory or manage_technicians or use_inventory",
	{
		summary: "Get today's restock",
		description:
			"Requires any of `view_inventory`, `manage_inventory`, `manage_technicians` or `use_inventory`. The vehicle's latest restock today (in the organization's timezone), or null.",
		request: { params: vehicleParams },
		responses: {
			200: json(
				envelope(loose("Restock record").nullable()),
				"Today's restock, or null",
			),
			404: vehicleNotFound,
		},
	},
	stockOff,
);

authed(
	"get",
	"/vehicles/{id}/restock/history",
	"Vehicles",
	"view_inventory or manage_inventory or manage_technicians or use_inventory or stock_own_vehicle",
	{
		summary: "List a vehicle's restocks",
		description:
			"Requires any of `view_inventory`, `manage_inventory`, `manage_technicians`, `use_inventory` or `stock_own_vehicle`. The last 30, newest first.",
		request: { params: vehicleParams },
		responses: {
			200: json(
				envelope(z.array(loose("Restock record"))),
				"Restocks (empty array if none)",
			),
			404: vehicleNotFound,
		},
	},
	stockOff,
);

authed(
	"post",
	"/vehicles/{id}/stock/adjust",
	"Vehicles",
	"stock_own_vehicle",
	{
		summary: "Adjust a vehicle's stock",
		description: `${ownOnly("stock_own_vehicle")} Sets each line's quantity to \`qty_after\` and records why: \`warehouse_exchange\` (swap with the warehouse), \`field_loss\`, \`transfer\` (to \`target_vehicle_id\`, or out of stock) or \`audit\`. Technicians also need \`adjust_<type>\` for the type. Lines name a stock row or an inventory item, not both.`,
		request: {
			params: vehicleParams,
			body: {
				content: {
					"application/json": {
						schema: z
							.object({
								type: z.enum([
									"warehouse_exchange",
									"field_loss",
									"transfer",
									"audit",
								]),
								note: z.string().max(500).nullable().optional(),
								target_vehicle_id: z
									.uuid()
									.optional()
									.describe("Transfers only"),
								lines: z
									.array(
										z.object({
											stock_item_id: z.uuid().optional(),
											inventory_item_id: z
												.uuid()
												.optional(),
											qty_after: stockQty,
											...trackingPicks,
										}),
									)
									.min(1),
							})
							.meta({ id: "AdjustVehicleStock" }),
						example: {
							type: "audit",
							lines: [
								{
									stock_item_id:
										"3f6c2a1e-8b4d-4c2a-9e1f-1a2b3c4d5e6f",
									qty_after: 4,
								},
							],
						},
					},
				},
			},
		},
		responses: {
			201: json(
				envelope(loose("The adjustment, with its lines")),
				"Adjusted",
			),
			400: json(
				errorEnvelope,
				"Validation failed, `target_vehicle_id` on a non-transfer or the same vehicle, or the update failed (`VALIDATION_ERROR`)",
			),
			403: json(
				errorEnvelope,
				"Technician without `adjust_<type>`, or not their current vehicle (`INVALID_CREDENTIALS`)",
			),
			404: json(
				errorEnvelope,
				"Vehicle, target vehicle or stock row not found (`VALIDATION_ERROR`)",
			),
			409: json(
				errorEnvelope,
				"Not enough warehouse stock for an exchange; `error.details.available` says how much (`VALIDATION_ERROR`)",
			),
		},
	},
	stockOff,
);

authed(
	"get",
	"/vehicles/{id}/stock/adjustments",
	"Vehicles",
	"view_inventory or manage_inventory or manage_technicians or use_inventory or stock_own_vehicle",
	{
		summary: "List a vehicle's stock adjustments",
		description:
			"Requires any of `view_inventory`, `manage_inventory`, `manage_technicians`, `use_inventory` or `stock_own_vehicle`. The last 50, newest first.",
		request: { params: vehicleParams },
		responses: {
			200: json(
				envelope(z.array(loose("Adjustment, with lines"))),
				"Adjustments (empty array if none)",
			),
			404: vehicleNotFound,
		},
	},
	stockOff,
);

authed(
	"get",
	"/vehicles/{id}/usage-today",
	"Vehicles",
	"view_inventory or manage_technicians or use_inventory",
	{
		summary: "List parts used from a vehicle today",
		description:
			"Requires any of `view_inventory`, `manage_technicians` or `use_inventory`. Parts used on today's visits, grouped by item.",
		request: { params: vehicleParams },
		responses: {
			200: json(
				envelope(z.array(loose("Item with its uses today"))),
				"Usage (empty array if none)",
			),
			404: vehicleNotFound,
		},
	},
	stockOff,
);

authed(
	"get",
	"/vehicles/{id}/tomorrow-requirements",
	"Vehicles",
	"view_inventory or manage_technicians",
	{
		summary: "List parts needed for tomorrow",
		description:
			"Requires `view_inventory` or `manage_technicians`. Tomorrow's visits for this vehicle and the parts each needs.",
		request: { params: vehicleParams },
		responses: {
			200: json(
				envelope(z.array(loose("Visit with its parts"))),
				"Visits (empty array if none)",
			),
			500: json(
				errorEnvelope,
				"Vehicle not found, or the lookup failed (`SERVER_ERROR`)",
			),
		},
	},
	stockOff,
);

const restockRequestBody = {
	qty_requested: z.number().positive().nullable().optional(),
	note: z.string().max(500).nullable().optional(),
};
const techOnlyRefused = json(
	errorEnvelope,
	"Not a technician, or not assigned to this vehicle (`INVALID_CREDENTIALS`)",
);

authed(
	"post",
	"/vehicles/{id}/stock/{itemId}/restock-request",
	"Vehicles",
	"view_vehicles",
	{
		summary: "Request a restock",
		description:
			"Technicians only, on their current vehicle (`view_vehicles`). Asks the office for more of one stock row (`itemId`). One pending request per row.",
		request: {
			params: stockItemParams,
			body: {
				content: {
					"application/json": {
						schema: z
							.object(restockRequestBody)
							.meta({ id: "CreateRestockRequest" }),
						example: {
							qty_requested: 4,
							note: "Used the last two today",
						},
					},
				},
			},
		},
		responses: {
			201: json(envelope(loose("The request")), "Requested"),
			400: json(
				errorEnvelope,
				"Validation failed, or the insert failed (`VALIDATION_ERROR`)",
			),
			403: techOnlyRefused,
			404: json(
				errorEnvelope,
				"Stock row not found (`VALIDATION_ERROR`)",
			),
			409: json(errorEnvelope, "Already requested (`CONFLICT`)"),
		},
	},
	stockOff,
);

authed(
	"post",
	"/vehicles/{id}/restock-requests/bulk",
	"Vehicles",
	"view_vehicles",
	{
		summary: "Request several restocks",
		description:
			"Technicians only, on their current vehicle (`view_vehicles`). Rows that already have a pending request, or aren't on this vehicle, are skipped.",
		request: {
			params: vehicleParams,
			body: {
				content: {
					"application/json": {
						schema: z
							.object({
								items: z
									.array(
										z.object({
											stock_item_id: z.uuid(),
											...restockRequestBody,
										}),
									)
									.min(1),
							})
							.meta({ id: "CreateRestockRequests" }),
					},
				},
			},
		},
		responses: {
			201: json(
				envelope(
					z.object({
						created: z.array(loose("A request")),
						skipped: z.array(loose("A skipped row and why")),
					}),
				),
				"Requested",
			),
			400: json(
				errorEnvelope,
				"Validation failed, or the insert failed (`VALIDATION_ERROR`)",
			),
			403: techOnlyRefused,
		},
	},
	stockOff,
);

authed(
	"get",
	"/vehicles/{id}/restock-requests",
	"Vehicles",
	"stock_own_vehicle or use_inventory or manage_inventory",
	{
		summary: "List a vehicle's restock requests",
		description:
			"Requires any of `stock_own_vehicle`, `use_inventory` or `manage_inventory`. Open requests, plus those resolved or dismissed today. Technicians only see their current vehicle's.",
		request: { params: vehicleParams },
		responses: {
			200: json(
				envelope(z.array(loose("A request"))),
				"Requests (empty array if none)",
			),
			403: json(
				errorEnvelope,
				"Technician not assigned to this vehicle (`INVALID_CREDENTIALS`)",
			),
			500: json(errorEnvelope, "The lookup failed (`SERVER_ERROR`)"),
		},
	},
	stockOff,
);

authed(
	"get",
	"/vehicles/{id}/movements",
	"Vehicles",
	"view_inventory or manage_technicians",
	{
		summary: "List a vehicle's stock movements",
		description:
			"Requires `view_inventory` or `manage_technicians`. Newest first, `limit` per page (default 25, at most 100). Pass the previous page's `nextCursor` as `cursor` for the next.",
		request: {
			params: vehicleParams,
			query: z.object({
				cursor: z.string().optional(),
				limit: z.coerce.number().int().optional(),
			}),
		},
		responses: {
			200: json(
				envelope(
					z.object({
						movements: z.array(loose("A ledger row")),
						nextCursor: z.string().nullable(),
					}),
				),
				"A page of movements",
			),
			404: vehicleNotFound,
		},
	},
	stockOff,
);

// Readiness: whether each vehicle carries the parts its visits need on a date.
const readinessGap = z.object({
	inventory_item_id: z.uuid(),
	name: z.string(),
	qty_needed: z.number(),
	qty_on_hand: z.number(),
	gap: z.number(),
	visit_ids: z.array(z.uuid()),
});
const readiness = z
	.object({
		state: z.enum([
			"not_applicable",
			"unknown",
			"auto_ready",
			"needs_action",
			"confirmed",
		]),
		date: z.string().describe("YYYY-MM-DD"),
		gaps: z.array(readinessGap),
		confirmed: z
			.object({
				id: z.uuid(),
				confirmed_by: z.string(),
				confirmed_by_type: z.enum([
					"dispatcher",
					"technician",
					"restock_auto",
				]),
				confirmed_at: z.iso.datetime(),
				notes: z.string().nullable(),
			})
			.optional(),
	})
	.meta({ id: "VehicleReadiness" });
const readinessDate = z.object({
	date: z.string().optional().describe("YYYY-MM-DD; defaults to today (UTC)"),
});

authed(
	"get",
	"/vehicles/readiness",
	"Vehicles",
	"view_inventory or manage_technicians",
	{
		summary: "Check fleet readiness",
		description:
			"Requires `view_inventory` or `manage_technicians`. For each active vehicle, whether it carries the parts its visits on `date` need, with the shortfalls (`gaps`) and any manual confirmation.",
		request: { query: readinessDate },
		responses: {
			200: json(
				envelope(z.array(readiness.extend({ vehicle_id: z.uuid() }))),
				"Readiness per vehicle (empty array if no active vehicles)",
			),
			500: json(errorEnvelope, "The lookup failed (`SERVER_ERROR`)"),
		},
	},
	stockOff,
);

authed(
	"get",
	"/vehicles/{id}/readiness",
	"Vehicles",
	"view_inventory or manage_technicians",
	{
		summary: "Check a vehicle's readiness",
		description:
			"Requires `view_inventory` or `manage_technicians`. Whether the vehicle carries the parts its visits on `date` need.",
		request: { params: vehicleParams, query: readinessDate },
		responses: {
			200: json(envelope(readiness), "Readiness"),
			404: vehicleNotFound,
		},
	},
	stockOff,
);

authed(
	"post",
	"/vehicles/{id}/readiness",
	"Vehicles",
	"manage_inventory or manage_technicians",
	{
		summary: "Confirm a vehicle is ready",
		description:
			"Requires `manage_inventory` or `manage_technicians`. Marks the vehicle ready for `date` by hand, whatever the gaps say. One confirmation per vehicle and date. Not recorded in the vehicle's history.",
		request: {
			params: vehicleParams,
			body: {
				content: {
					"application/json": {
						schema: z
							.object({
								date: z.string().describe("YYYY-MM-DD"),
								notes: z.string().optional(),
							})
							.meta({ id: "ConfirmReadiness" }),
						example: {
							date: "2026-11-14",
							notes: "Loaded the spare compressor",
						},
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(readiness),
				"Confirmed; the vehicle's readiness for that date",
			),
			400: json(
				errorEnvelope,
				"Validation failed, or the vehicle wasn't found (`VALIDATION_ERROR`)",
			),
			409: json(
				errorEnvelope,
				"Already confirmed for this date (`CONFLICT`)",
			),
		},
	},
	stockOff,
);

authed(
	"delete",
	"/vehicles/{id}/readiness/{date}",
	"Vehicles",
	"manage_inventory or manage_technicians",
	{
		summary: "Remove a readiness confirmation",
		description:
			"Requires `manage_inventory` or `manage_technicians`. Removes the manual confirmation for `date` (YYYY-MM-DD). Not recorded in the vehicle's history.",
		request: { params: vehicleParams.extend({ date: z.string() }) },
		responses: {
			200: json(
				envelope(readiness),
				"Removed; the vehicle's readiness for that date",
			),
			404: json(
				errorEnvelope,
				"Vehicle not found, or no confirmation on that date (`NOT_FOUND`)",
			),
		},
	},
	stockOff,
);

// Maintenance records and reminders. Every error on these routes is a 404.
const maintenanceParams = vehicleParams.extend({ recordId: z.uuid() });
const reminderParams = vehicleParams.extend({ reminderId: z.uuid() });
const fleetOff = moduleOff("fleet");
const maintenanceErr = (what: string) =>
	json(errorEnvelope, `${what} (\`NOT_FOUND\`, even for validation errors)`);
const reminder = z
	.object({
		id: z.uuid(),
		organization_id: z.uuid(),
		vehicle_id: z.uuid(),
		category: maintenanceRecord.shape.category,
		title: z.string(),
		description: z.string().nullable(),
		interval_miles: z.number().int().nullable(),
		interval_unit: z.enum(["days", "weeks", "months", "years"]).nullable(),
		interval_count: z.number().int().nullable(),
		repeats: z.boolean(),
		due_at: z.iso.datetime().nullable().describe("One-time reminders"),
		due_odometer_mi: z
			.number()
			.int()
			.nullable()
			.describe("One-time reminders"),
		completed_at: z.iso.datetime().nullable(),
		acknowledged_at: z.iso.datetime().nullable(),
		baseline_at: z.iso.datetime().nullable(),
		baseline_odometer_mi: z.number().int().nullable(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
	})
	.meta({ id: "MaintenanceReminder" });

authed(
	"get",
	"/vehicles/{id}/maintenance",
	"Vehicles",
	"view_vehicles or manage_vehicles or use_vehicles",
	{
		summary: "List a vehicle's maintenance records",
		description:
			"Requires any of `view_vehicles`, `manage_vehicles` or `use_vehicles`. Newest first.",
		request: { params: vehicleParams },
		responses: {
			200: json(
				envelope(z.array(maintenanceRecord)),
				"Records (empty array if none)",
			),
			404: vehicleNotFound,
		},
	},
	fleetOff,
);

authed(
	"patch",
	"/vehicles/{id}/maintenance/{recordId}",
	"Vehicles",
	"manage_vehicles",
	{
		summary: "Update a maintenance record",
		description:
			"Requires the `manage_vehicles` permission. Send only the fields to change. A linked purchase line must be for this vehicle.",
		request: {
			params: maintenanceParams,
			body: {
				content: {
					"application/json": {
						schema: updateMaintenanceRecordSchema.meta({
							id: "UpdateMaintenanceRecord",
						}),
						example: { cost: 89.5, notes: "Synthetic 5W-30" },
					},
				},
			},
		},
		responses: {
			200: json(envelope(maintenanceRecord), "Updated"),
			404: maintenanceErr(
				"Record not found on this vehicle, validation failed, or the purchase line is for another vehicle",
			),
		},
	},
	fleetOff,
);

authed(
	"delete",
	"/vehicles/{id}/maintenance/{recordId}",
	"Vehicles",
	"manage_vehicles",
	{
		summary: "Delete a maintenance record",
		description: "Requires the `manage_vehicles` permission.",
		request: { params: maintenanceParams },
		responses: {
			200: json(
				envelope(z.string()),
				'`data` is "Maintenance record deleted"',
			),
			404: maintenanceErr("Record not found on this vehicle"),
		},
	},
	fleetOff,
);

authed(
	"post",
	"/vehicles/{id}/maintenance/purchase-lines",
	"Vehicles",
	"view_vehicles or manage_vehicles or use_vehicles",
	{
		summary: "Find purchase lines to link to maintenance",
		description:
			"Requires any of `view_vehicles`, `manage_vehicles` or `use_vehicles`. A search, despite the POST: recent purchase order and field purchase lines for this vehicle (up to 20 of each), optionally matching `q`, to attach as a maintenance record's source. Allowed while the `fleet` module is read-only.",
		request: {
			params: vehicleParams,
			query: z.object({ q: z.string().optional() }),
		},
		responses: {
			200: json(
				envelope(
					z.array(
						z
							.record(z.string(), z.unknown())
							.describe("A purchase line and its purchase"),
					),
				),
				"Lines (empty array if none)",
			),
			404: vehicleNotFound,
		},
	},
	fleetOff,
);

authed(
	"get",
	"/vehicles/{id}/maintenance/reminders",
	"Vehicles",
	"view_vehicles or manage_vehicles or use_vehicles",
	{
		summary: "List a vehicle's maintenance reminders",
		description:
			"Requires any of `view_vehicles`, `manage_vehicles` or `use_vehicles`.",
		request: { params: vehicleParams },
		responses: {
			200: json(
				envelope(z.array(reminder)),
				"Reminders (empty array if none)",
			),
			404: vehicleNotFound,
		},
	},
	fleetOff,
);

authed(
	"post",
	"/vehicles/{id}/maintenance/reminders",
	"Vehicles",
	"manage_vehicles or use_vehicles",
	{
		summary: "Create a maintenance reminder",
		description:
			"Requires `manage_vehicles` or `use_vehicles`. A repeating reminder (`repeats`, the default) needs `interval_miles` or an `interval_unit` + `interval_count` pair; a one-time reminder needs `due_at` or `due_odometer_mi`. Returns 200, not 201.",
		request: {
			params: vehicleParams,
			body: {
				content: {
					"application/json": {
						schema: createMaintenanceReminderSchema.meta({
							id: "CreateMaintenanceReminder",
						}),
						example: {
							category: "oil_change",
							title: "Oil change",
							interval_miles: 5000,
							interval_unit: "months",
							interval_count: 6,
						},
					},
				},
			},
		},
		responses: {
			200: json(envelope(reminder), "Created"),
			404: maintenanceErr("Vehicle not found, or validation failed"),
		},
	},
	fleetOff,
);

authed(
	"patch",
	"/vehicles/{id}/maintenance/reminders/{reminderId}",
	"Vehicles",
	"manage_vehicles or use_vehicles",
	{
		summary: "Update a maintenance reminder",
		description:
			"Requires `manage_vehicles` or `use_vehicles`. Send only the fields to change. The create rules (interval pair, repeating vs one-time) aren't re-checked, and `due_at: null` doesn't clear the date.",
		request: {
			params: reminderParams,
			body: {
				content: {
					"application/json": {
						schema: updateMaintenanceReminderSchema.meta({
							id: "UpdateMaintenanceReminder",
						}),
					},
				},
			},
		},
		responses: {
			200: json(envelope(reminder), "Updated"),
			404: maintenanceErr(
				"Reminder not found on this vehicle, or validation failed",
			),
		},
	},
	fleetOff,
);

authed(
	"delete",
	"/vehicles/{id}/maintenance/reminders/{reminderId}",
	"Vehicles",
	"manage_vehicles",
	{
		summary: "Delete a maintenance reminder",
		description: "Requires the `manage_vehicles` permission.",
		request: { params: reminderParams },
		responses: {
			200: json(
				envelope(z.string()),
				'`data` is "Maintenance reminder deleted"',
			),
			404: maintenanceErr("Reminder not found on this vehicle"),
		},
	},
	fleetOff,
);

for (const [action, summary, text] of [
	[
		"acknowledge",
		"Acknowledge a maintenance reminder",
		"Marks a due reminder as seen, so it stops alerting.",
	],
	[
		"unacknowledge",
		"Un-acknowledge a maintenance reminder",
		"Clears the acknowledgement, so it alerts again.",
	],
	[
		"complete",
		"Complete a maintenance reminder",
		"Marks a one-time reminder done.",
	],
] as const) {
	authed(
		"post",
		`/vehicles/{id}/maintenance/reminders/{reminderId}/${action}`,
		"Vehicles",
		"manage_vehicles",
		{
			summary,
			description: `Requires the \`manage_vehicles\` permission. ${text} The current state isn't checked.`,
			request: { params: reminderParams },
			responses: {
				200: json(envelope(reminder), "Updated"),
				404: maintenanceErr("Reminder not found on this vehicle"),
			},
		},
		fleetOff,
	);
}

authed(
	"get",
	"/vehicles/{id}/changes",
	"Vehicles",
	"view_vehicles or manage_vehicles",
	{
		summary: "Get a vehicle's history",
		description: "Requires `view_vehicles` or `manage_vehicles`.",
		request: { params: vehicleParams, query: historyQuery },
		responses: historyResponses,
	},
	fleetOff,
);
