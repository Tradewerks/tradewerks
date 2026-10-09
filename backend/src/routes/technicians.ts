import { Router } from 'express';
import {
    getAllTechnicians,
    getTechnicianById,
    insertTechnician,
    updateTechnician,
    updateTechnicianLocation,
    deleteTechnician,
    checkAndClearWrappingUp,
    startShift,
    goOffline,
    goOnBreak,
    returnFromBreak,
    changeTechnicianPassword,
    returnFromJob,
    markAvailable
} from "../controllers/techniciansController.js";
import { requestPasswordReset } from '../controllers/authenticationController.js';
import { resetMfa } from '../controllers/mfaController.js';
import {
	ErrorCodes,
	createSuccessResponse,
	createErrorResponse,
} from "../types/responses.js";
import { getUserContext } from '../lib/context.js';
import { getJobVisitsByTechId } from '../controllers/jobVisitsController.js';
import { getSocket } from "../services/socketService.js";
import { setTechnicianVehicle } from "../controllers/vehiclesController.js";
import { 
    requirePermission,
    requireAnyPermission, 
    requirePermissionOrSelf,
    requireAnyPermissionOrSelf
} from '../lib/requirePermissions.js';
import { getUserHistory, parseHistoryLimit, INVALID_HISTORY_LIMIT } from '../controllers/logsController.js';

const router = Router();

router.get("/", requirePermission("view_technicians"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const technicians = await getAllTechnicians(orgId);
        res.json(
            createSuccessResponse(technicians, { count: technicians.length }),
        );
    } catch (err) {
        next(err);
    }
});

router.get("/:id", requirePermissionOrSelf("view_technicians"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const technician = await getTechnicianById(id, orgId);

        if (!technician) {
            return res
                .status(404)
                .json(
                    createErrorResponse(
                        ErrorCodes.NOT_FOUND,
                        "Technician not found",
                    ),
                );
        }

        res.json(createSuccessResponse(technician));
    } catch (err) {
        next(err);
    }
});

