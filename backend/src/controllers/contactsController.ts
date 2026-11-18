import { ZodError } from "zod";
import { getScopedDb, type UserContext } from "../lib/context.js";
import {
	createContactSchema,
	updateContactSchema,
	linkContactSchema,
	updateClientContactSchema,
	setContactConsentSchema,
} from "../lib/validate/contacts.js";
import {
	CONSENT_SELECT,
	CUSTOMER_EMAIL_OPT_OUT,
	CUSTOMER_SMS_OPT_OUT,
	isEmailResubscribable,
	isSuppressionSource,
	linkWithConsent,
	withConsent,
} from "../lib/contactConsent.js";
import { setConsent } from "../services/consentService.js";
import { logActivity, buildChanges } from "../services/logger.js";
import { Prisma } from "../../generated/prisma/client.js";
import { log } from "../services/appLogger.js";
import { httpError, ErrorCodes } from "../types/responses.js";

// ============================================================================
// CONTACT CRUD
// ============================================================================

export const getClientContacts = async (clientId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const links = await sdb.client_contact.findMany({
		where: { client_id: clientId },
		include: {
			contact: { include: { consents: CONSENT_SELECT } },
		},
		orderBy: { contact: { name: "asc" } },
	});
	return links.map(linkWithConsent);
};

export const getContactById = async (contactId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const contact = await sdb.contact.findFirst({
		where: { id: contactId },
		include: {
			consents: CONSENT_SELECT,
			client_contacts: {
				include: {
					client: {
						select: {
							id: true,
							name: true,
						},
					},
				},
			},
		},
	});
	return contact ? withConsent(contact) : null;
};

export const getAllContacts = async (organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const contacts = await sdb.contact.findMany({
		where: { is_active: true },
		include: {
			consents: CONSENT_SELECT,
			client_contacts: {
				include: {
					client: {
						select: {
							id: true,
							name: true,
						},
					},
				},
			},
		},
		orderBy: { name: "asc" },
	});
	return contacts.map(withConsent);
};

