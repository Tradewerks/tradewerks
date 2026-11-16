import z from "zod";
import {
	createDispatcherSchema,
	updateDispatcherSchema,
} from "../lib/validate/dispatchers.js";
import {
	authed,
	envelope,
	errorEnvelope,
	historyQuery,
	historyResponses,
	idName,
	json,
} from "./shared.js";

// ===============================================================================================================================
// Dispatchers
// ===============================================================================================================================

const dispatcher = z
	.object({
		id: z.uuid(),
		organization_id: z.uuid().nullable(),
		role: z
			.enum(["admin", "dispatcher"])
			.describe(
				"`admin` is the organization owner and has every permission",
			),
		name: z.string(),
		email: z.string(),
		phone: z.string().nullable(),
		title: z.string(),
		description: z.string(),
		last_login: z.iso.datetime().nullable(),
		email_verified_at: z.iso.datetime().nullable(),
		invite_expires_at: z.iso.datetime().nullable(),
		theme: z.string(),
		muted_notification_types: z.array(z.string()),
		dashboard_layout: z.unknown().nullable(),
		report_layout: z.unknown().nullable(),
		kpi_layout: z.unknown().nullable(),
		organization_role_id: z.uuid().nullable(),
		organization_role: idName.nullable(),
	})
	.meta({ id: "Dispatcher" });
const params = z.object({ id: z.uuid() });
const notFound = json(errorEnvelope, "Dispatcher not found (`NOT_FOUND`)");
const manageOrSelf =
	"Requires `manage_dispatchers`, or the caller must be this dispatcher.";
const body = (schema: z.ZodType, example?: unknown) => ({
	body: {
		content: {
			"application/json": { schema, ...(example ? { example } : {}) },
		},
	},
});

authed("get", "/dispatchers", "Dispatchers", "view_dispatchers", {
	summary: "List dispatchers",
	description:
		"Requires the `view_dispatchers` permission. Office users, including the organization admin.",
	responses: { 200: json(envelope(z.array(dispatcher)), "Dispatchers") },
});

authed("get", "/dispatchers/{id}", "Dispatchers", "view_dispatchers or self", {
	summary: "Get a dispatcher",
	description:
		"Requires `view_dispatchers`, or the caller must be this dispatcher. Also returns their effective `permissions` (every permission for an admin) and whether MFA is on.",
	request: { params },
	responses: {
		200: json(
			envelope(
				dispatcher.extend({
					permissions: z.array(z.string()),
					mfaEnabled: z.boolean(),
				}),
			),
			"Dispatcher",
		),
		404: notFound,
	},
});

authed("post", "/dispatchers", "Dispatchers", "manage_dispatchers", {
	summary: "Add a dispatcher",
	description:
		"Requires the `manage_dispatchers` permission. Without a `password` a random one is set and the new user is emailed to choose their own; with one, no reset is asked for. `organization_role_id` is only honored with `manage_roles`; otherwise the organization's default dispatcher role is used. Counts against the plan's seat limit.",
	request: body(
		createDispatcherSchema
			.omit({ organization_id: true })
			.meta({ id: "CreateDispatcher" }),
		{
			name: "Dana Ortiz",
			email: "dana@example.com",
			title: "Office manager",
		},
	),
	responses: {
		201: json(envelope(dispatcher), "Created"),
		400: json(
			errorEnvelope,
			"Validation failed, or the insert failed (`VALIDATION_ERROR`)",
		),
		409: json(
			errorEnvelope,
			"Email already in use (`CONFLICT`), or the plan's dispatcher seats are used up (`SEAT_LIMIT_REACHED`)",
		),
	},
});

authed(
	"put",
	"/dispatchers/{id}",
	"Dispatchers",
	"manage_dispatchers or self",
	{
		summary: "Update a dispatcher",
		description: `${manageOrSelf} Send only the fields to change, at least one. Also stores the user's own preferences (theme, muted notifications, dashboard, report and KPI layouts). Role and permissions are changed through \`/organization-roles\`, not here.`,
		request: {
			params,
			...body(updateDispatcherSchema.meta({ id: "UpdateDispatcher" }), {
				title: "Lead dispatcher",
			}),
		},
		responses: {
			200: json(envelope(dispatcher), "Updated"),
			400: json(
				errorEnvelope,
				"Dispatcher not found, validation failed, or the update failed (`VALIDATION_ERROR`)",
			),
			409: json(errorEnvelope, "Email already in use (`CONFLICT`)"),
		},
	},
);

authed("delete", "/dispatchers/{id}", "Dispatchers", "manage_dispatchers", {
	summary: "Delete a dispatcher",
	description:
		"Requires the `manage_dispatchers` permission. Not the organization admin, and not the caller's own account. Prefer deactivating anyone with history.",
	request: { params },
	responses: {
		200: json(
			envelope(z.object({ message: z.string(), id: z.uuid() })),
			"Deleted",
		),
		400: json(
			errorEnvelope,
			"Dispatcher not found, the admin, the caller, or the delete failed (`DELETE_ERROR`)",
		),
	},
});

