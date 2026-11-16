import z from "zod";
import {
	createTaxRateSchema,
	updateTaxRateSchema,
	createTaxGroupSchema,
	updateTaxGroupSchema,
	updateTaxSettingsSchema,
} from "../lib/validate/tax.js";
import { authed, decimal, envelope, errorEnvelope, json } from "./shared.js";

// ===============================================================================================================================
// Tax
// ===============================================================================================================================

// Every tax route requires `manage_taxes`. Unexpected errors come back as 500 with their raw message.
const manageTaxes = "Requires the `manage_taxes` permission.";
const params = z.object({ id: z.uuid() });
const body = (schema: z.ZodType, example?: unknown) => ({
	body: {
		content: {
			"application/json": { schema, ...(example ? { example } : {}) },
		},
	},
});
const failed = json(
	errorEnvelope,
	"Unexpected failure; the message is the raw error (`SERVER_ERROR`)",
);

const taxRate = z
	.object({
		id: z.uuid(),
		organization_id: z.uuid(),
		name: z.string(),
		rate: decimal.describe('Fraction, e.g. "0.0725" for 7.25%'),
		description: z.string().nullable(),
		jurisdiction: z.string().nullable(),
		is_default: z.boolean(),
		is_active: z.boolean(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
	})
	.meta({ id: "TaxRate" });
const taxGroup = z
	.object({
		id: z.uuid(),
		organization_id: z.uuid(),
		name: z.string(),
		description: z.string().nullable(),
		is_default: z.boolean(),
		is_active: z.boolean(),
		qb_tax_code_id: z.string().nullable(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		rates: z.array(
			z
				.object({ sort_order: z.number().int(), tax_rate: taxRate })
				.catchall(z.unknown()),
		),
		combined_rate: z.number().describe("Sum of the group's rates"),
	})
	.meta({ id: "TaxGroup" });
const includeInactive = z.object({
	include_inactive: z
		.enum(["true"])
		.optional()
		.describe("Also list deactivated ones"),
});

authed("get", "/tax/rates", "Tax", "manage_taxes", {
	summary: "List tax rates",
	description: `${manageTaxes} Active rates unless \`include_inactive=true\`.`,
	request: { query: includeInactive },
	responses: {
		200: json(envelope(z.array(taxRate)), "Rates (empty array if none)"),
	},
});

authed("post", "/tax/rates", "Tax", "manage_taxes", {
	summary: "Create a tax rate",
	description: `${manageTaxes} \`rate\` is a fraction from 0 to 1. \`is_default: true\` takes the default from the previous default rate.`,
	request: body(createTaxRateSchema.meta({ id: "CreateTaxRate" }), {
		name: "Colorado state",
		rate: 0.029,
		jurisdiction: "CO",
	}),
	responses: {
		201: json(envelope(taxRate), "Created"),
		400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
		500: failed,
	},
});

authed("patch", "/tax/rates/{id}", "Tax", "manage_taxes", {
	summary: "Update a tax rate",
	description: `${manageTaxes} Send only the fields to change.`,
	request: {
		params,
		...body(updateTaxRateSchema.meta({ id: "UpdateTaxRate" })),
	},
	responses: {
		200: json(envelope(taxRate), "Updated"),
		400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
		404: json(errorEnvelope, "Tax rate not found (`NOT_FOUND`)"),
		500: failed,
	},
});

authed("delete", "/tax/rates/{id}", "Tax", "manage_taxes", {
	summary: "Delete a tax rate",
	description: `${manageTaxes} Deactivates it. Not allowed while any tax group uses it.`,
	request: { params },
	responses: {
		200: json(envelope(z.object({ id: z.uuid() })), "Deactivated"),
		404: json(errorEnvelope, "Tax rate not found (`NOT_FOUND`)"),
		409: json(errorEnvelope, "Used in a tax group (`CONFLICT`)"),
		500: failed,
	},
});

authed("get", "/tax/groups", "Tax", "manage_taxes", {
	summary: "List tax groups",
	description: `${manageTaxes} A tax group is what line items and clients point at: one or more rates added together. Default first, then by name; active only unless \`include_inactive=true\`.`,
	request: { query: includeInactive },
	responses: {
		200: json(envelope(z.array(taxGroup)), "Groups (empty array if none)"),
	},
});

authed("get", "/tax/groups/default", "Tax", "manage_taxes", {
	summary: "Get the default tax group",
	description: `${manageTaxes} The group new line items get, or null if none is set.`,
	responses: {
		200: json(envelope(taxGroup.nullable()), "Default group, or null"),
	},
});

authed("post", "/tax/groups", "Tax", "manage_taxes", {
	summary: "Create a tax group",
	description: `${manageTaxes} \`rate_ids\` are active tax rates, in the order to apply them. \`is_default: true\` takes the default from the previous default group.`,
	request: body(createTaxGroupSchema.meta({ id: "CreateTaxGroup" }), {
		name: "Denver",
		rate_ids: ["3f6c2a1e-8b4d-4c2a-9e1f-1a2b3c4d5e6f"],
	}),
	responses: {
		201: json(envelope(taxGroup), "Created"),
		400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
		500: json(
			errorEnvelope,
			"A rate id is unknown or inactive, or another failure (`SERVER_ERROR`)",
		),
	},
});

authed("patch", "/tax/groups/{id}", "Tax", "manage_taxes", {
	summary: "Update a tax group",
	description: `${manageTaxes} Send only the fields to change. \`rate_ids\` replaces the group's rates.`,
	request: {
		params,
		...body(updateTaxGroupSchema.meta({ id: "UpdateTaxGroup" })),
	},
	responses: {
		200: json(envelope(taxGroup), "Updated"),
		400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
		404: json(errorEnvelope, "Tax group not found (`NOT_FOUND`)"),
		500: json(
			errorEnvelope,
			"A rate id is unknown or inactive, or another failure (`SERVER_ERROR`)",
		),
	},
});

authed("delete", "/tax/groups/{id}", "Tax", "manage_taxes", {
	summary: "Delete a tax group",
	description: `${manageTaxes} Deactivates it. Refused while clients, quote line items, open invoice line items or recurring plan line items use it; deactivate it with \`PATCH\` (\`is_active: false\`) instead.`,
	request: { params },
	responses: {
		200: json(envelope(z.object({ id: z.uuid() })), "Deactivated"),
		404: json(errorEnvelope, "Tax group not found (`NOT_FOUND`)"),
		409: json(
			errorEnvelope,
			"Still in use; the message says where (`CONFLICT`)",
		),
		500: failed,
	},
});

const taxSettings = z.object({
	tax_mode: z
		.enum(["auto", "manual"])
		.describe("What the organization chose"),
	effective_tax_mode: z
		.enum(["auto", "manual"])
		.describe(
			"What's in force (auto falls back to manual without the Automated Tax module)",
		),
	auto_entitled: z
		.boolean()
		.describe("Whether the plan includes Automated Tax"),
	tax_registered_states: z
		.array(z.string())
		.describe("US states where the organization collects sales tax"),
	org_state: z.string().nullable(),
	qb_passthrough_required: z
		.boolean()
		.describe("QuickBooks is connected without a pass-through tax code"),
	legacy_rate: z
		.number()
		.describe(
			"Flat rate used when an automatic lookup fails and there's no fallback group",
		),
});

authed("get", "/tax/settings", "Tax", "manage_taxes", {
	summary: "Get tax settings",
	description: `${manageTaxes} Manual (tax groups) or automatic (rates looked up from each address) tax, and where the organization collects it.`,
	responses: { 200: json(envelope(taxSettings), "Settings") },
});

authed("get", "/tax/settings/auto-switch-preview", "Tax", "manage_taxes", {
	summary: "Preview switching to automatic tax",
	description: `${manageTaxes} How many line items still carry the default tax group (which switching clears so the address lookup applies), per document type, and how many draft documents would be recalculated.`,
	responses: {
		200: json(
			envelope(
				z
					.object({
						default_group_lines: z.number().int(),
						quote_lines: z.number().int(),
						job_lines: z.number().int(),
						visit_lines: z.number().int(),
						invoice_lines: z.number().int(),
						default_group_drafts: z.number().int(),
						quote_drafts: z.number().int(),
						job_drafts: z.number().int(),
						visit_drafts: z.number().int(),
						invoice_drafts: z.number().int(),
					})
					.catchall(z.unknown()),
			),
			"Preview",
		),
	},
});

authed(
	"put",
	"/tax/settings",
	"Tax",
	"manage_taxes",
	{
		summary: "Update tax settings",
		description: `${manageTaxes} Set \`tax_mode\` and/or \`tax_registered_states\` (US state codes). Automatic tax needs the Automated Tax module and at least one state; switching to it with no states uses the organization's own state. Switching clears the default tax group from line items and recalculates drafts in the background (\`recompute_queued\`).`,
		request: body(
			updateTaxSettingsSchema.meta({ id: "UpdateTaxSettings" }),
			{
				tax_mode: "auto",
				tax_registered_states: ["CO"],
			},
		),
		responses: {
			200: json(
				envelope(
					taxSettings.extend({
						cleared_default_lines: z.number().int(),
						recompute_queued: z.number().int(),
					}),
				),
				"Updated",
			),
			400: json(
				errorEnvelope,
				"Validation failed, nothing to update, or auto with no states (`VALIDATION_ERROR`)",
			),
			409: json(
				errorEnvelope,
				"Auto is refused while QuickBooks is connected without a pass-through tax code (`CONFLICT`)",
			),
		},
	},
	"Automated Tax isn't in the plan (`MODULE_NOT_IN_PLAN`)",
);
