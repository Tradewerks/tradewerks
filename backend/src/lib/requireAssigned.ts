import type { Request, Response, NextFunction } from "express";
import { ErrorCodes, createErrorResponse } from "../types/responses.js";
import { hasPermission } from "./requirePermissions.js";
import {
	techOnJob,
	techOnVisit,
	techOnNote,
} from "../controllers/jobsController.js";

// Callers holding one of `seeAll` pass; everyone else must be assigned to the job, visit or note.
// `param` names the route param holding that id, else an optional body field (skipped when absent).
export const requireAssigned =
	(target: "job" | "visit" | "note", seeAll: string[], param: string) =>
	async (req: Request, res: Response, next: NextFunction) => {
		try {
			if (seeAll.some((p) => hasPermission(req, p))) return next();
			const id = req.params[param] ?? req.body?.[param];
			if (typeof id !== "string" || !id) return next();
			const orgId = req.user!.organization_id as string;
			const uid = req.user!.uid as string;
			const check =
				target === "job"
					? techOnJob
					: target === "visit"
						? techOnVisit
						: techOnNote;
			if (!(await check(orgId, uid, id))) {
				return res
					.status(403)
					.json(
						createErrorResponse(
							ErrorCodes.FORBIDDEN,
							`You're not assigned to this ${target}`,
						),
					);
			}
			next();
		} catch (err) {
			next(err);
		}
	};
