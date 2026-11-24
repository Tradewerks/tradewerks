import z from "zod";
import {
	createJobSchema,
	updateJobSchema,
	createJobNoteSchema,
	updateJobNoteSchema,
} from "../lib/validate/jobs.js";
import {
	createJobVisitSchema,
	updateJobVisitSchema,
} from "../lib/validate/jobVisits.js";
import {
	authed,
	decimal,
	envelope,
	errorEnvelope,
	historyQuery,
	historyResponses,
	idName,
	json,
} from "./shared.js";
import { clientParams, noteAuthor } from "./clients.js";
import { coords } from "./requestsQuotes.js";

export { jobParams, jobVisitParams, jobVisit };

const notAssigned = (target: string) =>
	`A technician limited to assigned work isn't assigned to the ${target} (\`FORBIDDEN\`)`;

// ===============================================================================================================================
// Jobs & Visits
// ===============================================================================================================================

const job = z
	.object({
		id: z.uuid(),
		job_number: z.string(),
		name: z.string(),
		description: z.string(),
		priority: z.enum(["Low", "Medium", "High", "Urgent", "Emergency"]),
		address: z.string(),
		coords: z.object({ lat: z.number(), lon: z.number() }),
		status: z.enum([
			"Unscheduled",
			"Scheduled",
			"InProgress",
			"Completed",
			"Cancelled",
		]),
		client_id: z.uuid(),
		request_id: z.uuid().nullable(),
		quote_id: z.uuid().nullable(),
		recurring_plan_id: z.uuid().nullable(),
		project_id: z.uuid().nullable(),
		subtotal: z.string().describe("Decimal as a string"),
		tax_rate: z.string().describe("Decimal as a string"),
		tax_amount: z.string().describe("Decimal as a string"),
		discount_type: z.enum(["percent", "amount"]).nullable(),
		discount_value: z.string().nullable().describe("Decimal as a string"),
		discount_amount: z.string().nullable().describe("Decimal as a string"),
		estimated_total: z.string().nullable().describe("Decimal as a string"),
		actual_total: z.string().nullable().describe("Decimal as a string"),
		tax_needs_review: z.boolean(),
		cancellation_reason: z.string().nullable(),
		status_changed_at: z.iso.datetime(),
		completed_at: z.iso.datetime().nullable(),
		cancelled_at: z.iso.datetime().nullable(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
	})
	.meta({ id: "Job" });

authed(
	"get",
	"/jobs",
	"Jobs",
	"view_jobs or view_assigned_jobs or view_all_jobs",
	{
		summary: "List jobs",
		description:
			"Requires any of `view_jobs`, `view_assigned_jobs` or `view_all_jobs`. Returns every job in the caller's organization, newest first. With only `view_assigned_jobs`, returns just the jobs the caller has a visit on.",
		responses: {
			200: json(envelope(z.array(job)), "Jobs (empty array if none)"),
		},
	},
);

authed(
	"get",
	"/jobs/{id}",
	"Jobs",
	"view_jobs or view_assigned_jobs or view_all_jobs",
	{
		summary: "Get a job",
		description:
			"Requires any of `view_jobs`, `view_assigned_jobs` or `view_all_jobs`.",
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: json(envelope(job), "Job"),
			404: json(
				errorEnvelope,
				"Job not in the caller's organization (`NOT_FOUND`)",
			),
		},
	},
	notAssigned("job"),
);

authed("post", "/jobs", "Jobs", "create_jobs", {
	summary: "Create a job",
	description:
		"Requires the `create_jobs` permission. With `quote_id` or `request_id` the job inherits name, description, address and priority from it, and the source is marked converted; otherwise `name`, `description` and `address` are required. `coords` is looked up from `address` when omitted.",
	request: {
		body: {
			content: {
				"application/json": {
					schema: createJobSchema.in
						.omit({
							tech_ids: true,
							cancellation_reason: true,
							actual_total: true,
						})
						.meta({ id: "CreateJob" }),
					example: {
						client_id: "3f2b6c1e-8a4d-4f7e-9b1a-2c5d8e7f6a90",
						name: "Furnace not igniting",
						description: "No heat since last night.",
						address: "123 Main St, Fargo, ND 58102",
						priority: "High",
					},
				},
			},
		},
	},
	responses: {
		201: json(envelope(job), "Job created"),
		400: json(
			errorEnvelope,
			"Validation failed, address couldn't be geocoded, a required field is missing, or the client, quote or request wasn't found or can't be converted (`VALIDATION_ERROR`)",
		),
	},
});

authed("patch", "/jobs/{id}", "Jobs", "edit_jobs", {
	summary: "Update a job",
	description:
		"Requires the `edit_jobs` permission. Send only the fields to change. `line_items`, when sent, replaces the job's line items: items with an `id` are updated, items without one are created, and missing ones are removed.",
	request: {
		params: z.object({ id: z.uuid() }),
		body: {
			content: {
				"application/json": {
					schema: updateJobSchema.meta({ id: "UpdateJob" }),
					example: { priority: "Urgent" },
				},
			},
		},
	},
	responses: {
		200: json(envelope(job), "Job updated"),
		400: json(
			errorEnvelope,
			"Validation failed, or address couldn't be geocoded (`VALIDATION_ERROR`)",
		),
		404: json(errorEnvelope, "Job not found (`NOT_FOUND`)"),
		409: json(
			errorEnvelope,
			"Address change needs a tax choice: resend with `address_tax_choice` (`ADDRESS_TAX_CHOICE_REQUIRED`)",
		),
	},
});

