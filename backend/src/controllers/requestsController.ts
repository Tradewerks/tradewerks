import { ZodError } from "zod";
import {
	createRequestSchema,
	updateRequestSchema,
	createRequestNoteSchema,
	updateRequestNoteSchema,
} from "../lib/validate/requests.js";
import { Request } from "express";
import { logActivity, buildChanges } from "../services/logger.js";
import { Prisma } from "../../generated/prisma/client.js";
import { log } from "../services/appLogger.js";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { fillCoords } from "../lib/geocode.js";
import { formatZodError } from "../lib/validate/shared.js";
import { assertValidRequestTransition, InvalidTransitionError } from "../lib/statusTransitions.js";
import { onRequestCreated } from "../services/followupTriggers.js";

export const getAllRequests = async (organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.request.findMany({
		include: {
			client: {
				select: {
					id: true,
					name: true,
				},
			},
			quotes: {
				select: {
					id: true,
					quote_number: true,
					status: true,
					total: true,
				},
			},
			jobs: {
				select: {
					id: true,
					job_number: true,
					name: true,
					status: true,
				},
			},
		},
		orderBy: { created_at: "desc" },
	});
};

export const getRequestById = async (requestId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.request.findFirst({
		where: { id: requestId },
		include: {
			client: {
				select: {
					id: true,
					name: true,
					address: true,
					coords: true,
					is_active: true,
					contacts: {
						where: {
							is_primary: true,
						},
						include: {
							contact: {
								select: {
									id: true,
									name: true,
									email: true,
									phone: true,
								},
							},
						},
						take: 1,
					},
				},
			},
			quotes: {
				select: {
					id: true,
					quote_number: true,
					title: true,
					status: true,
					is_active: true,
					total: true,
					created_at: true,
				},
				orderBy: { created_at: "desc" },
			},
			jobs: {
				select: {
					id: true,
					job_number: true,
					name: true,
					status: true,
					created_at: true,
				},
			},
			notes: {
				include: {
					creator_tech: {
						select: { id: true, name: true, email: true },
					},
					creator_dispatcher: {
						select: { id: true, name: true, email: true },
					},
					last_editor_tech: {
						select: { id: true, name: true, email: true },
					},
					last_editor_dispatcher: {
						select: { id: true, name: true, email: true },
					},
				},
				orderBy: { created_at: "desc" },
			},
		},
	});
};

export const getRequestsByClientId = async (clientId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.request.findMany({
		where: { client_id: clientId },
		include: {
			client: true,
			quotes: {
				select: {
					id: true,
					quote_number: true,
					status: true,
					total: true,
				},
			},
			jobs: {
				select: {
					id: true,
					job_number: true,
					name: true,
					status: true,
				},
			},
		},
		orderBy: { created_at: "desc" },
	});
};

