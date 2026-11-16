import z from "zod";
import {
	createRecurringPlanSchema,
	generateOccurrencesSchema,
	updateRecurringPlanSchema,
	updateRecurringPlanLineItemsSchema,
	invoiceScheduleSchema,
	createRecurringPlanNoteSchema,
	updateRecurringPlanNoteSchema,
	skipOccurrenceSchema,
	rescheduleOccurrenceSchema,
	bulkSkipOccurrencesSchema,
} from "../lib/validate/recurringPlans.js";
import { recurringTaxEstimateSchema } from "../lib/validate/recurringTaxEstimate.js";
import {
	authed,
	decimal,
	envelope,
	errorEnvelope,
	historyQuery,
	historyResponses,
	json,
	moduleOff,
} from "./shared.js";
import { noteAuthor } from "./clients.js";
import { coords, priority } from "./requestsQuotes.js";
import { jobParams, jobVisit } from "./jobs.js";

// ===============================================================================================================================
// Recurring Plans
// ===============================================================================================================================

const recurringPlan = z
	.object({
		id: z.uuid(),
		client_id: z.uuid(),
		name: z.string(),
		description: z.string(),
		address: z.string(),
		coords: coords.nullable(),
		priority,
		status: z.enum(["Active", "Paused", "Completed", "Cancelled"]),
		starts_at: z.iso.datetime(),
		ends_at: z.iso.datetime().nullable().describe("Null means indefinite"),
		timezone: z.string().describe("IANA timezone"),
		generation_window_days: z.number().int(),
		min_advance_days: z.number().int(),
		billing_mode: z.enum(["per_visit", "subscription", "none"]),
		invoice_timing: z.enum(["on_completion", "on_schedule_date", "manual"]),
		auto_invoice: z.boolean(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		client: z.object({
			id: z.uuid(),
			name: z.string(),
			address: z.string(),
		}),
		job_container: z
			.object({
				id: z.uuid(),
				job_number: z.string(),
				name: z.string(),
				status: z.string(),
			})
			.nullable(),
		rules: z.array(z.record(z.string(), z.unknown())),
		line_items: z.array(z.record(z.string(), z.unknown())),
		occurrences: z
			.array(z.record(z.string(), z.unknown()))
			.describe("Next 5 occurrences from today"),
	})
	.meta({ id: "RecurringPlan" });

authed(
	"get",
	"/recurring-plans",
	"Recurring Plans",
	"view_recurring_plans",
	{
		summary: "List recurring plans",
		description:
			"Requires the `view_recurring_plans` permission. Newest first, with rules, line items and the next 5 occurrences.",
		responses: {
			200: json(
				envelope(z.array(recurringPlan)),
				"Recurring plans (empty array if none)",
			),
		},
	},
	moduleOff("recurring_plans"),
);

authed(
	"get",
	"/recurring-plans/{id}",
	"Recurring Plans",
	"view_recurring_plans",
	{
		summary: "Get a recurring plan",
		description:
			"Requires the `view_recurring_plans` permission. Also includes `client` (with contacts), `job_container`, `rules`, `line_items`, `occurrences`, `invoice_schedule` and `created_by_dispatcher`.",
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: json(envelope(recurringPlan), "Recurring plan"),
			404: json(
				errorEnvelope,
				"Recurring plan not in the caller's organization (`NOT_FOUND`)",
			),
		},
	},
	moduleOff("recurring_plans"),
);

authed(
	"post",
	"/recurring-plans",
	"Recurring Plans",
	"manage_recurring_plans",
	{
		summary: "Create a recurring plan",
		description:
			"Requires the `manage_recurring_plans` permission. `weekly` rules need `by_weekday`, `monthly` need `by_month_day`, `yearly` need `by_month`; an `at` arrival needs `arrival_time` and a `between` arrival needs both window times. The response includes the first 10 occurrences.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: createRecurringPlanSchema.meta({
							id: "CreateRecurringPlan",
						}),
					},
				},
			},
		},
		responses: {
			201: json(envelope(recurringPlan), "Recurring plan created"),
			400: json(
				errorEnvelope,
				"Validation failed, or the insert failed (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Client not found (`VALIDATION_ERROR`)"),
		},
	},
	moduleOff("recurring_plans"),
);

