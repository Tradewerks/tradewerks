import type { Request, Response, NextFunction } from "express";
import { db } from "../db.js";
import { log } from "../services/appLogger.js";
import { createErrorResponse, ErrorCodes } from "../types/responses.js";
import { platformSecret, verifyStaffClaims } from "./staffToken.js";

// Read on every request, not cached: a cache is per instance, so a disable or MFA reset on
// one instance would leave the others honoring revoked tokens until it expired.
async function staffLive(id: string, iat: number | undefined): Promise<boolean> {
	// Disable and MFA reset revoke every token issued before them, so a re-enable revives none.
	const issuedAt = new Date((iat ?? 0) * 1000);
	const row = await db.platform_staff.findFirst({
		where: {
			id,
			status: "active",
			OR: [{ sessions_valid_after: null }, { sessions_valid_after: { lte: issuedAt } }],
		},
		select: { id: true },
	});
	return row !== null;
}

export function requirePlatformEnabled(
	_req: Request,
	res: Response,
	next: NextFunction,
) {
	if (platformSecret()) return next();
	log.error(
		"PLATFORM_JWT_SECRET missing, short, or shared; /platform disabled",
	);
	return res
		.status(503)
		.json(
			createErrorResponse(
				ErrorCodes.SERVER_ERROR,
				"Back office is not configured",
			),
		);
}

export function restrictPlatformIps(
	req: Request,
	res: Response,
	next: NextFunction,
) {
	const allowed = (process.env.PLATFORM_ALLOWED_IPS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (!allowed.length) return next();
	const ip = (req.ip ?? "").replace(/^::ffff:/, "");
	if (allowed.includes(ip)) return next();
	return res
		.status(404)
		.json(createErrorResponse(ErrorCodes.NOT_FOUND, "Not found"));
}

export async function verifyStaffToken(
	req: Request,
	res: Response,
	next: NextFunction,
) {
	if (req.method === "OPTIONS") return next();
	const token = req.headers.authorization?.split(" ")[1] ?? "";
	let claims;
	try {
		claims = verifyStaffClaims(token);
	} catch {
		return res
			.status(401)
			.json(
				createErrorResponse(ErrorCodes.INVALID_TOKEN, "Sign in again"),
			);
	}
	try {
		if (!(await staffLive(claims.sid, claims.iat)))
			return res
				.status(401)
				.json(
					createErrorResponse(
						ErrorCodes.INVALID_TOKEN,
						"Sign in again",
					),
				);
	} catch (err) {
		// Fails closed: an unchecked staff token can act on every organization.
		log.error({ err }, "staff active check failed");
		return res
			.status(503)
			.json(
				createErrorResponse(
					ErrorCodes.SERVER_ERROR,
					"Back office unavailable",
				),
			);
	}
	req.staff = { id: claims.sid, email: claims.email, name: claims.name };
	next();
}
