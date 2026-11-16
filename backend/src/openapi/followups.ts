import z from "zod";
import {
	enrollSchema,
	createSequenceSchema,
	updateSequenceSchema,
} from "../lib/validate/followups.js";
import { upsertTemplateSchema } from "../lib/validate/emailTemplates.js";
import { authed, envelope, errorEnvelope, json, moduleOff } from "./shared.js";

// ===============================================================================================================================
// Followups
// ===============================================================================================================================

const followupSequence = z
	.object({
		id: z.uuid(),
		name: z.string(),
		description: z.string().nullable(),
		trigger_type: z.enum([
			"manual",
			"date_based",
			"quote_sent",
			"invoice_sent",
			"request_created",
			"visit_scheduled",
		]),
		trigger_config: z.unknown().nullable(),
		stop_on_open: z.boolean(),
		is_active: z.boolean(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		steps: z.array(
			z.object({
				id: z.uuid(),
				step_order: z.number().int(),
				category: z.string(),
				delay_amount: z.number().int(),
				delay_unit: z.enum(["hours", "days"]),
				condition: z.string(),
			}),
		),
		_count: z.object({ enrollments: z.number().int() }),
	})
	.meta({ id: "FollowupSequence" });

const enrollmentStatus = z.enum(["active", "completed", "stopped", "failed"]);

const enrollmentFields = {
	id: z.uuid(),
	sequence_id: z.uuid(),
	client_id: z.uuid(),
	contact_id: z.uuid().nullable(),
	recipient_email: z.string(),
	status: enrollmentStatus,
	current_step_order: z.number().int(),
	next_send_at: z.iso.datetime().nullable(),
	anchor_entity_type: z.string().nullable(),
	anchor_entity_id: z.uuid().nullable(),
	anchor_at: z.iso.datetime().nullable(),
	started_at: z.iso.datetime(),
	completed_at: z.iso.datetime().nullable(),
	stopped_at: z.iso.datetime().nullable(),
	stop_reason: z.string().nullable(),
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
};

const followupEnrollment = z
	.object(enrollmentFields)
	.meta({ id: "FollowupEnrollment" });

const followupEnrollmentListItem = z
	.object({
		...enrollmentFields,
		sequence: z.object({ name: z.string(), trigger_type: z.string() }),
		client: z.object({ name: z.string() }),
		sends: z.array(
			z.object({
				id: z.uuid(),
				step_id: z.uuid().nullable(),
				recipient_email: z.string(),
				status: z.enum(["sent", "skipped", "failed"]),
				sent_at: z.iso.datetime(),
				opened_at: z.iso.datetime().nullable(),
				open_count: z.number().int(),
				error: z.string().nullable(),
			}),
		),
	})
	.meta({ id: "FollowupEnrollmentListItem" });

authed(
	"get",
	"/followups/sequences",
	"Followups",
	"view_followups",
	{
		summary: "List follow-up sequences",
		description:
			"Requires the `view_followups` permission. Newest first, with steps in order and an enrollment count.",
		responses: {
			200: json(
				envelope(z.array(followupSequence)),
				"Sequences (empty array if none)",
			),
		},
	},
	moduleOff("followups"),
);

authed(
	"get",
	"/followups/enrollments",
	"Followups",
	"view_followups",
	{
		summary: "List follow-up enrollments",
		description:
			"Requires the `view_followups` permission. Newest first, at most 200, with each enrollment's sends.",
		request: {
			query: z.object({
				status: enrollmentStatus
					.optional()
					.describe("Only this status; an unknown value is ignored"),
				client_id: z
					.uuid()
					.optional()
					.describe("Only this client's enrollments"),
			}),
		},
		responses: {
			200: json(
				envelope(z.array(followupEnrollmentListItem)),
				"Enrollments (empty array if none)",
			),
		},
	},
	moduleOff("followups"),
);

authed(
	"post",
	"/followups/enroll",
	"Followups",
	"manage_followups",
	{
		summary: "Enroll a client in a sequence",
		description:
			"Requires the `manage_followups` permission. Without `recipient_email`, the client's contact email is used. `scheduled_at` is required for `visit_scheduled` sequences and anchors `date_based` ones.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: enrollSchema.meta({ id: "EnrollFollowup" }),
						example: {
							sequence_id: "9b1d2c3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e",
							client_id: "3f6c2a1e-8b4d-4c2a-9e1f-1a2b3c4d5e6f",
						},
					},
				},
			},
		},
		responses: {
			200: json(envelope(followupEnrollment), "Enrolled"),
			400: json(
				errorEnvelope,
				"Validation failed, sequence inactive or has no steps, `scheduled_at` missing for a reminder sequence, or no recipient email (`VALIDATION_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"Sequence or client not found (`NOT_FOUND`)",
			),
			409: json(
				errorEnvelope,
				"An active enrollment already exists (`CONFLICT`)",
			),
		},
	},
	moduleOff("followups"),
);

authed(
	"post",
	"/followups/enrollments/{id}/stop",
	"Followups",
	"manage_followups",
	{
		summary: "Stop an enrollment",
		description:
			"Requires the `manage_followups` permission. Sets `status` to `stopped` and cancels pending sends. No body needed.",
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: json(envelope(followupEnrollment), "Enrollment stopped"),
			404: json(errorEnvelope, "Enrollment not found (`NOT_FOUND`)"),
		},
	},
	moduleOff("followups"),
);

