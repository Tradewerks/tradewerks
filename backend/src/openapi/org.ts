import z from "zod";
import { authed, decimal, envelope, errorEnvelope, json } from "./shared.js";

// ===============================================================================================================================
// Org
// ===============================================================================================================================

const organization = z
	.object({
		id: z.uuid(),
		name: z.string(),
		logo_url: z
			.string()
			.nullable()
			.describe("Signed, short-lived image URL"),
		phone: z.string().nullable(),
		address: z.string().nullable(),
		coords: z.object({ lat: z.number(), lon: z.number() }).nullable(),
		email: z.string().nullable(),
		website: z.string().nullable(),
		tax_rate: z.string().describe('Decimal as a string, e.g. "0.0725"'),
		tax_mode: z.string(),
		restock_mode: z.enum(["tech_self_serve", "dispatch_prepared"]),
		measurement_system: z.string(),
		mfa_required: z.boolean(),
		brand_color: z.string().nullable(),
		field_purchase_second_signoff_threshold: z.string().nullable(),
	})
	.meta({ id: "Organization" });

authed("get", "/org", "Org", null, {
	summary: "Get the caller's organization",
	description: "Any signed-in user. Zapier uses it to test the connection.",
	responses: {
		200: json(envelope(organization), "Organization"),
		404: json(
			errorEnvelope,
			"No organization on the token, or it no longer exists (`NOT_FOUND`)",
		),
	},
});

const manageOrg = "Requires the `manage_organization` permission.";
const orgMissing = json(
	errorEnvelope,
	"No organization on the token (`NOT_FOUND`)",
);
const jsonBody = (schema: z.ZodType, example?: unknown) => ({
	body: {
		content: {
			"application/json": { schema, ...(example ? { example } : {}) },
		},
	},
});

authed(
	"patch",
	"/org",
	"Org",
	"manage_organization",
	{
		summary: "Update organization settings",
		description: `${manageOrg} Send only the fields to change. Turning on \`mfa_required\` needs the Security+ module. \`field_purchase_second_signoff_threshold\` sets the total at which an approved field purchase needs a second sign-off; null turns that off.`,
		request: jsonBody(
			z
				.object({
					name: z.string().min(1).max(100).optional(),
					phone: z.string().max(30).nullable().optional(),
					address: z.string().max(200).nullable().optional(),
					coords: z
						.object({ lat: z.number(), lon: z.number() })
						.nullable()
						.optional(),
					email: z.email().nullable().optional(),
					website: z.string().max(100).nullable().optional(),
					restock_mode: z
						.enum(["tech_self_serve", "dispatch_prepared"])
						.optional(),
					measurement_system: z
						.enum(["imperial", "metric"])
						.optional(),
					mfa_required: z.boolean().optional(),
					brand_color: z
						.string()
						.nullable()
						.optional()
						.describe("Hex color like #1e3a5f"),
					field_purchase_second_signoff_threshold: z
						.number()
						.min(0)
						.nullable()
						.optional(),
				})
				.meta({ id: "UpdateOrganization" }),
			{ phone: "(303) 555-0142", brand_color: "#1e3a5f" },
		),
		responses: {
			200: json(envelope(organization), "Updated"),
			400: json(
				errorEnvelope,
				"Validation failed; the message is the first problem (`VALIDATION_ERROR`)",
			),
			404: orgMissing,
		},
	},
	"`mfa_required: true` without the Security+ module (`MODULE_NOT_IN_PLAN`)",
);

const costing = z
	.object({
		monthly_overhead: decimal,
		cost_per_mile: decimal,
		overhead_rate_per_hour: decimal
			.nullable()
			.describe("Null means not set"),
	})
	.meta({ id: "OrganizationCosting" });

authed("get", "/org/costing", "Org", "view_reports", {
	summary: "Get job costing settings",
	description:
		"Requires the `view_reports` permission. The overhead and mileage costs the job profitability report uses.",
	responses: {
		200: json(envelope(costing), "Costing settings"),
		404: orgMissing,
	},
});

