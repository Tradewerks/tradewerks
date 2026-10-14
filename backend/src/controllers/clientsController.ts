import { ZodError } from "zod";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { fillCoords } from "../lib/geocode.js";
import {
	createClientSchema,
	updateClientSchema,
} from "../lib/validate/clients.js";
import { logActivity, buildChanges } from "../services/logger.js";
import { log } from "../services/appLogger.js";
import { insertContact } from "./contactsController.js"
import { getOrgRealmId } from "../services/quickbooksService.js";

const buildClientInclude = () => ({
	jobs: {
		select: {
			id: true,
			job_number: true,
			name: true,
			status: true,
			created_at: true,
			actual_total: true,
		},
		orderBy: { created_at: "desc" as const },
	},
	contacts: {
		include: {
			contact: {
				select: {
					id: true,
					name: true,
					email: true,
					phone: true,
					type: true,
				},
			},
		},
	},
	notes: {
		select: {
			id: true,
			content: true,
			created_at: true,
			updated_at: true,
		},
		orderBy: { created_at: "desc" as const },
	},
	recurring_plans: {
		select: {
			id: true,
			name: true,
			status: true,
			starts_at: true,
			created_at: true,
		},
		orderBy: { created_at: "desc" as const },
	},
	requests: {
		select: {
			id: true,
			title: true,
			status: true,
			created_at: true,
		},
		orderBy: { created_at: "desc" as const },
	},
	quotes: {
		select: {
			id: true,
			quote_number: true,
			title: true,
			status: true,
			total: true,
			is_active: true,
			created_at: true,
		},
		orderBy: { created_at: "desc" as const },
	},
});

// ============================================================================
// CLIENT CRUD
// ============================================================================

export const getAllClients = async (organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.client.findMany({
		include: buildClientInclude(),
		orderBy: { last_activity: "desc" },
	});
};

export const getClientById = async (id: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.client.findFirst({
		where: { id },
		include: buildClientInclude(),
	});
};

export const insertClient = async (
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = createClientSchema.parse(data);
		const geoErr = await fillCoords(parsed, true);
		if (geoErr) return { err: geoErr };
		const sdb = getScopedDb(organizationId);
		// Scope the QB customer mapping to the org's current realm 
		const accountId = parsed.qb_customer_id
			? await getOrgRealmId(organizationId)
			: "";
		const created = await sdb.$transaction(async (tx) => {
			const client = await tx.client.create({
				data: {
					organization_id: organizationId,
					name: parsed.name,
					address: parsed.address,
					coords: parsed.coords!, // fillCoords guarantees coords once address (required) is set
					is_active: parsed.is_active ?? true,
					last_activity: new Date(),
				},
			});

			// adds qb relation
			if (parsed.qb_customer_id) {
				await tx.client_external_mapping.create({
					data: {
						client_id: client.id,
						provider: "quickbooks",
						account_id: accountId,
						external_id: parsed.qb_customer_id,
					},
				});
			}

			await logActivity({
				event_type: "client.created",
				action: "created",
				entity_type: "client",
				entity_id: client.id,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					name: { old: null, new: client.name },
					address: { old: null, new: client.address },
					is_active: { old: null, new: client.is_active },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			return tx.client.findFirst({
				where: { id: client.id },
				include: buildClientInclude(),
			});
		});
		
		// attempt to create contact if the qb info exists
		if (parsed.qb_contact_email || parsed.qb_contact_phone) {
			const contactResult = await insertContact({
				name: parsed.qb_contact_name || parsed.name,
				email: parsed.qb_contact_email,
				phone: parsed.qb_contact_phone,
				client_id: created!.id,
				is_primary: true,
				relationship: "contact",
			}, organizationId);

			// contact already exists in this org — link it instead of failing
			if (contactResult.existingContact) {
				await sdb.client_contact.create({
					data: {
						client_id: created!.id,
						contact_id: contactResult.existingContact.id,
						is_primary: true,
						relationship: "contact",
					},
				}).catch(() => {});  // ignore if already linked to this client
			}
		}

		return { err: "", item: created };
	} catch (e) {
		log.error({ err: e }, "Insert client error");
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		return { err: "Internal server error" };
	}
};

export const updateClient = async (
	id: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updateClientSchema.parse(data);
		const geoErr = await fillCoords(parsed, true);
		if (geoErr) return { err: geoErr };
		const sdb = getScopedDb(organizationId);

		const existing = await sdb.client.findFirst({ where: { id } });
		if (!existing) {
			return { err: "Client not found" };
		}

		const changes = buildChanges(existing, parsed, [
			"name",
			"address",
			"coords",
			"is_active",
		] as const);

		const updated = await sdb.$transaction(async (tx) => {
			const client = await tx.client.update({
				where: { id },
				data: {
					...(parsed.name !== undefined && { name: parsed.name }),
					...(parsed.address !== undefined && {
						address: parsed.address,
					}),
					...(parsed.coords !== undefined && {
						coords: parsed.coords,
					}),
					...(parsed.is_active !== undefined && {
						is_active: parsed.is_active,
					}),
					last_activity: new Date(),
				},
			});

			if (Object.keys(changes).length > 0) {
				await logActivity({
					event_type: "client.updated",
					action: "updated",
					entity_type: "client",
					entity_id: id,
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

			return tx.client.findFirst({
				where: { id: client.id },
				include: buildClientInclude(),
			});
		});

		return { err: "", item: updated ?? undefined };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		return { err: "Internal server error" };
	}
};

export const deleteClient = async (
	id: string,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);

		const existing = await sdb.client.findFirst({
			where: { id },
			include: {
				jobs: { select: { id: true } },
				recurring_plans: { select: { id: true } },
				requests: { select: { id: true } },
				quotes: { select: { id: true } },
				projects: { select: { id: true } },
			},
		});

		if (!existing) {
			return { err: "Client not found" };
		}

		if (existing.jobs.length > 0) {
			return { err: "Cannot delete client with existing jobs" };
		}
		if (existing.projects.length > 0) {
			return { err: "Cannot delete client with existing projects" };
		}
		if (existing.recurring_plans.length > 0) {
			return {
				err: "Cannot delete client with existing recurring plans",
			};
		}
		if (existing.requests.length > 0) {
			return { err: "Cannot delete client with existing requests" };
		}
		if (existing.quotes.length > 0) {
			return { err: "Cannot delete client with existing quotes" };
		}

		await sdb.$transaction(async (tx) => {
			await tx.client.delete({ where: { id } });

			await logActivity({
				event_type: "client.deleted",
				action: "deleted",
				entity_type: "client",
				entity_id: id,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					name: { old: existing.name, new: null },
					address: { old: existing.address, new: null },
					is_active: { old: existing.is_active, new: null },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});
		});

		return { err: "", message: "Client deleted successfully" };
	} catch (error) {
		log.error({ err: error }, "Delete client error");
		return { err: "Failed to delete client. It may have related records." };
	}
};
