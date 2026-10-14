import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ErrorCodes, createErrorResponse } from "../../types/responses.js";
import { getEntitlements } from "../../services/entitlementService.js";
import { getModule, type Access } from "./registry.js";
import { isAccessAllowed } from "./resolve.js";

// Deliberately ignores role and permissions: the admin role skips permission
// checks, and a module the org is not entitled to must be closed to admins too.
export const requireModule = (
	key: string,
	access?: Access,
	// For a gate on a router mount: paths (relative to the mount) whose non-GET
	// method only reads. A gate on the route itself would run after this one
	// had already refused the request.
	options: { readOnlyPaths?: RegExp[] } = {},
): RequestHandler => {
	// A mistyped key would resolve to not_in_plan and lock the route for every
	// org; gates are built at import time, so this stops the boot instead.
	if (!getModule(key))
		throw new Error(`requireModule: unknown module "${key}"`);
	return async (req: Request, res: Response, next: NextFunction) => {
		const orgId = req.user?.organization_id;
		if (!orgId) {
			return res
				.status(403)
				.json(
					createErrorResponse(
						ErrorCodes.FORBIDDEN,
						"No organization on this account",
					),
				);
		}
		const needed: Access =
			access ??
			(req.method === "GET" ||
			req.method === "HEAD" ||
			options.readOnlyPaths?.some((re) => re.test(req.path))
				? "read"
				: "write");
		try {
			const state =
				(await getEntitlements(orgId)).modules[key] ?? "not_in_plan";
			if (isAccessAllowed(state, needed)) return next();
			const label = getModule(key)?.label ?? key;
			if (state === "off_by_org") {
				return res
					.status(403)
					.json(
						createErrorResponse(
							ErrorCodes.MODULE_DISABLED,
							`${label} is turned off for your organization`,
						),
					);
			}
			return res
				.status(403)
				.json(
					createErrorResponse(
						ErrorCodes.MODULE_NOT_IN_PLAN,
						`${label} is not included in your plan`,
					),
				);
		} catch (err) {
			next(err);
		}
	};
};