export const insertContact = async (data: unknown, organizationId: string, context?: UserContext) => {
	try {
		const parsed = createContactSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		// Check for duplicate (same email or phone)
		if (parsed.email || parsed.phone) {
			const existing = await sdb.contact.findFirst({
				where: {
					OR: [
						...(parsed.email ? [{ email: parsed.email }] : []),
						...(parsed.phone ? [{ phone: parsed.phone }] : []),
					],
				},
				include: {
					client_contacts: {
						include: {
							client: {
								select: { id: true, name: true },
							},
						},
					},
				},
			});

			if (existing) {
				return {
					err: "Contact with this email or phone already exists",
					existingContact: existing,
				};
			}
		}

		const created = await sdb.$transaction(async (tx) => {
			const contact = await tx.contact.create({
				data: {
					organization_id: organizationId,
					name: parsed.name,
					email: parsed.email || null,
					phone: parsed.phone || null,
					type: parsed.type || null,
					is_active: true,
				},
			});

			// If client_id provided, create the link
			if (parsed.client_id) {
				const client = await tx.client.findFirst({
					where: { id: parsed.client_id, organization_id: organizationId },
				});

				if (!client) {
					throw httpError(404, ErrorCodes.NOT_FOUND, "Client not found");
				}

				await tx.client_contact.create({
					data: {
						client_id: parsed.client_id,
						contact_id: contact.id,
						relationship: parsed.relationship || "contact",
						is_primary: parsed.is_primary || false,
						is_billing: parsed.is_billing || false,
					},
				});

				await tx.client.updateMany({
					where: { id: parsed.client_id, organization_id: organizationId },
					data: { last_activity: new Date() },
				});
			}

			await logActivity({
				event_type: "contact.created",
				action: "created",
				entity_type: "contact",
				entity_id: contact.id,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					name: { old: null, new: contact.name },
					email: { old: null, new: contact.email },
					phone: { old: null, new: contact.phone },
					...(parsed.client_id && {
						linked_to_client: { old: null, new: parsed.client_id },
					}),
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			return tx.contact.findFirst({
				where: { id: contact.id },
				include: {
					consents: CONSENT_SELECT,
					client_contacts: {
						include: {
							client: true,
						},
					},
				},
			});
		});

		return { err: "", item: created ? withConsent(created) : created };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		log.error({ err: e }, "Insert contact error");
		throw e;
	}
};

export const updateContact = async (
	contactId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updateContactSchema.parse(data);

		const sdb = getScopedDb(organizationId);
		const existing = await sdb.contact.findFirst({
			where: { id: contactId },
		});

		if (!existing) {
			return { err: "Contact not found" };
		}

		// Check for duplicate email/phone if changing
		if (
			(parsed.email && parsed.email !== existing.email) ||
			(parsed.phone && parsed.phone !== existing.phone)
		) {
			const duplicate = await sdb.contact.findFirst({
				where: {
					AND: [
						{ id: { not: contactId } },
						{
							OR: [
								...(parsed.email
									? [{ email: parsed.email }]
									: []),
								...(parsed.phone
									? [{ phone: parsed.phone }]
									: []),
							],
						},
					],
				},
			});

			if (duplicate) {
				return {
					err: "Another contact with this email or phone already exists",
				};
			}
		}

		const changes = buildChanges(existing, parsed, [
			"name",
			"email",
			"phone",
			"type",
			"is_active",
		] as const);

		const updated = await sdb.$transaction(async (tx) => {
			await tx.contact.updateMany({
				where: { id: contactId, organization_id: organizationId },
				data: {
					...(parsed.name !== undefined && { name: parsed.name }),
					...(parsed.email !== undefined && { email: parsed.email }),
					...(parsed.phone !== undefined && { phone: parsed.phone }),
					...(parsed.type !== undefined && { type: parsed.type }),
					...(parsed.is_active !== undefined && {
						is_active: parsed.is_active,
					}),
				},
			});

			if (Object.keys(changes).length > 0) {
				await logActivity({
					event_type: "contact.updated",
					action: "updated",
					entity_type: "contact",
					entity_id: contactId,
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

			return tx.contact.findFirst({
				where: { id: contactId },
				include: {
					consents: CONSENT_SELECT,
					client_contacts: {
						include: {
							client: true,
						},
					},
				},
			});
		});

		return { err: "", item: updated ? withConsent(updated) : updated };
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

export const deleteContact = async (
	contactId: string,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.contact.findFirst({
			where: { id: contactId, organization_id: organizationId },
			include: {
				client_contacts: true,
			},
		});

		if (!existing) {
			return { err: "Contact not found" };
		}

		// Check if contact is linked to any clients
		if (existing.client_contacts.length > 0) {
			return {
				err: "Cannot delete contact that is linked to clients. Unlink first or set to inactive.",
			};
		}

		await sdb.$transaction(async (tx) => {
			await logActivity({
				event_type: "contact.deleted",
				action: "deleted",
				entity_type: "contact",
				entity_id: contactId,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					name: { old: existing.name, new: null },
					email: { old: existing.email, new: null },
					phone: { old: existing.phone, new: null },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			await tx.contact.deleteMany({
				where: { id: contactId, organization_id: organizationId },
			});
		});

		return { err: "", message: "Contact deleted successfully" };
	} catch (error) {
		log.error({ err: error }, "Delete contact error");
		throw error;
	}
};

// ============================================================================
// CLIENT-CONTACT RELATIONSHIP MANAGEMENT
// ============================================================================

export const linkContactToClient = async (
	contactId: string,
	clientId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = linkContactSchema.parse(data);

		const sdb = getScopedDb(organizationId);
		const contact = await sdb.contact.findFirst({
			where: { id: contactId },
		});
		const client = await sdb.client.findFirst({
			where: { id: clientId },
		});

		if (!contact) {
			return { err: "Contact not found" };
		}
		if (!client) {
			return { err: "Client not found" };
		}

		// Check if already linked
		const existing = await sdb.client_contact.findUnique({
			where: {
				client_id_contact_id: {
					client_id: clientId,
					contact_id: contactId,
				},
			},
		});

		if (existing) {
			return { err: "Contact already linked to this client" };
		}

		const linked = await sdb.$transaction(async (tx) => {
			const link = await tx.client_contact.create({
				data: {
					client_id: clientId,
					contact_id: contactId,
					relationship: parsed.relationship,
					is_primary: parsed.is_primary,
					is_billing: parsed.is_billing,
				},
			});

			await tx.client.updateMany({
				where: { id: clientId, organization_id: organizationId },
				data: { last_activity: new Date() },
			});

			await logActivity({
				event_type: "contact.linked_to_client",
				action: "updated",
				entity_type: "contact",
				entity_id: contactId,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					linked_to_client: { old: null, new: clientId },
					relationship: { old: null, new: link.relationship },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			return link;
		});

		return { err: "", item: linked };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		log.error({ err: e }, "Link contact error");
		throw e;
	}
};

export const updateClientContact = async (
	contactId: string,
	clientId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const parsed = updateClientContactSchema.parse(data);

		const existing = await sdb.client_contact.findUnique({
			where: {
				client_id_contact_id: {
					client_id: clientId,
					contact_id: contactId,
				},
			},
		});

		if (!existing) {
			return { err: "Contact not linked to this client" };
		}

		const changes = buildChanges(existing, parsed, [
			"relationship",
			"is_primary",
			"is_billing",
			"notify_visits",
		] as const);

		const updated = await sdb.$transaction(async (tx) => {
			const link = await tx.client_contact.update({
				where: {
					client_id_contact_id: {
						client_id: clientId,
						contact_id: contactId,
					},
				},
				data: {
					...(parsed.relationship !== undefined && {
						relationship: parsed.relationship,
					}),
					...(parsed.is_primary !== undefined && {
						is_primary: parsed.is_primary,
					}),
					...(parsed.is_billing !== undefined && {
						is_billing: parsed.is_billing,
					}),
					...(parsed.notify_visits !== undefined && {
						notify_visits: parsed.notify_visits,
					}),
				},
			});

			if (Object.keys(changes).length > 0) {
				await logActivity({
					event_type: "contact.client_relationship_updated",
					action: "updated",
					entity_type: "contact",
					entity_id: contactId,
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

			return link;
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

export const unlinkContactFromClient = async (
	contactId: string,
	clientId: string,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.client_contact.findUnique({
			where: {
				client_id_contact_id: {
					client_id: clientId,
					contact_id: contactId,
				},
			},
		});

		if (!existing) {
			return { err: "Contact not linked to this client" };
		}

		await sdb.$transaction(async (tx) => {
			await tx.client_contact.delete({
				where: {
					client_id_contact_id: {
						client_id: clientId,
						contact_id: contactId,
					},
				},
			});

			await logActivity({
				event_type: "contact.unlinked_from_client",
				action: "updated",
				entity_type: "contact",
				entity_id: contactId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					unlinked_from_client: { old: clientId, new: null },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});
		});

		return { err: "", message: "Contact unlinked successfully" };
	} catch (error) {
		throw error;
	}
};

export const searchContacts = async (
	query: string,
	organizationId: string,
	excludeClientId?: string,
) => {
	try {
		if (!query || query.trim().length < 2) {
			return { err: "", items: [] };
		}

		const sdb = getScopedDb(organizationId);
		const where: Prisma.contactWhereInput = {
			is_active: true,
			OR: [
				{ name: { contains: query.trim(), mode: "insensitive" } },
				{ email: { contains: query.trim(), mode: "insensitive" } },
				{ phone: { contains: query.trim(), mode: "insensitive" } },
			],
		};

		// Exclude contacts already linked to this client
		if (excludeClientId) {
			where.client_contacts = {
				none: {
					client_id: excludeClientId,
				},
			};
		}

		const contacts = await sdb.contact.findMany({
			where,
			select: {
				id: true,
				name: true,
				email: true,
				phone: true,
			},
			take: 10, // Limit results
			orderBy: {
				name: "asc",
			},
		});

		return { err: "", items: contacts };
	} catch (error) {
		log.error({ err: error }, "Search contacts error");
		throw error;
	}
};

export type ConsentResult =
	| { err: ""; code?: undefined; errorCode?: undefined }
	| {
			err: string;
			code: 400 | 404 | 409;
			errorCode?: "SMS_OPTED_OUT_BY_CUSTOMER" | "EMAIL_OPTED_OUT_BY_CUSTOMER";
	  };

export const setContactConsent = async (
	contactId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
): Promise<ConsentResult> => {
	const parsed = setContactConsentSchema.safeParse(data);
	if (!parsed.success) {
		return { err: "Invalid channel or status", code: 400 };
	}
	const { channel, status } = parsed.data;

	const sdb = getScopedDb(organizationId);
	const contact = await sdb.contact.findFirst({
		where: { id: contactId },
		select: { id: true, email: true },
	});
	if (!contact) return { err: "Contact not found", code: 404 };

	if (status === "subscribed") {
		const existing = await sdb.contact_consent.findFirst({
			where: { contact_id: contactId, channel },
			select: { status: true, source: true, source_detail: true },
		});
		if (existing?.status === "unsubscribed") {
			if (
				channel === "sms" &&
				CUSTOMER_SMS_OPT_OUT.has(existing.source)
			) {
				return {
					err: "The customer opted out of texts. Only the customer can agree to texts again.",
					code: 409,
					errorCode: "SMS_OPTED_OUT_BY_CUSTOMER",
				};
			}
			if (channel === "email") {
				if (CUSTOMER_EMAIL_OPT_OUT.has(existing.source)) {
					return {
						err: "The customer unsubscribed themselves. Only the customer can resubscribe.",
						code: 409,
						errorCode: "EMAIL_OPTED_OUT_BY_CUSTOMER",
					};
				}
				if (
					isSuppressionSource(existing.source) &&
					!isEmailResubscribable(existing, contact.email)
				) {
					return {
						err: "This address bounced or was reported as spam. Change the email address before re-subscribing.",
						code: 409,
					};
				}
			}
		}
	}

	await setConsent(organizationId, {
		contactId,
		channel,
		status,
		source: "dispatcher",
		dispatcherId: context?.dispatcherId,
	});
	return { err: "" };
};
