import z from "zod";
import {
	createTechnicianSchema,
	updateTechnicianSchema,
} from "../lib/validate/technicians.js";
import {
	authed,
	decimal,
	envelope,
	errorEnvelope,
	historyQuery,
	historyResponses,
	idName,
	json,
	moduleOff,
} from "./shared.js";
import { coords } from "./requestsQuotes.js";
import { jobVisit } from "./jobs.js";

// ===============================================================================================================================
// Technicians
// ===============================================================================================================================

const technician = z
	.object({
		id: z.uuid(),
		organization_id: z.uuid().nullable(),
		name: z.string(),
		email: z.string(),
		phone: z.string(),
		title: z.string(),
		description: z.string(),
		status: z.enum([
			"Offline",
			"Available",
			"Break",
			"EnRoute",
			"OnSite",
			"Working",
			"Paused",
			"WrappingUp",
			"HeadingBack",
		]),
		hire_date: z.iso.datetime(),
		coords: coords
			.or(z.object({}))
			.describe("Last reported location, `{}` if none"),
		last_ping_at: z.iso.datetime().nullable(),
		last_login: z.iso.datetime().nullable(),
		deactivated_at: z.iso
			.datetime()
			.nullable()
			.describe("Null while active"),
		theme: z.string(),
		language: z.string(),
		organization_role_id: z.uuid().nullable(),
		current_vehicle_id: z.uuid().nullable(),
		current_vehicle: idName
			.extend({ stored_at_coords: coords.nullable() })
			.nullable(),
		organization_role: idName
			.extend({ permissions: z.array(z.string()) })
			.nullable(),
		permissions: z.array(z.string()),
		mfaEnabled: z.boolean(),
		cost_rate: decimal
			.nullable()
			.optional()
			.describe(
				"Decimal as a string. Only when the caller has `manage_technicians`",
			),
		visit_techs: z
			.array(z.record(z.string(), z.unknown()))
			.describe("Every visit assignment, with its visit, job and client"),
	})
	.meta({ id: "Technician" });

authed("get", "/technicians", "Technicians", "view_technicians", {
	summary: "List technicians",
	description:
		"Requires the `view_technicians` permission. Includes deactivated technicians. Passwords are never returned; `cost_rate` only with `manage_technicians`.",
	responses: {
		200: json(
			envelope(z.array(technician)),
			"Technicians (empty array if none)",
		),
	},
});

const technicianRow = technician
	.omit({
		permissions: true,
		mfaEnabled: true,
		current_vehicle: true,
		organization_role: true,
	})
	.describe(
		"The technician row with `visit_techs`, without `permissions`, `mfaEnabled`, `current_vehicle` or `organization_role`",
	);

authed("get", "/technicians/{id}", "Technicians", "view_technicians", {
	summary: "Get a technician",
	description:
		"Requires the `view_technicians` permission, unless it's the caller's own record. `cost_rate` is only included for callers with `manage_technicians`.",
	request: { params: z.object({ id: z.uuid() }) },
	responses: {
		200: json(envelope(technician), "Technician"),
		404: json(
			errorEnvelope,
			"Technician not in the caller's organization (`NOT_FOUND`)",
		),
	},
});

authed("post", "/technicians", "Technicians", "manage_technicians", {
	summary: "Create a technician",
	description:
		"Requires the `manage_technicians` permission. Without `manage_roles`, `organization_role_id` is ignored and the org's default technician role is used. Without `password`, a random one is set. Counts against the plan's technician seats.",
	request: {
		body: {
			content: {
				"application/json": {
					schema: createTechnicianSchema.meta({
						id: "CreateTechnician",
					}),
				},
			},
		},
	},
	responses: {
		201: json(envelope(technicianRow), "Technician created"),
		400: json(
			errorEnvelope,
			"Validation failed, role not found, or the insert failed (`VALIDATION_ERROR`)",
		),
		409: json(
			errorEnvelope,
			"Email already used by any technician or dispatcher (`CONFLICT`), or no technician seats left",
		),
	},
});

