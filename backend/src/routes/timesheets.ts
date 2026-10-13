import { Router, type Response } from "express";
import { ErrorCodes, createSuccessResponse, createErrorResponse } from "../types/responses.js";
import { requireAnyPermission, requirePermission, requirePermissionOrSelf } from "../lib/requirePermissions.js";
import { reportShiftIssueSchema, timesheetWeekQuerySchema } from "../lib/validate/timesheets.js";
import { acceptCorrection, deleteTimesheet, editShift, getTechnicianWeek, getTimesheets, insertTimesheet, rejectCorrection, reportShiftIssue } from "../controllers/timesheetController.js";
import { getUserContext } from "../lib/context.js";
import { getEntityHistory, INVALID_HISTORY_LIMIT, parseHistoryLimit, timesheetWeekId } from "../controllers/logsController.js";
import { weekStartOf } from "../lib/dayRange.js";

const router = Router();

const view = requirePermission("view_timesheet");
const edit = requirePermission("manage_timesheet");
const editShiftPerm = requireAnyPermission("manage_timesheet", "edit_own_timesheet");

function sendControllerErr(res: Response, err: string) {
	if (err.includes("not found")) return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, err));
	if (err.includes("already")) return res.status(409).json(createErrorResponse(ErrorCodes.CONFLICT, err));
	if (err.startsWith("Only ")) return res.status(403).json(createErrorResponse(ErrorCodes.FORBIDDEN, err));
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

router.get("/technician/:technicianId", requirePermissionOrSelf("view_timesheet", "technicianId"), async (req, res, next) => {
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

router.get("/weeks/:id/changes", view, async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const match = /^([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(req.params.id as string);
		if (!match || Number.isNaN(Date.parse(match[2]))) {
			return res
				.status(400)
				.json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, "id must be <technicianId>:<YYYY-MM-DD>"));
		}
		let limit: number;
		try {
			limit = parseHistoryLimit(req.query.limit);
		} catch {
			return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, INVALID_HISTORY_LIMIT));
		}

		const id = timesheetWeekId(match[1], weekStartOf(match[2]));
		const results = await getEntityHistory(orgId, "timesheet", id, limit);
		if (results.err) return res.status(500).json(createErrorResponse(ErrorCodes.SERVER_ERROR, results.err));

		res.json(createSuccessResponse(results.rows, {
			count: results.rows.length,
			hasMore: results.hasMore,
			total: results.total,
		}));
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

router.patch("/shifts/:shiftId", editShiftPerm, async (req, res, next) => {
	try {
		const orgId= req.user!.organization_id as string;
		const data = req.body;
		const shiftId = req.params.shiftId as string;

		const result = await editShift(orgId, shiftId, data, getUserContext(req));
		if ("err" in result) return sendControllerErr(res, result.err ?? "Error editing shift");

		res.json(createSuccessResponse(result.shift));
	} catch (err) {
		next(err);
	}
})

router.post("/shifts/:shiftId/report", async (req, res, next) => {
	try {
		const parsed = reportShiftIssueSchema.safeParse(req.body);
		if (!parsed.success) {
			return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0].message));
		}
		const orgId = req.user!.organization_id as string;
		const shiftId = req.params.shiftId as string;

		const result = await reportShiftIssue(orgId, shiftId, parsed.data.message, getUserContext(req), parsed.data.proposed);
		if ("err" in result) return sendControllerErr(res, result.err ?? "Error reporting issue");

		res.json(createSuccessResponse(null));
	} catch (err) {
		next(err);
	}
});

router.post("/corrections/:id/accept", edit, async(req, res, next) =>{
	try {
		const data = req.body;
		const id = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		
		const result = await acceptCorrection(orgId, id, data, getUserContext(req));
		if ("err" in result) return sendControllerErr(res, result.err ?? "Error editing shift");

		res.json(createSuccessResponse(result.ok));
	} catch (err) {
		next(err);
	}
});

router.post("/corrections/:id/reject", edit, async(req, res, next) =>{
	try {
		const data = req.body;
		const id = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		
		const result = await rejectCorrection(orgId, id, data, getUserContext(req));
		if ("err" in result) return sendControllerErr(res, result.err ?? "Error editing shift");

		res.json(createSuccessResponse(result.ok));
	} catch (err) {
		next(err);
	}
});


export default router;
