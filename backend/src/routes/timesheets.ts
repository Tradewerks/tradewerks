import { Router, type Response } from "express";
import { ErrorCodes, createSuccessResponse, createErrorResponse } from "../types/responses.js";
import { requirePermission } from "../lib/requirePermissions.js";
import { timesheetWeekQuerySchema } from "../lib/validate/timesheets.js";
import { deleteTimesheet, getTechnicianWeek, getTimesheets, insertTimesheet } from "../controllers/timesheetController.js";
import { getUserContext } from "../lib/context.js";

const router = Router();

const view = requirePermission("view_timesheet");
const edit = requirePermission("manage_timesheet");

function sendControllerErr(res: Response, err: string) {
	if (err.includes("not found")) return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, err));
	if (err.includes("already")) return res.status(409).json(createErrorResponse(ErrorCodes.CONFLICT, err));
	if (err.startsWith("Only dispatchers")) return res.status(403).json(createErrorResponse(ErrorCodes.FORBIDDEN, err));
	return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, err));
}

router.get("/", view, async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const parsed = timesheetWeekQuerySchema.safeParse(req.query);
		if (!parsed.success) {
			return res
				.status(400)
				.json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0].message));
		}
		res.json(createSuccessResponse(await getTimesheets(orgId, parsed.data.date)));
	} catch (err) {
		next(err);
	}
});

router.get("/technician/:technicianId", view, async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const parsed = timesheetWeekQuerySchema.safeParse(req.query);
		if (!parsed.success) {
			return res
				.status(400)
				.json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0].message));
		}
		const result = await getTechnicianWeek(orgId, req.params.technicianId as string, parsed.data.date);
		if ("err" in result) return sendControllerErr(res, result.err ?? "Error loading timesheet");
		res.json(createSuccessResponse(result));
	} catch (err) {
		next(err);
	}
});

router.post("/approve", edit, async (req,res, next) =>{
	try {
		const orgId= req.user!.organization_id as string;
		const data = req.body;
		const result = await insertTimesheet(orgId, data, getUserContext(req));

		if ("err" in result) return sendControllerErr(res, result.err ?? "Error arrpoving time");

		res.status(201).json(createSuccessResponse(result.timesheet));
	} catch (err) {
		next(err);
	}
});

router.delete("/approve", edit, async (req,res, next) =>{
	try {
		const orgId= req.user!.organization_id as string;
		const data = req.body;
		const result = await deleteTimesheet(orgId, data, getUserContext(req));

		if ("err" in result) return sendControllerErr(res, result.err);

		res.json(createSuccessResponse(result.timesheet));
	} catch (err) {
		next(err);
	}
});

export default router;