const jobNote = z
	.object({
		id: z.uuid(),
		job_id: z.uuid(),
		visit_id: z.uuid().nullable(),
		content: z.string(),
		notify_technician: z.boolean(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		creator_tech: noteAuthor,
		creator_dispatcher: noteAuthor,
		last_editor_tech: noteAuthor,
		last_editor_dispatcher: noteAuthor,
		visit: z
			.object({
				id: z.uuid(),
				scheduled_start_at: z.iso.datetime(),
				scheduled_end_at: z.iso.datetime(),
				status: z.string(),
			})
			.nullable(),
		photos: z.array(
			z.object({
				id: z.uuid(),
				photo_url: z.string().describe("Signed, short-lived image URL"),
				photo_label: z.enum(["Before", "After", "Other"]),
				photo_name: z.string().nullable(),
				created_at: z.iso.datetime(),
			}),
		),
	})
	.meta({ id: "JobNote" });

authed(
	"post",
	"/jobs/{id}/notes",
	"Jobs",
	"edit_jobs or add_job_notes",
	{
		summary: "Add a note to a job",
		description:
			"Requires `edit_jobs` or `add_job_notes`. Needs `content` or at least one photo. The author is the caller, taken from the token. With `visit_id` and `notify_technician: true`, the visit's technicians get a notification.",
		request: {
			params: z.object({ id: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: createJobNoteSchema.meta({
							id: "CreateJobNote",
						}),
						example: {
							content: "Replaced the igniter; furnace runs fine.",
						},
					},
				},
			},
		},
		responses: {
			201: json(envelope(jobNote), "Note created"),
			400: json(
				errorEnvelope,
				"Validation failed, the visit isn't on this job, or the note couldn't be created (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Job or visit not found (`NOT_FOUND`)"),
		},
	},
	notAssigned("job or visit"),
);

const jobVisit = z
	.object({
		id: z.uuid(),
		job_id: z.uuid(),
		name: z.string().nullable(),
		description: z.string().nullable(),
		status: z.enum([
			"Scheduled",
			"Driving",
			"OnSite",
			"InProgress",
			"Paused",
			"Delayed",
			"Completed",
			"Cancelled",
		]),
		arrival_constraint: z.enum(["anytime", "at", "between", "by"]),
		finish_constraint: z.enum(["when_done", "at", "by"]),
		scheduled_start_at: z.iso.datetime(),
		scheduled_end_at: z.iso.datetime(),
		arrival_time: z.string().nullable().describe("HH:MM"),
		arrival_window_start: z.string().nullable().describe("HH:MM"),
		arrival_window_end: z.string().nullable().describe("HH:MM"),
		finish_time: z.string().nullable().describe("HH:MM"),
		actual_start_at: z.iso.datetime().nullable(),
		actual_end_at: z.iso.datetime().nullable(),
		cancellation_reason: z.string().nullable(),
		subtotal: z.string().describe("Decimal as a string"),
		tax_rate: z.string().describe("Decimal as a string"),
		tax_amount: z.string().describe("Decimal as a string"),
		discount_type: z.enum(["percent", "amount"]).nullable(),
		discount_value: z.string().nullable().describe("Decimal as a string"),
		discount_amount: z.string().nullable().describe("Decimal as a string"),
		total: z.string().describe("Decimal as a string"),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		visit_techs: z.array(
			z.object({
				tech_id: z.uuid(),
				tech_status: z.enum(["Assigned", "EnRoute", "OnSite", "Done"]),
				tech: z.object({ id: z.uuid(), name: z.string() }),
			}),
		),
	})
	.meta({ id: "JobVisit" });

authed(
	"get",
	"/job-visits",
	"Visits",
	"view_jobs or view_visits or view_assigned_jobs",
	{
		summary: "List visits",
		description:
			"Requires any of `view_jobs`, `view_visits` or `view_assigned_jobs`. Returns every visit in the caller's organization, earliest scheduled start first. With only `view_assigned_jobs`, returns just the caller's visits.",
		responses: {
			200: json(
				envelope(z.array(jobVisit)),
				"Visits (empty array if none)",
			),
		},
	},
);

authed("post", "/job-visits", "Visits", "create_jobs or edit_jobs", {
	summary: "Schedule a visit",
	description:
		"Requires `create_jobs` or `edit_jobs`. An `Unscheduled` job moves to `Scheduled`. `arrival_time` is required when `arrival_constraint` is `at`, both window ends for `between`, `arrival_window_end` for `by`, and `finish_time` when `finish_constraint` is `at` or `by`.",
	request: {
		body: {
			content: {
				"application/json": {
					schema: createJobVisitSchema.meta({ id: "CreateJobVisit" }),
					example: {
						job_id: "8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
						name: "Diagnose furnace",
						arrival_constraint: "between",
						arrival_window_start: "08:00",
						arrival_window_end: "10:00",
						finish_constraint: "when_done",
						scheduled_start_at: "2026-11-16T14:00:00Z",
						scheduled_end_at: "2026-11-16T16:00:00Z",
					},
				},
			},
		},
	},
	responses: {
		201: json(envelope(jobVisit), "Visit created"),
		400: json(
			errorEnvelope,
			"Validation failed, job not found, or a technician, tax group, inventory item or vehicle isn't in the caller's organization (`VALIDATION_ERROR`)",
		),
	},
});

