import { ZodError } from "zod";
import { getScopedDb, type UserContext } from "../lib/context.js";
import {
	createProjectNoteSchema,
	updateProjectNoteSchema,
} from "../lib/validate/projects.js";
import { logActivity, buildChanges } from "../services/logger.js";
import { parentBreadcrumb } from "./logsController.js";
import { Prisma } from "../../generated/prisma/client.js";
import { log } from "../services/appLogger.js";
import { signImageUrl, deleteFile } from "../services/wasabiService.js";

type NoteLike = { photos?: { photo_url: string }[] | null } | null | undefined;

async function signNotePhotos<T extends NoteLike>(note: T): Promise<T> {
	if (!note || !note.photos || note.photos.length === 0) return note;
	const photos = await Promise.all(
		note.photos.map(async (p) => ({
			...p,
			photo_url: (await signImageUrl(p.photo_url)) ?? p.photo_url,
		})),
	);
	return { ...note, photos } as T;
}

async function signNotePhotosMany<T extends NoteLike>(notes: T[]): Promise<T[]> {
	return Promise.all(notes.map((n) => signNotePhotos(n)));
}

const noteInclude = {
	creator_tech: { select: { id: true, name: true, email: true } },
	creator_dispatcher: { select: { id: true, name: true, email: true } },
	last_editor_tech: { select: { id: true, name: true, email: true } },
	last_editor_dispatcher: { select: { id: true, name: true, email: true } },
	photos: { orderBy: { created_at: "asc" as const } },
};

export const getProjectNotes = async (projectId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const notes = await sdb.project_note.findMany({
		where: { project_id: projectId },
		include: noteInclude,
		orderBy: { created_at: "desc" },
	});
	return await signNotePhotosMany(notes);
};

export const getNoteById = async (projectId: string, noteId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const note = await sdb.project_note.findFirst({
		where: { id: noteId, project_id: projectId },
		include: noteInclude,
	});
	return await signNotePhotos(note);
};

export const insertProjectNote = async (
	projectId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = createProjectNoteSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const project = await sdb.project.findFirst({ where: { id: projectId } });
		if (!project) {
			return { err: "Project not found" };
		}

		const created = await sdb.$transaction(async (tx) => {
			const noteData: Prisma.project_noteCreateInput = {
				project: { connect: { id: projectId } },
				organization: { connect: { id: organizationId } },
				content: parsed.content,
				notify_technician: parsed.notify_technician,
				...(context?.techId && {
					creator_tech: { connect: { id: context.techId } },
				}),
				...(context?.dispatcherId && {
					creator_dispatcher: { connect: { id: context.dispatcherId } },
				}),
			};

			const note = await tx.project_note.create({ data: noteData });

			if (parsed.photos.length > 0) {
				await tx.project_note_photo.createMany({
					data: parsed.photos.map((p) => ({
						note_id: note.id,
						photo_url: p.photo_url,
						photo_label: p.photo_label,
					})),
				});
			}

			await logActivity({
				event_type: "project_note.created",
				action: "created",
				entity_type: "project_note",
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
					...parentBreadcrumb("project", projectId),
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			return await tx.project_note.findFirst({
				where: { id: note.id },
				include: noteInclude,
			});
		});

		if (!created) return { err: "Failed to create note" };
		const signed = await signNotePhotos(created);
		return { err: "", item: signed };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues.map((err) => err.message).join(", ")}`,
			};
		}
		log.error({ err: e }, "Error inserting project note");
		return { err: "Internal server error" };
	}
};

export const updateProjectNote = async (
	projectId: string,
	noteId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updateProjectNoteSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const existing = await sdb.project_note.findFirst({
			where: { id: noteId, project_id: projectId },
		});

		if (!existing) {
			return { err: "Note not found" };
		}

		const changes = buildChanges(existing, parsed, ["content"] as const);

		const removedPhotoUrls: string[] = [];
		const updated = await sdb.$transaction(async (tx) => {
			const updateData: Prisma.project_noteUpdateInput = {
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

			await tx.project_note.update({
				where: { id: noteId },
				data: updateData,
			});

			if (parsed.photos !== undefined) {
				const existingPhotos = await tx.project_note_photo.findMany({
					where: { note_id: noteId },
					select: { id: true, photo_url: true },
				});
				const incomingPhotos = new Set(parsed.photos.filter((p) => p.id).map((p) => p.id!));
				const photosToDelete = existingPhotos.filter((p) => !incomingPhotos.has(p.id));
				if (photosToDelete.length > 0) {
					await tx.project_note_photo.deleteMany({
						where: { id: { in: photosToDelete.map((p) => p.id) } },
					});
					removedPhotoUrls.push(...photosToDelete.map((p) => p.photo_url));
				}

				const photosToCreate = parsed.photos.filter((p) => !p.id);
				if (photosToCreate.length > 0) {
					await tx.project_note_photo.createMany({
						data: photosToCreate.map((p) => ({
							note_id: noteId,
							photo_url: p.photo_url,
							photo_label: p.photo_label,
						})),
					});
				}
			}

			if (Object.keys(changes).length > 0) {
				await logActivity({
					event_type: "project_note.updated",
					action: "updated",
					entity_type: "project_note",
					entity_id: noteId,
					organization_id: organizationId,
					actor_type: context?.techId
						? "technician"
						: context?.dispatcherId
							? "dispatcher"
							: "system",
					actor_id: context?.techId || context?.dispatcherId,
					changes: { ...changes, ...parentBreadcrumb("project", projectId) },
					ip_address: context?.ipAddress,
					user_agent: context?.userAgent,
				});
			}

			return await tx.project_note.findFirst({
				where: { id: noteId },
				include: noteInclude,
			});
		});

		if (!updated) return { err: "Failed to update note" };
		for (const url of removedPhotoUrls) {
			deleteFile(url).catch((err) =>
				log.warn({ err, url, noteId }, "Failed to delete removed project note photo from storage"),
			);
		}
		const signed = await signNotePhotos(updated);
		return { err: "", item: signed };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues.map((err) => err.message).join(", ")}`,
			};
		}
		log.error({ err: e }, "Error updating project note");
		return { err: "Internal server error" };
	}
};

export const deleteProjectNote = async (
	projectId: string,
	noteId: string,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.project_note.findFirst({
			where: { id: noteId, project_id: projectId },
		});

		if (!existing) {
			return { err: "Note not found" };
		}

		await sdb.$transaction(async (tx) => {
			await logActivity({
				event_type: "project_note.deleted",
				action: "deleted",
				entity_type: "project_note",
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
					...parentBreadcrumb("project", projectId),
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			await tx.project_note.delete({ where: { id: noteId } });
		});

		return { err: "", message: "Note deleted successfully" };
	} catch (error) {
		log.error({ err: error }, "Error deleting project note");
		return { err: "Internal server error" };
	}
};
