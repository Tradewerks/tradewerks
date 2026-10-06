import { Router } from "express";
import { requireModule } from "../lib/entitlements/requireModule.js";
import { ErrorCodes, createSuccessResponse, createErrorResponse } from "../types/responses.js";
import { getUserContext } from "../lib/context.js";
import { db } from "../db.js";
import {
	listVehicles,
	createVehicle,
	updateVehicle,
	listVehicleStock,
	addVehicleStockItem,
	updateVehicleStockItem,
	deleteVehicleStockItem,
	createRestockRequest,
	createRestockRequestsBulk,
	listRestockRequests,
	listVehicleRestockRequests,
	dismissRestockRequest,
	acknowledgeRestockRequest,
	getTomorrowRequirements,
	getFillPlan,
	applyFill,
	getUsageToday,
	getStockConflicts,
	completeRestock,
	getRestockToday,
	getRestockHistory,
	adjustStock,
	getStockAdjustmentHistory,
	getVehicleReadiness,
	getFleetReadiness,
	confirmReadiness,
	revokeReadiness,
	getVehicleMovements,
	type VehicleAdjustmentType,
	getMaintenanceRecords,
	createMaintenanceRecord,
	updateMaintenanceRecord,
	deleteMaintenanceRecord,
	searchMaintenanceSourceLines,
	getMaintenanceReminders,
	createMaintenanceReminder,
	updateMaintenanceReminder,
	deleteMaintenanceReminder,
	acknowledgeMaintenanceReminder,
	unacknowledgeMaintenanceReminder,
	completeMaintenanceReminder,
	getMaintenanceAlerts,
} from "../controllers/vehiclesController.js";
import {
	requirePermission,
	requireAnyPermission,
	requireVehiclePermission,
} from "../lib/requirePermissions.js";
import { getEntityHistory, INVALID_HISTORY_LIMIT, parseHistoryLimit } from "../controllers/logsController.js";

const router = Router();

router.get("/", requireAnyPermission("view_vehicles", "manage_vehicles", "use_vehicles"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const { status } = req.query as { status?: string };
		const vehicles = await listVehicles(orgId, status);
		res.json(createSuccessResponse(vehicles, { count: vehicles.length }));
	} catch (err) {
		next(err);
	}
});