authed(
	"put",
	"/job-visits/{id}",
	"Visits",
	"edit_jobs or update_visit_status",
	{
		summary: "Update a visit",
		description:
			'Requires `edit_jobs` or `update_visit_status`. Send only the fields to change. `line_items`, when sent, replaces the visit\'s line items. `reschedule_scope: "future"` on a recurring job also moves later visits.',
		request: {
			params: z.object({ id: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: updateJobVisitSchema.meta({
							id: "UpdateJobVisit",
						}),
						example: {
							scheduled_start_at: "2026-11-17T14:00:00Z",
							scheduled_end_at: "2026-11-17T16:00:00Z",
						},
					},
				},
			},
		},
		responses: {
			200: json(envelope(jobVisit), "Visit updated"),
			400: json(
				errorEnvelope,
				"Validation failed, a tax group or vehicle isn't in the caller's organization, or a status past `Scheduled` set with no technician assigned (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Visit not found (`NOT_FOUND`)"),
		},
	},
	notAssigned("visit"),
);

authed("put", "/job-visits/{id}/technicians", "Visits", "edit_jobs", {
	summary: "Set a visit's technicians",
	description:
		"Requires the `edit_jobs` permission. Replaces the assigned technicians with `tech_ids`; newly assigned technicians are notified.",
	request: {
		params: z.object({ id: z.uuid() }),
		body: {
			content: {
				"application/json": {
					schema: z
						.object({ tech_ids: z.array(z.uuid()) })
						.meta({ id: "SetVisitTechnicians" }),
					example: {
						tech_ids: ["5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b"],
					},
				},
			},
		},
	},
	responses: {
		200: json(envelope(jobVisit), "Technicians updated"),
		400: json(
			errorEnvelope,
			"`tech_ids` isn't an array (`INVALID_INPUT`); or removing everyone from a visit already underway, or the update failed (`VALIDATION_ERROR`)",
		),
		404: json(
			errorEnvelope,
			"Visit not found, or a technician not found or deactivated (`NOT_FOUND`)",
		),
	},
});

authed(
	"post",
	"/job-visits/{id}/cancel",
	"Visits",
	"edit_jobs or update_visit_status",
	{
		summary: "Cancel a visit",
		description:
			"Requires `edit_jobs` or `update_visit_status`. Sets the visit to `Cancelled`, updates the job's status to match its remaining visits, and notifies the assigned technicians. Send a JSON body, even `{}`.",
		request: {
			params: z.object({ id: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: z
							.object({
								cancellation_reason: z.string().optional(),
							})
							.meta({ id: "CancelJobVisit" }),
						example: {
							cancellation_reason: "Customer rescheduled",
						},
					},
				},
			},
		},
		responses: {
			200: json(envelope(jobVisit), "Visit cancelled"),
			404: json(errorEnvelope, "Visit not found (`NOT_FOUND`)"),
			409: json(
				errorEnvelope,
				"The visit is already `Completed` or `Cancelled`, or the cancel failed (`VALIDATION_ERROR`)",
			),
		},
	},
	notAssigned("visit"),
);

authed("delete", "/jobs/{id}", "Jobs", "delete_jobs", {
	summary: "Delete a job",
	description:
		"Requires the `delete_jobs` permission. Blocked while the job is on an invoice; cancel it instead, or remove it from the invoice first.",
	request: { params: z.object({ id: z.uuid() }) },
	responses: {
		200: json(
			envelope(z.object({ message: z.string(), id: z.uuid() })),
			"Job deleted",
		),
		400: json(errorEnvelope, "The job is on an invoice (`DELETE_ERROR`)"),
		404: json(errorEnvelope, "Job not found (`NOT_FOUND`)"),
	},
});

authed(
	"get",
	"/job-visits/{id}",
	"Visits",
	"view_jobs or view_visits or view_assigned_jobs",
	{
		summary: "Get a visit",
		description:
			"Requires any of `view_jobs`, `view_visits` or `view_assigned_jobs`. Also includes `job` (with its client, primary contact, quote and project), `visit_techs`, `line_items`, `time_entries`, `notes` and `invoice_visits`.",
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: json(envelope(jobVisit), "Visit"),
			404: json(
				errorEnvelope,
				"Visit not in the caller's organization (`NOT_FOUND`)",
			),
		},
	},
	notAssigned("visit"),
);

authed("delete", "/job-visits/{id}", "Visits", "delete_jobs", {
	summary: "Delete a visit",
	description:
		"Requires the `delete_jobs` permission. Blocked while the visit is on an invoice or has stock used against it; cancel it instead. If it was the job's last visit, the job goes back to `Unscheduled`.",
	request: { params: z.object({ id: z.uuid() }) },
	responses: {
		200: json(
			envelope(z.object({ message: z.string(), id: z.uuid() })),
			"Visit deleted",
		),
		400: json(
			errorEnvelope,
			"The visit is on an invoice or has stock used against it (`DELETE_ERROR`)",
		),
		404: json(errorEnvelope, "Visit not found (`NOT_FOUND`)"),
	},
});