authed(
	"put",
	"/technicians/{id}",
	"Technicians",
	"manage_technicians",
	{
		summary: "Update a technician",
		description:
			"Requires the `manage_technicians` permission, unless it's the caller's own record. Technicians can't change their own `cost_rate`.",
		request: {
			params: z.object({ id: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: updateTechnicianSchema.meta({
							id: "UpdateTechnician",
						}),
					},
				},
			},
		},
		responses: {
			200: json(envelope(technicianRow), "Technician updated"),
			400: json(
				errorEnvelope,
				"Validation failed, technician not found, or the update failed (`VALIDATION_ERROR`)",
			),
			409: json(
				errorEnvelope,
				"Email already used by any technician or dispatcher (`CONFLICT`)",
			),
		},
	},
	"A technician changing their own `cost_rate` (`FORBIDDEN`)",
);

authed("delete", "/technicians/{id}", "Technicians", "manage_technicians", {
	summary: "Delete a technician",
	description:
		"Requires the `manage_technicians` permission. Blocked while the technician is on an open visit, or once they have work history; deactivate them instead.",
	request: { params: z.object({ id: z.uuid() }) },
	responses: {
		200: json(
			envelope(z.object({ message: z.string(), id: z.uuid() })),
			"Technician deleted",
		),
		400: json(
			errorEnvelope,
			"Technician not found, on an open visit, has work history, or the delete failed (`DELETE_ERROR`)",
		),
	},
});

// Self means the caller is the technician in the path.
const techParams = z.object({ id: z.uuid() });
const techNotFound = json(errorEnvelope, "Technician not found (`NOT_FOUND`)");
const manageOrSelf =
	"Requires `manage_technicians`, or the caller must be this technician.";
const techOut = (text = "The technician") => json(envelope(technician), text);
const statusChange = (
	path: string,
	summary: string,
	text: string,
	errors: Record<number, ReturnType<typeof json>>,
	body?: z.ZodType,
) =>
	authed(
		"post",
		`/technicians/{id}/${path}`,
		"Technicians",
		"manage_technicians or self",
		{
			summary,
			description: `${manageOrSelf} ${text}`,
			request: {
				params: techParams,
				...(body
					? {
							body: {
								content: {
									"application/json": { schema: body },
								},
							},
						}
					: {}),
			},
			responses: {
				200: techOut("The technician, with the new status"),
				...errors,
			},
		},
	);

authed(
	"post",
	"/technicians/{id}/ping",
	"Technicians",
	"manage_technicians or self",
	{
		summary: "Report a technician's location",
		description: `${manageOrSelf} Updates the live position the dispatch map shows. A technician left in \`WrappingUp\` past its timer is moved to \`Available\` first.`,
		request: {
			params: techParams,
			body: {
				content: {
					"application/json": {
						schema: z
							.object({ coords })
							.meta({ id: "TechnicianPing" }),
						example: { coords: { lat: 39.7392, lon: -104.9903 } },
					},
				},
			},
		},
		responses: {
			200: techOut(),
			400: json(
				errorEnvelope,
				"`coords` missing or invalid, or the update failed (`VALIDATION_ERROR`)",
			),
			404: techNotFound,
		},
	},
);

