import { ZodError } from "zod";
import {
	createRecurringPlanNoteSchema,
	updateRecurringPlanNoteSchema,
} from "../lib/validate/recurringPlans.js";
import { Request } from "express";
import { logActivity, buildChanges } from "../services/logger.js";
import { parentBreadcrumb } from "./logsController.js";
import { log } from "../services/appLogger.js";
import { getScopedDb, type UserContext } from "../lib/context.js";

// ============================================================================
// RECURRING PLAN NOTES CRUD
// ============================================================================

export const getRecurringPlanNotes = async (planId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.recurring_plan_note.findMany({
		where: { recurring_plan_id: planId },
		include: {
			creator_tech: { select: { id: true, name: true, email: true } },
			creator_dispatcher: { select: { id: true, name: true, email: true } },
			last_editor_tech: { select: { id: true, name: true, email: true } },
			last_editor_dispatcher: { select: { id: true, name: true, email: true } },
		},
		orderBy: { created_at: "desc" },
	});
};

export const getRecurringPlanNoteById = async (
	planId: string,
	noteId: string,
	organizationId: string,
) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.recurring_plan_note.findFirst({
		where: { id: noteId, recurring_plan_id: planId },
		include: {
			creator_tech: { select: { id: true, name: true, email: true } },
			creator_dispatcher: { select: { id: true, name: true, email: true } },
			last_editor_tech: { select: { id: true, name: true, email: true } },
			last_editor_dispatcher: { select: { id: true, name: true, email: true } },
		},
	});
};

export const insertRecurringPlanNote = async (
	req: Request,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const planId = req.params.jobId as string;
		const parsed = createRecurringPlanNoteSchema.parse(req.body);
		const sdb = getScopedDb(organizationId);

		const plan = await sdb.recurring_plan.findFirst({
			where: { job_container: { id: planId } },
		});

		if (!plan) {
			return { err: "Recurring plan not found" };
		}

		const created = await sdb.$transaction(async (tx) => {
			const note = await tx.recurring_plan_note.create({
				data: {
					recurring_plan_id: plan.id,
					organization_id: plan.organization_id,
					content: parsed.content,
					creator_tech_id: context?.techId || null,
					creator_dispatcher_id: context?.dispatcherId || null,
				},
				include: {
					creator_tech: { select: { id: true, name: true, email: true } },
					creator_dispatcher: { select: { id: true, name: true, email: true } },
				},
			});

			await logActivity({
				event_type: "recurring_plan_note.created",
				action: "created",
				entity_type: "recurring_plan_note",
				entity_id: note.id,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					content: { old: null, new: note.content },
					...parentBreadcrumb("recurring_plan", plan.id),
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			return note;
		});

		return { err: "", item: created };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues.map((err) => err.message).join(", ")}`,
			};
		}
		if (e instanceof Error) {
			return { err: e.message };
		}
		log.error({ err: e }, "Insert recurring plan note error");
		return { err: "Internal server error" };
	}
};

export const updateRecurringPlanNote = async (
	req: Request,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const jobId = req.params.jobId as string;
		const noteId = req.params.noteId as string;
		const parsed = updateRecurringPlanNoteSchema.parse(req.body);
		const sdb = getScopedDb(organizationId);

		const plan = await sdb.recurring_plan.findFirst({
			where: { job_container: { id: jobId } },
		});

		if (!plan) {
			return { err: "Recurring plan not found" };
		}

		const existing = await sdb.recurring_plan_note.findFirst({
			where: { id: noteId, recurring_plan_id: plan.id },
		});

		if (!existing) {
			return { err: "Note not found" };
		}

		const changes = buildChanges(existing, parsed, ["content"] as const);

		const updated = await sdb.$transaction(async (tx) => {
			const note = await tx.recurring_plan_note.update({
				where: { id: noteId },
				data: {
					...(parsed.content !== undefined && { content: parsed.content }),
					last_editor_tech_id: context?.techId || null,
					last_editor_dispatcher_id: context?.dispatcherId || null,
				},
				include: {
					creator_tech: { select: { id: true, name: true, email: true } },
					creator_dispatcher: { select: { id: true, name: true, email: true } },
					last_editor_tech: { select: { id: true, name: true, email: true } },
					last_editor_dispatcher: { select: { id: true, name: true, email: true } },
				},
			});

			if (Object.keys(changes).length > 0) {
				await logActivity({
					event_type: "recurring_plan_note.updated",
					action: "updated",
					entity_type: "recurring_plan_note",
					entity_id: noteId,
					organization_id: organizationId,
					actor_type: context?.techId
						? "technician"
						: context?.dispatcherId
							? "dispatcher"
							: "system",
					actor_id: context?.techId || context?.dispatcherId,
					changes: { ...changes, ...parentBreadcrumb("recurring_plan", plan.id) },
					ip_address: context?.ipAddress,
					user_agent: context?.userAgent,
				});
			}

			return note;
		});

		return { err: "", item: updated };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues.map((err) => err.message).join(", ")}`,
			};
		}
		log.error({ err: e }, "Update recurring plan note error");
		return { err: "Internal server error" };
	}
};

export const deleteRecurringPlanNote = async (
	jobId: string,
	noteId: string,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);

		const plan = await sdb.recurring_plan.findFirst({
			where: { job_container: { id: jobId } },
		});

		if (!plan) {
			return { err: "Recurring plan not found" };
		}

		const existing = await sdb.recurring_plan_note.findFirst({
			where: { id: noteId, recurring_plan_id: plan.id },
		});

		if (!existing) {
			return { err: "Note not found" };
		}

		await sdb.$transaction(async (tx) => {
			await logActivity({
				event_type: "recurring_plan_note.deleted",
				action: "deleted",
				entity_type: "recurring_plan_note",
				entity_id: noteId,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					content: { old: existing.content, new: null },
					...parentBreadcrumb("recurring_plan", plan.id),
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			await tx.recurring_plan_note.delete({ where: { id: noteId } });
		});

		return { err: "", message: "Note deleted successfully" };
	} catch (e) {
		log.error({ err: e }, "Delete recurring plan note error");
		return { err: "Internal server error" };
	}
};