authed(
	"get",
	"/clients/{clientId}/jobs",
	"Clients",
	"view_clients or view_jobs",
	{
		summary: "List a client's jobs",
		description:
			"Requires `view_clients` or `view_jobs`. Newest first, each with its `client`, `request`, `quote` and `visits` (with assigned technicians). An unknown client returns an empty array.",
		request: { params: clientParams },
		responses: {
			200: json(envelope(z.array(job)), "Jobs (empty array if none)"),
		},
	},
);

const visitIdParams = z.object({ id: z.uuid() });
const visitVerbs = ["edit_jobs", "update_visit_status"] as const;
const lifecycle = (
	action: string,
	from: string,
	to: string,
	extra = "",
): [string, string] => [
	`${action[0].toUpperCase()}${action.slice(1)} a visit`,
	`Requires \`edit_jobs\` or \`update_visit_status\`. Moves the visit from ${from} to \`${to}\`. Technicians must be assigned to the visit, and the visit needs at least one technician.${extra}`,
];
const visitWithRelations = json(
	envelope(jobVisit),
	"The visit, with its `job` (client and quote) and `visit_techs`",
);
const transitionRefused = json(
	errorEnvelope,
	"No technician is assigned, or the visit's status doesn't allow the action (`VALIDATION_ERROR`)",
);
const visitNotFound = json(errorEnvelope, "Visit not found (`NOT_FOUND`)");
const pauseReason = z
	.enum(["AwaitingMaterials", "EquipmentIssue", "Break", "Other"])
	.optional()
	.describe("Any other value is ignored");
const timeEntry = z
	.object({
		id: z.uuid(),
		visit_id: z.uuid(),
		tech_id: z.uuid(),
		clocked_in_at: z.iso.datetime(),
		clocked_out_at: z.iso.datetime().nullable(),
		hours_worked: decimal.nullable(),
		pause_reason: z
			.enum(["AwaitingMaterials", "EquipmentIssue", "Break", "Other"])
			.nullable(),
		line_item_id: z
			.uuid()
			.nullable()
			.describe("The labor line written at clock-out"),
		created_at: z.iso.datetime(),
	})
	.meta({ id: "VisitTimeEntry" });

for (const [action, from, to, extra] of [
	["start", "`OnSite`", "InProgress", ""],
	["pause", "`InProgress`", "Paused", ""],
	["resume", "`Paused`", "InProgress", ""],
	["complete", "`InProgress`, `Paused` or `OnSite`", "Completed", ""],
	[
		"delay",
		"`Scheduled`, `Driving` or `OnSite`",
		"Delayed",
		" Dispatchers only, and allowed with no technician assigned.",
	],
] as const) {
	const [summary, description] = lifecycle(action, from, to, extra);
	authed(
		"post",
		`/job-visits/{id}/${action}`,
		"Visits",
		visitVerbs.join(" or "),
		{
			summary,
			description,
			request: { params: visitIdParams },
			responses: {
				200: visitWithRelations,
				404: visitNotFound,
				409: transitionRefused,
			},
		},
		notAssigned("visit"),
	);
}

authed(
	"post",
	"/job-visits/{id}/transition",
	"Visits",
	"edit_jobs, update_visit_status, check_in or check_out",
	{
		summary: "Change a visit's status",
		description:
			"Requires any of `edit_jobs`, `update_visit_status`, `check_in` or `check_out`. One route for every lifecycle action: `drive` (Scheduled/Delayed → Driving), `arrive` (Driving → OnSite), `start`, `pause`, `resume`, `complete`, `delay` (same rules as their own routes). A technician who is already past the action on a shared visit just has their own status updated. `drive` and `arrive` are refused while the technician is clocked in (`CLOCKED_IN`).",
		request: {
			params: visitIdParams,
			body: {
				content: {
					"application/json": {
						schema: z.object({
							action: z.enum([
								"drive",
								"arrive",
								"start",
								"pause",
								"resume",
								"complete",
								"delay",
							]),
							pause_reason: pauseReason,
							tech_coords: coords
								.optional()
								.describe(
									"The technician's location, recorded with the change",
								),
						}),
						example: {
							action: "arrive",
							tech_coords: { lat: 43.81, lon: -91.23 },
						},
					},
				},
			},
		},
		responses: {
			200: visitWithRelations,
			400: json(
				errorEnvelope,
				"`action` missing or unknown (`VALIDATION_ERROR`)",
			),
			404: visitNotFound,
			409: transitionRefused,
		},
	},
	notAssigned("visit"),
);

