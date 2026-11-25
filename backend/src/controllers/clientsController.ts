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
import { CONSENT_SELECT, clientWithConsent } from "../lib/contactConsent.js";
import { getOrgRealmId } from "../services/quickbooksService.js";
import { Prisma } from "../../generated/prisma/client.js";
import { getEffectiveTaxMode } from "../services/tax/taxMode.js";
import { jobAssignedWhere } from "../lib/assignedScope.js";
import type { Request } from "express";
import {
	type ListSpec,
	type ParsedList,
	ListQueryError,
} from "../lib/listQuery.js";
import {
	andOfOrs,
	containsInsensitive,
	singleParam,
} from "../lib/listSearch.js";
import {
	AddressTaxChoiceError,
	addressMoves,
	addressTaxChoiceRefusal,
	applyAddressTaxChoiceToFamily,
	choiceActor,
	keptFamily,
} from "../lib/addressTaxChoice.js";

/**
 * How much of a client a view_clients caller sees. `assignedTechId` (an
 * assigned-only technician) narrows jobs to theirs and drops job totals;
 * `quotes: false` (no view_quotes) drops the quote list, which carries totals.
 */
export interface ClientReadScope {
	assignedTechId?: string;
	quotes: boolean;
}

const buildClientInclude = (scope?: ClientReadScope) => ({
	jobs: {
		where: scope?.assignedTechId ? jobAssignedWhere(scope.assignedTechId) : undefined,
		select: {
			id: true,
			job_number: true,
			name: true,
			status: true,
			created_at: true,
			actual_total: !scope?.assignedTechId,
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
					consents: CONSENT_SELECT,
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
	...(scope && !scope.quotes
		? {}
		: {
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
			}),
});

// ============================================================================
// CLIENT CRUD
// ============================================================================

export const getAllClients = async (organizationId: string, scope?: ClientReadScope) => {
	const sdb = getScopedDb(organizationId);
	const clients = await sdb.client.findMany({
		include: buildClientInclude(scope),
		orderBy: { last_activity: "desc" },
	});
	return clients.map(clientWithConsent);
};

export const CLIENT_LIST_SPEC = {
	sortable: ["name", "created_at", "last_activity"] as const,
	defaultSort: "last_activity" as const,
	defaultDir: "desc" as const,
	statuses: ["active", "inactive"] as const,
} satisfies ListSpec<string, "active" | "inactive">;

type ClientListQuery = ParsedList<
	(typeof CLIENT_LIST_SPEC.sortable)[number],
	"active" | "inactive"
>;

// Beyond the shared contract: the Clients page filters on tax status, and tells
// us whether the caller chose a sort (none means active first, then recent).
export const parseClientListExtras = (query: Request["query"]) => {
	const tax = singleParam(query, "tax");
	if (tax !== undefined && tax !== "exempt" && tax !== "taxable") {
		throw new ListQueryError("tax", "tax must be exempt or taxable");
	}
	const qb = singleParam(query, "qb");
	if (qb !== undefined && qb !== "synced" && qb !== "not_synced") {
		throw new ListQueryError("qb", "qb must be synced or not_synced");
	}
	// The QuickBooks sync screen also wants each row's linked customer id.
	const withQb = singleParam(query, "with_qb") === "1";
	const explicitSort = singleParam(query, "sort") !== undefined;
	return { tax, qb, withQb, explicitSort };
};

// Counts only: the card and pickers need how many, not which. The legacy list
// trims jobs to the caller's assigned ones and hides quotes without
// view_quotes; the counts follow the same rules so
// a slim row never reveals more than the full one did.
const clientListSelect = (scope: ClientReadScope, qbRealm?: string) =>
	({
		id: true,
		name: true,
		is_active: true,
		is_tax_exempt: true,
		address: true,
		last_activity: true,
		created_at: true,
		...(qbRealm !== undefined && {
			client_external_mapping: {
				where: { provider: "quickbooks", account_id: qbRealm },
				take: 1,
				select: { external_id: true },
			},
		}),
		contacts: {
			where: { is_primary: true },
			take: 1,
			select: {
				is_primary: true,
				contact: {
					select: { id: true, name: true, email: true, phone: true },
				},
			},
		},
		_count: {
			select: {
				jobs: scope.assignedTechId
					? { where: jobAssignedWhere(scope.assignedTechId) }
					: true,
				...(scope.quotes && { quotes: true }),
				requests: true,
			},
		},
	}) satisfies Prisma.clientSelect;

const clientOrderBy = (
	parsed: ClientListQuery,
	explicitSort: boolean,
): Prisma.clientOrderByWithRelationInput[] => {
	if (!explicitSort) {
		return [
			{ is_active: "desc" },
			{ last_activity: "desc" },
			{ id: "asc" },
		];
	}
	// id breaks ties so a page boundary never repeats or drops a row.
	return [{ [parsed.sort]: parsed.dir }, { id: "asc" }];
};

export const getClientsPage = async (
	organizationId: string,
	parsed: ClientListQuery,
	extras: ReturnType<typeof parseClientListExtras>,
	scope: ClientReadScope,
) => {
	const sdb = getScopedDb(organizationId);
	// Both statuses (or none) is no filter.
	const onlyOne = parsed.status?.length === 1 ? parsed.status[0] : undefined;
	// Linked to a QuickBooks customer in the org's current realm, as
	// /quickbooks/customers/mappings reads it; a client linked under an old
	// realm is not synced.
	const wantsQb = extras.qb || extras.withQb;
	const realm = wantsQb ? await getOrgRealmId(organizationId) : undefined;
	const mapping = {
		provider: "quickbooks",
		account_id: realm,
	};
	const where: Prisma.clientWhereInput = {
		...(onlyOne && { is_active: onlyOne === "active" }),
		...(extras.tax && { is_tax_exempt: extras.tax === "exempt" }),
		...(extras.qb && {
			client_external_mapping:
				extras.qb === "synced" ? { some: mapping } : { none: mapping },
		}),
		...andOfOrs<Prisma.clientWhereInput>(parsed.q, (term) => [
			{ name: containsInsensitive(term) },
			{ address: containsInsensitive(term) },
			{
				contacts: {
					some: {
						is_primary: true,
						contact: {
							OR: [
								{ name: containsInsensitive(term) },
								{ email: containsInsensitive(term) },
								{ phone: containsInsensitive(term) },
							],
						},
					},
				},
			},
		]),
	};
	const [rows, total] = await Promise.all([
		sdb.client.findMany({
			where,
			select: clientListSelect(scope, extras.withQb ? realm : undefined),
			orderBy: clientOrderBy(parsed, extras.explicitSort),
			skip: parsed.skip,
			take: parsed.take,
		}),
		sdb.client.count({ where }),
	]);
	return { rows, total };
};

export const getClientById = async (id: string, organizationId: string, scope?: ClientReadScope) => {
	const sdb = getScopedDb(organizationId);
	const client = await sdb.client.findFirst({
		where: { id },
		include: buildClientInclude(scope),
	});
	return client ? clientWithConsent(client) : null;
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
					is_tax_exempt: parsed.is_tax_exempt,
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
					is_tax_exempt: { old: null, new: client.is_tax_exempt },
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
			}, organizationId).catch((ce) => {
				// The client already exists; a failed contact mustn't turn the create into a 500.
				log.error({ err: ce }, "QuickBooks contact create failed");
				return { err: "", existingContact: undefined };
			});

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

		return { err: "", item: created ? clientWithConsent(created) : created };
	} catch (e) {
		log.error({ err: e }, "Insert client error");
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

		// Job-less draft invoices are taxed at the client's address.
		const addressFamily =
			addressMoves(data, parsed, existing) &&
			(await getEffectiveTaxMode(organizationId)) !== "auto"
				? await keptFamily(sdb as unknown as Prisma.TransactionClient, organizationId, {
						kind: "client",
						id,
					})
				: null;
		if (addressFamily && !parsed.address_tax_choice) {
			return { ...addressTaxChoiceRefusal(addressFamily), item: undefined };
		}

		const changes = buildChanges(existing, parsed, [
			"name",
			"address",
			"coords",
			"is_active",
			"is_tax_exempt",
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
					...(parsed.is_tax_exempt !== undefined && {
						is_tax_exempt: parsed.is_tax_exempt,
					}),
					last_activity: new Date(),
				},
			});

			if (addressFamily && parsed.address_tax_choice) {
				await applyAddressTaxChoiceToFamily(
					tx as unknown as Prisma.TransactionClient,
					organizationId,
					{ kind: "client", id },
					parsed.address_tax_choice,
					choiceActor(context),
				);
			}

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

		return { err: "", item: updated ? clientWithConsent(updated) : undefined };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		if (e instanceof AddressTaxChoiceError) return { err: e.message };
		throw e;
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
		if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
			return { err: "This client has invoices or is linked to QuickBooks, so it can't be deleted. Mark the client inactive instead." };
		}
		throw error;
	}
};
