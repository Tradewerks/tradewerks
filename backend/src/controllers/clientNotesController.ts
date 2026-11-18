import { ZodError } from "zod";
import { getScopedDb, type UserContext } from "../lib/context.js";
import {
	createNoteSchema,
	updateNoteSchema,
} from "../lib/validate/clientNotes.js";
import { logActivity, buildChanges } from "../services/logger.js";
import { Prisma } from "../../generated/prisma/client.js";

export const getClientNotes = async (clientId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.client_note.findMany({
		where: { client_id: clientId },
		include: {
			creator_tech: {
				select: {
					id: true,
					name: true,
					email: true,
				},
			},
			creator_dispatcher: {
				select: {
					id: true,
					name: true,
					email: true,
				},
			},
			last_editor_tech: {
				select: {
					id: true,
					name: true,
					email: true,
				},
			},
			last_editor_dispatcher: {
				select: {
					id: true,
					name: true,
					email: true,
				},
			},
		},
		orderBy: { created_at: "desc" },
	});
};

export const getNoteById = async (clientId: string, noteId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.client_note.findFirst({
		where: {
			id: noteId,
			client_id: clientId,
		},
		include: {
			creator_tech: {
				select: {
					id: true,
					name: true,
					email: true,
				},
			},
			creator_dispatcher: {
				select: {
					id: true,
					name: true,
					email: true,
				},
			},
			last_editor_tech: {
				select: {
					id: true,
					name: true,
					email: true,
				},
			},
			last_editor_dispatcher: {
				select: {
					id: true,
					name: true,
					email: true,
				},
			},
		},
	});
};

export const insertNote = async (
	clientId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext
) => {
	try {
		const parsed = createNoteSchema.parse(data);

		const sdb = getScopedDb(organizationId);
		const client = await sdb.client.findFirst({ where: { id: clientId } });
		if (!client) {
			return { err: "Client not found" };
		}

		const created = await sdb.$transaction(async (tx) => {
			const note = await tx.client_note.create({
				data: {
					client_id: clientId,
					organization_id: organizationId,
					content: parsed.content,
					creator_tech_id: context?.techId || null,
					creator_dispatcher_id: context?.dispatcherId || null,
				},
			});

			await logActivity({
				event_type: "client_note.created",
				action: "created",
				entity_type: "client_note",
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
					client_id: { old: null, new: clientId },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			await tx.client.update({
				where: { id: clientId },
				data: { last_activity: new Date() },
			});

			return tx.client_note.findFirst({
				where: { id: note.id },
				include: {
					client: true,
					creator_tech: {
						select: {
							id: true,
							name: true,
							email: true,
						},
					},
					creator_dispatcher: {
						select: {
							id: true,
							name: true,
							email: true,
						},
					},
				},
			});
		});

		return { err: "", item: created };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		throw e;
	}
};

export const updateNote = async (
	clientId: string,
	noteId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext
) => {
	try {
		const parsed = updateNoteSchema.parse(data);

		const sdb = getScopedDb(organizationId);
		const existing = await sdb.client_note.findFirst({
			where: {
				id: noteId,
				client_id: clientId,
			},
			include: {
				client: true,
			},
		});

		if (!existing) {
			return { err: "Note not found" };
		}

		const changes = buildChanges(existing, parsed, ["content"] as const);

		const updated = await sdb.$transaction(async (tx) => {
			const updateData: Prisma.client_noteUpdateInput = {
				content: parsed.content,
				updated_at: new Date(),
			};

			if (context?.techId) {
				updateData.last_editor_tech = {
					connect: { id: context.techId },
				};
				updateData.last_editor_dispatcher = { disconnect: true };
			} else if (context?.dispatcherId) {
				updateData.last_editor_dispatcher = {
					connect: { id: context.dispatcherId },
				};
				updateData.last_editor_tech = { disconnect: true };
			}

			const note = await tx.client_note.update({
				where: { id: noteId },
				data: updateData,
				include: {
					client: true,
					creator_tech: {
						select: {
							id: true,
							name: true,
							email: true,
						},
					},
					creator_dispatcher: {
						select: {
							id: true,
							name: true,
							email: true,
						},
					},
					last_editor_tech: {
						select: {
							id: true,
							name: true,
							email: true,
						},
					},
					last_editor_dispatcher: {
						select: {
							id: true,
							name: true,
							email: true,
						},
					},
				},
			});

			if (Object.keys(changes).length > 0) {
				await logActivity({
					event_type: "client_note.updated",
					action: "updated",
					entity_type: "client_note",
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

			await tx.client.update({
				where: { id: clientId },
				data: { last_activity: new Date() },
			});

			return note;
		});

		return { err: "", item: updated };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		throw e;
	}
};

export const deleteNote = async (
	clientId: string,
	noteId: string,
	organizationId: string,
	context?: UserContext
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.client_note.findFirst({
			where: {
				id: noteId,
				client_id: clientId,
			},
			include: {
				client: true,
			},
		});

		if (!existing) {
			return { err: "Note not found" };
		}

		await sdb.$transaction(async (tx) => {
			await logActivity({
				event_type: "client_note.deleted",
				action: "deleted",
				entity_type: "client_note",
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
					client_id: { old: existing.client_id, new: null },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			await tx.client_note.delete({
				where: { id: noteId },
			});
		});

		return { err: "", message: "Note deleted successfully" };
	} catch (error) {
		throw error;
	}
};