const occurrence = z
	.object({
		id: z.uuid(),
		recurring_plan_id: z.uuid(),
		occurrence_start_at: z.iso.datetime(),
		occurrence_end_at: z.iso.datetime(),
		status: z.enum([
			"planned",
			"generated",
			"skipped",
			"cancelled",
			"completed",
		]),
		arrival_constraint: z.enum(["anytime", "at", "between", "by"]),
		finish_constraint: z.enum(["when_done", "at", "by"]),
		arrival_time: z.string().nullable().describe("HH:MM"),
		arrival_window_start: z.string().nullable().describe("HH:MM"),
		arrival_window_end: z.string().nullable().describe("HH:MM"),
		finish_time: z.string().nullable().describe("HH:MM"),
		job_visit_id: z.uuid().nullable(),
		generated_at: z.iso.datetime().nullable(),
		completed_at: z.iso.datetime().nullable(),
		skipped_at: z.iso.datetime().nullable(),
		skip_reason: z.string().nullable(),
		template_version: z.number().int(),
		created_at: z.iso.datetime(),
		job_visit: jobVisit
			.nullable()
			.describe("The visit made from this occurrence, once generated"),
	})
	.meta({ id: "RecurringOccurrence" });

authed(
	"get",
	"/jobs/{jobId}/occurrences",
	"Recurring Plans",
	"view_recurring_plans or view_jobs",
	{
		summary: "List a plan's occurrences",
		description:
			"Requires `view_recurring_plans` or `view_jobs`. `jobId` is the plan's job container (`job_container.id` on the plan). Every occurrence of the plan, earliest first. A job that isn't a plan's container returns an empty array.",
		request: { params: jobParams },
		responses: {
			200: json(
				envelope(z.array(occurrence)),
				"Occurrences (empty array if none)",
			),
		},
	},
	moduleOff("recurring_plans"),
);