authed(
	"post",
	"/dispatchers/{id}/deactivate",
	"Dispatchers",
	"manage_dispatchers",
	{
		summary: "Deactivate a dispatcher",
		description:
			"Requires the `manage_dispatchers` permission. Signs them out. Not the caller's own account, and not the only active admin.",
		request: { params },
		responses: {
			200: json(envelope(dispatcher), "Deactivated"),
			400: json(
				errorEnvelope,
				"Dispatcher not found, already deactivated, the caller, or the last active admin (`BAD_REQUEST`)",
			),
		},
	},
);

authed(
	"post",
	"/dispatchers/{id}/reactivate",
	"Dispatchers",
	"manage_dispatchers",
	{
		summary: "Reactivate a dispatcher",
		description: "Requires the `manage_dispatchers` permission.",
		request: { params },
		responses: {
			200: json(envelope(dispatcher), "Reactivated"),
			400: json(
				errorEnvelope,
				"Dispatcher not found, or already active (`BAD_REQUEST`)",
			),
		},
	},
);

authed(
	"post",
	"/dispatchers/{id}/reset-password",
	"Dispatchers",
	"manage_dispatchers or self",
	{
		summary: "Send a dispatcher a password reset",
		description: `${manageOrSelf} Emails a password reset link to the dispatcher's address.`,
		request: { params },
		responses: {
			200: json(envelope(z.null()), "Sent (`data` is null)"),
			400: json(
				errorEnvelope,
				"The email couldn't be sent (`VALIDATION_ERROR`)",
			),
			404: notFound,
		},
	},
);

authed("post", "/dispatchers/{id}/change-password", "Dispatchers", null, {
	summary: "Change my password",
	description:
		"Only the dispatcher themselves. Needs the current password. Signs out every other session; the caller gets a new refresh token cookie.",
	request: {
		params,
		...body(
			z
				.object({
					current_password: z.string().min(1),
					new_password: z.string().min(8),
				})
				.meta({ id: "ChangeDispatcherPassword" }),
		),
	},
	responses: {
		200: json(envelope(z.null()), "Changed (`data` is null)"),
		400: json(
			errorEnvelope,
			"Wrong current password, validation failed, or dispatcher not found (`VALIDATION_ERROR`)",
		),
		403: json(errorEnvelope, "Not the caller's own account (`FORBIDDEN`)"),
	},
});

authed(
	"post",
	"/dispatchers/{id}/mfa/reset",
	"Dispatchers",
	"manage_dispatchers or self",
	{
		summary: "Reset a dispatcher's MFA",
		description: `${manageOrSelf} Removes their authenticator and recovery codes and signs out every session; they set MFA up again at next login. No password or code is asked for, and an organization admin's MFA can be reset too.`,
		request: { params },
		responses: {
			200: json(envelope(z.null()), "Reset (`data` is null)"),
			404: notFound,
		},
	},
);

authed(
	"get",
	"/dispatchers/{id}/changes",
	"Dispatchers",
	"view_dispatchers or self",
	{
		summary: "Get a dispatcher's history",
		description:
			"Requires `view_dispatchers`, or the caller must be this dispatcher. What the dispatcher did, and changes made to their account.",
		request: { params, query: historyQuery },
		responses: historyResponses,
	},
);

const notification = z
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
	.meta({ id: "DispatcherNotification" });
const ownOnly = json(
	errorEnvelope,
	"Not the caller's own notifications (`FORBIDDEN`)",
);

authed("get", "/dispatchers/{id}/notifications", "Dispatchers", null, {
	summary: "List my notifications",
	description: "Only the dispatcher themselves. Newest first.",
	request: {
		params,
		query: z.object({
			unread: z.enum(["true"]).optional().describe("Only unread ones"),
		}),
	},
	responses: {
		200: json(
			envelope(z.array(notification)),
			"Notifications (empty array if none)",
		),
		403: ownOnly,
	},
});

authed(
	"patch",
	"/dispatchers/{id}/notifications/read-all",
	"Dispatchers",
	null,
	{
		summary: "Mark all my notifications read",
		description: "Only the dispatcher themselves.",
		request: { params },
		responses: {
			200: json(envelope(z.null()), "Done (`data` is null)"),
			400: json(errorEnvelope, "The update failed (`SERVER_ERROR`)"),
			403: ownOnly,
		},
	},
);

authed(
	"patch",
	"/dispatchers/{id}/notifications/{notifId}/read",
	"Dispatchers",
	null,
	{
		summary: "Mark a notification read",
		description: "Only the dispatcher themselves.",
		request: { params: params.extend({ notifId: z.uuid() }) },
		responses: {
			200: json(envelope(notification), "Marked read"),
			400: json(errorEnvelope, "The update failed (`VALIDATION_ERROR`)"),
			403: ownOnly,
			404: json(
				errorEnvelope,
				"Notification not found (`VALIDATION_ERROR`)",
			),
		},
	},
);
