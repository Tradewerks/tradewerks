import type { Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { createErrorResponse, ErrorCodes } from "../types/responses.js";

const tooMany = (message: string) => (_req: Request, res: Response) =>
	res.status(429).json(createErrorResponse(ErrorCodes.TOO_MANY_REQUESTS, message));

export const platformAuthLimiter = rateLimit({
	windowMs: 15 * 60_000,
	limit: 20,
	standardHeaders: "draft-8",
	legacyHeaders: false,
	handler: tooMany("Too many attempts. Try again in 15 minutes."),
});

export const upgradeRequestLimiter = rateLimit({
	windowMs: 60 * 60_000,
	limit: 5,
	keyGenerator: (req) => req.user?.uid ?? "anonymous",
	// Refused attempts (validation, already-open request) do not use up the hour.
	skipFailedRequests: true,
	standardHeaders: "draft-8",
	legacyHeaders: false,
	handler: tooMany("Too many requests. Try again in an hour."),
});

export const signupLimiter = rateLimit({
	windowMs: 60 * 60_000,
	limit: 5,
	standardHeaders: "draft-8",
	legacyHeaders: false,
	handler: tooMany("Too many signups from this network. Try again later."),
});

export const orgInviteLimiter = rateLimit({
	windowMs: 15 * 60_000,
	limit: 20,
	standardHeaders: "draft-8",
	legacyHeaders: false,
	handler: tooMany("Too many attempts. Try again in 15 minutes."),
});