statusChange(
	"available",
	"Start a shift or end a break",
	"From `Offline` starts a shift; from `Break` ends the break. Either way the technician becomes `Available`.",
	{
		400: json(errorEnvelope, "The change failed (`VALIDATION_ERROR`)"),
		404: techNotFound,
		409: json(
			errorEnvelope,
			"Not `Offline` or on a break (`VALIDATION_ERROR`), or the week's timesheet is locked (`CONFLICT`)",
		),
	},
);
statusChange(
	"offline",
	"End a shift",
	"Ends the open shift and sets `Offline`. `tech_coords` records where it ended.",
	{
		400: json(
			errorEnvelope,
			"Technician not found, or the change failed (`VALIDATION_ERROR`)",
		),
		409: json(
			errorEnvelope,
			"Still clocked into a visit (`VALIDATION_ERROR`)",
		),
	},
	z.object({ tech_coords: coords.optional() }).meta({ id: "EndShift" }),
);
statusChange(
	"break",
	"Start a break",
	"Sets `Break` during an open shift. Paid or unpaid depends on the reason.",
	{
		400: json(
			errorEnvelope,
			"No `reason`, an unknown reason, no open shift, technician not found, or the change failed (`VALIDATION_ERROR`)",
		),
		409: json(
			errorEnvelope,
			"Clocked into a visit; pause the visit instead (`VALIDATION_ERROR`)",
		),
	},
	z
		.object({
			reason: z.enum(["Lunch", "Rest", "EquipmentIssue", "Other"]),
		})
		.meta({ id: "StartBreak" }),
);
statusChange(
	"done",
	"Finish wrapping up",
	"Sets the technician `Available` (normally from `WrappingUp` after a visit). The current status isn't checked.",
	{
		400: json(
			errorEnvelope,
			"Technician not found, or the update failed (`VALIDATION_ERROR`)",
		),
	},
);
statusChange(
	"head-back",
	"Head back",
	"From `Available` or `WrappingUp` during a shift, sets `HeadingBack` (driving back to base).",
	{
		400: json(
			errorEnvelope,
			"Not available or wrapping up, no open shift, technician not found, or the change failed (`VALIDATION_ERROR`)",
		),
	},
);

authed(
	"get",
	"/technicians/{techId}/visits",
	"Technicians",
	"view_technicians or self",
	{
		summary: "List a technician's visits",
		description:
			"Requires `view_technicians`, or the caller must be this technician. Every visit they're assigned to, with its job, line items and time entries.",
		request: { params: z.object({ techId: z.uuid() }) },
		responses: {
			200: json(
				envelope(z.array(jobVisit)),
				"Visits (empty array if none)",
			),
		},
	},
);

authed(
	"put",
	"/technicians/{id}/vehicle",
	"Technicians",
	"manage_vehicles or self",
	{
		summary: "Set a technician's vehicle",
		description:
			"Requires `manage_vehicles`, or the caller must be this technician (techs can only set their own). `vehicle_id: null` clears it.",
		request: {
			params: techParams,
			body: {
				content: {
					"application/json": {
						schema: z
							.object({ vehicle_id: z.uuid().nullable() })
							.meta({ id: "SetTechnicianVehicle" }),
					},
				},
			},
		},
		responses: {
			200: techOut(),
			400: json(errorEnvelope, "The update failed (`VALIDATION_ERROR`)"),
			404: json(
				errorEnvelope,
				"Technician or vehicle not found (`VALIDATION_ERROR`)",
			),
		},
	},
	moduleOff("fleet"),
);

authed(
	"post",
	"/technicians/{id}/reset-password",
	"Technicians",
	"manage_technicians",
	{
		summary: "Send a technician a password reset",
		description:
			"Requires the `manage_technicians` permission. Emails the technician a password reset link.",
		request: { params: techParams },
		responses: {
			200: json(envelope(z.null()), "Sent (`data` is null)"),
			400: json(
				errorEnvelope,
				"The email couldn't be sent (`VALIDATION_ERROR`)",
			),
			404: techNotFound,
		},
	},
);

authed("post", "/technicians/{id}/change-password", "Technicians", null, {
	summary: "Change my password",
	description:
		"Only the technician themselves. Needs the current password. Signs out every other session; the caller gets a new refresh token cookie.",
	request: {
		params: techParams,
		body: {
			content: {
				"application/json": {
					schema: z
						.object({
							current_password: z.string().min(1),
							new_password: z.string().min(8),
						})
						.meta({ id: "ChangeTechnicianPassword" }),
				},
			},
		},
	},
	responses: {
		200: json(envelope(z.null()), "Changed (`data` is null)"),
		400: json(
			errorEnvelope,
			"Wrong current password, a new password under 8 characters, or technician not found (`VALIDATION_ERROR`)",
		),
		403: json(errorEnvelope, "Not the caller's own account (`FORBIDDEN`)"),
	},
});