authed("patch", "/org/costing", "Org", "manage_organization", {
	summary: "Update job costing settings",
	description: `${manageOrg} At least one field. Numbers may be sent as strings. \`overhead_rate_per_hour: null\` clears it (0 means overhead is free).`,
	request: jsonBody(
		z
			.object({
				monthly_overhead: z.number().min(0).optional(),
				cost_per_mile: z.number().min(0).optional(),
				overhead_rate_per_hour: z.number().min(0).nullable().optional(),
			})
			.meta({ id: "UpdateOrganizationCosting" }),
		{ cost_per_mile: 0.67 },
	),
	responses: {
		200: json(envelope(costing), "Updated"),
		400: json(
			errorEnvelope,
			"Validation failed, or no field given (`VALIDATION_ERROR`)",
		),
		404: orgMissing,
	},
});

authed("post", "/org/logo", "Org", "manage_organization", {
	summary: "Upload the organization logo",
	description: `${manageOrg} Replaces the logo shown on quotes, invoices and emails. JPEG, PNG or WebP, up to 5 MB.`,
	request: {
		body: {
			content: {
				"multipart/form-data": {
					schema: z.object({
						image: z.string().meta({ format: "binary" }),
					}),
				},
			},
		},
	},
	responses: {
		200: json(
			envelope(
				z.object({
					url: z.string().describe("Signed, short-lived URL"),
				}),
			),
			"Uploaded",
		),
		400: json(
			errorEnvelope,
			"No `image`, or the file is over 5 MB (the message says 15MB) (`VALIDATION_ERROR`)",
		),
		404: orgMissing,
		500: json(
			errorEnvelope,
			"The file isn't JPEG, PNG or WebP, or the upload failed (`SERVER_ERROR`)",
		),
	},
});

authed("delete", "/org/logo", "Org", "manage_organization", {
	summary: "Remove the organization logo",
	description: `${manageOrg} Deletes the stored image too.`,
	responses: {
		200: json(envelope(z.null()), "Removed (`data` is null)"),
		404: orgMissing,
	},
});

// Entitlements: which modules the organization's plan includes and which are switched on.
const moduleState = z.object({
	key: z.string(),
	label: z.string(),
	description: z.string(),
	kind: z.enum(["core", "optional", "plan_gated"]),
	requires: z.array(z.string()).describe("Modules that must be on first"),
	state: z.enum(["on", "off_by_org", "not_in_plan"]),
});
const entitlements = z
	.object({
		plan: z
			.object({
				key: z.string(),
				version: z.number().int(),
				trialActive: z.boolean(),
				label: z.string().optional(),
			})
			.catchall(z.unknown()),
		modules: z.array(moduleState),
		permissionMap: z
			.record(z.string(), z.unknown())
			.describe("Which permissions each module unlocks"),
		limits: z
			.record(z.string(), z.number().nullable())
			.describe("Plan limits; null means unlimited"),
	})
	.meta({ id: "OrganizationEntitlements" });
const upgradeRequest = z
	.record(z.string(), z.unknown())
	.describe(
		"An upgrade request: `id`, `status` (open, approved, declined, withdrawn), `requested_plan_label`, `requested_modules`, `note`, `created_at`, `resolved_at`",
	);

authed("get", "/org/entitlements", "Org", null, {
	summary: "Get plan and modules",
	description:
		"Any signed-in user. The plan, every module with its state for this organization, plan limits, and setup progress. `usage` (counts against the limits) is only filled in for admins and `manage_organization`; otherwise null.",
	responses: {
		200: json(
			envelope(
				entitlements.extend({
					usage: z.record(z.string(), z.unknown()).nullable(),
					setup: z
						.object({
							templateKey: z.string().nullable(),
							modulesReviewed: z.boolean(),
							trial: z.record(z.string(), z.unknown()).nullable(),
						})
						.nullable(),
				}),
			),
			"Entitlements",
		),
	},
});

