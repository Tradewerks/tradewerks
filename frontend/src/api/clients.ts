import { isAxiosError } from "axios";
import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type {
	Client,
	CreateClientInput,
	UpdateClientInput,
	Contact,
	ClientContactLink,
	CreateContactInput,
	UpdateContactInput,
	UpdateClientContactInput,
	ClientNote,
	CreateClientNoteInput,
	UpdateClientNoteInput,
} from "../types/clients";
import type { Project } from "../types/project";


// ============================================================================
// CLIENT API
// ============================================================================

export const getAllClients = async (): Promise<Client[]> => {
	const response = await api.get<ApiResponse<Client[]>>("/clients");
	return response.data.data || [];
};

export const getClientById = async (id: string): Promise<Client> => {
	const response = await api.get<ApiResponse<Client>>(`/clients/${id}`);

	if (!response.data.data) {
		throw new Error("Client not found");
	}

	return response.data.data;
};

export const createClient = async (input: CreateClientInput): Promise<Client> => {
	const response = await api.post<ApiResponse<Client>>("/clients", input);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to create client");
	}

	return response.data.data!;
};

export const updateClient = async (id: string, data: UpdateClientInput): Promise<Client> => {
	const response = await api.put<ApiResponse<Client>>(`/clients/${id}`, data);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update client");
	}

	return response.data.data!;
};

export const deleteClient = async (id: string): Promise<{ message: string; id: string }> => {
	try {
		const response = await api.delete<ApiResponse<{ message: string; id: string }>>(
			`/clients/${id}`
		);
		return response.data.data || { message: "Client deleted successfully", id };
	} catch (err) {
		// A refusal comes back as a 400, so axios throws before the body is read.
		throw new Error(
			(isAxiosError(err) && err.response?.data?.error?.message) || "Failed to delete client"
		);
	}
};

// ============================================================================
// INDEPENDENT CONTACT API
// ============================================================================

export const getAllContacts = async (): Promise<Contact[]> => {
	const response = await api.get<ApiResponse<Contact[]>>("/contacts");
	return response.data.data || [];
};

export const getContactById = async (contactId: string): Promise<Contact> => {
	const response = await api.get<ApiResponse<Contact>>(`/contacts/${contactId}`);

	if (!response.data.data) {
		throw new Error("Contact not found");
	}

	return response.data.data;
};

export const getClientContacts = async (clientId: string): Promise<ClientContactLink[]> => {
	const response = await api.get<ApiResponse<ClientContactLink[]>>(
		`/clients/${clientId}/contacts`
	);
	return response.data.data || [];
};

export const createContact = async (data: CreateContactInput): Promise<Contact> => {
	const response = await api.post<ApiResponse<Contact>>("/contacts", data);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to create contact");
	}

	return response.data.data!;
};

export const updateContact = async (
	contactId: string,
	data: UpdateContactInput
): Promise<Contact> => {
	const response = await api.put<ApiResponse<Contact>>(`/contacts/${contactId}`, data);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update contact");
	}

	return response.data.data!;
};

export const deleteContact = async (contactId: string): Promise<{ message: string }> => {
	const response = await api.delete<ApiResponse<{ message: string }>>(
		`/contacts/${contactId}`
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to delete contact");
	}

	return response.data.data || { message: "Contact deleted successfully" };
};

export const searchContacts = async (
	query: string,
	excludeClientId?: string
): Promise<Contact[]> => {
	const params = new URLSearchParams({ q: query });
	if (excludeClientId) {
		params.append("exclude_client_id", excludeClientId);
	}

	const response = await api.get<ApiResponse<Contact[]>>(`/contacts/search?${params}`);
	return response.data.data || [];
};

// ============================================================================
// CLIENT-CONTACT RELATIONSHIP API
// ============================================================================

export const linkContactToClient = async (
	clientId: string,
	data: {
		contact_id: string;
		relationship: string;
		is_primary: boolean;
		is_billing: boolean;
	}
): Promise<ClientContactLink> => {
	const response = await api.post<ApiResponse<ClientContactLink>>(
		`/clients/${clientId}/contacts/link`,
		data
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to link contact to client");
	}

	return response.data.data!;
};

export const updateClientContact = async (
	clientId: string,
	contactId: string,
	data: UpdateClientContactInput
): Promise<ClientContactLink> => {
	const response = await api.put<ApiResponse<ClientContactLink>>(
		`/clients/${clientId}/contacts/${contactId}/relationship`,
		data
	);

	if (!response.data.success) {
		throw new Error(
			response.data.error?.message ||
				"Failed to update client-contact relationship"
		);
	}

	return response.data.data!;
};

export const unlinkContactFromClient = async (
	clientId: string,
	contactId: string
): Promise<{ message: string }> => {
	const response = await api.delete<ApiResponse<{ message: string }>>(
		`/clients/${clientId}/contacts/${contactId}/link`
	);

	if (!response.data.success) {
		throw new Error(
			response.data.error?.message || "Failed to unlink contact from client"
		);
	}

	return response.data.data || { message: "Contact unlinked successfully" };
};

// ============================================================================
// CLIENT NOTE API
// ============================================================================

export const getClientNotes = async (clientId: string): Promise<ClientNote[]> => {
	const response = await api.get<ApiResponse<ClientNote[]>>(`/clients/${clientId}/notes`);
	return response.data.data || [];
};

export const createClientNote = async (
	clientId: string,
	data: CreateClientNoteInput
): Promise<ClientNote> => {
	const response = await api.post<ApiResponse<ClientNote>>(
		`/clients/${clientId}/notes`,
		data
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to create client note");
	}

	return response.data.data!;
};

export const updateClientNote = async (
	clientId: string,
	noteId: string,
	data: UpdateClientNoteInput
): Promise<ClientNote> => {
	const response = await api.put<ApiResponse<ClientNote>>(
		`/clients/${clientId}/notes/${noteId}`,
		data
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update client note");
	}

	return response.data.data!;
};

export const deleteClientNote = async (
	clientId: string,
	noteId: string
): Promise<{ message: string }> => {
	const response = await api.delete<ApiResponse<{ message: string }>>(
		`/clients/${clientId}/notes/${noteId}`
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to delete client note");
	}

	return response.data.data || { message: "Client note deleted successfully" };
};

export const getClientProjects = async (clientId: string): Promise<Project[]> => {
	const response = await api.get<ApiResponse<Project[]>>(`/clients/${clientId}/projects`);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to fetch client projects");
	}
	return response.data.data || [];
}