router.post("/", requirePermission("manage_vehicles"), async (req, res, next) => {
	try {
		const context = getUserContext(req);
		const orgId = req.user!.organization_id as string;
		const result = await createVehicle(req.body, orgId, context);
		if (result.err) {
			return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
		}
		res.status(201).json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});

router.get(
	"/stock-conflicts",
	requireModule("vehicle_stock"),
	requireAnyPermission("view_inventory", "manage_technicians", "use_vehicles", "stock_own_vehicle"),
	async (req, res, next) => {
		try {
			const orgId = req.user!.organization_id as string;
			let scopeVehicleId: string | undefined;
			if (req.user?.role === "technician") {
				const tech = await db.technician.findFirst({
					where: { id: req.user.uid as string, organization_id: orgId },
					select: { current_vehicle_id: true },
				});
				scopeVehicleId = tech?.current_vehicle_id ?? undefined;
			}
			const data = await getStockConflicts(orgId, scopeVehicleId);
			res.json(createSuccessResponse(data, { count: data.length }));
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	"/maintenance-alerts",
	requireAnyPermission("view_vehicles", "manage_vehicles", "use_vehicles", "stock_own_vehicle"),
	async (req, res, next) => {
		try {
			const orgId = req.user!.organization_id as string;
			let scopeVehicleId: string | undefined;
			if (req.user?.role === "technician") {
				const tech = await db.technician.findFirst({
					where: { id: req.user.uid as string, organization_id: orgId },
					select: { current_vehicle_id: true },
				});
				scopeVehicleId = tech?.current_vehicle_id ?? undefined;
			}
			const data = await getMaintenanceAlerts(orgId, scopeVehicleId);
			res.json(createSuccessResponse(data, { count: data.length }));
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	"/readiness",
	requireModule("vehicle_stock"),
	requireAnyPermission("view_inventory", "manage_technicians"),
	async (req, res, next) => {
		try {
			const orgId = req.user!.organization_id as string;
			const dateStr =
				typeof req.query.date === "string"
					? req.query.date
					: new Date().toISOString().slice(0, 10);
			const result = await getFleetReadiness(orgId, dateStr);
			if (result.err) {
				return res.status(500).json(createErrorResponse(ErrorCodes.SERVER_ERROR, result.err));
			}
			res.json(createSuccessResponse(result.items, { count: result.items!.length }));
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	"/restock-requests",
	requireModule("vehicle_stock"),
	requireAnyPermission("view_inventory", "manage_technicians"),
	async (req, res, next) => {
		try {
			const orgId = req.user!.organization_id as string;
			const { status, vehicleId } = req.query as { status?: string; vehicleId?: string };
			const result = await listRestockRequests(orgId, status, vehicleId);
			if (result.err) {
				return res.status(500).json(createErrorResponse(ErrorCodes.SERVER_ERROR, result.err));
			}
			res.json(createSuccessResponse(result.requests, { count: result.requests!.length }));
		} catch (err) {
			next(err);
		}
	},
);


router.post(
	"/restock-requests/:requestId/dismiss",
	requireModule("vehicle_stock"),
	requireAnyPermission("manage_inventory", "manage_technicians"),
	async (req, res, next) => {
		try {
			const requestId = req.params.requestId as string;
			const orgId = req.user!.organization_id as string;
			const context = getUserContext(req);
			const result = await dismissRestockRequest(requestId, orgId, context);
			if (result.err) {
				if (result.err.includes("not found")) {
					return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
				}
				if (result.err.includes("already")) {
					return res.status(409).json(createErrorResponse(ErrorCodes.CONFLICT, result.err));
				}
				return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
			}
			res.json(createSuccessResponse(result.request));
		} catch (err) {
			next(err);
		}
	},
);


router.post(
	"/restock-requests/:requestId/acknowledge",
	requireModule("vehicle_stock"),
	requireAnyPermission("manage_inventory", "manage_technicians"),
	async (req, res, next) => {
		try {
			const requestId = req.params.requestId as string;
			const orgId = req.user!.organization_id as string;
			const context = getUserContext(req);
			const result = await acknowledgeRestockRequest(requestId, orgId, context);
			if (result.err) {
				if (result.err.includes("not found")) {
					return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
				}
				return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
			}
			res.json(createSuccessResponse(result.request));
		} catch (err) {
			next(err);
		}
	},
);


router.put("/:id", requirePermission("manage_technicians"), async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const context = getUserContext(req);
		const orgId = req.user!.organization_id as string;
		const result = await updateVehicle(id, req.body, orgId, context);
		if (result.err) {
			const statusCode = result.err.includes("not found") ? 404 : 400;
			return res.status(statusCode).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
		}
		res.json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});

router.get("/:id/stock", requireModule("vehicle_stock"), requireAnyPermission("view_vehicles", "manage_vehicles", "use_vehicles", "stock_own_vehicle", "complete_own_restock"), async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		const result = await listVehicleStock(id, orgId);
		if (result.err) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
		}
		res.json(createSuccessResponse(result.items, { count: result.items!.length }));
	} catch (err) {
		next(err);
	}
});

router.post("/:id/stock", requireModule("vehicle_stock"), requireVehiclePermission("stock_own_vehicle"), async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const context = getUserContext(req);
		const orgId = req.user!.organization_id as string;
		const result = await addVehicleStockItem(id, req.body, orgId, context);
		if (result.err) {
			const statusCode = result.err.includes("not found") ? 404 : 400;
			return res.status(statusCode).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
		}
		res.status(201).json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});

router.get(
	"/:id/stock/fill-plan",
	requireModule("vehicle_stock"),
	requireVehiclePermission("stock_own_vehicle"),
	async (req, res, next) => {
		try {
			const id = req.params.id as string;
			const orgId = req.user!.organization_id as string;
			const result = await getFillPlan(id, orgId);
			if (result.err) {
				return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
			}
			res.json(createSuccessResponse(result.plan));
		} catch (err) {
			next(err);
		}
	},
);

router.post(
	"/:id/stock/fill",
	requireModule("vehicle_stock"),
	requireVehiclePermission("stock_own_vehicle"),
	async (req, res, next) => {
		try {
			const id = req.params.id as string;
			const orgId = req.user!.organization_id as string;
			const context = getUserContext(req);
			const result = await applyFill(id, req.body, orgId, context);
			if (result.err) {
				const status = result.err.includes("not found") ? 404 : 400;
				return res.status(status).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
			}
			res.json(createSuccessResponse(result.lines));
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	"/:id/usage-today",
	requireModule("vehicle_stock"),
	requireAnyPermission("view_inventory", "manage_technicians", "use_inventory"),
	async (req, res, next) => {
		try {
			const id = req.params.id as string;
			const orgId = req.user!.organization_id as string;
			const result = await getUsageToday(id, orgId);
			if (result.err) {
				return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
			}
			res.json(createSuccessResponse(result.data, { count: result.data!.length }));
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	"/:id/tomorrow-requirements",
	requireModule("vehicle_stock"),
	requireAnyPermission("view_inventory", "manage_technicians"),
	async (req, res, next) => {
		try {
			const id = req.params.id as string;
			const orgId = req.user!.organization_id as string;
			const result = await getTomorrowRequirements(id, orgId);
			if (result.err) {
				return res.status(500).json(createErrorResponse(ErrorCodes.SERVER_ERROR, result.err));
			}
			res.json(createSuccessResponse(result.data, { count: result.data!.length }));
		} catch (err) {
			next(err);
		}
	},
);

router.post(
	"/:id/restock",
	requireModule("vehicle_stock"),
	requireVehiclePermission("complete_own_restock"),
	async (req, res, next) => {
		try {
			const id = req.params.id as string;
			const orgId = req.user!.organization_id as string;
			const context = getUserContext(req);
			const result = await completeRestock(id, req.body, orgId, context);
			if (result.err) {
				const status = result.err.includes("not found")
					? 404
					: result.err.includes("already completed")
					? 409
					: 400;
				return res.status(status).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
			}
			return res
				.status(201)
				.json(createSuccessResponse({ ...result.record, line_details: result.line_details }));
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	"/:id/restock/today",
	requireModule("vehicle_stock"),
	requireAnyPermission("view_inventory", "manage_inventory", "manage_technicians", "use_inventory"),
	async (req, res, next) => {
		try {
			const id = req.params.id as string;
			const orgId = req.user!.organization_id as string;
			const result = await getRestockToday(id, orgId);
			if (result.err) {
				return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
			}
			return res.json(createSuccessResponse(result.record));
		} catch (err) {
			next(err);
		}
	},
);

const ADJUST_TYPE_PERMS: Partial<Record<VehicleAdjustmentType, string>> = {
	field_loss:         "adjust_field_loss",
	transfer:           "adjust_transfer",
	audit:              "adjust_audit",
	warehouse_exchange: "adjust_warehouse_exchange",
};

router.post(
	"/:id/stock/adjust",
	requireModule("vehicle_stock"),
	requireVehiclePermission("stock_own_vehicle"),
	async (req, res, next) => {
		try {
			// Technicians need an additional per-type permission on top of stock_own_vehicle
			if (req.user?.role === "technician") {
				const type = req.body?.type as VehicleAdjustmentType | undefined;
				const required = type ? ADJUST_TYPE_PERMS[type] : undefined;
				if (required) {
					const perms = (req.user?.permissions as string[]) || [];
					if (!perms.includes(required)) {
						return res.status(403).json(
							createErrorResponse(ErrorCodes.INVALID_CREDENTIALS, "Insufficient permissions for this adjustment type"),
						);
					}
				}
			}

			const id = req.params.id as string;
			const orgId = req.user!.organization_id as string;
			const context = getUserContext(req);
			const result = await adjustStock(id, req.body, orgId, context);
			if (result.err) {
				if (result.err === "insufficient_warehouse_stock") {
					return res.status(409).json(
						createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err, {
							available: result.available,
						}),
					);
				}
				const status = result.err.includes("not found") ? 404 : 400;
				return res.status(status).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
			}
			return res.status(201).json(createSuccessResponse(result.adjustment));
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	"/:id/restock/history",
	requireModule("vehicle_stock"),
	requireAnyPermission("view_inventory", "manage_inventory", "manage_technicians", "use_inventory", "stock_own_vehicle"),
	async (req, res, next) => {
		try {
			const id = req.params.id as string;
			const orgId = req.user!.organization_id as string;
			const result = await getRestockHistory(id, orgId);
			if (result.err) {
				return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
			}
			return res.json(createSuccessResponse(result.records, { count: result.records!.length }));
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	"/:id/stock/adjustments",
	requireModule("vehicle_stock"),
	requireAnyPermission("view_inventory", "manage_inventory", "manage_technicians", "use_inventory", "stock_own_vehicle"),
	async (req, res, next) => {
		try {
			const id = req.params.id as string;
			const orgId = req.user!.organization_id as string;
			const result = await getStockAdjustmentHistory(id, orgId);
			if (result.err) {
				return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
			}
			return res.json(createSuccessResponse(result.adjustments, { count: result.adjustments!.length }));
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	"/:id/readiness",
	requireModule("vehicle_stock"),
	requireAnyPermission("view_inventory", "manage_technicians"),
	async (req, res, next) => {
		try {
			const id = req.params.id as string;
			const dateStr =
				typeof req.query.date === "string"
					? req.query.date
					: new Date().toISOString().slice(0, 10);
			const orgId = req.user!.organization_id as string;
			const result = await getVehicleReadiness(id, orgId, dateStr);
			if (result.err) return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
			res.json(createSuccessResponse(result.item));
		} catch (err) {
			next(err);
		}
	}
);

router.post(
	"/:id/readiness",
	requireModule("vehicle_stock"),
	requireAnyPermission("manage_inventory", "manage_technicians"),
	async (req, res, next) => {
		try {
			const id = req.params.id as string;
			const orgId = req.user!.organization_id as string;
			const dispatcherId = req.user?.uid ?? "";
			const result = await confirmReadiness(id, orgId, dispatcherId, req.body);
			if (result.err) {
				const status = result.err.includes("already confirmed") ? 409 : 400;
				const code = result.err.includes("already confirmed")
					? ErrorCodes.CONFLICT
					: ErrorCodes.VALIDATION_ERROR;
				return res.status(status).json(createErrorResponse(code, result.err));
			}
			res.json(createSuccessResponse(result.item));
		} catch (err) {
			next(err);
		}
	}
);

router.delete(
	"/:id/readiness/:date",
	requireModule("vehicle_stock"),
	requireAnyPermission("manage_inventory", "manage_technicians"),
	async (req, res, next) => {
		try {
			const { id, date } = req.params as { id: string; date: string };
			const orgId = req.user!.organization_id as string;
			const result = await revokeReadiness(id, orgId, date);
			if (result.err) return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
			res.json(createSuccessResponse(result.item));
		} catch (err) {
			next(err);
		}
	}
);

router.put("/:id/stock/:itemId", requireModule("vehicle_stock"), requireVehiclePermission("stock_own_vehicle"), async (req, res, next) => {
	try {
		const { id, itemId } = req.params as { id: string; itemId: string };
		const context = getUserContext(req);
		const orgId = req.user!.organization_id as string;
		const result = await updateVehicleStockItem(id, itemId, req.body, orgId, context);
		if (result.err) {
			const statusCode = result.err.includes("not found") ? 404 : 400;
			return res.status(statusCode).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
		}
		res.json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});

router.delete("/:id/stock/:itemId", requireModule("vehicle_stock"), requireVehiclePermission("stock_own_vehicle"), async (req, res, next) => {
	try {
		const { id, itemId } = req.params as { id: string; itemId: string };
		const context = getUserContext(req);
		const orgId = req.user!.organization_id as string;
		const result = await deleteVehicleStockItem(id, itemId, orgId, context);
		if (result.err) {
			const statusCode = result.err.includes("not found") ? 404 : 400;
			return res.status(statusCode).json(createErrorResponse(ErrorCodes.DELETE_ERROR, result.err));
		}
		res.json(createSuccessResponse(null));
	} catch (err) {
		next(err);
	}
});

router.post("/:id/stock/:itemId/restock-request", requireModule("vehicle_stock"), requireVehiclePermission("view_vehicles"), async (req, res, next) => {
	try {
		const { id, itemId } = req.params as { id: string; itemId: string };
		const orgId = req.user!.organization_id as string;
		const context = getUserContext(req);
		const result = await createRestockRequest(id, itemId, req.body, orgId, context);
		if (result.err) {
			if (result.err.includes("Only technicians") || result.err.includes("not assigned")) {
				return res.status(403).json(createErrorResponse(ErrorCodes.INVALID_CREDENTIALS, result.err));
			}
			if (result.err.includes("already requested")) {
				return res.status(409).json(createErrorResponse(ErrorCodes.CONFLICT, result.err));
			}
			const statusCode = result.err.includes("not found") ? 404 : 400;
			return res.status(statusCode).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
		}
		res.status(201).json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});

router.post("/:id/restock-requests/bulk", requireModule("vehicle_stock"), requireVehiclePermission("view_vehicles"), async (req, res, next) => {
	try {
		const vehicleId = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		const context = getUserContext(req);
		const result = await createRestockRequestsBulk(vehicleId, req.body, orgId, context);
		if (result.err) {
			if (result.err.includes("Only technicians") || result.err.includes("not assigned")) {
				return res.status(403).json(createErrorResponse(ErrorCodes.INVALID_CREDENTIALS, result.err));
			}
			return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
		}
		res.status(201).json(createSuccessResponse({ created: result.created, skipped: result.skipped }));
	} catch (err) {
		next(err);
	}
});

router.get("/:id/restock-requests", requireModule("vehicle_stock"), requireAnyPermission("stock_own_vehicle", "use_inventory", "manage_inventory"), async (req, res, next) => {
	try {
		const vehicleId = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		const context = getUserContext(req);
		const result = await listVehicleRestockRequests(vehicleId, orgId, context);
		if (result.err) {
			if (result.err.includes("not assigned")) {
				return res.status(403).json(createErrorResponse(ErrorCodes.INVALID_CREDENTIALS, result.err));
			}
			return res.status(500).json(createErrorResponse(ErrorCodes.SERVER_ERROR, result.err));
		}
		res.json(createSuccessResponse(result.requests, { count: result.requests!.length }));
	} catch (err) {
		next(err);
	}
});

router.get("/:id/movements", requireModule("vehicle_stock"), requireAnyPermission("view_inventory", "manage_technicians"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const { cursor, limit } = req.query as { cursor?: string; limit?: string };
		const result = await getVehicleMovements(
			id,
			orgId,
			cursor,
			limit ? parseInt(limit, 10) : 25,
		);
		if (result.err) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
		}
		res.json(createSuccessResponse({ movements: result.movements, nextCursor: result.nextCursor }));
	} catch (err) {
		next(err);
	}
});

// vehicle maintenance

router.get("/:id/maintenance", requireAnyPermission("view_vehicles", "manage_vehicles", "use_vehicles"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;

		const result = await getMaintenanceRecords(orgId, id);
		if (result.err) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
		}
		res.json(createSuccessResponse(result.records, { count: result.records!.length }));
	} catch (err) {
		next(err);
	}
});

router.post("/:id/maintenance", requireAnyPermission("manage_vehicles", "use_vehicles"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;

		const result = await createMaintenanceRecord(orgId, id, req.body, getUserContext(req));
		if (result.err) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
		}
		res.json(createSuccessResponse(result.record));
	} catch (err) {
		next(err);
	}
});

router.patch("/:id/maintenance/:recordId", requirePermission("manage_vehicles"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const recordId = req.params.recordId as string;

		const result = await updateMaintenanceRecord(orgId, id, recordId, req.body, getUserContext(req));
		if (result?.err) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
		}
		res.json(createSuccessResponse(result.record));
	} catch (err) {
		next(err);
	}
});

router.delete("/:id/maintenance/:recordId", requirePermission("manage_vehicles"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const recordId = req.params.recordId as string;

		const result = await deleteMaintenanceRecord(orgId, recordId, id, getUserContext(req));
		if (result.err) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
		}
		res.json(createSuccessResponse("Maintenance record deleted"));
	} catch (err) {
		next(err);
	}
});

router.post("/:id/maintenance/purchase-lines", requireAnyPermission("view_vehicles", "manage_vehicles", "use_vehicles"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const { q } = req.query as { q?: string };

		const result = await searchMaintenanceSourceLines(orgId, id, q);
		if (result.err) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
		}
		res.json(createSuccessResponse(result.lines, { count: result.lines!.length }));
	} catch (err) {
		next(err);
	}
});

// maintenance reminders

router.get("/:id/maintenance/reminders", requireAnyPermission("view_vehicles", "manage_vehicles", "use_vehicles"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;

		const result = await getMaintenanceReminders(orgId, id);
		if (result.err) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
		}
		res.json(createSuccessResponse(result.reminders));
	} catch (err) {
		next(err);
	}
});

router.post("/:id/maintenance/reminders", requireAnyPermission("manage_vehicles", "use_vehicles"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		
		const result = await createMaintenanceReminder(orgId, id, req.body, getUserContext(req));
		if (result.err) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
		}
		res.json(createSuccessResponse(result.reminder));
	} catch (err) {
		next(err);
	}
});

