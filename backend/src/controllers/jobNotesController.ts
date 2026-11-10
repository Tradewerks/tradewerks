import { ZodError } from "zod";
import { getScopedDb, type UserContext } from "../lib/context.js";
import {
	createJobNoteSchema,
	updateJobNoteSchema,
} from "../lib/validate/jobs.js";
import { logActivity, buildChanges } from "../services/logger.js";
import { parentBreadcrumb } from "./logsController.js";
import { Prisma } from "../../generated/prisma/client.js";
import { log } from "../services/appLogger.js";
import { createNotification, notifyDispatchers } from "./notificationsController.js";
import { emitToOrg } from "../services/socketService.js";
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
	visit: {
		select: {
			id: true,
			scheduled_start_at: true,
			scheduled_end_at: true,
			status: true,
		},
	},
	photos: { orderBy: { created_at: "asc" as const } },
};

export const getJobNotes = async (jobId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const notes = await sdb.job_note.findMany({
		where: { job_id: jobId },
		include: noteInclude,
		orderBy: { created_at: "desc" },
	});
	return await signNotePhotosMany(notes);
};

export const getJobNotesByVisitId = async (jobId: string, visitId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const notes = await sdb.job_note.findMany({
		where: {
			job_id: jobId,
			visit_id: visitId,
		},
		include: noteInclude,
		orderBy: { created_at: "desc" },
	});
	return await signNotePhotosMany(notes);
};

export const getNoteById = async (jobId: string, noteId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const note = await sdb.job_note.findFirst({
		where: {
			id: noteId,
			job_id: jobId,
		},
		include: noteInclude,
	});
	return await signNotePhotos(note);
};

