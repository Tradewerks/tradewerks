import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	keepPreviousData,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
	type UseMutationResult,
	type UseQueryResult,
} from "@tanstack/react-query";
import type {
	Client,
	CreateClientInput,
	UpdateClientInput,
	Contact,
	ClientContactLink,
	CreateContactInput,
	UpdateContactInput,
	UpdateClientContactInput,
	ConsentChannel,
	ClientNote,
	CreateClientNoteInput,
	UpdateClientNoteInput,
} from "../types/clients";
import * as clientApi from "../api/clients";
import type { ListParams } from "../types/paging";
import { qk } from "../lib/queryKeys";
import { useDebouncedValue } from "./useDebouncedValue";
import { useToast } from "../components/ui/useToast";

// ============================================================================
// CLIENT QUERIES
// ============================================================================

// Every client's id, name and coordinates for the map. Under qk.clients.all so client
// record changes refresh it, but slim: no jobs, quotes or contacts ride along.
export const useClientMapPointsQuery = (): UseQueryResult<clientApi.ClientMapPoint[], Error> => {
	return useQuery({
		queryKey: [...qk.clients.all, "mapPoints"],
		queryFn: clientApi.getClientMapPoints,
	});
};

const CLIENT_SEARCH_LIMIT = 20;

/** Org-wide client search for pickers: first page only, A-Z, slim rows. */
export const useClientSearchQuery = (q: string, opts: { enabled?: boolean } = {}) => {
	const params: ListParams = {
		page: 1,
		limit: CLIENT_SEARCH_LIMIT,
		sort: "name",
		dir: "asc",
		...(q.trim() && { q: q.trim() }),
	};
	return useQuery({
		queryKey: [...qk.clients.list(), params],
		queryFn: () => clientApi.getClientsPage(params),
		enabled: opts.enabled ?? true,
		placeholderData: keepPreviousData,
	});
};

/**
 * The client filter of a "start from existing" panel: suggestions come from a server
 * search of what the user has typed, and nothing is fetched until they type.
 */
export const useClientFilterSearch = (enabled: boolean) => {
	const [text, setText] = useState("");
	const q = useDebouncedValue(text.trim());
	const { data } = useClientSearchQuery(q, { enabled: enabled && q !== "" });
	const clients = useMemo(
		() => (q === "" ? [] : (data?.rows ?? []).map((c) => ({ id: c.id, name: c.name }))),
		[data, q]
	);
	return { clients, onClientQueryChange: setText };
};

/** Names (by id) for a set of client ids (a draft list's rows), one cached lookup each. */
export const useClientNames = (ids: (string | null | undefined)[], enabled: boolean) => {
	// Keyed by content: callers pass a fresh array every render.
	const idKey = [...new Set(ids.filter((id): id is string => !!id))].join(",");
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const unique = useMemo(() => (idKey ? idKey.split(",") : []), [idKey]);
	// A plain record so react-query's structural sharing keeps its identity between renders.
	return useQueries({
		queries: unique.map((id) => ({
			queryKey: ["clients", id],
			queryFn: () => clientApi.getClientById(id),
			enabled,
		})),
		combine: (results) =>
			Object.fromEntries(
				results.flatMap((r, i) => (r.data ? [[unique[i], r.data.name] as const] : []))
			) as Record<string, string>,
	});
};

/** Reads a client from the cache or fetches it: for prefilling a form at the moment of a pick. */
export const useFetchClient = () => {
	const queryClient = useQueryClient();
	return useCallback(
		(id: string) =>
			queryClient.fetchQuery({
				queryKey: ["clients", id],
				queryFn: () => clientApi.getClientById(id),
				staleTime: 30_000,
			}),
		[queryClient]
	);
};

/**
 * The client a form is filling in, for its tax settings; a failed load is told, not
 * hidden. Told once per error and only while the form is open: not for a background
 * refetch with the modal closed, nor again for an error already cached at mount.
 */