authed("patch", "/org/entitlements/modules", "Org", "manage_organization", {
	summary: "Turn modules on or off",
	description: `${manageOrg} \`choices\` maps module keys to on (true) or off (false). Only modules in the plan can be turned on; a module's \`requires\` must be on first, and modules that depend on it must be off first. Some modules refuse to turn off while they hold data (see the disable preview).`,
	request: jsonBody(
		z
			.object({ choices: z.record(z.string(), z.boolean()) })
			.meta({ id: "SetModuleChoices" }),
		{ choices: { vehicle_stock: true, followups: false } },
	),
	responses: {
		200: json(envelope(entitlements), "The new state"),
		400: json(
			errorEnvelope,
			"Unknown module, not in the plan, or a dependency is in the way (`BAD_REQUEST`, `VALIDATION_ERROR`)",
		),
		404: json(
			errorEnvelope,
			"No entitlements for the organization (`NOT_FOUND`)",
		),
		409: json(
			errorEnvelope,
			"Data blocks turning a module off, or someone else changed the settings first (`CONFLICT`)",
		),
	},
});

authed(
	"get",
	"/org/entitlements/modules/{key}/disable-preview",
	"Org",
	"manage_organization",
	{
		summary: "Preview turning a module off",
		description: `${manageOrg} What turning the module off would affect: a warning, the modules that depend on it, and anything that would block it.`,
		request: { params: z.object({ key: z.string() }) },
		responses: {
			200: json(
				envelope(
					z.object({
						module: z.string(),
						warning: z.string().nullable(),
						dependents: z.array(z.string()),
						blocker: z
							.object({
								count: z.number().int(),
								message: z.string(),
							})
							.nullable(),
					}),
				),
				"Preview",
			),
			400: json(errorEnvelope, "Unknown module (`BAD_REQUEST`)"),
		},
	},
);

authed(
	"post",
	"/org/entitlements/modules-reviewed",
	"Org",
	"manage_organization",
	{
		summary: "Mark module setup as reviewed",
		description: `${manageOrg} Records that the admin has looked over the module choices during setup. Only the first call does anything.`,
		responses: {
			200: json(
				envelope(z.object({ reviewed: z.literal(true) })),
				"Done",
			),
		},
	},
);

authed("get", "/org/entitlements/tiers", "Org", "manage_organization", {
	summary: "List subscription tiers",
	description: `${manageOrg} The plans an upgrade can be requested to, with the plan-gated modules each includes.`,
	responses: {
		200: json(
			envelope(
				z.array(
					z.object({
						key: z.string(),
						label: z.string(),
						modules: z.array(
							z.object({ key: z.string(), label: z.string() }),
						),
					}),
				),
			),
			"Tiers",
		),
	},
});

authed(
	"get",
	"/org/entitlements/upgrade-requests",
	"Org",
	"manage_organization",
	{
		summary: "List upgrade requests",
		description: `${manageOrg} The organization's last 20 requests, newest first.`,
		responses: {
			200: json(
				envelope(z.array(upgradeRequest)),
				"Requests (empty array if none)",
			),
		},
	},
);

authed(
	"post",
	"/org/entitlements/upgrade-requests",
	"Org",
	"manage_organization",
	{
		summary: "Request an upgrade",
		description: `${manageOrg} Asks the TradeWerks team for another plan (\`planKey\`) and/or extra modules, with a note. One open request at a time.`,
		request: jsonBody(
			z
				.object({
					planKey: z.string().min(1).max(40).optional(),
					modules: z
						.array(z.string().min(1).max(40))
						.max(20)
						.optional(),
					note: z.string().max(1000).optional(),
				})
				.meta({ id: "FileUpgradeRequest" }),
			{
				modules: ["advanced_reporting"],
				note: "We need the job profitability report",
			},
		),
		responses: {
			201: json(envelope(upgradeRequest), "Requested"),
			400: json(
				errorEnvelope,
				"Validation failed, an unknown or current plan, or nothing asked for (`VALIDATION_ERROR`, `BAD_REQUEST`)",
			),
			409: json(
				errorEnvelope,
				"An open request already exists (`REQUEST_OPEN`)",
			),
		},
	},
);

