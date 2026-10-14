import { ZodError } from "zod";
import {
	createQuoteNoteSchema,
	updateQuoteNoteSchema,
} from "../lib/validate/quotes.js";
import { logActivity, buildChanges } from "../services/logger.js";
import { Prisma } from "../../generated/prisma/client.js";
import { log } from "../services/appLogger.js";
import { getScopedDb, type UserContext } from "../lib/context.js";

export const getQuoteNotes = async (quoteId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.quote_note.findMany({
		where: { quote_id: quoteId },
		include: {
			creator_tech: { select: { id: true, name: true, email: true } },
			creator_dispatcher: { select: { id: true, name: true, email: true } },
			last_editor_tech: { select: { id: true, name: true, email: true } },
			last_editor_dispatcher: { select: { id: true, name: true, email: true } },
		},
		orderBy: { created_at: "desc" },
	});
};

export const getNoteById = async (quoteId: string, noteId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.quote_note.findFirst({
		where: { id: noteId, quote_id: quoteId },
		include: {
			creator_tech: { select: { id: true, name: true, email: true } },
			creator_dispatcher: { select: { id: true, name: true, email: true } },
			last_editor_tech: { select: { id: true, name: true, email: true } },
			last_editor_dispatcher: { select: { id: true, name: true, email: true } },
		},
	});
};

export const insertQuoteNote = async (
	quoteId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = createQuoteNoteSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const quote = await sdb.quote.findFirst({ where: { id: quoteId } });
		if (!quote) {
			return { err: "Quote not found" };
		}

		const created = await sdb.$transaction(async (tx) => {
			const noteData: Prisma.quote_noteCreateInput = {
				quote: { connect: { id: quoteId } },
				organization: { connect: { id: organizationId } },
				content: parsed.content,
				...(context?.techId && {
					creator_tech: { connect: { id: context.techId } },
				}),
				...(context?.dispatcherId && {
					creator_dispatcher: { connect: { id: context.dispatcherId } },
				}),
			};

			const note = await tx.quote_note.create({
				data: noteData,
				include: {
					creator_tech: { select: { id: true, name: true, email: true } },
					creator_dispatcher: { select: { id: true, name: true, email: true } },
				},
			});

			await logActivity({
				event_type: "quote_note.created",
				action: "created",
				entity_type: "quote_note",
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
					quote_id: { old: null, new: quoteId },
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
		log.error({ err: e }, "Error inserting quote note");
		return { err: "Internal server error" };
	}
};

export const updateQuoteNote = async (
	quoteId: string,
	noteId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updateQuoteNoteSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const existing = await sdb.quote_note.findFirst({
			where: { id: noteId, quote_id: quoteId },
		});

		if (!existing) {
			return { err: "Note not found" };
		}

		const changes = buildChanges(existing, parsed, ["content"] as const);

		const updated = await sdb.$transaction(async (tx) => {
			const updateData: Prisma.quote_noteUpdateInput = {
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

			const note = await tx.quote_note.update({
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
					event_type: "quote_note.updated",
					action: "updated",
					entity_type: "quote_note",
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
		log.error({ err: e }, "Error updating quote note");
		return { err: "Internal server error" };
	}
};

export const deleteQuoteNote = async (
	quoteId: string,
	noteId: string,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.quote_note.findFirst({
			where: { id: noteId, quote_id: quoteId },
		});

		if (!existing) {
			return { err: "Note not found" };
		}

		await sdb.$transaction(async (tx) => {
			await logActivity({
				event_type: "quote_note.deleted",
				action: "deleted",
				entity_type: "quote_note",
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
					quote_id: { old: existing.quote_id, new: null },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			await tx.quote_note.delete({ where: { id: noteId } });
		});

		return { err: "", message: "Note deleted successfully" };
	} catch (error) {
		log.error({ err: error }, "Error deleting quote note");
		return { err: "Internal server error" };
	}
};