export const useSelectedClient = (clientId: string, open: boolean) => {
	const toast = useToast();
	const query = useClientByIdQuery(clientId || null);
	const queryClient = useQueryClient();
	const message = query.error?.message;
	// By message: a refetch that fails the same way is the same news. The observer
	// shows "pending" while it refetches, so the cached error is read from the cache.
	const told = useRef<string | undefined>(
		(queryClient.getQueryState(["clients", clientId])?.error as Error | null)?.message
	);
	useEffect(() => {
		if (!open || !message || told.current === message) return;
		told.current = message;
		toast.error(`Could not load the client's details: ${message}`);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [message, open]);
	return query.data;
};

export const useClientByIdQuery = (
	id: string | null | undefined,
	options?: { enabled?: boolean; retry?: boolean }
): UseQueryResult<Client, Error> => {
	return useQuery({
		queryKey: ["clients", id],
		queryFn: () => clientApi.getClientById(id!),
		enabled: options?.enabled !== undefined ? options.enabled : !!id,
		...(options?.retry !== undefined ? { retry: options.retry } : {}),
	});
};

// ============================================================================
// CLIENT MUTATIONS
// ============================================================================

export const useCreateClientMutation = (): UseMutationResult<Client, Error, CreateClientInput> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: clientApi.createClient,
		onSuccess: (newClient: Client) => {
			queryClient.invalidateQueries({ queryKey: ["clients"] });
			queryClient.setQueryData(["clients", newClient.id], newClient);
			queryClient.invalidateQueries({ queryKey: ["qbMappedCustomers"] });
		},
		onError: (error) => {
			console.error("Failed to create client:", error);
		},
	});
};

export const useUpdateClientMutation = (): UseMutationResult<
	Client,
	Error,
	{ id: string; data: UpdateClientInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateClientInput }) =>
			clientApi.updateClient(id, data),
		onSuccess: (updatedClient: Client) => {
			// Invalidate all clients
			queryClient.invalidateQueries({ queryKey: ["clients"] });
			queryClient.setQueryData(["clients", updatedClient.id], updatedClient);

			// Invalidate all related entities (list AND detail views)
			queryClient.invalidateQueries({ queryKey: ["jobs"] });
			queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			queryClient.invalidateQueries({ queryKey: ["quotes"] });
			queryClient.invalidateQueries({ queryKey: ["requests"] });
			queryClient.invalidateQueries({ queryKey: ["recurringPlans"] });
		},
		onError: (error: Error) => {
			console.error("Failed to update client:", error);
		},
	});
};

export const useDeleteClientMutation = (): UseMutationResult<
	{ message: string; id: string },
	Error,
	string
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: clientApi.deleteClient,
		onSuccess: (_, deletedId) => {
			queryClient.invalidateQueries({ queryKey: ["clients"] });
			queryClient.removeQueries({ queryKey: ["clients", deletedId] });

			// Invalidate all related entities (list AND detail views)
			queryClient.invalidateQueries({ queryKey: ["jobs"] });
			queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			queryClient.invalidateQueries({ queryKey: ["quotes"] });
			queryClient.invalidateQueries({ queryKey: ["requests"] });
			queryClient.invalidateQueries({ queryKey: ["recurringPlans"] });
		},
		onError: (error: Error) => {
			console.error("Failed to delete client:", error);
		},
	});
};

// ============================================================================
// INDEPENDENT CONTACT QUERIES
// ============================================================================

export const useAllContactsQuery = (): UseQueryResult<Contact[], Error> => {
	return useQuery({
		queryKey: ["contacts"],
		queryFn: clientApi.getAllContacts,
	});
};

export const useContactByIdQuery = (
	contactId: string | null | undefined,
	options?: { enabled?: boolean }
): UseQueryResult<Contact, Error> => {
	return useQuery({
		queryKey: ["contacts", contactId],
		queryFn: () => clientApi.getContactById(contactId!),
		enabled: options?.enabled !== undefined ? options.enabled : !!contactId,
	});
};