authed(
	"post",
	"/org/entitlements/upgrade-requests/{id}/withdraw",
	"Org",
	"manage_organization",
	{
		summary: "Withdraw an upgrade request",
		description: `${manageOrg} Only an open request.`,
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: json(envelope(z.null()), "Withdrawn (`data` is null)"),
			409: json(
				errorEnvelope,
				"Not open, or not found (`REQUEST_CLOSED`)",
			),
		},
	},
);

const moduleQuery = z.object({
	module: z.enum(["inventory", "vehicle_stock"]),
});

authed(
	"get",
	"/org/entitlements/notices/untracked-stock",
	"Org",
	"view_inventory or manage_inventory",
	{
		summary: "Check for stock used while a module was off",
		description:
			"Requires `view_inventory` or `manage_inventory`. After the module was turned off and back on: the visits completed in between, whose parts weren't deducted from stock. Null when there's nothing to review or it was dismissed.",
		request: { query: moduleQuery },
		responses: {
			200: json(
				envelope(
					z
						.object({
							module: z.enum(["inventory", "vehicle_stock"]),
							off: z.iso.datetime(),
							on: z.iso.datetime(),
							visits: z.array(z.record(z.string(), z.unknown())),
						})
						.nullable(),
				),
				"The notice, or null",
			),
			400: json(
				errorEnvelope,
				"`module` isn't inventory or vehicle_stock (`VALIDATION_ERROR`)",
			),
		},
	},
);

authed(
	"post",
	"/org/entitlements/notices/untracked-stock/dismiss",
	"Org",
	"manage_inventory",
	{
		summary: "Dismiss the untracked stock notice",
		description:
			"Requires the `manage_inventory` permission. `on` is the notice's `on` time, so a later off/on gap still shows.",
		request: jsonBody(
			z
				.object({
					module: z.enum(["inventory", "vehicle_stock"]),
					on: z.string().describe("Date-time"),
				})
				.meta({ id: "DismissUntrackedStockNotice" }),
		),
		responses: {
			200: json(envelope(z.null()), "Dismissed (`data` is null)"),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
		},
	},
);

// Custom roles: a named permission set on top of the dispatcher or technician base tier.
const orgRole = z
	.object({
		id: z.uuid(),
		organization_id: z.uuid(),
		name: z.string(),
		base_tier: z.enum(["dispatcher", "technician"]),
		permissions: z.array(z.string()),
		is_default: z.boolean().describe("Given to new users of this tier"),
	})
	.meta({ id: "OrganizationRole" });
const manageRoles = "Requires the `manage_roles` permission.";
const roleParams = z.object({ id: z.uuid() });
const roleFields = {
	name: z.string().min(1),
	base_tier: z.enum(["dispatcher", "technician"]),
	permissions: z
		.array(z.string())
		.describe("Must all be valid for the base tier"),
	is_default: z.boolean(),
};

authed("get", "/organization-roles", "Org", "manage_roles", {
	summary: "List roles",
	description: manageRoles,
	responses: {
		200: json(envelope(z.array(orgRole)), "Roles"),
		404: json(errorEnvelope, "The lookup failed (`NOT_FOUND`)"),
	},
});

