import { ZodError } from "zod";
import {
	createRequestNoteSchema,
	updateRequestNoteSchema,
} from "../lib/validate/requests.js";
import { logActivity, buildChanges } from "../services/logger.js";
import { Prisma } from "../../generated/prisma/client.js";
import { log } from "../services/appLogger.js";
import { getScopedDb, type UserContext } from "../lib/context.js";

export const getRequestNotes = async (requestId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.request_note.findMany({
		where: { request_id: requestId },
		include: {
			creator_tech: { select: { id: true, name: true, email: true } },
			creator_dispatcher: { select: { id: true, name: true, email: true } },
			last_editor_tech: { select: { id: true, name: true, email: true } },
			last_editor_dispatcher: { select: { id: true, name: true, email: true } },
		},
		orderBy: { created_at: "desc" },
	});
};

export const getNoteById = async (requestId: string, noteId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.request_note.findFirst({
		where: { id: noteId, request_id: requestId },
		include: {
			creator_tech: { select: { id: true, name: true, email: true } },
			creator_dispatcher: { select: { id: true, name: true, email: true } },
			last_editor_tech: { select: { id: true, name: true, email: true } },
			last_editor_dispatcher: { select: { id: true, name: true, email: true } },
		},
	});
};

export const insertRequestNote = async (
	requestId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = createRequestNoteSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const request = await sdb.request.findFirst({ where: { id: requestId } });
		if (!request) {
			return { err: "Request not found" };
		}

		const created = await sdb.$transaction(async (tx) => {
			const noteData: Prisma.request_noteCreateInput = {
				request: { connect: { id: requestId } },
				organization: { connect: { id: organizationId } },
				content: parsed.content,
				...(context?.techId && {
					creator_tech: { connect: { id: context.techId } },
				}),
				...(context?.dispatcherId && {
					creator_dispatcher: { connect: { id: context.dispatcherId } },
				}),
			};

			const note = await tx.request_note.create({
				data: noteData,
				include: {
					creator_tech: { select: { id: true, name: true, email: true } },
					creator_dispatcher: { select: { id: true, name: true, email: true } },
				},
			});

			await logActivity({
				event_type: "request_note.created",
				action: "created",
				entity_type: "request_note",
				entity_id: note.id,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
					? "dispatcher"
					: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					content: { old: null, new: parsed.content },
					request_id: { old: null, new: requestId },
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
		log.error({ err: e }, "Error inserting request note");
		return { err: "Internal server error" };
	}
};

export const updateRequestNote = async (
	requestId: string,
	noteId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updateRequestNoteSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const existing = await sdb.request_note.findFirst({
			where: { id: noteId, request_id: requestId },
		});

		if (!existing) {
			return { err: "Note not found" };
		}

		const changes = buildChanges(existing, parsed, ["content"] as const);

		const updated = await sdb.$transaction(async (tx) => {
			const updateData: Prisma.request_noteUpdateInput = {
				updated_at: new Date(),
			};

			if (parsed.content !== undefined) {
				updateData.content = parsed.content;
			}

			if (context?.techId) {
				updateData.last_editor_tech = { connect: { id: context.techId } };
				updateData.last_editor_dispatcher = { disconnect: true };
			} else if (context?.dispatcherId) {
				updateData.last_editor_dispatcher = { connect: { id: context.dispatcherId } };
				updateData.last_editor_tech = { disconnect: true };
			}

			const note = await tx.request_note.update({
				where: { id: noteId },
				data: updateData,
				include: {
					creator_tech: { select: { id: true, name: true, email: true } },
					creator_dispatcher: { select: { id: true, name: true, email: true } },
					last_editor_tech: { select: { id: true, name: true, email: true } },
					last_editor_dispatcher: { select: { id: true, name: true, email: true } },
				},
			});

			if (Object.keys(changes).length > 0) {
				await logActivity({
					event_type: "request_note.updated",
					action: "updated",
					entity_type: "request_note",
					entity_id: noteId,
					organization_id: organizationId,
					actor_type: context?.techId
						? "technician"
						: context?.dispatcherId
						? "dispatcher"
						: "system",
					actor_id: context?.techId || context?.dispatcherId,
					changes,
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
		log.error({ err: e }, "Error updating request note");
		return { err: "Internal server error" };
	}
};

export const deleteRequestNote = async (
	requestId: string,
	noteId: string,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.request_note.findFirst({
			where: { id: noteId, request_id: requestId },
		});

		if (!existing) {
			return { err: "Note not found" };
		}

		await sdb.$transaction(async (tx) => {
			await logActivity({
				event_type: "request_note.deleted",
				action: "deleted",
				entity_type: "request_note",
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
					request_id: { old: existing.request_id, new: null },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			await tx.request_note.delete({ where: { id: noteId } });
		});

		return { err: "", message: "Note deleted successfully" };
	} catch (error) {
		log.error({ err: error }, "Error deleting request note");
		return { err: "Internal server error" };
	}
};