router.post("/", requirePermission("manage_technicians"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await insertTechnician(req.body, orgId, context);

        if (result.err) {
            const isDuplicate = result.err
                .toLowerCase()
                .includes("already exists");
            return res
                .status(isDuplicate ? 409 : 400)
                .json(
                    createErrorResponse(
                        isDuplicate
                            ? ErrorCodes.CONFLICT
                            : ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.status(201).json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post("/:id/ping", requirePermissionOrSelf("manage_technicians"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;

        // Lazy WrappingUp auto-transition: clear to Available if timer has passed
        const cleared = await checkAndClearWrappingUp(id, orgId);
        if (cleared) {
            getSocket().emit("technician-update", cleared);
            getSocket().emit("technician:status_changed", {
                techId: cleared.id,
                techName: cleared.name,
                newStatus: "Available",
                changeType: "wrapping_up_cleared",
                changedAt: new Date().toISOString(),
            });
        }

        const result = await updateTechnicianLocation(id, req.body, orgId);

        if (result.err) {
            const notFound = result.err === "Technician not found";
            return res
                .status(notFound ? 404 : 400)
                .json(
                    createErrorResponse(
                        notFound ? ErrorCodes.NOT_FOUND : ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        const io = getSocket();
        io.emit("technician-update", result.item);
        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.put("/:id", requirePermissionOrSelf("manage_technicians"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await updateTechnician(id, req.body, orgId, context);

        if (result.err) {
            const isDuplicate = result.err
                .toLowerCase()
                .includes("already exists");
            return res
                .status(isDuplicate ? 409 : 400)
                .json(
                    createErrorResponse(
                        isDuplicate
                            ? ErrorCodes.CONFLICT
                            : ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post("/:id/reset-password", requirePermission("manage_technicians"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const user = await getTechnicianById(id, orgId);
        if (!user) {
            return res
                .status(404)
                .json(
                    createErrorResponse(
                        ErrorCodes.NOT_FOUND,
                        "Technician not found",
                    ),
                );
        }
        const result = await requestPasswordReset(user.email, "technician");

        if (result.err) {
            return res
                .status(400)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(null));
    } catch (err) {
        next(err);
    }
});

router.post("/:id/change-password", async (req, res, next) => {
    try {
        if (req.user?.uid !== req.params.id) {
            return res
                .status(403)
                .json(
                    createErrorResponse(
                        ErrorCodes.FORBIDDEN,
                        "You are not the owner of this technician",
                    ),
                );
        }
        const id = req.params.id as string;
        const orgId = req.user.organization_id as string;
        const data = req.body;
        const result = await changeTechnicianPassword(id, orgId, data, getUserContext(req));
        if (result.err) {
            return res
                .status(400)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }
        res.json(createSuccessResponse(null));
    } catch (err) {
        next(err);
    }
});

router.delete("/:id", requirePermission("manage_technicians"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await deleteTechnician(id, orgId, context);

        if (result.err) {
            return res
                .status(400)
                .json(createErrorResponse(ErrorCodes.DELETE_ERROR, result.err));
        }

        res.status(200).json(
            createSuccessResponse({
                message: result.message || "Technician deleted successfully",
                id,
            }),
        );
    } catch (err) {
        next(err);
    }
});

// Get job visits for a technician
router.get("/:techId/visits", requirePermissionOrSelf("view_technicians", "techId"), async (req, res, next) => {
    try {
        const techId = req.params.techId as string;
        const orgId = req.user!.organization_id as string;
        const visits = await getJobVisitsByTechId(techId, orgId);
        res.json(createSuccessResponse(visits, { count: visits.length }));
    } catch (err) {
        next(err);
    }
});

// Technicians may set only their OWN current vehicle (self match on :id); dispatchers
// with manage_vehicles may set anyone's. use_vehicles is intentionally NOT accepted here —
// it would let any technician reassign a colleague's vehicle (horizontal priv-esc).
router.put("/:id/vehicle", requireAnyPermissionOrSelf(["manage_vehicles"], "id"), async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		const { vehicle_id } = req.body as { vehicle_id: string | null };
		const result = await setTechnicianVehicle(id, vehicle_id ?? null, orgId);
		if (result.err) {
			const statusCode = result.err.includes("not found") ? 404 : 400;
			return res.status(statusCode).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
		}
		res.json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});

// Shift start (Offline → Available) or return from break
router.post("/:id/available", async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		const tech = await getTechnicianById(id, orgId);
		if (!tech) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, "Technician not found"));
		}

		let result;
		let changeType: "shift_start" | "break_end";
		if (tech.status === "Offline") {
			result = await startShift(id, orgId);
			changeType = "shift_start";
		} else if (tech.status === "Break") {
			result = await returnFromBreak(id, orgId);
			changeType = "break_end";
		} else {
			return res.status(409).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, "Technician is not Offline or on Break"));
		}

		if (result.err) {
			if (result.err.startsWith("TIMESHEET_LOCKED")) {
				return res.status(409).json(createErrorResponse(ErrorCodes.CONFLICT, result.err));
			}
			return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
		}
		getSocket().emit("technician-update", result.item);
		getSocket().emit("technician:status_changed", {
			techId: result.item!.id,
			techName: result.item!.name,
			newStatus: result.item!.status,
			changeType,
			changedAt: new Date().toISOString(),
		});
		res.json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});

// Shift end → Offline
router.post("/:id/offline", async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		const { tech_coords } = req.body;
		const rawLat = Number(tech_coords?.lat);
		const rawLon = Number(tech_coords?.lon);
		const techCoords =
			Number.isFinite(rawLat) && Number.isFinite(rawLon)
				? { lat: rawLat, lon: rawLon }
				: undefined;
		const result = await goOffline(id, orgId, techCoords);
		if (result.err) {
			const status = result.err.includes("clocked into") ? 409 : 400;
			return res.status(status).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
		}
		getSocket().emit("technician-update", result.item);
		getSocket().emit("technician:status_changed", {
			techId: result.item!.id,
			techName: result.item!.name,
			newStatus: "Offline",
			changeType: "shift_end",
			changedAt: new Date().toISOString(),
		});
		res.json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});

// Take a break
router.post("/:id/break", async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		const { reason } = req.body as { reason?: string };
		if (!reason) {
			return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, "reason is required"));
		}
		const result = await goOnBreak(id, orgId, reason);
		if (result.err) {
			const status = result.err.includes("clocked into") ? 409 : 400;
			return res.status(status).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
		}
		getSocket().emit("technician-update", result.item);
		getSocket().emit("technician:status_changed", {
			techId: result.item!.id,
			techName: result.item!.name,
			newStatus: "Break",
			changeType: "break_start",
			changedAt: new Date().toISOString(),
		});
		res.json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});


// Tech explicitly clears WrappingUp → Available
router.post("/:id/done", async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		import("../services/wrappingUpTimer.js").then(({ cancelWrappingUpTimer }) => {
			cancelWrappingUpTimer(id);
		}).catch(() => {});
		const result = await markAvailable(id, orgId, getUserContext(req));
		if (result.err) {
			return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
		}
		getSocket().emit("technician-update", result.item);
		getSocket().emit("technician:status_changed", {
			techId: result.item!.id,
			techName: result.item!.name,
			newStatus: "Available",
			changeType: "wrapping_up_cleared",
			changedAt: new Date().toISOString(),
		});
		res.json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});

// Tech explicitly clears WrappingUp → EnRoute (heading back)
router.post("/:id/head-back", async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		import("../services/wrappingUpTimer.js").then(({ cancelWrappingUpTimer }) => {
			cancelWrappingUpTimer(id);
		}).catch(() => {});
		const result = await returnFromJob(orgId, id, getUserContext(req));
		if (result.err) {
			return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
		}
		getSocket().emit("technician-update", result.item);
		getSocket().emit("technician:status_changed", {
			techId: result.item!.id,
			techName: result.item!.name,
			newStatus: "HeadingBack",
			changeType: "heading_back",
			changedAt: new Date().toISOString(),
		});
		res.json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});

router.post("/:id/mfa/reset", requirePermissionOrSelf("manage_technicians"), async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		const target = await getTechnicianById(id, orgId);
		if (!target) {
			return res
				.status(404)
				.json(createErrorResponse(ErrorCodes.NOT_FOUND, "Technician not found"));
		}
		const result = await resetMfa(id, "technician", req.user!.uid, req.user!.role);
		res.json(createSuccessResponse(result.data));
	} catch (err) {
		next(err);
	}
});

router.get("/:id/changes", requirePermissionOrSelf("view_technicians"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        let limit: number;
        try {
            limit = parseHistoryLimit(req.query.limit);
        } catch {
            return res
                .status(400)
                .json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, INVALID_HISTORY_LIMIT));
        }

        const results = await getUserHistory(orgId, "technician", id, limit);

        if (results.err) {
            return res
                .status(500)
                .json(createErrorResponse(ErrorCodes.SERVER_ERROR, results.err));
        }

        res.json(createSuccessResponse(results.rows, {
            count: results.rows.length,
            hasMore: results.hasMore,
            total: results.total,
        }));
    } catch (err) {
        next(err);
    }
});

export default router;
