import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type { RegisterOrganizationInput, OrganizationRole } from "../types/organizations";

export const registerOrganization = async (input: RegisterOrganizationInput) => {
	const response = await api.post<ApiResponse<{ org: { id: string; name: string }; admin: { id: string; name: string; email: string } }>>(
		"/organizations/register",
		input,
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Registration failed");
	}

	return response.data.data!;
};

export const getOrgRoles = async () => {
	const response = await api.get<ApiResponse<OrganizationRole[]>>(
		`/organization-roles`
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to fetch organization roles");
	}

	return response.data.data ?? [];
};

export const createOrgRole = async (input: { name: string; base_tier: "dispatcher" | "technician"; permissions?: string[]; is_default?: boolean }) => {
	const response = await api.post<ApiResponse<OrganizationRole>>(
		`/organization-roles`,
		input,
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to create organization role");
	}

	return response.data.data!;
};

export const updateOrgRole = async (id: string, input: { name?: string; base_tier?: "dispatcher" | "technician"; permissions?: string[]; is_default?: boolean }) => {
	const response = await api.put<ApiResponse<OrganizationRole>>(
		`/organization-roles/${id}`,
		input,
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update organization role");
	}

	return response.data.data!;
};

export const deleteOrgRole = async (id: string) => {
	const response = await api.delete<ApiResponse<null>>(
		`/organization-roles/${id}`,
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to delete organization role");
	}

	return true;
};

export const getOrgRoleById = async (id: string) => {
	const response = await api.get<ApiResponse<{ id: string; name: string; base_tier: string; permissions: string[] }>>(
		`/organization-roles/${id}`,
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to fetch organization role");
	}

	return response.data.data!;
};

export const assignOrgRole = async (input: { user_id: string; user_type: "dispatcher" | "technician"; role_id: string | null }) => {
	const response = await api.post<ApiResponse<null>>(
		`/organization-roles/assign`,
		input,
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to assign organization role");
	}

	return true;
};
export const getBusinessTypes = async () =>
	(await api.get<ApiResponse<{ key: string; label: string }[]>>("/organizations/business-types")).data.data ?? [];

export const previewOrgInvite = async (token: string) =>
	(await api.post<ApiResponse<{ company: string; email: string }>>("/organizations/invites/preview", { token })).data.data!;

export const acceptOrgInvite = async (token: string, password: string) =>
	(await api.post<ApiResponse<{ email: string }>>("/organizations/invites/accept", { token, password })).data.data!;
