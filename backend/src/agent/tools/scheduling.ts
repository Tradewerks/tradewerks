/**
 * Scheduling writes: the tools that change live dispatch state.
 *
 * These are the exception to draft-first. Creating a quote through a draft costs
 * a dispatcher one click and gains a review step worth having. Moving a visit
 * through a draft gains nothing — the dispatcher would be re-entering the change
 * they just described — so these act directly and every one of them requires an
 * explicit human approval instead. The approval is not a formality: the executor
 * refuses to run them without it, and the panel shows the exact arguments.
 *
 * All of them route through the domain controllers, which is where the status
 * guards, conflict checks, socket emissions and activity logging live.
 */

import { z } from "zod";
import {
	assignTechniciansToVisit,
	insertJobVisit,
	updateJobVisit,
} from "../../controllers/jobVisitsController.js";
import { updateJob } from "../../controllers/jobsController.js";
import { insertJobNote } from "../../controllers/jobNotesController.js";
import { requestFor, unwrap, userContextFor, type ControllerOutcome } from "../controllerBridge.js";
import { defineTool } from "../registry.js";

const isoDateTime = z
	.string()
	.refine((v) => !Number.isNaN(Date.parse(v)), "Expected an ISO 8601 datetime")
	.describe("ISO 8601 datetime, e.g. 2026-08-25T14:00:00Z.");

/** Both writes and reads of a visit accept the same arrival/finish vocabulary. */
const arrivalConstraint = z.enum(["anytime", "at", "between", "by"]);
const finishConstraint = z.enum(["when_done", "at", "by"]);
const clockTime = z.string().regex(/^\d{2}:\d{2}$/, "Time must be HH:MM");

export const scheduleVisit = defineTool({
	name: "schedule_visit",
	title: "Schedule a visit",
	description:
		"Put a new visit on the calendar for an existing job, optionally assigning technicians. Needs the job's id — " +
		"use search_records to find it. Check get_technician_availability first if you are assigning anyone; this " +
		"tool will not tell you about a clash it did not cause. A person must approve before it takes effect.",
	risk: "write",
	requiresApproval: true,
	permissions: ["edit_jobs", "create_jobs"],
	input: z.object({
		job_id: z.string().uuid().describe("The job this visit belongs to."),
		name: z.string().min(1).max(255).describe("Short label, e.g. “Spring maintenance — first visit”."),
		description: z.string().nullish(),
		scheduled_start_at: isoDateTime,
		scheduled_end_at: isoDateTime,
		arrival_constraint: arrivalConstraint.default("anytime").describe("How firm the arrival time is."),
		finish_constraint: finishConstraint.default("when_done"),
		arrival_time: clockTime.nullish().describe('Required when arrival_constraint is "at".'),
		arrival_window_start: clockTime.nullish().describe('Required when arrival_constraint is "between".'),
		arrival_window_end: clockTime.nullish().describe('Required when arrival_constraint is "between" or "by".'),
		finish_time: clockTime.nullish().describe('Required when finish_constraint is "at" or "by".'),
		tech_ids: z.array(z.string().uuid()).default([]).describe("Technicians to assign. May be empty."),
	}),
	audit: (input, result) => ({
		event_type: "job_visit.created",
		action: "created",
		entity_type: "job_visit",
		entity_id: (result as { id?: string })?.id ?? input.job_id,
		reason: "Scheduled by the assistant with human approval",
	}),
	invalidates: (input) => ["jobs", "visits", `job:${input.job_id}`, "schedule"],
	async handler({ input, ctx }) {
		const outcome = (await insertJobVisit(
			requestFor(ctx, input),
			ctx.organizationId,
			userContextFor(ctx),
		)) as ControllerOutcome<{ id: string; scheduled_start_at: Date; status: string }>;

		const visit = unwrap(outcome, "Scheduling the visit");
		return {
			id: visit.id,
			job_id: input.job_id,
			status: visit.status,
			scheduled_start_at: visit.scheduled_start_at,
			assigned: input.tech_ids.length,
		};
	},
});

export const rescheduleVisit = defineTool({
	name: "reschedule_visit",
	title: "Reschedule a visit",
	description:
		"Move an existing visit to a new time. Supply only what changes — omitted fields are left alone. Use " +
		"get_schedule or search_records to find the visit id first. A person must approve before it takes effect.",
	risk: "write",
	requiresApproval: true,
	permissions: ["edit_jobs"],
	input: z
		.object({
			visit_id: z.string().uuid(),
			scheduled_start_at: isoDateTime.optional(),
			scheduled_end_at: isoDateTime.optional(),
			arrival_constraint: arrivalConstraint.optional(),
			finish_constraint: finishConstraint.optional(),
			arrival_time: clockTime.nullish(),
			arrival_window_start: clockTime.nullish(),
			arrival_window_end: clockTime.nullish(),
			finish_time: clockTime.nullish(),
			name: z.string().min(1).max(255).optional(),
			description: z.string().nullish(),
		})
		.refine(
			(v) => Object.keys(v).some((k) => k !== "visit_id" && v[k as keyof typeof v] !== undefined),
			"Nothing to change: supply at least one field besides visit_id",
		),
	audit: (input) => ({
		event_type: "job_visit.updated",
		action: "updated",
		entity_type: "job_visit",
		entity_id: input.visit_id,
		reason: "Rescheduled by the assistant with human approval",
	}),
	invalidates: (input) => ["jobs", "visits", `visit:${input.visit_id}`, "schedule"],
	async handler({ input, ctx }) {
		const { visit_id, ...changes } = input;
		const outcome = (await updateJobVisit(
			requestFor(ctx, changes, { id: visit_id }),
			ctx.organizationId,
			userContextFor(ctx),
		)) as ControllerOutcome<{ id: string; scheduled_start_at: Date; scheduled_end_at: Date; status: string }>;

		const visit = unwrap(outcome, "Rescheduling the visit");
		return {
			id: visit.id,
			status: visit.status,
			scheduled_start_at: visit.scheduled_start_at,
			scheduled_end_at: visit.scheduled_end_at,
		};
	},
});

