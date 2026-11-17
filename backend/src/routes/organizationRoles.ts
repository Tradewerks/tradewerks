import { Router } from "express";
import {
    ErrorCodes,
    createSuccessResponse,
    createErrorResponse,
} from "../types/responses.js";
import {
    getOrgRoles,
    getOrgRoleById,
    createOrgRole,
    updateOrgRole,
    deleteOrgRole,
    assignOrgRole
} from "../controllers/organizationsController.js";
import { getUserContext } from "../lib/context.js";
import { requirePermission } from "../lib/requirePermissions.js";

const router = Router();

router.get("/", requirePermission("manage_roles"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const result = await getOrgRoles(orgId);
		if (result == undefined || result.err) {
			return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result?.err || "Organization roles not found"));
		}
		res.json(createSuccessResponse(result.items));
	} catch (err) {
		next(err);
	}
});

router.post("/", requirePermission("manage_roles"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
		const result = await createOrgRole(req.body, orgId, context);
		if (result == undefined || result.err) {
			return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result?.err || "Failed to create organization role"));
		}
		res.status(201).json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});

router.get("/:id", requirePermission("manage_roles"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await getOrgRoleById(id, orgId);
        if (result == undefined || result.err) {
            return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result?.err || "Organization role not found"));
        }
        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);  
    }
});

router.put("/:id", requirePermission("manage_roles"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const context = getUserContext(req);
        const result = await updateOrgRole(id, req.body, orgId, context);
        if (result == undefined || result.err) {
            return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result?.err || "Failed to update organization role"));
        }
        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.delete("/:id", requirePermission("manage_roles"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const context = getUserContext(req);
        const result = await deleteOrgRole(id, orgId, context);
        if (result == undefined || result.err) {
            return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result?.err || "Failed to delete organization role"));
        }
        res.json(createSuccessResponse({ id }));
    } catch (err) {
        next(err);
    }
});

router.post("/assign", requirePermission("manage_roles"), async (req, res, next) => {
    try {  
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await assignOrgRole(req.body, orgId, context);
        if (result == undefined || result.err) {
            return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result?.err || "Failed to assign organization role"));
        }
        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

export default router;