authed("post", "/organization-roles", "Org", "manage_roles", {
	summary: "Create a role",
	description: `${manageRoles} Names are unique per organization. \`is_default: true\` takes the default from the tier's previous default role.`,
	request: jsonBody(
		z
			.object({
				...roleFields,
				permissions: roleFields.permissions.optional(),
				is_default: roleFields.is_default.optional(),
			})
			.meta({ id: "CreateOrganizationRole" }),
		{
			name: "Lead technician",
			base_tier: "technician",
			permissions: ["view_jobs", "add_job_notes"],
		},
	),
	responses: {
		201: json(envelope(orgRole), "Created"),
		400: json(
			errorEnvelope,
			"Validation failed, a permission outside the tier, the name is taken, or the insert failed (`VALIDATION_ERROR`)",
		),
	},
});

authed("get", "/organization-roles/{id}", "Org", "manage_roles", {
	summary: "Get a role",
	description: manageRoles,
	request: { params: roleParams },
	responses: {
		200: json(envelope(orgRole), "Role"),
		404: json(errorEnvelope, "Role not found (`NOT_FOUND`)"),
	},
});

authed("put", "/organization-roles/{id}", "Org", "manage_roles", {
	summary: "Update a role",
	description: `${manageRoles} Send at least one field. Users with the role get the new permissions when their access token next refreshes (up to 15 minutes).`,
	request: {
		params: roleParams,
		...jsonBody(
			z
				.object({
					name: roleFields.name.optional(),
					base_tier: roleFields.base_tier.optional(),
					permissions: roleFields.permissions.optional(),
					is_default: roleFields.is_default.optional(),
				})
				.meta({ id: "UpdateOrganizationRole" }),
		),
	},
	responses: {
		200: json(envelope(orgRole), "Updated"),
		400: json(
			errorEnvelope,
			"Role not found, validation failed, a permission outside the tier, the name is taken, or the update failed (`VALIDATION_ERROR`)",
		),
	},
});

authed("delete", "/organization-roles/{id}", "Org", "manage_roles", {
	summary: "Delete a role",
	description: manageRoles,
	request: { params: roleParams },
	responses: {
		200: json(envelope(z.object({ id: z.uuid() })), "Deleted"),
		400: json(
			errorEnvelope,
			"Role not found, or the delete failed (`VALIDATION_ERROR`)",
		),
	},
});

authed("post", "/organization-roles/assign", "Org", "manage_roles", {
	summary: "Assign a role to a user",
	description: `${manageRoles} Gives a dispatcher or technician a role of their tier, or removes it with \`role_id: null\`. Takes effect when their access token next refreshes.`,
	request: jsonBody(
		z
			.object({
				user_id: z.uuid(),
				user_type: z.enum(["dispatcher", "technician"]),
				role_id: z.uuid().nullable(),
			})
			.meta({ id: "AssignOrganizationRole" }),
	),
	responses: {
		200: json(
			envelope(z.record(z.string(), z.unknown()).describe("The user")),
			"Assigned",
		),
		400: json(
			errorEnvelope,
			'Role or user not found, the role is for the other tier, or the update failed (`VALIDATION_ERROR`). An unknown `user_type` with `role_id: null` returns 200 with `{ err: "Invalid user type" }` as `data`',
		),
	},
});

authed("get", "/logs/recent", "Org", null, {
	summary: "Get the recent activity feed",
	description:
		"The organization's recent notable events (jobs, quotes, invoices, payments, …), newest first, as shown on the dashboard. Office users can read the whole feed; with `userId`, only events by or about that user, which technicians may read for themselves and others need a feed-viewer permission for. Page with `cursor` (the last row's `timestamp`).",
	request: {
		query: z.object({
			userId: z.uuid().optional(),
			cursor: z.iso.datetime().optional(),
			limit: z.coerce.number().int().optional(),
		}),
	},
	responses: {
		200: json(
			envelope(
				z.array(
					z
						.record(z.string(), z.unknown())
						.describe("A history entry"),
				),
			).extend({
				meta: z.object({
					timestamp: z.string(),
					count: z.number().int(),
					hasMore: z.boolean(),
				}),
			}),
			"Feed",
		),
		403: json(
			errorEnvelope,
			"A technician reading the whole feed or someone else's (`FORBIDDEN`)",
		),
	},
});
