import { Router, type RequestHandler } from "express";
import { ErrorCodes, createSuccessResponse, createErrorResponse } from "../types/responses.js";
import {
	listNotifications,
	markNotificationRead,
	markAllNotificationsRead,
	listDispatcherNotifications,
	markDispatcherNotificationRead,
	markAllDispatcherNotificationsRead,
} from "../controllers/notificationsController.js";

const router = Router();

// Users can only reach their own notifications
const ownNotifications: RequestHandler = (req, res, next) => {
	if (req.user?.uid !== req.params.id) {
		res.status(403).json(createErrorResponse(ErrorCodes.FORBIDDEN, "Not your notifications"));
		return;
	}
	next();
};

router.use("/:id/notifications", ownNotifications);

router.get("/:id/notifications", async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const unreadOnly = req.query.unread === "true";
		const orgId = req.user!.organization_id as string;
		const notifications = await listNotifications(id, unreadOnly, orgId);
		res.json(createSuccessResponse(notifications, { count: notifications.length }));
	} catch (err) {
		next(err);
	}
});

// read-all MUST be before /:notifId/read to avoid Express treating "read-all" as a notifId
router.patch("/:id/notifications/read-all", async (req, res, next) => {
	try {
		const id  = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		const result = await markAllNotificationsRead(id, orgId);
		if (result.err) {
			return res.status(400).json(createErrorResponse(ErrorCodes.SERVER_ERROR, result.err));
		}
		res.json(createSuccessResponse(null));
	} catch (err) {
		next(err);
	}
});

router.patch("/:id/notifications/:notifId/read", async (req, res, next) => {
	try {
		const { id, notifId } = req.params as { id: string; notifId: string };
		const orgId = req.user!.organization_id as string;
		const result = await markNotificationRead(id, notifId, orgId);
		if (result.err) {
			const statusCode = result.err.includes("not found") ? 404 : 400;
			return res.status(statusCode).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
		}
		res.json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});

// Dispatcher notification routes, mounted under /dispatchers
export const dispatcherNotificationsRouter = Router();

dispatcherNotificationsRouter.use("/:id/notifications", ownNotifications);

dispatcherNotificationsRouter.get("/:id/notifications", async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const unreadOnly = req.query.unread === "true";
		const orgId = req.user!.organization_id as string;
		const notifications = await listDispatcherNotifications(id, unreadOnly, orgId);
		res.json(createSuccessResponse(notifications, { count: notifications.length }));
	} catch (err) {
		next(err);
	}
});

// read-all MUST be before /:notifId/read to avoid Express treating "read-all" as a notifId
dispatcherNotificationsRouter.patch("/:id/notifications/read-all", async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		const result = await markAllDispatcherNotificationsRead(id, orgId);
		if (result.err) {
			return res.status(400).json(createErrorResponse(ErrorCodes.SERVER_ERROR, result.err));
		}
		res.json(createSuccessResponse(null));
	} catch (err) {
		next(err);
	}
});

dispatcherNotificationsRouter.patch("/:id/notifications/:notifId/read", async (req, res, next) => {
	try {
		const { id, notifId } = req.params as { id: string; notifId: string };
		const orgId = req.user!.organization_id as string;
		const result = await markDispatcherNotificationRead(id, notifId, orgId);
		if (result.err) {
			const statusCode = result.err.includes("not found") ? 404 : 400;
			return res.status(statusCode).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
		}
		res.json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});

export default router;
