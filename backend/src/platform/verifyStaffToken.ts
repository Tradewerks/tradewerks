import type { Request, Response, NextFunction } from "express";
import { db } from "../db.js";
import { log } from "../services/appLogger.js";
import { createErrorResponse, ErrorCodes } from "../types/responses.js";
import { platformSecret, verifyStaffClaims } from "./staffToken.js";

const TTL_MS = 30_000;
type StaffState = { at: number; active: boolean; validAfter: number };
const cache = new Map<string, StaffState>();

export function setStaffActive(
	id: string,
	active: boolean,
	validAfter: Date | null = null,
): void {
	cache.set(id, {
		at: Date.now(),
		active,
		validAfter: validAfter?.getTime() ?? 0,
	});
}

export function forgetStaff(id: string): void {
	cache.delete(id);
}

async function staffState(id: string): Promise<StaffState> {
	const hit = cache.get(id);
	if (hit && Date.now() - hit.at < TTL_MS) return hit;
	const row = await db.platform_staff.findUnique({
		where: { id },
		select: { status: true, sessions_valid_after: true },
	});
	const state = {
		at: Date.now(),
		active: row?.status === "active",
		validAfter: row?.sessions_valid_after?.getTime() ?? 0,
	};
	cache.set(id, state);
	return state;
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
		const st = await staffState(claims.sid);
		// Disable and MFA reset revoke every token issued before them, so a re-enable revives none.
		if (!st.active || (claims.iat ?? 0) * 1000 < st.validAfter)
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