export const insertJobNote = async (
	jobId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = createJobNoteSchema.parse(data);

		const sdb = getScopedDb(organizationId);
		const job = await sdb.job.findFirst({
			where: { id: jobId },
			select: { id: true, organization_id: true },
		});

		if (!job) {
			return { err: "Job not found" };
		}

		if (parsed.visit_id) {
			const visit = await sdb.job_visit.findUnique({
				where: { id: parsed.visit_id },
			});

			if (!visit) {
				return { err: "Visit not found" };
			}

			if (visit.job_id !== jobId) {
				return { err: "Visit does not belong to this job" };
			}
		}

		const created = await sdb.$transaction(async (tx) => {
			const noteData: Prisma.job_noteCreateInput = {
				job: { connect: { id: jobId } },
				content: parsed.content,
				notify_technician: parsed.notify_technician,
				...(job.organization_id && {
					organization: { connect: { id: job.organization_id } },
				}),
				...(parsed.visit_id && {
					visit: { connect: { id: parsed.visit_id } },
				}),
				...(context?.techId && {
					creator_tech: { connect: { id: context.techId } },
				}),
				...(context?.dispatcherId && {
					creator_dispatcher: {
						connect: { id: context.dispatcherId },
					},
				}),
			};

			const note = await tx.job_note.create({ data: noteData });

			if (parsed.photos.length > 0) {
				await tx.job_note_photo.createMany({
					data: parsed.photos.map((p) => ({
						note_id: note.id,
						photo_url: p.photo_url,
						photo_label: p.photo_label,
						photo_name: p.photo_name || null,
					})),
				});
			}

			await logActivity({
				event_type: "job_note.created",
				action: "created",
				entity_type: "job_note",
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
					visit_id: { old: null, new: parsed.visit_id || null },
					...parentBreadcrumb("job", jobId),
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			return await tx.job_note.findFirst({
				where: { id: note.id },
				include: noteInclude,
			});
		});

		if (!created) return { err: "Failed to create note" };
		const signed = await signNotePhotos(created);

		// Notify assigned technicians if dispatcher flagged the note
		if (parsed.notify_technician && created.visit_id) {
			const visitTechs = await sdb.job_visit_technician.findMany({
				where: { visit_id: created.visit_id },
				select: { tech_id: true },
			});
			const jobName = (await sdb.job.findFirst({
				where: { id: jobId },
				select: { job_number: true },
			}))?.job_number ?? "a job";
			for (const { tech_id } of visitTechs) {
				await createNotification({
					technicianId: tech_id,
					type:         "note_added",
					title:        `Note added: Job #${jobName}`,
					body:         parsed.content.slice(0, 200),
					actionUrl:    `/technician/visits/${created.visit_id}`,
				}, organizationId);
			}
		}

		if (context?.techId) {
			const job = await sdb.job.findFirst({ where: { id: jobId }, select: { job_number: true } });
			notifyDispatchers({
				type: "tech_note_added",
				title: `Technician note on Job ${job?.job_number ?? ""}`.trim(),
				body: parsed.content.slice(0, 200),
				actionUrl: `/dispatch/jobs/${jobId}`,
			}, organizationId).catch(() => {});
		}

		emitToOrg(organizationId, "job_note:created", { organizationId });
		return { err: "", item: signed };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		log.error({ err: e }, "Error inserting job note");
		return { err: "Internal server error" };
	}
};

export const updateJobNote = async (
	jobId: string,
	noteId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updateJobNoteSchema.parse(data);

		const sdb = getScopedDb(organizationId);
		const existing = await sdb.job_note.findFirst({
			where: {
				id: noteId,
				job_id: jobId,
			},
		});

		if (!existing) {
			return { err: "Note not found" };
		}

		if (parsed.visit_id !== undefined && parsed.visit_id !== null) {
			const visit = await sdb.job_visit.findFirst({
				where: { id: parsed.visit_id },
			});

			if (!visit) {
				return { err: "Visit not found" };
			}

			if (visit.job_id !== jobId) {
				return { err: "Visit does not belong to this job" };
			}
		}

		const changes = buildChanges(existing, parsed, [
			"content",
			"visit_id",
		] as const);

		// Wasabi objects for photos dropped from the note; deleted best-effort
		// after the transaction commits so a storage hiccup can't fail the update.
		const removedPhotoUrls: string[] = [];
		const updated = await sdb.$transaction(async (tx) => {
			const updateData: Prisma.job_noteUpdateInput = {
				updated_at: new Date(),
			};

			if (parsed.content !== undefined) {
				updateData.content = parsed.content;
			}

			if (parsed.visit_id !== undefined) {
				if (parsed.visit_id === null) {
					updateData.visit = { disconnect: true };
				} else {
					updateData.visit = { connect: { id: parsed.visit_id } };
				}
			}

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

			await tx.job_note.update({
				where: { id: noteId },
				data: updateData,
			});

			if (parsed.photos !== undefined) {
				const existingPhotos = await tx.job_note_photo.findMany({
					where: { note_id: noteId},
					select: { id: true, photo_url: true },
				});
				const incomingPhotos = new Set(parsed.photos.filter((p) => p.id).map((p) => p.id!));
				const photosToDelete = existingPhotos.filter((p) => !incomingPhotos.has(p.id));
				if (photosToDelete.length > 0){
					await tx.job_note_photo.deleteMany({
						where: { id: { in: photosToDelete.map((p) => p.id) }}
					});
					removedPhotoUrls.push(...photosToDelete.map((p) => p.photo_url));
				}

				const photosToCreate = parsed.photos.filter((p) => !p.id);
				if (photosToCreate.length > 0){
					await tx.job_note_photo.createMany({
						data: photosToCreate.map((p) => ({
							note_id: noteId,
							photo_url: p.photo_url,
							photo_label: p.photo_label,
							photo_name: p.photo_name || null,
						}))
					});
				}
			}

			if (Object.keys(changes).length > 0) {
				await logActivity({
					event_type: "job_note.updated",
					action: "updated",
					entity_type: "job_note",
					entity_id: noteId,
					organization_id: organizationId,
					actor_type: context?.techId
						? "technician"
						: context?.dispatcherId
							? "dispatcher"
							: "system",
					actor_id: context?.techId || context?.dispatcherId,
					changes: { ...changes, ...parentBreadcrumb("job", jobId) },
					ip_address: context?.ipAddress,
					user_agent: context?.userAgent,
				});
			}

			return await tx.job_note.findFirst({
				where: { id: noteId },
				include: noteInclude,
			});
		});

		if (!updated) return { err: "Failed to update note" };
		for (const url of removedPhotoUrls) {
			deleteFile(url).catch((err) =>
				log.warn({ err, url, noteId }, "Failed to delete removed job note photo from storage"),
			);
		}
		const signed = await signNotePhotos(updated);
		return { err: "", item: signed };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		log.error({ err: e }, "Error updating job note");
		return { err: "Internal server error" };
	}
};

export const deleteJobNote = async (
	jobId: string,
	noteId: string,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.job_note.findFirst({
			where: {
				id: noteId,
				job_id: jobId,
			},
		});

		if (!existing) {
			return { err: "Note not found" };
		}

		await sdb.$transaction(async (tx) => {
			await logActivity({
				event_type: "job_note.deleted",
				action: "deleted",
				entity_type: "job_note",
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
					job_id: { old: existing.job_id, new: null },
					visit_id: { old: existing.visit_id, new: null },
					...parentBreadcrumb("job", existing.job_id),
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			await tx.job_note.delete({
				where: { id: noteId },
			});
		});

		return { err: "", message: "Note deleted successfully" };
	} catch (error) {
		log.error({ err: error }, "Error deleting job note");
		return { err: "Internal server error" };
	}
};