export const insertRequest = async (req: Request, organizationId: string, context?: UserContext) => {
	try {
		const parsed = createRequestSchema.parse(req.body);
		await fillCoords(parsed, false);
		const sdb = getScopedDb(organizationId);

		const created = await sdb.$transaction(async (tx) => {
			const client = await sdb.client.findFirst({
				where: { id: parsed.client_id },
			});

			if (!client) {
				throw new Error("Client not found");
			}

			const requestData: Prisma.requestCreateInput = {
				organization: { connect: { id: organizationId } },
				client: { connect: { id: parsed.client_id } },
				title: parsed.title,
				description: parsed.description,
				priority: parsed.priority,
				address: parsed.address,
				status: parsed.status || "New",

				...(parsed.coords && { coords: parsed.coords }),
				...(parsed.requires_quote !== undefined && {
					requires_quote: parsed.requires_quote,
				}),
				...(parsed.source && { source: parsed.source }),
				...(parsed.source_reference && {
					source_reference: parsed.source_reference,
				}),
			};

			if (parsed.estimated_value !== undefined) {
				requestData.estimated_value = parsed.estimated_value;
			}

			const request = await tx.request.create({
				data: requestData,
			});

			await tx.client.update({
				where: { id: parsed.client_id },
				data: { last_activity: new Date() },
			});

			await logActivity({
				event_type: "request.created",
				action: "created",
				entity_type: "request",
				entity_id: request.id,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					title: { old: null, new: request.title },
					client_id: { old: null, new: request.client_id },
					priority: { old: null, new: request.priority },
					status: { old: null, new: request.status },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			return tx.request.findUnique({
				where: { id: request.id },
				include: {
					client: true,
					quotes: true,
					jobs: true,
				},
			});
		});

		// Best-effort: auto-enroll into any active request_created followup sequences.
		if (created) onRequestCreated(created.id, organizationId);
		return { err: "", item: created ?? undefined };
	} catch (e) {
		if (e instanceof ZodError) {
			return { err: formatZodError(e) };
		}
		if (e instanceof Error) {
			return { err: e.message };
		}
		log.error({ err: e }, "Insert request error");
		return { err: "Internal server error" };
	}
};

export const updateRequest = async (req: Request, organizationId: string, context?: UserContext) => {
	try {
		const requestId = req.params.id as string;
		const parsed = updateRequestSchema.parse(req.body);
		await fillCoords(parsed, false);
		const sdb = getScopedDb(organizationId);

		const existing = await sdb.request.findFirst({
			where: { id: requestId },
			include: { jobs: true },
		});

		if (!existing) {
			return { err: "Request not found" };
		}

		if (existing.jobs && existing.jobs.length > 0) {
			return {
				err: "Cannot modify request that has been converted to a job",
			};
		}

		if (parsed.status && parsed.status !== existing.status) {
			try {
				assertValidRequestTransition(existing.status, parsed.status);
			} catch (e) {
				if (e instanceof InvalidTransitionError) {
					return { err: e.message };
				}
				throw e;
			}
		}

		const changes = buildChanges(existing, parsed, [
			"title",
			"description",
			"priority",
			"address",
			"status",
			"requires_quote",
			"source",
			"source_reference",
			"cancellation_reason",
			"estimated_value",
			"coords",
		] as const);

		const updated = await sdb.$transaction(async (tx) => {
			const request = await tx.request.update({
				where: { id: requestId },
				data: {
					...(parsed.title !== undefined && { title: parsed.title }),
					...(parsed.description !== undefined && {
						description: parsed.description,
					}),
					...(parsed.priority !== undefined && {
						priority: parsed.priority,
					}),
					...(parsed.address !== undefined && {
						address: parsed.address,
					}),
					...(parsed.coords !== undefined && {
						coords: parsed.coords,
					}),
					...(parsed.status !== undefined && {
						status: parsed.status,
					}),
					...(parsed.requires_quote !== undefined && {
						requires_quote: parsed.requires_quote,
					}),
					...(parsed.estimated_value !== undefined && {
						estimated_value: parsed.estimated_value,
					}),
					...(parsed.source !== undefined && {
						source: parsed.source,
					}),
					...(parsed.source_reference !== undefined && {
						source_reference: parsed.source_reference,
					}),
					...(parsed.cancellation_reason !== undefined && {
						cancellation_reason: parsed.cancellation_reason,
					}),
					// Auto-timestamps
					...(parsed.status === "Cancelled" &&
						!existing.cancelled_at && { cancelled_at: new Date() }),
				},
				include: {
					client: true,
					quotes: true,
					jobs: true,
				},
			});

			if (Object.keys(changes).length > 0) {
				await logActivity({
					event_type: "request.updated",
					action: "updated",
					entity_type: "request",
					entity_id: requestId,
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

			return request;
		});

		return { err: "", item: updated };
	} catch (e) {
		if (e instanceof ZodError) {
			return { err: formatZodError(e) };
		}
		log.error({ err: e }, "Update request error");
		return { err: "Internal server error" };
	}
};

export const deleteRequest = async (id: string, organizationId: string, context?: UserContext) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.request.findFirst({
			where: { id },
			include: {
				quotes: true,
				jobs: true,
			},
		});

		if (!existing) {
			return { err: "Request not found" };
		}

		// Check if request has quotes
		if (existing.quotes && existing.quotes.length > 0) {
			return {
				err: "Cannot delete request that has quotes. Delete quotes first or archive the request.",
			};
		}

		// Check if request has been converted to job
		if (existing.jobs && existing.jobs.length > 0) {
			return {
				err: "Cannot delete request that has been converted to a job",
			};
		}

		await sdb.$transaction(async (tx) => {
			await logActivity({
				event_type: "request.deleted",
				action: "deleted",
				entity_type: "request",
				entity_id: id,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					title: { old: existing.title, new: null },
					status: { old: existing.status, new: null },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			await tx.request_note.deleteMany({
				where: { request_id: id },
			});

			await tx.request.delete({
				where: { id },
			});
		});

		return { err: "", item: { id } };
	} catch (error) {
		log.error({ err: error }, "Delete request error");
		return { err: "Internal server error" };
	}
};

// ============================================================================
// REQUEST NOTES
// ============================================================================

export const getRequestNotes = async (requestId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.request_note.findMany({
		where: { request_id: requestId },
		include: {
			creator_tech: {
				select: { id: true, name: true, email: true },
			},
			creator_dispatcher: {
				select: { id: true, name: true, email: true },
			},
			last_editor_tech: {
				select: { id: true, name: true, email: true },
			},
			last_editor_dispatcher: {
				select: { id: true, name: true, email: true },
			},
		},
		orderBy: { created_at: "desc" },
	});
};

export const getRequestNoteById = async (requestId: string, noteId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.request_note.findFirst({
		where: {
			id: noteId,
			request_id: requestId,
		},
		include: {
			creator_tech: {
				select: { id: true, name: true, email: true },
			},
			creator_dispatcher: {
				select: { id: true, name: true, email: true },
			},
			last_editor_tech: {
				select: { id: true, name: true, email: true },
			},
			last_editor_dispatcher: {
				select: { id: true, name: true, email: true },
			},
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

		const request = await sdb.request.findFirst({
			where: { id: requestId },
		});

		if (!request) {
			return { err: "Request not found" };
		}

		const created = await sdb.$transaction(async (tx) => {
			const noteData: Prisma.request_noteCreateInput = {
				request: { connect: { id: requestId } },
				content: parsed.content,
				...(context?.techId && {
					creator_tech: { connect: { id: context.techId } },
				}),
				...(context?.dispatcherId && {
					creator_dispatcher: {
						connect: { id: context.dispatcherId },
					},
				}),
			};

			const note = await tx.request_note.create({
				data: noteData,
				include: {
					creator_tech: {
						select: { id: true, name: true, email: true },
					},
					creator_dispatcher: {
						select: { id: true, name: true, email: true },
					},
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
			return { err: formatZodError(e) };
		}
		log.error({ err: e }, "Insert request note error");
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
			where: {
				id: noteId,
				request_id: requestId,
			},
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

			const note = await tx.request_note.update({
				where: { id: noteId },
				data: updateData,
				include: {
					creator_tech: {
						select: { id: true, name: true, email: true },
					},
					creator_dispatcher: {
						select: { id: true, name: true, email: true },
					},
					last_editor_tech: {
						select: { id: true, name: true, email: true },
					},
					last_editor_dispatcher: {
						select: { id: true, name: true, email: true },
					},
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
			return { err: formatZodError(e) };
		}
		log.error({ err: e }, "Update request note error");
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
			where: {
				id: noteId,
				request_id: requestId,
			},
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

			await tx.request_note.delete({
				where: { id: noteId },
			});
		});

		return { err: "", message: "Note deleted successfully" };
	} catch (error) {
		log.error({ err: error }, "Delete request note error");
		return { err: "Internal server error" };
	}
};
