import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseMutationResult,
	type UseQueryResult,
} from "@tanstack/react-query";
import type {
	Dispatcher,
	CreateDispatcherInput,
	UpdateDispatcherInput,
} from "../types/dispatchers";
import * as dispatcherApi from "../api/dispatchers";
import { activeOnly } from "../lib/permissionAccess";
import { ENTITLEMENTS_QUERY_KEY } from "./useEntitlements";

export const useAllDispatchersQuery = (): UseQueryResult<Dispatcher[], Error> => {
	return useQuery({
		queryKey: ["dispatchers"],
		queryFn: dispatcherApi.getAllDispatchers,
	});
};

export const useDispatcherByIdQuery = (
	id: string | null | undefined,
	options?: { enabled?: boolean }
): UseQueryResult<Dispatcher, Error> => {
	return useQuery({
		queryKey: ["dispatchers", id],
		queryFn: () => dispatcherApi.getDispatcherById(id!),
		enabled: options?.enabled !== undefined ? options.enabled : !!id,
		retry: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
};

export const useCreateDispatcherMutation = (): UseMutationResult<
	Dispatcher,
	Error,
	CreateDispatcherInput
> => {
	const queryClient = useQueryClient();
 
	return useMutation({
		mutationFn: dispatcherApi.createDispatcher,
		onSuccess: (newDispatcher: Dispatcher) => {
			queryClient.invalidateQueries({ queryKey: ["dispatchers"] });
			queryClient.setQueryData(["dispatchers", newDispatcher.id], newDispatcher);
		},
		onError: (error) => {
			console.error(`Failed to create dispatcher:`, error.message);
		},
	});
};

export const useUpdateDispatcherMutation = (): UseMutationResult<
	Dispatcher,
	Error,
	{ id: string; data: UpdateDispatcherInput }
> => {
	const queryClient = useQueryClient();
 
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateDispatcherInput }) =>
			dispatcherApi.updateDispatcher(id, data),
		onSuccess: (updatedDispatcher: Dispatcher) => {
			queryClient.invalidateQueries({ queryKey: ["dispatchers"] });
			queryClient.setQueryData(
				["dispatchers", updatedDispatcher.id],
				updatedDispatcher
			);
		},
		onError: (error: Error) => {
			console.error(`Failed to update dispatcher:`, error.message);
		},
	});
};

export const useChangeDispatcherPasswordMutation = (): UseMutationResult<
	Dispatcher,
	Error,
	{ id: string; data: { current_password: string; new_password: string } }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: { current_password: string; new_password: string } }) =>
			dispatcherApi.changeDispatcherPassword(id, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["dispatchers"] });
		},
		onError: (error: Error) => {
			console.error(`Failed to change dispatcher password:`, error.message);
		},
	});
};

export const useDeleteDispatcherMutation = (): UseMutationResult<
	{ message: string; id: string },
	Error,
	string
> => {
	const queryClient = useQueryClient();
 
	return useMutation({
		mutationFn: dispatcherApi.deleteDispatcher,
		onMutate: async (deletedId: string) => {
			await queryClient.cancelQueries({ queryKey: ["dispatchers"] });
			const previousList = queryClient.getQueryData<Dispatcher[]>(["dispatchers"]);
			queryClient.setQueryData<Dispatcher[]>(["dispatchers"], (old) =>
				(old ?? []).filter((d) => d.id !== deletedId)
			);
			return { previousList };
		},
		onSuccess: (_, deletedId) => {
			queryClient.removeQueries({ queryKey: ["dispatchers", deletedId] });
		},
		onError: (error: Error, _id, context) => {
			queryClient.setQueryData(["dispatchers"], context?.previousList);
			console.error(`Failed to delete dispatcher:`, error.message);
		},
	});
};

export const useActiveDispatchersQuery = (): UseQueryResult<Dispatcher[], Error> =>
	useQuery({
		queryKey: ["dispatchers"],
		queryFn: dispatcherApi.getAllDispatchers,
		select: activeOnly,
	});

const useDispatcherStatusMutation = (fn: (id: string) => Promise<Dispatcher>) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: async (_, id) => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["dispatchers"] }),
				queryClient.invalidateQueries({ queryKey: ["dispatchers", id] }),
				queryClient.invalidateQueries({ queryKey: ENTITLEMENTS_QUERY_KEY }),
			]);
		},
	});
};

export const useDeactivateDispatcherMutation = () => useDispatcherStatusMutation(dispatcherApi.deactivateDispatcher);
export const useReactivateDispatcherMutation = () => useDispatcherStatusMutation(dispatcherApi.reactivateDispatcher);