export const useClientContactsQuery = (
	clientId: string | null | undefined,
	options?: { enabled?: boolean }
): UseQueryResult<ClientContactLink[], Error> => {
	return useQuery({
		queryKey: ["clients", clientId, "contacts"],
		queryFn: () => clientApi.getClientContacts(clientId!),
		enabled: options?.enabled !== undefined ? options.enabled : !!clientId,
	});
};

// ============================================================================
// INDEPENDENT CONTACT MUTATIONS
// ============================================================================

export const useSearchContactsQuery = (
	query: string,
	clientId: string,
	enabled: boolean = true
): UseQueryResult<Contact[], Error> => {
	return useQuery({
		queryKey: ["contacts", "search", query, clientId],
		queryFn: () => clientApi.searchContacts(query, clientId),
		enabled: enabled && query.length >= 2,
		staleTime: 30000, // Cache for 30 seconds
	});
};

export const useCreateContactMutation = (): UseMutationResult<
	Contact,
	Error,
	CreateContactInput
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: clientApi.createContact,
		onSuccess: (newContact: Contact) => {
			// Invalidate all contacts list
			queryClient.invalidateQueries({ queryKey: ["contacts"] });

			// Cache the new contact
			queryClient.setQueryData(["contacts", newContact.id], newContact);

			// If linked to a client, invalidate that client's contacts and related entities
			if (newContact.client_contacts.length > 0) {
				newContact.client_contacts.forEach((link) => {
					queryClient.invalidateQueries({
						queryKey: ["clients", link.client_id, "contacts"],
					});
					queryClient.invalidateQueries({
						queryKey: ["clients", link.client_id],
					});
				});

				// Invalidate all related entities (list AND detail views)
				queryClient.invalidateQueries({ queryKey: ["jobs"] });
				queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
				queryClient.invalidateQueries({ queryKey: ["quotes"] });
				queryClient.invalidateQueries({ queryKey: ["requests"] });
				queryClient.invalidateQueries({ queryKey: ["recurringPlans"] });
			}
		},
		onError: (error: Error) => {
			console.error("Failed to create contact:", error);
		},
	});
};

export const useUpdateContactMutation = (): UseMutationResult<
	Contact,
	Error,
	{ contactId: string; data: UpdateContactInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			contactId,
			data,
		}: {
			contactId: string;
			data: UpdateContactInput;
		}) => clientApi.updateContact(contactId, data),
		onSuccess: (updatedContact: Contact) => {
			// Invalidate all contacts list
			queryClient.invalidateQueries({ queryKey: ["contacts"] });

			// Update cached contact
			queryClient.setQueryData(["contacts", updatedContact.id], updatedContact);

			// Invalidate all clients this contact is linked to
			updatedContact.client_contacts.forEach((link) => {
				queryClient.invalidateQueries({
					queryKey: ["clients", link.client_id, "contacts"],
				});
				queryClient.invalidateQueries({
					queryKey: ["clients", link.client_id],
				});
			});

			// Invalidate all related entities (list AND detail views)
			queryClient.invalidateQueries({ queryKey: ["jobs"] });
			queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			queryClient.invalidateQueries({ queryKey: ["quotes"] });
			queryClient.invalidateQueries({ queryKey: ["requests"] });
			queryClient.invalidateQueries({ queryKey: ["recurringPlans"] });
		},
		onError: (error: Error) => {
			console.error("Failed to update contact:", error);
		},
	});
};

export const useDeleteContactMutation = (): UseMutationResult<
	{ message: string },
	Error,
	string
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: clientApi.deleteContact,
		onSuccess: (_, deletedContactId) => {
			queryClient.invalidateQueries({ queryKey: ["contacts"] });
			queryClient.removeQueries({ queryKey: ["contacts", deletedContactId] });

			// Invalidate related entities as they might show this contact
			queryClient.invalidateQueries({ queryKey: ["clients"] });

			// Invalidate all related entities (list AND detail views)
			queryClient.invalidateQueries({ queryKey: ["jobs"] });
			queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			queryClient.invalidateQueries({ queryKey: ["quotes"] });
			queryClient.invalidateQueries({ queryKey: ["requests"] });
			queryClient.invalidateQueries({ queryKey: ["recurringPlans"] });
		},
		onError: (error: Error) => {
			console.error("Failed to delete contact:", error);
		},
	});
};

