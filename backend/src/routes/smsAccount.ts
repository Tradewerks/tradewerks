import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { requirePermission } from "../lib/requirePermissions.js";
import {
	createErrorResponse,
	createSuccessResponse,
} from "../types/responses.js";
import {
	SmsAccountError,
	getSmsAccount,
	saveRegistrationDraft,
	submitRegistration,
} from "../services/sms/registrationService.js";

const router = Router();

router.use(requirePermission("manage_customer_comms"));

const orgOf = (req: Request) => req.user!.organization_id as string;

const handle =
	(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
	async (req, res, next) => {
		try {
			await fn(req, res);
		} catch (err) {
			if (err instanceof SmsAccountError) {
				res.status(err.status).json(
					createErrorResponse(err.code, err.message),
				);
				return;
			}
			next(err);
		}
	};

router.get(
	"/",
	handle(async (req, res) => {
		res.json(createSuccessResponse(await getSmsAccount(orgOf(req))));
	}),
);

router.put(
	"/registration",
	handle(async (req, res) => {
		res.json(
			createSuccessResponse(
				await saveRegistrationDraft(orgOf(req), req.body),
			),
		);
	}),
);

router.post(
	"/submit",
	handle(async (req, res) => {
		res.json(
			createSuccessResponse(
				await submitRegistration(orgOf(req), req.body),
			),
		);
	}),
);

export default router;
