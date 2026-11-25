import { Router } from 'express';
import {
    ErrorCodes,
    createSuccessResponse,
    createErrorResponse,
} from "../types/responses.js";
import {
    getAllRequests,
    getRequestsPage,
    parseRequestListExtras,
    REQUEST_LIST_SPEC,
    getRequestById,
    insertRequest,
    updateRequest,
    deleteRequest
} from "../controllers/requestsController.js";
import { getUserContext } from '../lib/context.js';
import * as requestNotesController from '../controllers/requestNotesController.js';
import { markLegacyList, parseListQuery, sendList, sendListError } from '../lib/listQuery.js';
import { requirePermission } from '../lib/requirePermissions.js';
import { getEntityHistory, parseHistoryLimit, INVALID_HISTORY_LIMIT } from '../controllers/logsController.js';

const router = Router();

router.get("/", requirePermission("view_requests"), async (req, res, next) => {
    // requireRole("dispatcher"),           temp removal until further implementation
    try {
        const orgId = req.user!.organization_id as string;
        let parsed, extras;
        try {
            parsed = parseListQuery(req.query, REQUEST_LIST_SPEC);
            // Legacy calls are not validated, so stray params must not reach the extras.
            extras = parsed.paged ? parseRequestListExtras(req.query) : undefined;
        } catch (err) {
            if (sendListError(res, err)) return;
            throw err;
        }
        if (!parsed.paged) {
            markLegacyList(res);
            const requests = await getAllRequests(orgId);
            return res.json(createSuccessResponse(requests, { count: requests.length }));
        }
        const { rows, total } = await getRequestsPage(orgId, parsed, extras!);
        sendList(res, parsed, rows, total);
    } catch (err) {
        next(err);
    }
});

router.get("/:id", requirePermission("view_requests"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const request = await getRequestById(id, orgId);

        if (!request) {
            return res
                .status(404)
                .json(
                    createErrorResponse(
                        ErrorCodes.NOT_FOUND,
                        "Request not found",
                    ),
                );
        }

        res.json(createSuccessResponse(request));
    } catch (err) {
        next(err);
    }
});



router.post("/", requirePermission("create_requests"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await insertRequest(req, orgId, context);

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

        res.status(201).json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.put("/:id", requirePermission("edit_requests"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await updateRequest(req, orgId, context);

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.delete("/:id", requirePermission("delete_requests"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await deleteRequest(id, orgId, context);

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(createErrorResponse(ErrorCodes.DELETE_ERROR, result.err));
        }

        res.status(200).json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

// ============================================
// REQUEST NOTE ROUTES
// ============================================

router.get("/:requestId/notes", requirePermission("view_requests"), async (req, res, next) => {
    try {
        const requestId = req.params.requestId as string;
        const orgId = req.user!.organization_id as string;
        const notes = await requestNotesController.getRequestNotes(requestId, orgId);
        res.json(createSuccessResponse(notes, { count: notes.length }));
    } catch (err) {
        next(err);
    }
});

router.get("/:requestId/notes/:noteId", requirePermission("view_requests"), async (req, res, next) => {
    try {
        const { requestId, noteId } = req.params as { requestId: string; noteId: string };
        const orgId = req.user!.organization_id as string;
        const note = await requestNotesController.getNoteById(
            requestId,
            noteId,
            orgId,
        );

        if (!note) {
            return res
                .status(404)
                .json(
                    createErrorResponse(ErrorCodes.NOT_FOUND, "Note not found"),
                );
        }

        res.json(createSuccessResponse(note));
    } catch (err) {
        next(err);
    }
});

router.post("/:requestId/notes", requirePermission("edit_requests"), async (req, res, next) => {
    try {
        const requestId = req.params.requestId as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await requestNotesController.insertRequestNote(
            requestId,
            req.body,
            orgId,
            context,
        );

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.status(201).json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.put("/:requestId/notes/:noteId", requirePermission("edit_requests"), async (req, res, next) => {
    try {
        const { requestId, noteId } = req.params as { requestId: string; noteId: string };
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await requestNotesController.updateRequestNote(
            requestId,
            noteId,
            req.body,
            orgId,
            context,
        );

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.delete("/:requestId/notes/:noteId", requirePermission("edit_requests"), async (req, res, next) => {
    try {
        const { requestId, noteId } = req.params as { requestId: string; noteId: string };
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await requestNotesController.deleteRequestNote(
            requestId,
            noteId,
            orgId,
            context,
        );

        if (result.err) {
            const statusCode = result.err.includes("not found") ? 404 : 400;
            return res
                .status(statusCode)
                .json(createErrorResponse(ErrorCodes.DELETE_ERROR, result.err));
        }

        res.status(200).json(
            createSuccessResponse({ message: result.message }),
        );
    } catch (err) {
        next(err);
    }
});

router.get("/:requestId/changes", requirePermission("view_requests"), async (req, res, next) => {
    try {
        const requestId = req.params.requestId as string;
        const orgId = req.user!.organization_id as string;
        let limit: number;
        try {
            limit = parseHistoryLimit(req.query.limit);
        } catch {
            return res
                .status(400)
                .json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, INVALID_HISTORY_LIMIT));
        }

        const results = await getEntityHistory(orgId, "request", requestId, limit);

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