router.patch("/:id/maintenance/reminders/:reminderId", requirePermission("manage_vehicles"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const reminderId = req.params.reminderId as string;

		const result = await updateMaintenanceReminder(orgId, id, reminderId, req.body, getUserContext(req));
		if (result.err) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
		}
		res.json(createSuccessResponse(result.reminder));
	} catch (err) {
		next(err);
	}
});

router.delete("/:id/maintenance/reminders/:reminderId", requirePermission("manage_vehicles"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const reminderId = req.params.reminderId as string;

		const result = await deleteMaintenanceReminder(orgId, id, reminderId, getUserContext(req));
		if (result.err) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
		}
		res.json(createSuccessResponse("Maintenance reminder deleted"));
	} catch (err) {
		next(err);
	}
});

router.post("/:id/maintenance/reminders/:reminderId/acknowledge", requirePermission("manage_vehicles"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const reminderId = req.params.reminderId as string;

		const result = await acknowledgeMaintenanceReminder(orgId, id, reminderId, getUserContext(req));
		if (result.err) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
		}
		res.json(createSuccessResponse(result.reminder));
	} catch (err) {
		next(err);
	}
});

router.post("/:id/maintenance/reminders/:reminderId/complete", requirePermission("manage_vehicles"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const reminderId = req.params.reminderId as string;

		const result = await completeMaintenanceReminder(orgId, id, reminderId, getUserContext(req));
		if (result.err) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
		}
		res.json(createSuccessResponse(result.reminder));
	} catch (err) {
		next(err);
	}
});

router.post("/:id/maintenance/reminders/:reminderId/unacknowledge", requirePermission("manage_vehicles"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;
		const reminderId = req.params.reminderId as string;

		const result = await unacknowledgeMaintenanceReminder(orgId, id, reminderId, getUserContext(req));
		if (result.err) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
		}
		res.json(createSuccessResponse(result.reminder));
	} catch (err) {
		next(err);
	}
});

router.get("/:id/changes", requireAnyPermission("view_vehicles", "manage_vehicles"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const id = req.params.id as string;

		let limit: number;
		try {
			limit = parseHistoryLimit(req.query.limit);
		} catch {
			return res
				.status(400)
				.json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, INVALID_HISTORY_LIMIT));
		}

		const results = await getEntityHistory(orgId, "vehicle", id, limit);

		if (results.err)
			return res.status(500).json(createErrorResponse(ErrorCodes.SERVER_ERROR, results.err));
		res.json(createSuccessResponse(results.rows, { count: results.rows.length, hasMore: results.hasMore, total: results.total }));
	} catch (err) {
		next(err);
	}
});

export default router;
