import { Router } from 'express';
import {
    ErrorCodes,
    createSuccessResponse,
    createErrorResponse,
} from "../types/responses.js";
import { getUserContext } from '../lib/context.js';
import {
    getAllDispatchers,
    getDispatcherById,
    insertDispatcher,
    updateDispatcher,
    deleteDispatcher,
    changeDispatcherPassword,
    deactivateDispatcher,
    reactivateDispatcher
} from "../controllers/dispatchersController.js";
import { requestPasswordReset } from '../controllers/authenticationController.js';
import { resetMfa } from '../controllers/mfaController.js';
import { requirePermission, requirePermissionOrSelf } from '../lib/requirePermissions.js';
import { getUserHistory, parseHistoryLimit, INVALID_HISTORY_LIMIT } from '../controllers/logsController.js';

const router = Router();

router.get("/", requirePermission("view_dispatchers"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const dispatcher = await getAllDispatchers(orgId);
        res.json(
            createSuccessResponse(dispatcher, { count: dispatcher.length }),
        );
    } catch (err) {
        next(err);
    }
});

router.get("/:id", requirePermissionOrSelf("view_dispatchers"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const dispatcher = await getDispatcherById(id, orgId);

        if (!dispatcher) {
            return res
                .status(404)
                .json(
                    createErrorResponse(
                        ErrorCodes.NOT_FOUND,
                        "Dispatcher not found",
                    ),
                );
        }

        res.json(createSuccessResponse(dispatcher));
    } catch (err) {
        next(err);
    }
});

router.post("/", requirePermission("manage_dispatchers"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await insertDispatcher(req.body, orgId, context);

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

router.put("/:id", requirePermissionOrSelf("manage_dispatchers"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await updateDispatcher(id, req.body, orgId, context);

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

router.post("/:id/reset-password", requirePermissionOrSelf("manage_dispatchers"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const user = await getDispatcherById(id, orgId);
        if (!user) {
            return res
                .status(404)
                .json(
                    createErrorResponse(
                        ErrorCodes.NOT_FOUND,
                        "Dispatcher not found",
                    ),
                );
        }
        const result = await requestPasswordReset(user.email, user.role);

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
                        "You are not the owner of this dispatcher",
                    ),
                );
        }
        const id = req.params.id as string;
        const orgId = req.user.organization_id as string;
        const data = req.body;
        const result = await changeDispatcherPassword(id, orgId, data, getUserContext(req));
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

router.delete("/:id", requirePermission("manage_dispatchers"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await deleteDispatcher(id, orgId, context);

        if (result.err) {
            return res
                .status(400)
                .json(createErrorResponse(ErrorCodes.DELETE_ERROR, result.err));
        }

        res.status(200).json(
            createSuccessResponse({
                message: result.message || "Dispatcher deleted successfully",
                id,
            }),
        );
    } catch (err) {
        next(err);
    }
});

router.post("/:id/deactivate", requirePermission("manage_dispatchers"), async (req, res, next) => {
    try {
        const result = await deactivateDispatcher(
            req.params.id as string,
            req.user!.organization_id as string,
            getUserContext(req),
        );
        if (result.err) {
            return res.status(400).json(createErrorResponse(ErrorCodes.BAD_REQUEST, result.err));
        }
        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post("/:id/reactivate", requirePermission("manage_dispatchers"), async (req, res, next) => {
    try {
        const result = await reactivateDispatcher(
            req.params.id as string,
            req.user!.organization_id as string,
            getUserContext(req),
        );
        if (result.err) {
            return res.status(400).json(createErrorResponse(ErrorCodes.BAD_REQUEST, result.err));
        }
        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post("/:id/mfa/reset", requirePermissionOrSelf("manage_dispatchers"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const target = await getDispatcherById(id, orgId);
        if (!target) {
            return res
                .status(404)
                .json(createErrorResponse(ErrorCodes.NOT_FOUND, "Dispatcher not found"));
        }
        const result = await resetMfa(id, "dispatcher", req.user!.uid, req.user!.role);
        res.json(createSuccessResponse(result.data));
    } catch (err) {
        next(err);
    }
});

router.get("/:id/changes", requirePermissionOrSelf("view_dispatchers"), async (req, res, next) => {
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

        const results = await getUserHistory(orgId, "dispatcher", id, limit);

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