// ============================================================================
// CLIENT-CONTACT RELATIONSHIP MUTATIONS
// ============================================================================

export const useLinkContactMutation = (): UseMutationResult<
	ClientContactLink,
	Error,
	{
		clientId: string;
		data: {
			contact_id: string;
			relationship: string;
			is_primary: boolean;
			is_billing: boolean;
		};
	}
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			clientId,
			data,
		}: {
			clientId: string;
			data: {
				contact_id: string;
				relationship: string;
				is_primary: boolean;
				is_billing: boolean;
			};
		}) => clientApi.linkContactToClient(clientId, data),
		onSuccess: (_, variables) => {
			// Invalidate client-specific queries
			queryClient.invalidateQueries({
				queryKey: ["clients", variables.clientId, "contacts"],
			});
			queryClient.invalidateQueries({
				queryKey: ["clients", variables.clientId],
			});

			// Invalidate contact queries
			queryClient.invalidateQueries({
				queryKey: ["contacts", variables.data.contact_id],
			});
			queryClient.invalidateQueries({
				queryKey: ["contacts"],
			});

			// Invalidate all entities that display client/contact info
			if (variables.data.is_primary) {
				// Invalidate all related entities (list AND detail views)
				queryClient.invalidateQueries({ queryKey: ["jobs"] });
				queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
				queryClient.invalidateQueries({ queryKey: ["quotes"] });
				queryClient.invalidateQueries({ queryKey: ["requests"] });
				queryClient.invalidateQueries({ queryKey: ["recurringPlans"] });
			}
		},
		onError: (error: Error) => {
			console.error("Failed to link contact:", error);
		},
	});
};

export const useUpdateClientContactMutation = (): UseMutationResult<
	ClientContactLink,
	Error,
	{ clientId: string; contactId: string; data: UpdateClientContactInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			clientId,
			contactId,
			data,
		}: {
			clientId: string;
			contactId: string;
			data: UpdateClientContactInput;
		}) => clientApi.updateClientContact(clientId, contactId, data),
		onSuccess: (_, variables) => {
			// Invalidate client-specific queries
			queryClient.invalidateQueries({
				queryKey: ["clients", variables.clientId, "contacts"],
			});
			queryClient.invalidateQueries({
				queryKey: ["clients", variables.clientId],
			});

			// Invalidate contact queries
			queryClient.invalidateQueries({
				queryKey: ["contacts", variables.contactId],
			});

			// If primary status changed, invalidate everything that shows contact info
			if (variables.data.is_primary !== undefined) {
				// Invalidate all related entities (list AND detail views)
				queryClient.invalidateQueries({ queryKey: ["jobs"] });
				queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
				queryClient.invalidateQueries({ queryKey: ["quotes"] });
				queryClient.invalidateQueries({ queryKey: ["requests"] });
				queryClient.invalidateQueries({ queryKey: ["recurringPlans"] });
			}
		},
		onError: (error: Error) => {
			console.error("Failed to update client-contact relationship:", error);
		},
	});
};

export const useSetContactConsentMutation = (): UseMutationResult<
	Contact,
	Error,
	{
		clientId: string;
		contactId: string;
		data: { channel: ConsentChannel; status: "subscribed" | "unsubscribed" };
	}
> => {
	const queryClient = useQueryClient();

	return useMutation({
		meta: { silentError: true },
		mutationFn: ({ contactId, data }) => clientApi.setContactConsent(contactId, data),
		onSuccess: (_, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["clients", variables.clientId, "contacts"],
			});
			queryClient.invalidateQueries({ queryKey: ["clients", variables.clientId] });
			queryClient.invalidateQueries({ queryKey: ["contacts"] });
		},
		onError: (error: Error) => {
			console.error("Failed to update contact consent:", error);
		},
	});
};