export const assignTechnician = defineTool({
	name: "assign_technician",
	title: "Assign technicians to a visit",
	description:
		"Set which technicians are on a visit. This REPLACES the current assignment rather than adding to it — to " +
		"add someone, read the visit first and send the full list. Check get_technician_availability before " +
		"assigning. A person must approve before it takes effect.",
	risk: "write",
	requiresApproval: true,
	permissions: ["edit_jobs"],
	input: z.object({
		visit_id: z.string().uuid(),
		tech_ids: z
			.array(z.string().uuid())
			.describe("The complete set of technicians for this visit. An empty array unassigns everyone."),
	}),
	audit: (input) => ({
		event_type: "job_visit.technicians_assigned",
		action: "updated",
		entity_type: "job_visit",
		entity_id: input.visit_id,
		reason: "Assigned by the assistant with human approval",
	}),
	invalidates: (input) => ["jobs", "visits", `visit:${input.visit_id}`, "schedule", "technicians"],
	async handler({ input, ctx }) {
		const outcome = (await assignTechniciansToVisit(
			input.visit_id,
			input.tech_ids,
			ctx.organizationId,
			userContextFor(ctx),
		)) as ControllerOutcome<{ id: string }>;

		unwrap(outcome, "Assigning technicians");
		return { visit_id: input.visit_id, assigned: input.tech_ids.length };
	},
});

export const updateJobStatus = defineTool({
	name: "update_job_status",
	title: "Change a job's status",
	description:
		"Move a job to a different status. Transitions are validated server-side — an invalid one is refused with " +
		"an explanation rather than silently applied. Cancelling requires a reason. A person must approve first.",
	risk: "write",
	requiresApproval: true,
	permissions: ["edit_jobs", "update_job_status"],
	input: z
		.object({
			job_id: z.string().uuid(),
			status: z.enum(["Unscheduled", "Scheduled", "InProgress", "Completed", "Cancelled"]),
			cancellation_reason: z.string().min(1).optional().describe("Required when cancelling."),
		})
		.refine(
			(v) => v.status !== "Cancelled" || !!v.cancellation_reason,
			{ message: "cancellation_reason is required when cancelling a job", path: ["cancellation_reason"] },
		),
	audit: (input) => ({
		event_type: "job.status_changed",
		action: "updated",
		entity_type: "job",
		entity_id: input.job_id,
		reason: `Status set to ${input.status} by the assistant with human approval`,
	}),
	invalidates: (input) => ["jobs", `job:${input.job_id}`],
	async handler({ input, ctx }) {
		const { job_id, ...changes } = input;
		const outcome = (await updateJob(
			requestFor(ctx, changes, { id: job_id }),
			ctx.organizationId,
			userContextFor(ctx),
		)) as ControllerOutcome<{ id: string; status: string; job_number: string }>;

		const job = unwrap(outcome, "Updating the job");
		return { id: job.id, job_number: job.job_number, status: job.status };
	},
});

export const addJobNote = defineTool({
	name: "add_job_note",
	title: "Add a note to a job",
	description:
		"Record an internal note on a job — what a caller said, what was decided, what to watch for. Notes are " +
		"internal to the team and are not sent to the client. Optionally notify the assigned technician.",
	risk: "write",
	// Additive, internal, and reversible by any dispatcher; the audit row names
	// the assistant. Gating every note would make the assistant tedious for the
	// one write it is most obviously useful for.
	requiresApproval: false,
	permissions: ["edit_jobs", "add_job_notes"],
	input: z.object({
		job_id: z.string().uuid(),
		content: z.string().min(1).max(4000),
		visit_id: z.string().uuid().nullish().describe("Attach the note to one visit rather than the job as a whole."),
		notify_technician: z.boolean().default(false),
	}),
	audit: (input, result) => ({
		event_type: "job_note.created",
		action: "created",
		entity_type: "job_note",
		entity_id: (result as { id?: string })?.id ?? input.job_id,
		reason: "Note added by the assistant",
	}),
	invalidates: (input) => [`job:${input.job_id}`, "jobs"],
	async handler({ input, ctx }) {
		const outcome = (await insertJobNote(
			input.job_id,
			{
				content: input.content,
				visit_id: input.visit_id ?? null,
				notify_technician: input.notify_technician,
				photos: [],
			},
			ctx.organizationId,
			userContextFor(ctx),
		)) as ControllerOutcome<{ id: string; content: string }>;

		const note = unwrap(outcome, "Adding the note");
		return { id: note.id, job_id: input.job_id };
	},
});