authed(
	"post",
	"/jobs/{jobId}/occurrences/generate",
	"Recurring Plans",
	"manage_recurring_plans",
	{
		summary: "Generate a plan's occurrences",
		description:
			"Requires the `manage_recurring_plans` permission. `jobId` is the plan's job container. Adds occurrences from the plan's rules up to `days_ahead` days out; dates that already have one are skipped. Active plans only.",
		request: {
			params: jobParams,
			body: {
				content: {
					"application/json": {
						schema: generateOccurrencesSchema.meta({
							id: "GenerateOccurrences",
						}),
						example: { days_ahead: 60 },
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(
					z.object({
						generated: z.number().int(),
						skipped: z.number().int(),
						start_date: z.iso.datetime(),
						end_date: z.iso.datetime(),
					}),
				),
				"Generated",
			),
			400: json(
				errorEnvelope,
				"Validation failed, the plan isn't Active or has no rules, or another error (its raw message is returned) (`VALIDATION_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"No plan has this job as its container (`VALIDATION_ERROR`)",
			),
		},
	},
	moduleOff("recurring_plans"),
);

const plansOff = moduleOff("recurring_plans");
const containerNote =
	"`jobId` is the plan's job container (`job_container.id` on the plan).";
const noPlan = json(
	errorEnvelope,
	"No plan has this job as its container (`VALIDATION_ERROR`)",
);
const planNote = z
	.object({
		id: z.uuid(),
		recurring_plan_id: z.uuid(),
		content: z.string(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		creator_tech: noteAuthor,
		creator_dispatcher: noteAuthor,
		last_editor_tech: noteAuthor,
		last_editor_dispatcher: noteAuthor,
	})
	.meta({ id: "RecurringPlanNote" });
const planNoteParams = jobParams.extend({ noteId: z.uuid() });
const invoiceSchedule = z
	.object({
		id: z.uuid(),
		recurring_plan_id: z.uuid(),
		frequency: z.enum([
			"on_visit_completion",
			"weekly",
			"biweekly",
			"monthly",
			"quarterly",
		]),
		billing_basis: z.enum([
			"visit_actuals",
			"plan_line_items",
			"fixed_amount",
		]),
		fixed_amount: decimal.nullable(),
		day_of_month: z.number().int().nullable(),
		day_of_week: z
			.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"])
			.nullable(),
		generate_days_before: z.number().int(),
		payment_terms_days: z.number().int().nullable(),
		auto_send: z.boolean(),
		memo_template: z.string().nullable(),
		next_invoice_at: z.iso.datetime().nullable(),
		last_invoiced_at: z.iso.datetime().nullable(),
		is_active: z.boolean(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
	})
	.meta({ id: "InvoiceSchedule" });
const planStatusAction = (
	action: string,
	text: string,
): Parameters<typeof authed>[4] => ({
	summary: `${action} a recurring plan`,
	description: `Requires the \`manage_recurring_plans\` permission. ${containerNote} ${text} The current status isn't checked.`,
	request: { params: jobParams },
	responses: {
		200: json(
			envelope(recurringPlan),
			"The plan, with the same related records as `PUT /jobs/{jobId}/recurring-plan`",
		),
		400: json(errorEnvelope, "The update failed (`VALIDATION_ERROR`)"),
		404: noPlan,
	},
});

authed(
	"get",
	"/jobs/{jobId}/recurring-plan",
	"Recurring Plans",
	"view_recurring_plans",
	{
		summary: "Get a recurring plan by its job",
		description: `Requires the \`view_recurring_plans\` permission. ${containerNote} Also includes \`client\`, \`job_container\`, \`rules\`, \`line_items\`, every occurrence (earliest first), \`invoice_schedule\` and \`created_by_dispatcher\`.`,
		request: { params: jobParams },
		responses: {
			200: json(envelope(recurringPlan), "Recurring plan"),
			404: json(
				errorEnvelope,
				"No plan has this job as its container (`NOT_FOUND`)",
			),
		},
	},
	plansOff,
);

authed(
	"put",
	"/jobs/{jobId}/recurring-plan",
	"Recurring Plans",
	"manage_recurring_plans",
	{
		summary: "Update a recurring plan",
		description: `Requires the \`manage_recurring_plans\` permission. ${containerNote} Send only the fields to change. \`name\`, \`description\`, \`address\`, \`coords\` and \`priority\` are copied to the job container. A \`rule\` replaces the plan's rule, deletes future \`planned\` occurrences and generates new ones; it is ignored if the plan has no rule. \`line_items\` replaces the list (lines with an \`id\` are updated, lines without are added, missing lines are deleted). \`invoice_schedule\` creates or replaces the schedule, or deactivates it when \`billing_mode\` is \`none\` in the same request. \`status\` is set as sent, with no transition checks or side effects.`,
		request: {
			params: jobParams,
			body: {
				content: {
					"application/json": {
						schema: updateRecurringPlanSchema.meta({
							id: "UpdateRecurringPlan",
						}),
						example: {
							name: "Quarterly HVAC service",
							priority: "High",
						},
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(recurringPlan),
				"The plan, with `client` (and contacts), `job_container`, `rules`, `line_items`, every occurrence, `invoice_schedule` and `created_by_dispatcher`",
			),
			400: json(
				errorEnvelope,
				"Validation failed, an inventory item, tax group or vehicle isn't in the organization, or the update failed (`VALIDATION_ERROR`)",
			),
			404: noPlan,
		},
	},
	plansOff,
);

authed(
	"put",
	"/jobs/{jobId}/recurring-plan/template",
	"Recurring Plans",
	"manage_recurring_plans",
	{
		summary: "Replace a plan's line items",
		description: `Requires the \`manage_recurring_plans\` permission. ${containerNote} Replaces the line items used for new visits: lines with an \`id\` are updated, lines without are added, missing lines are deleted. At least one line is required. Existing visits aren't changed.`,
		request: {
			params: jobParams,
			body: {
				content: {
					"application/json": {
						schema: updateRecurringPlanLineItemsSchema.meta({
							id: "UpdateRecurringPlanLineItems",
						}),
						example: {
							line_items: [
								{
									name: "Filter replacement",
									quantity: 1,
									unit_price: 45,
								},
							],
						},
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(
					recurringPlan
						.pick({ id: true, name: true, status: true })
						.extend({
							line_items: z.array(
								z.record(z.string(), z.unknown()),
							),
						}),
				),
				"The plan row with its `line_items` (sorted); no other relations",
			),
			400: json(
				errorEnvelope,
				"Validation failed, an inventory item, tax group or vehicle isn't in the organization, or the update failed (`VALIDATION_ERROR`)",
			),
			404: noPlan,
		},
	},
	plansOff,
);

authed(
	"post",
	"/jobs/{jobId}/recurring-plan/pause",
	"Recurring Plans",
	"manage_recurring_plans",
	planStatusAction(
		"Pause",
		"Sets the status to `Paused`. `POST /jobs/{jobId}/occurrences/generate` refuses paused plans.",
	),
	plansOff,
);

authed(
	"post",
	"/jobs/{jobId}/recurring-plan/resume",
	"Recurring Plans",
	"manage_recurring_plans",
	planStatusAction(
		"Resume",
		"Sets the status to `Active`, including from `Cancelled` or `Completed`.",
	),
	plansOff,
);

authed(
	"post",
	"/jobs/{jobId}/recurring-plan/complete",
	"Recurring Plans",
	"manage_recurring_plans",
	planStatusAction(
		"Complete",
		"Sets the status to `Completed`. Future planned occurrences are left as they are (cancel cancels them).",
	),
	plansOff,
);

authed(
	"post",
	"/jobs/{jobId}/recurring-plan/cancel",
	"Recurring Plans",
	"manage_recurring_plans",
	{
		summary: "Cancel a recurring plan",
		description: `Requires the \`manage_recurring_plans\` permission. ${containerNote} Sets the status to \`Cancelled\` and cancels every future \`planned\` occurrence. Existing visits aren't touched. The current status isn't checked.`,
		request: { params: jobParams },
		responses: {
			200: json(
				envelope(
					recurringPlan.omit({
						client: true,
						job_container: true,
						rules: true,
						line_items: true,
						occurrences: true,
					}),
				),
				"The plan row, with no related records",
			),
			400: json(errorEnvelope, "The update failed (`VALIDATION_ERROR`)"),
			404: noPlan,
		},
	},
	plansOff,
);

authed(
	"get",
	"/jobs/{jobId}/recurring-plan/skipped-dates",
	"Recurring Plans",
	"view_recurring_plans",
	{
		summary: "List dates skipped while the module was off",
		description:
			"Requires the `view_recurring_plans` permission. Dates the plan's rule would have produced while the `recurring_plans` module was turned off, and that have no occurrence. Uses the plan the job belongs to (`recurring_plan_id` on the job). A job with no plan returns an empty list.",
		request: { params: jobParams },
		responses: {
			200: json(
				envelope(z.object({ dates: z.array(z.iso.datetime()) })),
				"Dates, earliest first",
			),
		},
	},
	plansOff,
);

authed(
	"put",
	"/jobs/{jobId}/recurring-plan/invoice-schedule",
	"Recurring Plans",
	"manage_recurring_plans",
	{
		summary: "Set a plan's invoice schedule",
		description: `Requires the \`manage_recurring_plans\` permission. ${containerNote} Creates the schedule or replaces it, and makes it active. \`fixed_amount\` is required for \`fixed_amount\` billing, \`day_of_week\` for weekly and biweekly, \`day_of_month\` for monthly and quarterly. \`next_invoice_at\` is recalculated only when the frequency, day or \`generate_days_before\` changes.`,
		request: {
			params: jobParams,
			body: {
				content: {
					"application/json": {
						schema: invoiceScheduleSchema.meta({
							id: "SetInvoiceSchedule",
						}),
						example: {
							billing_basis: "plan_line_items",
							frequency: "monthly",
							day_of_month: 1,
						},
					},
				},
			},
		},
		responses: {
			200: json(envelope(invoiceSchedule), "Invoice schedule"),
			400: json(
				errorEnvelope,
				"Validation failed, no plan has this job as its container, or the update failed (`VALIDATION_ERROR`)",
			),
		},
	},
	plansOff,
);

authed(
	"delete",
	"/jobs/{jobId}/recurring-plan/invoice-schedule",
	"Recurring Plans",
	"manage_recurring_plans",
	{
		summary: "Remove a plan's invoice schedule",
		description: `Requires the \`manage_recurring_plans\` permission. ${containerNote} Succeeds even if the plan has no schedule. Not recorded in the plan's history.`,
		request: { params: jobParams },
		responses: {
			200: json(envelope(z.object({ message: z.string() })), "Removed"),
			404: json(
				errorEnvelope,
				"No plan has this job as its container (`NOT_FOUND`)",
			),
		},
	},
	plansOff,
);

authed(
	"get",
	"/jobs/{jobId}/recurring-plan/notes",
	"Recurring Plans",
	"view_recurring_plans",
	{
		summary: "List a plan's notes",
		description: `Requires the \`view_recurring_plans\` permission. ${containerNote} Newest first.`,
		request: { params: jobParams },
		responses: {
			200: json(
				envelope(z.array(planNote)),
				"Notes (empty array if none)",
			),
			404: json(
				errorEnvelope,
				"No plan has this job as its container (`NOT_FOUND`)",
			),
		},
	},
	plansOff,
);

authed(
	"post",
	"/jobs/{jobId}/recurring-plan/notes",
	"Recurring Plans",
	"manage_recurring_plans",
	{
		summary: "Add a note to a plan",
		description: `Requires the \`manage_recurring_plans\` permission. ${containerNote} The author is the caller, taken from the token.`,
		request: {
			params: jobParams,
			body: {
				content: {
					"application/json": {
						schema: createRecurringPlanNoteSchema.meta({
							id: "CreateRecurringPlanNote",
						}),
						example: { content: "Gate code changed to 4471." },
					},
				},
			},
		},
		responses: {
			201: json(
				envelope(
					planNote.omit({
						last_editor_tech: true,
						last_editor_dispatcher: true,
					}),
				),
				"Note created",
			),
			400: json(
				errorEnvelope,
				"Validation failed, or the insert failed (`VALIDATION_ERROR`)",
			),
			404: noPlan,
		},
	},
	plansOff,
);

authed(
	"put",
	"/jobs/{jobId}/recurring-plan/notes/{noteId}",
	"Recurring Plans",
	"manage_recurring_plans",
	{
		summary: "Update a plan note",
		description: `Requires the \`manage_recurring_plans\` permission. ${containerNote} Any user with the permission can edit any note; the caller is recorded as the last editor.`,
		request: {
			params: planNoteParams,
			body: {
				content: {
					"application/json": {
						schema: updateRecurringPlanNoteSchema.meta({
							id: "UpdateRecurringPlanNote",
						}),
					},
				},
			},
		},
		responses: {
			200: json(envelope(planNote), "Note updated"),
			400: json(
				errorEnvelope,
				"Validation failed, or the update failed (`VALIDATION_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"No plan has this job as its container, or the note isn't on it (`VALIDATION_ERROR`)",
			),
		},
	},
	plansOff,
);

authed(
	"delete",
	"/jobs/{jobId}/recurring-plan/notes/{noteId}",
	"Recurring Plans",
	"manage_recurring_plans",
	{
		summary: "Delete a plan note",
		description: `Requires the \`manage_recurring_plans\` permission. ${containerNote} Any user with the permission can delete any note.`,
		request: { params: planNoteParams },
		responses: {
			200: json(
				envelope(z.object({ message: z.string() })),
				"Note deleted",
			),
			400: json(errorEnvelope, "The delete failed (`VALIDATION_ERROR`)"),
			404: json(
				errorEnvelope,
				"No plan has this job as its container, or the note isn't on it (`VALIDATION_ERROR`)",
			),
		},
	},
	plansOff,
);

const occParams = z.object({ occurrenceId: z.uuid() });
const occNotFound = json(
	errorEnvelope,
	"Occurrence not found (`VALIDATION_ERROR`)",
);

authed(
	"post",
	"/occurrences/{occurrenceId}/skip",
	"Recurring Plans",
	"manage_recurring_plans",
	{
		summary: "Skip an occurrence",
		description:
			"Requires the `manage_recurring_plans` permission. Only `planned` occurrences.",
		request: {
			params: occParams,
			body: {
				content: {
					"application/json": {
						schema: skipOccurrenceSchema.meta({
							id: "SkipOccurrence",
						}),
						example: { skip_reason: "Client on vacation" },
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(occurrence.omit({ job_visit: true })),
				"Skipped",
			),
			400: json(
				errorEnvelope,
				"Validation failed, or not planned (`VALIDATION_ERROR`)",
			),
			404: occNotFound,
		},
	},
	plansOff,
);

authed(
	"post",
	"/occurrences/bulk-skip",
	"Recurring Plans",
	"manage_recurring_plans",
	{
		summary: "Skip several occurrences",
		description:
			"Requires the `manage_recurring_plans` permission. Ids that aren't `planned` (or don't exist) are left alone; `skipped` counts the ones changed.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: bulkSkipOccurrencesSchema.meta({
							id: "BulkSkipOccurrences",
						}),
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(z.object({ skipped: z.number().int() })),
				"Skipped",
			),
			400: json(
				errorEnvelope,
				"Validation failed, or the update failed (`VALIDATION_ERROR`)",
			),
		},
	},
	plansOff,
);

authed(
	"put",
	"/occurrences/{occurrenceId}/reschedule",
	"Recurring Plans",
	"manage_recurring_plans",
	{
		summary: "Reschedule an occurrence",
		description:
			"Requires the `manage_recurring_plans` permission. Only `planned` occurrences. Moves it to `new_start_at` (the end time stays as it was unless `new_end_at` is given, and isn't checked to be after the new start) and can change its arrival and finish window. `scope: future` shifts every later planned occurrence of the plan by the same amount.",
		request: {
			params: occParams,
			body: {
				content: {
					"application/json": {
						schema: rescheduleOccurrenceSchema.meta({
							id: "RescheduleOccurrence",
						}),
						example: {
							new_start_at: "2026-12-02T09:00:00-07:00",
							scope: "this",
						},
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(occurrence.omit({ job_visit: true })),
				"Rescheduled",
			),
			400: json(
				errorEnvelope,
				"Validation failed, not planned, another occurrence of the plan is already at that time, or another error with its raw message (`VALIDATION_ERROR`)",
			),
			404: occNotFound,
		},
	},
	plansOff,
);

authed(
	"post",
	"/occurrences/{occurrenceId}/generate-visit",
	"Recurring Plans",
	"manage_recurring_plans",
	{
		summary: "Create the visit for an occurrence",
		description:
			"Requires the `manage_recurring_plans` permission. Turns a `planned` occurrence into a visit on the plan's job, with the plan's line items.",
		request: { params: occParams },
		responses: {
			201: json(
				envelope(
					z.object({
						visit_id: z.uuid(),
						occurrence_id: z.uuid(),
						scheduled_start_at: z.iso.datetime(),
						scheduled_end_at: z.iso.datetime(),
						template_version: z.number().int(),
					}),
				),
				"Visit created",
			),
			400: json(
				errorEnvelope,
				"Not planned, or a visit already exists for it (`VALIDATION_ERROR`)",
			),
			404: occNotFound,
		},
	},
	plansOff,
);

authed(
	"post",
	"/recurring-plans/tax-estimate",
	"Recurring Plans",
	"view_recurring_plans",
	{
		summary: "Estimate a plan's tax",
		description:
			"Requires the `view_recurring_plans` permission. The tax a visit with these line items would carry at this address, using the organization's tax settings. With `plan_id`, an existing plan's kept rate is honored. Nothing is saved.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: recurringTaxEstimateSchema.meta({
							id: "RecurringTaxEstimate",
						}),
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(
					z
						.record(z.string(), z.unknown())
						.describe("Tax amount, rate and how it was found"),
				),
				"Estimate",
			),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
			404: json(errorEnvelope, "`plan_id` not found (`NOT_FOUND`)"),
		},
	},
	plansOff,
);

authed(
	"get",
	"/recurring-plans/{id}/changes",
	"Recurring Plans",
	"view_recurring_plans",
	{
		summary: "Get a recurring plan's history",
		description: "Requires the `view_recurring_plans` permission.",
		request: { params: z.object({ id: z.uuid() }), query: historyQuery },
		responses: historyResponses,
	},
	plansOff,
);
