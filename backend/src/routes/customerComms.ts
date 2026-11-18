import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { requirePermission } from "../lib/requirePermissions.js";
import {
	ErrorCodes,
	createErrorResponse,
	createSuccessResponse,
} from "../types/responses.js";
import * as controller from "../controllers/customerCommsController.js";
import * as templatesController from "../controllers/emailTemplatesController.js";
import type { CustomerEvent } from "../services/customerComms/events.js";
import {
	CustomerEventParam,
	messagesQuerySchema,
	parseEventConfig,
	updateSettingSchema,
} from "../lib/validate/customerComms.js";
import { upsertTemplateSchema } from "../lib/validate/emailTemplates.js";
import { smsUnavailableReason } from "../services/sms/smsAvailability.js";

const router = Router();

const orgOf = (req: Request) => req.user!.organization_id as string;

const badRequest = (res: Response, message: string) =>
	res
		.status(400)
		.json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, message));

/** Wraps a handler: forwards thrown errors to the error middleware. */
const handle =
	(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
	async (req, res, next) => {
		try {
			await fn(req, res);
		} catch (err) {
			next(err);
		}
	};

/** As `handle`, but resolves :event first and answers 404 when it is unknown. */
const handleEvent = (
	fn: (event: CustomerEvent, req: Request, res: Response) => Promise<unknown>,
) =>
	handle(async (req, res) => {
		const event = CustomerEventParam.safeParse(req.params.event);
		if (!event.success) {
			return res
				.status(404)
				.json(
					createErrorResponse(ErrorCodes.NOT_FOUND, "Unknown event"),
				);
		}
		return fn(event.data, req, res);
	});

router.get(
	"/settings",
	requirePermission("view_customer_comms"),
	handle(async (req, res) => {
		const events = await controller.listSettings(orgOf(req));
		res.json(createSuccessResponse({ events }));
	}),
);

router.put(
	"/settings/:event",
	requirePermission("manage_customer_comms"),
	handleEvent(async (event, req, res) => {
		const parsed = updateSettingSchema.safeParse(req.body);
		if (!parsed.success) {
			return badRequest(res, parsed.error.issues[0].message);
		}
		if (
			parsed.data.review_url !== undefined &&
			event !== "review_request"
		) {
			return badRequest(
				res,
				"A review link belongs to the review request",
			);
		}
		if (parsed.data.config !== undefined) {
			const cfg = parseEventConfig(event, parsed.data.config);
			if (!cfg.success)
				return badRequest(res, cfg.error.issues[0].message);
			parsed.data.config = cfg.data;
		}
		const orgId = orgOf(req);
		if (
			parsed.data.sms_enabled === true &&
			(await smsUnavailableReason(orgId))
		) {
			return res
				.status(409)
				.json(
					createErrorResponse(
						"SMS_NOT_ACTIVE",
						"Set up text messaging before turning on text messages.",
					),
				);
		}
		if (
			event === "review_request" &&
			(await controller.reviewUrlMissing(orgId, parsed.data))
		) {
			return res
				.status(409)
				.json(
					createErrorResponse(
						"REVIEW_URL_REQUIRED",
						"Add your review link before turning on review requests.",
					),
				);
		}
		res.json(
			createSuccessResponse(
				await controller.updateSetting(orgId, event, parsed.data),
			),
		);
	}),
);

router.get(
	"/messages",
	requirePermission("view_customer_comms"),
	handle(async (req, res) => {
		const parsed = messagesQuerySchema.safeParse(req.query);
		if (!parsed.success) {
			return badRequest(res, parsed.error.issues[0].message);
		}
		const items = await controller.listMessages(orgOf(req), parsed.data);
		res.json(createSuccessResponse(items, { count: items.length }));
	}),
);

// Customer-message templates. The editor lives under this module, so it is
// gated on customer_comms permissions rather than the followups ones.
router.get(
	"/templates/context",
	requirePermission("view_customer_comms"),
	handle(async (req, res) => {
		res.json(
			createSuccessResponse(
				await templatesController.getPreviewContext(orgOf(req)),
			),
		);
	}),
);

router.get(
	"/templates/:event",
	requirePermission("view_customer_comms"),
	handleEvent(async (event, req, res) => {
		res.json(
			createSuccessResponse(
				await controller.getTemplate(orgOf(req), event),
			),
		);
	}),
);

router.put(
	"/templates/:event",
	requirePermission("manage_customer_comms"),
	handleEvent(async (event, req, res) => {
		const parsed = upsertTemplateSchema.safeParse(req.body);
		if (!parsed.success) {
			return badRequest(res, parsed.error.issues[0].message);
		}
		res.json(
			createSuccessResponse(
				await controller.upsertTemplate(
					orgOf(req),
					event,
					parsed.data,
					req.user!.uid ?? null,
				),
			),
		);
	}),
);

router.post(
	"/templates/:event/reset",
	requirePermission("manage_customer_comms"),
	handleEvent(async (event, req, res) => {
		res.json(
			createSuccessResponse(
				await controller.resetTemplate(orgOf(req), event),
			),
		);
	}),
);

export default router;
