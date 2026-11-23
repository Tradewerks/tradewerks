import type { Request, Response } from "express";
import crypto from "node:crypto";
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

// Account deletion takes the password; only wrong ones count against the window.
export const accountDeletionLimiter = rateLimit({
	windowMs: 15 * 60_000,
	limit: 5,
	keyGenerator: (req) => req.user?.uid ?? "anonymous",
	skipSuccessfulRequests: true,
	standardHeaders: "draft-8",
	legacyHeaders: false,
	handler: tooMany("Too many attempts. Try again in 15 minutes."),
});

// PDF renders are expensive; cap each link however many IPs replay it.
export const documentPdfTokenLimiter = rateLimit({
	windowMs: 15 * 60_000,
	limit: 20,
	keyGenerator: (req) =>
		crypto
			.createHash("sha256")
			.update(
				typeof req.body?.token === "string"
					? req.body.token.slice(0, 200)
					: "",
			)
			.digest("hex"),
	standardHeaders: "draft-8",
	legacyHeaders: false,
	handler: tooMany("Too many requests. Try again in 15 minutes."),
});

// Unauthenticated customer links: one budget per IP for the link and unsubscribe pages.
export const publicLinkLimiter = rateLimit({
	windowMs: 15 * 60_000,
	limit: 60,
	standardHeaders: "draft-8",
	legacyHeaders: false,
	handler: tooMany("Too many requests. Try again in 15 minutes."),
});

// RFC 8058 one-click POSTs come from mailbox providers whose servers share IPs, so
// they get a per-token budget and only a generous per-IP backstop.
export const oneClickTokenLimiter = rateLimit({
	windowMs: 15 * 60_000,
	limit: 10,
	keyGenerator: (req) =>
		crypto
			.createHash("sha256")
			.update(typeof req.query.t === "string" ? req.query.t : "")
			.digest("hex"),
	standardHeaders: "draft-8",
	legacyHeaders: false,
	handler: tooMany("Too many requests. Try again in 15 minutes."),
});

export const oneClickIpLimiter = rateLimit({
	windowMs: 15 * 60_000,
	limit: 1000,
	standardHeaders: "draft-8",
	legacyHeaders: false,
	handler: tooMany("Too many requests. Try again in 15 minutes."),
});