const followupsOff = moduleOff("followups");
const seqParams = z.object({ id: z.uuid() });
const seqNotFound = json(errorEnvelope, "Sequence not found (`NOT_FOUND`)");
const firstIssue = json(
	errorEnvelope,
	"Validation failed; the message is the first problem (`VALIDATION_ERROR`)",
);
const category = z.enum([
	"followup",
	"reminder",
	"quote_chase",
	"invoice_chase",
	"request_ack",
	"custom",
]);
const template = z
	.object({
		category,
		name: z.string(),
		subject: z.string(),
		html: z.string(),
		text: z
			.string()
			.nullable()
			.describe(
				"Plain-text version; null means generated from the HTML at send time",
			),
		is_customized: z
			.boolean()
			.describe("False when this is the built-in default"),
		updated_at: z.iso.datetime().nullable(),
	})
	.meta({ id: "EmailTemplate" });
const categoryParams = z.object({ category });
const unknownCategory = json(
	errorEnvelope,
	"Unknown template category (`NOT_FOUND`)",
);

authed(
	"get",
	"/followups/sequences/{id}",
	"Followups",
	"view_followups",
	{
		summary: "Get a follow-up sequence",
		description:
			"Requires the `view_followups` permission. With its steps.",
		request: { params: seqParams },
		responses: {
			200: json(envelope(followupSequence), "Sequence"),
			404: seqNotFound,
		},
	},
	followupsOff,
);

authed(
	"post",
	"/followups/sequences",
	"Followups",
	"manage_followups",
	{
		summary: "Create a follow-up sequence",
		description:
			"Requires the `manage_followups` permission. A series of emails (`steps`) sent after a trigger, each a template `category` sent `delay_amount` `delay_unit` after the previous one; `condition` controls whether it still goes out. Step orders must be unique. Returns 200, not 201.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: createSequenceSchema.meta({
							id: "CreateFollowupSequence",
						}),
						example: {
							name: "Quote chase",
							trigger_type: "quote_sent",
							steps: [
								{
									step_order: 1,
									category: "quote_chase",
									delay_amount: 3,
									delay_unit: "days",
								},
								{
									step_order: 2,
									category: "quote_chase",
									delay_amount: 7,
									delay_unit: "days",
								},
							],
						},
					},
				},
			},
		},
		responses: {
			200: json(envelope(followupSequence), "Created"),
			400: firstIssue,
		},
	},
	followupsOff,
);

authed(
	"patch",
	"/followups/sequences/{id}",
	"Followups",
	"manage_followups",
	{
		summary: "Update a follow-up sequence",
		description:
			"Requires the `manage_followups` permission. Send only the fields to change. `steps` replaces every step.",
		request: {
			params: seqParams,
			body: {
				content: {
					"application/json": {
						schema: updateSequenceSchema.meta({
							id: "UpdateFollowupSequence",
						}),
						example: { is_active: false },
					},
				},
			},
		},
		responses: {
			200: json(envelope(followupSequence), "Updated"),
			400: firstIssue,
			404: seqNotFound,
		},
	},
	followupsOff,
);

authed(
	"delete",
	"/followups/sequences/{id}",
	"Followups",
	"manage_followups",
	{
		summary: "Delete a follow-up sequence",
		description:
			"Requires the `manage_followups` permission. Deletes it with its steps and every enrollment, active or finished.",
		request: { params: seqParams },
		responses: {
			200: json(envelope(z.object({ id: z.uuid() })), "Deleted"),
			404: seqNotFound,
		},
	},
	followupsOff,
);

authed(
	"get",
	"/followups/templates",
	"Followups",
	"view_followups",
	{
		summary: "List email templates",
		description:
			"Requires the `view_followups` permission. One per category: the organization's version where it has saved one, the built-in default otherwise.",
		responses: { 200: json(envelope(z.array(template)), "Templates") },
	},
	followupsOff,
);

authed(
	"get",
	"/followups/templates/context",
	"Followups",
	"view_followups",
	{
		summary: "Get template preview values",
		description:
			"Requires the `view_followups` permission. The organization's branding and sample values, for previewing a template as a client would see it.",
		responses: {
			200: json(
				envelope(
					z.object({
						brand: z
							.record(z.string(), z.unknown())
							.describe("Name, logo, color and contact details"),
						samples: z.object({
							client_name: z.string(),
							anchor_type: z.string().nullable(),
						}),
					}),
				),
				"Preview values",
			),
		},
	},
	followupsOff,
);

authed(
	"get",
	"/followups/templates/{category}",
	"Followups",
	"view_followups",
	{
		summary: "Get an email template",
		description: "Requires the `view_followups` permission.",
		request: { params: categoryParams },
		responses: {
			200: json(envelope(template), "Template"),
			404: unknownCategory,
		},
	},
	followupsOff,
);

authed(
	"put",
	"/followups/templates/{category}",
	"Followups",
	"manage_followups",
	{
		summary: "Save an email template",
		description:
			"Requires the `manage_followups` permission. Saves the organization's version of the category's template. A blank `name` keeps the default name; a blank `text` is generated from the HTML at send time.",
		request: {
			params: categoryParams,
			body: {
				content: {
					"application/json": {
						schema: upsertTemplateSchema.meta({
							id: "SaveEmailTemplate",
						}),
					},
				},
			},
		},
		responses: {
			200: json(envelope(template), "Saved"),
			400: firstIssue,
			404: unknownCategory,
		},
	},
	followupsOff,
);

authed(
	"post",
	"/followups/templates/{category}/reset",
	"Followups",
	"manage_followups",
	{
		summary: "Reset an email template",
		description:
			"Requires the `manage_followups` permission. Discards the organization's version, going back to the built-in default.",
		request: { params: categoryParams },
		responses: {
			200: json(envelope(template), "The default template"),
			404: unknownCategory,
		},
	},
	followupsOff,
);