authed(
	"post",
	"/job-visits/{id}/accept",
	"Visits",
	"edit_jobs or update_visit_status",
	{
		summary: "Assign a technician to a visit",
		description:
			"Requires `edit_jobs` or `update_visit_status`. Adds `tech_id` to the visit's technicians; already assigned is a no-op. Dispatchers can assign anyone. Technicians can only claim a visit for themselves, and only while it has no technician.",
		request: {
			params: visitIdParams,
			body: {
				content: {
					"application/json": {
						schema: z.object({ tech_id: z.uuid() }),
					},
				},
			},
		},
		responses: {
			200: visitWithRelations,
			400: json(errorEnvelope, "`tech_id` missing (`INVALID_INPUT`)"),
			404: json(
				errorEnvelope,
				"Visit or technician not found (`NOT_FOUND`)",
			),
			409: json(
				errorEnvelope,
				"The visit is `Completed` or `Cancelled`, or a technician is claiming a visit that already has someone (`CONFLICT`)",
			),
		},
	},
	"A technician sent another technician's `tech_id` (`FORBIDDEN`)",
);

authed(
	"post",
	"/job-visits/{id}/clock-in",
	"Visits",
	"check_in",
	{
		summary: "Clock a technician in",
		description:
			"Requires the `check_in` permission. Opens a time entry for `tech_id`, who must be assigned to the visit. The visit must be `OnSite`, `InProgress` or `Paused`; `OnSite` and `Paused` move to `InProgress`. Technicians can only clock themselves in.",
		request: {
			params: visitIdParams,
			body: {
				content: {
					"application/json": {
						schema: z.object({ tech_id: z.uuid() }),
					},
				},
			},
		},
		responses: {
			201: json(
				envelope(timeEntry.extend({ tech: idName })),
				"Clocked in",
			),
			400: json(
				errorEnvelope,
				"`tech_id` missing (`INVALID_INPUT`); or visit not found, not ready (`VISIT_NOT_READY: …`), or the technician isn't assigned (`VALIDATION_ERROR`)",
			),
			409: json(
				errorEnvelope,
				"The technician is already clocked in somewhere (`ALREADY_CLOCKED_IN:<visit id>`), or their timesheet week is locked (`CONFLICT`)",
			),
		},
	},
	"A technician sent another technician's `tech_id`, or isn't assigned to the visit (`FORBIDDEN`)",
);

