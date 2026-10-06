import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseMutationResult,
	type UseQueryResult,
} from "@tanstack/react-query";
import type {
	Technician,
	CreateTechnicianInput,
	UpdateTechnicianInput,
} from "../types/technicians";
import * as technicianApi from "../api/technicians";
import { getDeviceCoords } from "../lib/geolocation";
import { activeOnly } from "../lib/permissionAccess";
import { ENTITLEMENTS_QUERY_KEY } from "./useEntitlements";

export const useAllTechniciansQuery = (): UseQueryResult<Technician[], Error> => {
	return useQuery({
		queryKey: ["technicians"],
		queryFn: technicianApi.getAllTechnicians,
	});
};

export const useTechnicianByIdQuery = (
	id: string | null | undefined,
	options?: { enabled?: boolean }
): UseQueryResult<Technician, Error> => {
	return useQuery({
		queryKey: ["technicians", id],
		queryFn: () => technicianApi.getTechnicianById(id!),
		enabled: options?.enabled !== undefined ? options.enabled : !!id,
		// Automatically handles 404 errors as ApiError with NOT_FOUND code
		retry: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
};

export const useCreateTechnicianMutation = (): UseMutationResult<
	Technician,
	Error,
	CreateTechnicianInput
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: technicianApi.createTechnician,
		onSuccess: (newTechnician: Technician) => {
			queryClient.invalidateQueries({ queryKey: ["technicians"] });
			queryClient.setQueryData(["technicians", newTechnician.id], newTechnician);
		},
		onError: (error) => {
			console.error(`Failed to create technician:`, error.message);
		},
	});
};

export const useUpdateTechnicianMutation = (): UseMutationResult<
	Technician,
	Error,
	{ id: string; data: UpdateTechnicianInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateTechnicianInput }) =>
			technicianApi.updateTechnician(id, data),
		onSuccess: (updatedTechnician: Technician) => {
			queryClient.invalidateQueries({ queryKey: ["technicians"] });
			queryClient.setQueryData(
				["technicians", updatedTechnician.id],
				updatedTechnician
			);
		},
		onError: (error: Error) => {
			console.error(`Failed to update technician:`, error.message);
		},
	});
};

export const useChangeTechnicianPasswordMutation = (): UseMutationResult<
	Technician,
	Error,
	{ id: string; data: { current_password: string; new_password: string } }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: { current_password: string; new_password: string } }) =>
			technicianApi.changeTechnicianPassword(id, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["technicians"] });
		},
		onError: (error: Error) => {
			console.error(`Failed to change technician password:`, error.message);
		},
	});
};

export const useDeleteTechnicianMutation = (): UseMutationResult<
	{ message: string; id: string },
	Error,
	string
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: technicianApi.deleteTechnician,
		onMutate: async (deletedId: string) => {
			await queryClient.cancelQueries({ queryKey: ["technicians"] });
			const previousList = queryClient.getQueryData<Technician[]>(["technicians"]);
			queryClient.setQueryData<Technician[]>(["technicians"], (old) =>
				(old ?? []).filter((t) => t.id !== deletedId)
			);
			return { previousList };
		},
		onSuccess: (_, deletedId) => {
			queryClient.removeQueries({ queryKey: ["technicians", deletedId] });
		},
		onError: (error: Error, _id, context) => {
			queryClient.setQueryData(["technicians"], context?.previousList);
			console.error(`Failed to delete technician:`, error.message);
		},
	});
};


export const useSetTechnicianVehicleMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, Error, { technicianId: string; vehicleId: string | null }>({
		mutationFn: ({ technicianId, vehicleId }) =>
			technicianApi.setTechnicianCurrentVehicle(technicianId, vehicleId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["technicians"] });
			queryClient.invalidateQueries({ queryKey: ["vehicles"] });
		},
	});
};

export const useGoAvailableMutation = (): UseMutationResult<Technician, Error, string> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (techId: string) => technicianApi.goAvailable(techId),
		onSuccess: (updated) => {
			queryClient.setQueryData(["technicians", updated.id], updated);
			queryClient.invalidateQueries({ queryKey: ["technicians"] });
		},
	});
};

export const useGoOfflineMutation = (): UseMutationResult<Technician, Error, string> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (techId: string) => {
			const techCoords = await getDeviceCoords();
			return technicianApi.goOffline(techId, techCoords ?? undefined);
		},
		onSuccess: (updated) => {
			queryClient.setQueryData(["technicians", updated.id], updated);
			queryClient.invalidateQueries({ queryKey: ["technicians"] });
		},
	});
};

export const useGoOnBreakMutation = (): UseMutationResult<Technician, Error, { techId: string; reason: string }> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ techId, reason }) => technicianApi.goOnBreak(techId, reason),
		onSuccess: (updated) => {
			queryClient.setQueryData(["technicians", updated.id], updated);
			queryClient.invalidateQueries({ queryKey: ["technicians"] });
		},
	});
};

export const useMarkDoneMutation = (): UseMutationResult<Technician, Error, string> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (techId: string) => technicianApi.markDone(techId),
		onSuccess: (updated) => {
			queryClient.setQueryData(["technicians", updated.id], updated);
			queryClient.invalidateQueries({ queryKey: ["technicians"] });
		},
	});
};

export const useReturnFromJobMutation = (): UseMutationResult<Technician, Error, string> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (techId: string) => technicianApi.returnFromJob(techId),
		onSuccess: (updated) => {
			queryClient.setQueryData(["technicians", updated.id], updated);
			queryClient.invalidateQueries({ queryKey: ["technicians"] });
		},
	});
};

export const useActiveTechniciansQuery = (): UseQueryResult<Technician[], Error> =>
	useQuery({
		queryKey: ["technicians"],
		queryFn: technicianApi.getAllTechnicians,
		select: activeOnly,
	});

const useTechnicianStatusMutation = (fn: (id: string) => Promise<Technician>) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: async (_, id) => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["technicians"] }),
				queryClient.invalidateQueries({ queryKey: ["technicians", id] }),
				queryClient.invalidateQueries({ queryKey: ENTITLEMENTS_QUERY_KEY }),
			]);
		},
	});
};

export const useDeactivateTechnicianMutation = () => useTechnicianStatusMutation(technicianApi.deactivateTechnician);
export const useReactivateTechnicianMutation = () => useTechnicianStatusMutation(technicianApi.reactivateTechnician);
