import z from "zod";
import {
	approveTimesheetSchema,
	editShiftSchema,
	reportShiftIssueSchema,
	reviewCorrectionSchema,
} from "../lib/validate/timesheets.js";
import {
	authed,
	envelope,
	errorEnvelope,
	historyQuery,
	historyResponses,
	json,
} from "./shared.js";

// ===============================================================================================================================
// Timesheets
// ===============================================================================================================================

// Weeks run Monday to Sunday in the organization's timezone. An approved week is
// locked: shifts in it can't be edited until it's unapproved.
const weekQuery = z.object({
	date: z.iso
		.date()
		.optional()
		.describe("Any day in the week; defaults to this week"),
});
const badWeek = json(
	errorEnvelope,
	"`date` isn't YYYY-MM-DD (`VALIDATION_ERROR`)",
);
const loose = (text: string) =>
	z.record(z.string(), z.unknown()).describe(text);
const body = (schema: z.ZodType, example?: unknown) => ({
	body: {
		content: {
			"application/json": { schema, ...(example ? { example } : {}) },
		},
	},
});
const officeOnly = (what: string) =>
	json(errorEnvelope, `${what} (\`FORBIDDEN\`)`);

authed("get", "/timesheets", "Timesheets", "view_timesheet", {
	summary: "List the week's timesheets",
	description:
		"Requires the `view_timesheet` permission. Every technician's hours for the week (shifts, breaks, visit time, drive time), with whether the week is approved.",
	request: { query: weekQuery },
	responses: {
		200: json(
			envelope(loose("Per-technician totals and status for the week")),
			"Week",
		),
		400: badWeek,
	},
});

authed(
	"get",
	"/timesheets/technician/{technicianId}",
	"Timesheets",
	"view_timesheet or self",
	{
		summary: "Get a technician's week",
		description:
			"Requires `view_timesheet`, or the caller must be this technician. Day by day: shifts, breaks, visit clock-ins and corrections they've reported.",
		request: {
			params: z.object({ technicianId: z.uuid() }),
			query: weekQuery,
		},
		responses: {
			200: json(envelope(loose("The technician's week")), "Week"),
			400: badWeek,
			404: json(errorEnvelope, "Technician not found (`NOT_FOUND`)"),
		},
	},
);

authed(
	"get",
	"/timesheets/weeks/{id}/changes",
	"Timesheets",
	"view_timesheet",
	{
		summary: "Get a timesheet week's history",
		description:
			"Requires the `view_timesheet` permission. `id` is `<technicianId>:<YYYY-MM-DD>` with any date in the week. Approvals and shift edits.",
		request: { params: z.object({ id: z.string() }), query: historyQuery },
		responses: {
			...historyResponses,
			400: json(
				errorEnvelope,
				"`id` isn't `<technicianId>:<YYYY-MM-DD>`, or `limit` is out of range (`VALIDATION_ERROR`)",
			),
		},
	},
);

authed("post", "/timesheets/approve", "Timesheets", "manage_timesheet", {
	summary: "Approve a technician's week",
	description:
		"Requires the `manage_timesheet` permission; office users only. Locks the week. Every shift and visit clock-in in it must be closed.",
	request: body(approveTimesheetSchema.meta({ id: "ApproveTimesheet" }), {
		technician_id: "3f6c2a1e-8b4d-4c2a-9e1f-1a2b3c4d5e6f",
		date: "2026-11-09",
	}),
	responses: {
		201: json(envelope(loose("The approval")), "Approved"),
		400: json(
			errorEnvelope,
			"Validation failed, a shift or clock-in is still open, or no completed shifts (`VALIDATION_ERROR`)",
		),
		403: officeOnly("Not an office user"),
		404: json(errorEnvelope, "Technician not found (`NOT_FOUND`)"),
		409: json(errorEnvelope, "Already approved (`CONFLICT`)"),
	},
});