authed(
	"post",
	"/technicians/{id}/deactivate",
	"Technicians",
	"manage_technicians",
	{
		summary: "Deactivate a technician",
		description:
			"Requires the `manage_technicians` permission. Signs them out, sets `Offline` and clears their vehicle. Refused while they're on open visits.",
		request: { params: techParams },
		responses: {
			200: techOut(),
			400: json(
				errorEnvelope,
				"Technician not found, already deactivated, or still on open visits (`BAD_REQUEST`)",
			),
		},
	},
);

authed(
	"post",
	"/technicians/{id}/reactivate",
	"Technicians",
	"manage_technicians",
	{
		summary: "Reactivate a technician",
		description: "Requires the `manage_technicians` permission.",
		request: { params: techParams },
		responses: {
			200: techOut(),
			400: json(
				errorEnvelope,
				"Technician not found, or already active (`BAD_REQUEST`)",
			),
		},
	},
);

authed(
	"post",
	"/technicians/{id}/mfa/reset",
	"Technicians",
	"manage_technicians or self",
	{
		summary: "Reset a technician's MFA",
		description:
			"Requires `manage_technicians`, or the caller must be this technician. Removes their authenticator and recovery codes and signs out every session; they set MFA up again at next login. Unlike `POST /mfa/disable`, no password or code is asked for.",
		request: { params: techParams },
		responses: {
			200: json(envelope(z.null()), "Reset (`data` is null)"),
			404: techNotFound,
		},
	},
);

authed(
	"get",
	"/technicians/{id}/changes",
	"Technicians",
	"view_technicians or self",
	{
		summary: "Get a technician's history",
		description:
			"Requires `view_technicians`, or the caller must be this technician. What the technician did, and changes made to their account.",
		request: { params: techParams, query: historyQuery },
		responses: historyResponses,
	},
);

const techNotification = z
	.object({
		id: z.uuid(),
		type: z.string(),
		title: z.string(),
		body: z.string().nullable(),
		action_url: z.string().nullable(),
		read_at: z.iso.datetime().nullable(),
		created_at: z.iso.datetime(),
	})
	.catchall(z.unknown())
	.meta({ id: "TechnicianNotification" });
const ownOnly = json(
	errorEnvelope,
	"Not the caller's own notifications (`FORBIDDEN`)",
);

authed("get", "/technicians/{id}/notifications", "Technicians", null, {
	summary: "List my notifications",
	description: "Only the technician themselves. Newest first.",
	request: {
		params: techParams,
		query: z.object({
			unread: z.enum(["true"]).optional().describe("Only unread ones"),
		}),
	},
	responses: {
		200: json(
			envelope(z.array(techNotification)),
			"Notifications (empty array if none)",
		),
		403: ownOnly,
	},
});

authed(
	"patch",
	"/technicians/{id}/notifications/read-all",
	"Technicians",
	null,
	{
		summary: "Mark all my notifications read",
		description: "Only the technician themselves.",
		request: { params: techParams },
		responses: {
			200: json(envelope(z.null()), "Done (`data` is null)"),
			400: json(errorEnvelope, "The update failed (`SERVER_ERROR`)"),
			403: ownOnly,
		},
	},
);

authed(
	"patch",
	"/technicians/{id}/notifications/{notifId}/read",
	"Technicians",
	null,
	{
		summary: "Mark a notification read",
		description: "Only the technician themselves.",
		request: { params: techParams.extend({ notifId: z.uuid() }) },
		responses: {
			200: json(envelope(techNotification), "Marked read"),
			400: json(errorEnvelope, "The update failed (`VALIDATION_ERROR`)"),
			403: ownOnly,
			404: json(
				errorEnvelope,
				"Notification not found (`VALIDATION_ERROR`)",
			),
		},
	},
);