authed(
	"post",
	"/job-visits/{id}/clock-out",
	"Visits",
	"check_out",
	{
		summary: "Clock a technician out",
		description:
			"Requires the `check_out` permission. Closes `tech_id`'s open time entry on the visit and records the labor. When the last technician clocks out, the visit moves to `Paused`. Technicians can only clock themselves out.",
		request: {
			params: visitIdParams,
			body: {
				content: {
					"application/json": {
						schema: z.object({
							tech_id: z.uuid(),
							pause_reason: pauseReason,
						}),
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(
					z.object({
						entry: timeEntry,
						line_item: z
							.record(z.string(), z.unknown())
							.nullable()
							.describe("The labor line written for this entry"),
						is_last_tech: z.boolean(),
						statusChangedToPaused: z.boolean(),
					}),
				),
				"Clocked out",
			),
			400: json(
				errorEnvelope,
				"`tech_id` missing (`INVALID_INPUT`); or no open clock-in for this technician on this visit, or technician not found (`VALIDATION_ERROR`)",
			),
		},
	},
	"A technician sent another technician's `tech_id`, or isn't assigned to the visit (`FORBIDDEN`)",
);

const partsUsedOffOrNotAssigned = `The \`vehicle_stock\` module is off or not in the plan (\`MODULE_DISABLED\`, \`MODULE_NOT_IN_PLAN\`); ${notAssigned("visit")}`;

authed(
	"post",
	"/job-visits/{id}/parts-used",
	"Visits",
	"edit_jobs or use_inventory",
	{
		summary: "Record a part used from a vehicle",
		description:
			"Requires `edit_jobs` or `use_inventory`. Takes the part off the vehicle's stock, adds it to the visit as a line item and recomputes the visit's totals. Serialized items need `serial_unit_ids`; batch-tracked items can name a `batch_id`.",
		request: {
			params: visitIdParams,
			body: {
				content: {
					"application/json": {
						schema: z
							.object({
								stock_item_id: z.uuid(),
								qty_used: z.number().positive(),
								technician_id: z
									.uuid()
									.describe("Who the usage is credited to"),
								serial_unit_ids: z.array(z.uuid()).optional(),
								batch_id: z.uuid().optional(),
							})
							.meta({ id: "AddPartsUsed" }),
					},
				},
			},
		},
		responses: {
			201: json(
				envelope(
					z.object({
						lineItem: z.record(z.string(), z.unknown()),
						usage: z.record(z.string(), z.unknown()),
					}),
				),
				"Part recorded",
			),
			400: json(
				errorEnvelope,
				"Validation failed, the visit is Completed, Cancelled or invoiced, or the update failed (`VALIDATION_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"Stock item, visit or technician not found (`NOT_FOUND`)",
			),
		},
	},
	partsUsedOffOrNotAssigned,
);

authed(
	"patch",
	"/job-visits/{id}/parts-used/{lineItemId}",
	"Visits",
	"edit_jobs or use_inventory",
	{
		summary: "Change a used part's quantity",
		description:
			"Requires `edit_jobs` or `use_inventory`. Sets the quantity of a part added through `parts-used`; the difference goes back to or comes off the same vehicle. `0` removes it. Not allowed on `Completed` or `Cancelled` visits, or once the visit is invoiced. The ledger records the caller; `technician_id` only sets who the part is credited to.",
		request: {
			params: visitIdParams.extend({ lineItemId: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: z
							.object({
								quantity: z.number().min(0),
								technician_id: z.uuid().optional(),
							})
							.meta({ id: "UpdatePartsUsed" }),
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(z.record(z.string(), z.unknown())),
				"The updated line item",
			),
			400: json(
				errorEnvelope,
				"Validation failed, the visit is Completed, Cancelled or invoiced, the line isn't linked to vehicle stock, or the update failed (`VALIDATION_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"Visit, line item or technician not found (`NOT_FOUND`)",
			),
		},
	},
	partsUsedOffOrNotAssigned,
);

authed(
	"get",
	"/job-visits/mine",
	"Visits",
	"view_assigned_jobs, view_visits or view_jobs",
	{
		summary: "List the caller's jobs",
		description:
			"Requires any of `view_assigned_jobs`, `view_visits` or `view_jobs`. One row per job the caller is assigned a non-cancelled visit on, with that job's most recent visit. Used to pick a job for a field purchase.",
		responses: {
			200: json(
				envelope(
					z.array(
						z.object({
							job_id: z.uuid(),
							job_name: z.string().nullable(),
							job_number: z.string().nullable(),
							visit_id: z.uuid(),
							visit_name: z.string(),
							scheduled_start_at: z.iso.datetime(),
						}),
					),
				),
				"Jobs (empty array if none)",
			),
		},
	},
);

authed(
	"get",
	"/job-visits/recent-status-events",
	"Visits",
	"view_jobs, view_visits or view_assigned_jobs",
	{
		summary: "List recent visit status changes",
		description:
			"Requires any of `view_jobs`, `view_visits` or `view_assigned_jobs`. Up to 9 visit status changes from the last 24 hours, newest first.",
		responses: {
			200: json(
				envelope(
					z.array(
						z.object({
							visitStatusChanged: z.literal(true),
							visitStatus: z.string(),
							previousVisitStatus: z.string().nullable(),
							actor: z
								.object({
									type: z.enum(["technician", "dispatcher"]),
									name: z.string().nullable(),
									id: z.string(),
								})
								.nullable(),
							changedAt: z.iso.datetime(),
							visit: z.object({
								id: z.uuid(),
								name: z.string(),
								scheduledAt: z.iso.datetime(),
								job: z.object({
									id: z.uuid(),
									client: z.object({ name: z.string() }),
								}),
							}),
						}),
					),
				),
				"Status changes (empty array if none)",
			),
		},
	},
);

authed(
	"get",
	"/job-visits/date-range/{startDate}/{endDate}",
	"Visits",
	"view_jobs, view_visits or view_assigned_jobs",
	{
		summary: "List visits in a date range",
		description:
			"Requires any of `view_jobs`, `view_visits` or `view_assigned_jobs`. Visits whose scheduled span overlaps the range (start before `endDate`, end after `startDate`), earliest first, with their job and line items. With only `view_assigned_jobs`, returns just the caller's visits.",
		request: {
			params: z.object({
				startDate: z
					.string()
					.describe("YYYY-MM-DD or any date `new Date()` accepts"),
				endDate: z.string(),
			}),
		},
		responses: {
			200: json(
				envelope(z.array(jobVisit)),
				"Visits (empty array if none)",
			),
			400: json(
				errorEnvelope,
				"A date couldn't be parsed (`INVALID_INPUT`)",
			),
		},
	},
);

const boardVisit = z
	.object({
		...jobVisit.pick({
			id: true,
			job_id: true,
			name: true,
			description: true,
			status: true,
			scheduled_start_at: true,
			scheduled_end_at: true,
			arrival_constraint: true,
			finish_constraint: true,
			arrival_time: true,
			arrival_window_start: true,
			arrival_window_end: true,
			finish_time: true,
			actual_start_at: true,
			actual_end_at: true,
			updated_at: true,
		}).shape,
		_count: z.object({ line_items: z.number().int() }),
		visit_techs: z.array(
			z.object({
				tech_id: z.uuid(),
				tech: z.object({ id: z.uuid(), name: z.string() }),
			}),
		),
		job: job
			.pick({
				id: true,
				job_number: true,
				name: true,
				description: true,
				status: true,
				priority: true,
				address: true,
				coords: true,
				recurring_plan_id: true,
			})
			.extend({ client: z.object({ id: z.uuid(), name: z.string() }) }),
	})
	.meta({ id: "BoardVisit" });

authed(
	"get",
	"/job-visits/board",
	"Visits",
	"view_jobs, view_visits or view_assigned_jobs",
	{
		summary: "List visits for the schedule board",
		description:
			"Requires any of `view_jobs`, `view_visits` or `view_assigned_jobs`. Slim visits whose scheduled span overlaps `[from, to)` (start before `to`, end after `from`), earliest first; no line items, notes, time entries or money fields. With only `view_assigned_jobs`, returns just the caller's visits; `techId` narrows further and never widens. `includeUnscheduled=1` adds up to 200 jobs with status `Unscheduled` and no visits, newest first; that list is empty without `view_jobs`. `occurrences` lists planned recurring slots in the range (same `view_jobs` gate). `meta.count` is the number of visits.",
		request: {
			query: z.object({
				from: z.iso.datetime().describe("Range start (inclusive)"),
				to: z.iso
					.datetime()
					.describe("Range end (exclusive); at most 62 days after `from`"),
				techId: z.uuid().optional().describe("Only visits this technician is on"),
				includeUnscheduled: z.enum(["0", "1", "true", "false"]).optional(),
			}),
		},
		responses: {
			200: json(
				envelope(
					z.object({
						visits: z.array(boardVisit),
						occurrences: z
							.array(
								z.object({
									id: z.uuid(),
									recurring_plan_id: z.uuid(),
									occurrence_start_at: z.iso.datetime(),
									occurrence_end_at: z.iso.datetime(),
									status: z.literal("planned"),
									arrival_constraint: z.string(),
									finish_constraint: z.string(),
									arrival_time: z.string().nullable(),
									arrival_window_start: z.string().nullable(),
									arrival_window_end: z.string().nullable(),
									finish_time: z.string().nullable(),
									job_visit_id: z.null(),
									recurring_plan: z.object({
										id: z.uuid(),
										name: z.string(),
										description: z.string(),
										address: z.string(),
										priority: z.string(),
										client: z.object({ id: z.uuid(), name: z.string() }),
										job_container: z
											.object({
												id: z.uuid(),
												job_number: z.string(),
												name: z.string(),
											})
											.nullable(),
									}),
								}),
							)
							.describe(
								"Planned, not-yet-generated recurring occurrences starting in `[from, to)`; empty without `view_jobs`",
							),
						unscheduledJobs: z
							.array(
								job
									.pick({
										id: true,
										job_number: true,
										name: true,
										priority: true,
										address: true,
									})
									.extend({
										client: z.object({ id: z.uuid(), name: z.string() }),
									}),
							)
							.optional()
							.describe("Present only with `includeUnscheduled`"),
					}),
				),
				"Visits in range (empty array if none)",
			),
			400: json(
				errorEnvelope,
				"`from`/`to` missing or unparseable, `to` not after `from`, the span over 62 days, or `techId` not a UUID (`INVALID_INPUT`)",
			),
		},
	},
);

const jobParams = z.object({ jobId: z.uuid() });
const jobNoteParams = jobParams.extend({ noteId: z.uuid() });
const jobVisitParams = jobParams.extend({ visitId: z.uuid() });

authed("post", "/jobs/{id}/tax-review/acknowledge", "Jobs", "edit_jobs", {
	summary: "Acknowledge a job's tax review",
	description:
		"Requires the `edit_jobs` permission. Clears a tax review flagged on the job (`tax_needs_review`) by recording who acknowledged it and when. Office users only.",
	request: { params: z.object({ id: z.uuid() }) },
	responses: {
		200: json(
			envelope(
				z.object({
					id: z.uuid(),
					tax_review_ack_by: z.uuid(),
					tax_review_ack_at: z.iso.datetime(),
				}),
			),
			"Acknowledged",
		),
		400: json(
			errorEnvelope,
			"The caller isn't an office user (`VALIDATION_ERROR`)",
		),
		404: json(errorEnvelope, "Job not found (`NOT_FOUND`)"),
		409: json(
			errorEnvelope,
			"The job has no tax review to acknowledge (`CONFLICT`)",
		),
	},
});

authed(
	"get",
	"/jobs/{jobId}/visits",
	"Jobs",
	"view_jobs or view_visits or view_assigned_jobs",
	{
		summary: "List a job's visits",
		description:
			"Requires any of `view_jobs`, `view_visits` or `view_assigned_jobs`. Earliest scheduled start first. Each visit also has `line_items` (with tax group and rates), `notes`, and `_count.invoice_visits` (invoices other than Draft or Void it is on); `visit_techs[].tech` is the full technician record. An unknown job returns an empty array.",
		request: { params: jobParams },
		responses: {
			200: json(
				envelope(
					z.array(
						jobVisit.extend({
							line_items: z.array(
								z.record(z.string(), z.unknown()),
							),
							notes: z.array(z.record(z.string(), z.unknown())),
							_count: z.object({ invoice_visits: z.number() }),
						}),
					),
				),
				"Visits (empty array if none)",
			),
		},
	},
	notAssigned("job"),
);

authed(
	"get",
	"/jobs/{jobId}/notes",
	"Jobs",
	"view_jobs or view_assigned_jobs or view_all_jobs",
	{
		summary: "List a job's notes",
		description:
			"Requires any of `view_jobs`, `view_assigned_jobs` or `view_all_jobs`. Newest first, including notes on its visits. An unknown job returns an empty array.",
		request: { params: jobParams },
		responses: {
			200: json(
				envelope(z.array(jobNote)),
				"Notes (empty array if none)",
			),
		},
	},
	notAssigned("job"),
);

authed(
	"get",
	"/jobs/{jobId}/visits/{visitId}/notes",
	"Jobs",
	"view_jobs or view_visits or view_assigned_jobs",
	{
		summary: "List a visit's notes",
		description:
			"Requires any of `view_jobs`, `view_visits` or `view_assigned_jobs`. Newest first. Only notes attached to this visit; an unknown job or visit, or a visit on another job, returns an empty array.",
		request: { params: jobVisitParams },
		responses: {
			200: json(
				envelope(z.array(jobNote)),
				"Notes (empty array if none)",
			),
		},
	},
	notAssigned("visit"),
);

authed(
	"put",
	"/jobs/{jobId}/notes/{noteId}",
	"Jobs",
	"edit_jobs or add_job_notes",
	{
		summary: "Update a job note",
		description:
			"Requires `edit_jobs` or `add_job_notes`. Any user with either permission can edit any note; the caller is recorded as the last editor. `visit_id: null` detaches the note from its visit. When `photos` is sent it replaces the list: photos with an `id` are kept, ones without are added, and missing ones are deleted.",
		request: {
			params: jobNoteParams,
			body: {
				content: {
					"application/json": {
						schema: updateJobNoteSchema.meta({
							id: "UpdateJobNote",
						}),
						example: { content: "Igniter replaced; tested twice." },
					},
				},
			},
		},
		responses: {
			200: json(envelope(jobNote), "Note updated"),
			400: json(
				errorEnvelope,
				"Validation failed, the visit isn't on this job, or the update failed (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Note or visit not found (`NOT_FOUND`)"),
		},
	},
	notAssigned("note's job"),
);

authed("delete", "/jobs/{jobId}/notes/{noteId}", "Jobs", "edit_jobs", {
	summary: "Delete a job note",
	description:
		"Requires the `edit_jobs` permission. Any user with the permission can delete any note. Its photos are deleted from storage too.",
	request: { params: jobNoteParams },
	responses: {
		200: json(envelope(z.object({ message: z.string() })), "Note deleted"),
		404: json(errorEnvelope, "Note not found on this job (`NOT_FOUND`)"),
	},
});

authed(
	"post",
	"/jobs/{jobId}/notes/upload-photo",
	"Jobs",
	"edit_jobs or add_job_notes",
	{
		summary: "Upload a note photo",
		description:
			"Requires `edit_jobs` or `add_job_notes`. Stores one image and returns its URLs; it isn't attached to anything until a note is created or updated with `raw_url` as a `photo_url`. JPEG, PNG or WebP, up to 5 MB. The job isn't checked.",
		request: {
			params: jobParams,
			body: {
				content: {
					"multipart/form-data": {
						schema: z.object({
							photo: z
								.string()
								.meta({ format: "binary" })
								.describe("The image file"),
						}),
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(
					z.object({
						url: z
							.string()
							.describe("Signed, short-lived URL for display"),
						raw_url: z
							.string()
							.describe("Storage URL to save on the note"),
					}),
				),
				"Uploaded",
			),
			400: json(
				errorEnvelope,
				"No `photo` file, or the file is over 5 MB (the message says 15MB) (`VALIDATION_ERROR`)",
			),
			500: json(
				errorEnvelope,
				"The file isn't JPEG, PNG or WebP, or the upload failed (`SERVER_ERROR`)",
			),
		},
	},
);

authed("get", "/jobs/{jobId}/changes", "Jobs", "view_jobs", {
	summary: "Get a job's history",
	description:
		"Requires the `view_jobs` permission. Activity on the job, its visits, line items and notes, and the quote and request it came from.",
	request: { params: jobParams, query: historyQuery },
	responses: historyResponses,
});

authed("get", "/arrivals", "Visits", "view_jobs", {
	summary: "Get live arrival forecasts",
	description:
		"Requires the `view_jobs` permission. For each technician heading to a visit: when they're due, when they're expected (`eta_at`), when they should leave, the delay, and whether they've arrived. Without filters, the dispatch board's window (visits around now, plus recent arrivals); `summary` counts them by status, latest first.",
	request: {
		query: z.object({
			visitId: z
				.uuid()
				.optional()
				.describe("Only this visit's technicians, at any time"),
			techId: z.uuid().optional(),
		}),
	},
	responses: {
		200: json(
			envelope(
				z.object({
					as_of: z.iso.datetime(),
					summary: z.object({
						late: z.number().int(),
						at_risk: z.number().int(),
						on_time: z.number().int(),
						unknown: z.number().int(),
						arrived: z.number().int(),
					}),
					arrivals: z.array(
						z
							.object({
								visit_id: z.uuid(),
								job_id: z.uuid(),
								tech_id: z.uuid(),
								tech_name: z.string(),
								status: z.enum([
									"late",
									"at_risk",
									"on_time",
									"unknown",
									"arrived",
								]),
								due_at: z.iso.datetime().nullable(),
								eta_at: z.iso.datetime().nullable(),
								leave_by_at: z.iso.datetime().nullable(),
								arrived_at: z.iso.datetime().nullable(),
								delay_minutes: z.number().int().nullable(),
								drive_minutes: z.number().int().nullable(),
								distance_miles: z.number().nullable(),
								stale: z
									.boolean()
									.describe(
										"The forecast hasn't been refreshed recently",
									),
							})
							.catchall(z.unknown()),
					),
				}),
			),
			"Arrivals",
		),
		400: json(
			errorEnvelope,
			"`visitId` or `techId` isn't a UUID (`VALIDATION_ERROR`)",
		),
	},
});