authed("delete", "/timesheets/approve", "Timesheets", "manage_timesheet", {
	summary: "Unapprove a technician's week",
	description:
		"Requires the `manage_timesheet` permission; office users only. Unlocks the week for edits. Takes the same body as approving.",
	request: body(approveTimesheetSchema),
	responses: {
		200: json(envelope(loose("The removed approval")), "Unapproved"),
		400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
		403: officeOnly("Not an office user"),
		404: json(errorEnvelope, "No approval for that week (`NOT_FOUND`)"),
	},
});

authed(
	"patch",
	"/timesheets/shifts/{shiftId}",
	"Timesheets",
	"manage_timesheet or edit_own_timesheet",
	{
		summary: "Edit a shift",
		description:
			"Requires `manage_timesheet` or `edit_own_timesheet`; technicians can only edit their own shifts. Changes start and end times, adds, edits or deletes breaks (`delete_break_ids`), and corrects visit clock-in and clock-out times. The shift must be closed and its week not approved; breaks must fall within the shift and not overlap.",
		request: {
			params: z.object({ shiftId: z.uuid() }),
			...body(editShiftSchema.meta({ id: "EditShift" }), {
				ended_at: "2026-11-12T17:30:00-07:00",
			}),
		},
		responses: {
			200: json(envelope(loose("The shift")), "Updated"),
			400: json(
				errorEnvelope,
				"Validation failed, the shift is open or its week approved, or the times don't fit (`VALIDATION_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"Shift, break or visit time entry not found, or another technician's shift (`NOT_FOUND`)",
			),
		},
	},
);

authed("post", "/timesheets/shifts/{shiftId}/report", "Timesheets", null, {
	summary: "Report a problem with my shift",
	description:
		"Technicians only, on their own shifts. Sends the office a correction request with a `message` and optionally the times they think are right (`proposed`, same shape as editing a shift).",
	request: {
		params: z.object({ shiftId: z.uuid() }),
		...body(reportShiftIssueSchema.meta({ id: "ReportShiftIssue" }), {
			message: "I forgot to end my lunch break; it was 30 minutes.",
		}),
	},
	responses: {
		200: json(envelope(z.null()), "Reported (`data` is null)"),
		400: json(
			errorEnvelope,
			"Validation failed, or the proposed times don't fit (`VALIDATION_ERROR`)",
		),
		403: officeOnly("Not a technician"),
		404: json(
			errorEnvelope,
			"Shift not found, or not the caller's (`NOT_FOUND`)",
		),
	},
});

const reviewParams = z.object({ id: z.uuid() });
const correctionResponses = {
	400: json(
		errorEnvelope,
		"Validation failed, or the times don't fit (`VALIDATION_ERROR`)",
	),
	403: officeOnly("Not an office user"),
	404: json(errorEnvelope, "Correction not found (`NOT_FOUND`)"),
	409: json(errorEnvelope, "Already reviewed (`CONFLICT`)"),
};

authed(
	"post",
	"/timesheets/corrections/{id}/accept",
	"Timesheets",
	"manage_timesheet",
	{
		summary: "Accept a shift correction",
		description:
			"Requires the `manage_timesheet` permission; office users only. Applies the technician's proposed times, or `proposed` here to adjust them first, and closes the request with an optional `note`.",
		request: {
			params: reviewParams,
			...body(
				reviewCorrectionSchema.meta({ id: "ReviewShiftCorrection" }),
			),
		},
		responses: {
			200: json(envelope(z.literal(true)), "Accepted"),
			...correctionResponses,
		},
	},
);

authed(
	"post",
	"/timesheets/corrections/{id}/reject",
	"Timesheets",
	"manage_timesheet",
	{
		summary: "Reject a shift correction",
		description:
			"Requires the `manage_timesheet` permission; office users only. Closes the request without changing the shift, with an optional `note`.",
		request: { params: reviewParams, ...body(reviewCorrectionSchema) },
		responses: {
			200: json(envelope(z.literal(true)), "Rejected"),
			...correctionResponses,
		},
	},
);