export const useUnlinkContactFromClientMutation = (): UseMutationResult<
	{ message: string },
	Error,
	{ clientId: string; contactId: string }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ clientId, contactId }: { clientId: string; contactId: string }) =>
			clientApi.unlinkContactFromClient(clientId, contactId),
		onSuccess: (_, variables) => {
			// Invalidate client-specific queries
			queryClient.invalidateQueries({
				queryKey: ["clients", variables.clientId, "contacts"],
			});
			queryClient.invalidateQueries({
				queryKey: ["clients", variables.clientId],
			});

			// Invalidate contact queries
			queryClient.invalidateQueries({
				queryKey: ["contacts", variables.contactId],
			});

			// Invalidate all entities that might show this contact
			// Invalidate all related entities (list AND detail views)
			queryClient.invalidateQueries({ queryKey: ["jobs"] });
			queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			queryClient.invalidateQueries({ queryKey: ["quotes"] });
			queryClient.invalidateQueries({ queryKey: ["requests"] });
			queryClient.invalidateQueries({ queryKey: ["recurringPlans"] });
		},
		onError: (error: Error) => {
			console.error("Failed to unlink contact from client:", error);
		},
	});
};

// ============================================================================
// CLIENT NOTE QUERIES & MUTATIONS
// ============================================================================

export const useClientNotesQuery = (
	clientId: string | null | undefined,
	options?: { enabled?: boolean }
): UseQueryResult<ClientNote[], Error> => {
	return useQuery({
		queryKey: ["clients", clientId, "notes"],
		queryFn: () => clientApi.getClientNotes(clientId!),
		enabled: options?.enabled !== undefined ? options.enabled : !!clientId,
	});
};

export const useCreateClientNoteMutation = (): UseMutationResult<
	ClientNote,
	Error,
	{ clientId: string; data: CreateClientNoteInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			clientId,
			data,
		}: {
			clientId: string;
			data: CreateClientNoteInput;
		}) => clientApi.createClientNote(clientId, data),
		onSuccess: (_, variables) => {
			void queryClient.invalidateQueries({
				queryKey: ["clients", variables.clientId],
			});
			void queryClient.invalidateQueries({
				queryKey: ["clients", variables.clientId, "notes"],
			});
		},
		onError: (error: Error) => {
			console.error("Failed to create client note:", error);
		},
	});
};

export const useUpdateClientNoteMutation = (): UseMutationResult<
	ClientNote,
	Error,
	{ clientId: string; noteId: string; data: UpdateClientNoteInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			clientId,
			noteId,
			data,
		}: {
			clientId: string;
			noteId: string;
			data: UpdateClientNoteInput;
		}) => clientApi.updateClientNote(clientId, noteId, data),
		onSuccess: (_, variables) => {
			void queryClient.invalidateQueries({
				queryKey: ["clients", variables.clientId],
			});
			void queryClient.invalidateQueries({
				queryKey: ["clients", variables.clientId, "notes"],
			});
		},
		onError: (error: Error) => {
			console.error("Failed to update client note:", error);
		},
	});
};

export const useDeleteClientNoteMutation = (): UseMutationResult<
	{ message: string },
	Error,
	{ clientId: string; noteId: string }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ clientId, noteId }: { clientId: string; noteId: string }) =>
			clientApi.deleteClientNote(clientId, noteId),
		onSuccess: (_, variables) => {
			void queryClient.invalidateQueries({
				queryKey: ["clients", variables.clientId],
			});
			void queryClient.invalidateQueries({
				queryKey: ["clients", variables.clientId, "notes"],
			});
		},
		onError: (error: Error) => {
			console.error("Failed to delete client note:", error);
		},
	});
};
