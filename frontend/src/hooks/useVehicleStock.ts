import { useMutation, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { moduleQuery } from "./moduleQuery";
import * as vehicleApi from "../api/vehicles";
import type {
	VehicleStockItem,
	VehicleStockConflict,
	VehicleMaintenanceAlert,
	VehicleUsageTodayGroup,
	VehicleRestockRecord,
	CompleteRestockInput,
	AdjustStockInput,
	VehicleStockAdjustment,
	RestockRequest,
	FillPlan,
	ApplyFillInput,
	BulkRestockInput,
	TomorrowRequirementVisit,
	AddVehicleStockItemInput,
	UpdateVehicleStockItemInput,
	AddPartsUsedInput,
	RestockRequestInput,
	VehicleStockUsage,
} from "../types/vehicles";
import type { VisitLineItem } from "../types/jobs";
import { qk, invalidate } from "../lib/queryKeys";

const useQuery = moduleQuery("vehicle_stock");

// ── Vehicle stock queries ──────────────────────────────────────────────────────

export const useVehicleStockQuery = (vehicleId: string | null | undefined): UseQueryResult<VehicleStockItem[], Error> => {
	return useQuery({
		queryKey: qk.vehicles.stock(vehicleId ?? ""),
		queryFn: () => vehicleApi.getVehicleStock(vehicleId!),
		enabled: !!vehicleId,
		staleTime: 30_000,
	});
};

export const useVehicleStockConflictsQuery = () => {
	return useQuery<VehicleStockConflict[]>({
		queryKey: qk.vehicles.stockConflicts,
		queryFn: vehicleApi.getStockConflicts,
		staleTime: 30_000,
	});
};

export const useMaintenanceAlertsQuery = () =>
	useQuery<VehicleMaintenanceAlert[]>({
		queryKey: qk.vehicles.maintenanceAlerts,
		queryFn: vehicleApi.getMaintenanceAlerts,
		staleTime: 30_000,
	});

export const useFillPlanQuery = (vehicleId: string, enabled: boolean) =>
	useQuery<FillPlan>({
		queryKey: qk.vehicles.fillPlan(vehicleId),
		queryFn: () => vehicleApi.getFillPlan(vehicleId),
		enabled: !!vehicleId && enabled,
		staleTime: 0,
	});

export const useApplyFillMutation = (vehicleId: string) => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: ApplyFillInput) => vehicleApi.applyFill(vehicleId, input),
		onSuccess: async () => {
			await Promise.all([
				invalidate.stockData(qc, vehicleId),
				qc.invalidateQueries({ queryKey: qk.vehicles.fillPlan(vehicleId) }),
			]);
		},
	});
};

export const useVehicleUsageTodayQuery = (vehicleId: string) =>
	useQuery<VehicleUsageTodayGroup[]>({
		queryKey: qk.vehicles.usageToday(vehicleId),
		queryFn: () => vehicleApi.getUsageToday(vehicleId),
		enabled: !!vehicleId,
		staleTime: 30_000,
	});

export const useVehicleRestockTodayQuery = (vehicleId: string) =>
	useQuery<VehicleRestockRecord | null>({
		queryKey: qk.vehicles.restockToday(vehicleId),
		queryFn: () => vehicleApi.getVehicleRestockToday(vehicleId),
		enabled: !!vehicleId,
		staleTime: 30_000,
	});

export const useVehicleRestockHistoryQuery = (vehicleId: string, enabled: boolean) =>
	useQuery<VehicleRestockRecord[]>({
		queryKey: qk.vehicles.restockHistory(vehicleId),
		queryFn: () => vehicleApi.getVehicleRestockHistory(vehicleId),
		enabled: !!vehicleId && enabled,
		staleTime: 60_000,
	});

export const useVehicleStockAdjustmentHistoryQuery = (vehicleId: string, enabled: boolean) =>
	useQuery<VehicleStockAdjustment[]>({
		queryKey: qk.vehicles.stockAdjustments(vehicleId),
		queryFn: () => vehicleApi.getVehicleStockAdjustmentHistory(vehicleId),
		enabled: !!vehicleId && enabled,
		staleTime: 30_000,
	});

export const useAdjustStockMutation = (vehicleId: string) => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: AdjustStockInput) => vehicleApi.adjustStock(vehicleId, input),
		onSuccess: async () => {
			await Promise.all([
				invalidate.stockData(qc, vehicleId),
				qc.invalidateQueries({ queryKey: qk.vehicles.stockAdjustments(vehicleId) }),
			]);
		},
	});
};

export const useRestockRequestsQuery = (status?: string, vehicleId?: string) =>
	useQuery<RestockRequest[]>({
		queryKey: qk.restockRequests.list({ status, vehicleId }),
		queryFn: () => vehicleApi.getRestockRequests(status, vehicleId),
		staleTime: 30_000,
	});

export const useAcknowledgeRestockRequestMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (requestId: string) => vehicleApi.acknowledgeRestockRequest(requestId),
		onSuccess: async () => {
			await invalidate.restockRequests(qc);
		},
	});
};

export const useDismissRestockRequestMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (requestId: string) => vehicleApi.dismissRestockRequest(requestId),
		onSuccess: async () => {
			await invalidate.restockRequests(qc);
		},
	});
};

export const useTomorrowRequirementsQuery = (vehicleId: string) =>
	useQuery<TomorrowRequirementVisit[]>({
		queryKey: qk.vehicles.tomorrowRequirements(vehicleId),
		queryFn: () => vehicleApi.getTomorrowRequirements(vehicleId),
		staleTime: 60_000,
	});

export const useCompleteRestockMutation = (vehicleId: string) => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: CompleteRestockInput) => vehicleApi.completeRestock(vehicleId, input),
		onSuccess: async () => {
			await Promise.all([
				invalidate.stockData(qc, vehicleId),
				qc.invalidateQueries({ queryKey: qk.vehicles.restockToday(vehicleId) }),
				invalidate.restockRequests(qc),
			]);
		},
	});
};

export const useVehicleRestockRequestsQuery = (vehicleId: string) =>
	useQuery<RestockRequest[]>({
		queryKey: qk.restockRequests.list({ vehicleId }),
		queryFn: () => vehicleApi.getVehicleRestockRequests(vehicleId),
		enabled: !!vehicleId,
		staleTime: 30_000,
	});

export const useBulkRestockMutation = (vehicleId: string) => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: BulkRestockInput) => vehicleApi.createRestockRequestsBulk(vehicleId, input),
		onSuccess: async () => {
			await invalidate.restockRequests(qc);
		},
	});
};

// ── Stock item CRUD ────────────────────────────────────────────────────────────

export const useAddVehicleStockItemMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<VehicleStockItem, Error, { vehicleId: string; data: AddVehicleStockItemInput }>({
		mutationFn: ({ vehicleId, data }) => vehicleApi.addVehicleStockItem(vehicleId, data),
		onSuccess: (_result, { vehicleId }) => {
			invalidate.stockData(queryClient, vehicleId);
		},
	});
};

export const useUpdateVehicleStockItemMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<VehicleStockItem, Error, { vehicleId: string; itemId: string; data: UpdateVehicleStockItemInput }>({
		mutationFn: ({ vehicleId, itemId, data }) => vehicleApi.updateVehicleStockItem(vehicleId, itemId, data),
		onSuccess: (_result, { vehicleId }) => {
			invalidate.stockData(queryClient, vehicleId);
		},
	});
};

export const useDeleteVehicleStockItemMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, Error, { vehicleId: string; itemId: string }>({
		mutationFn: ({ vehicleId, itemId }) => vehicleApi.deleteVehicleStockItem(vehicleId, itemId),
		onSuccess: (_result, { vehicleId }) => {
			invalidate.stockData(queryClient, vehicleId);
		},
	});
};

export const useRestockRequestMutation = () => {
	const qc = useQueryClient();
	return useMutation<void, Error, { vehicleId: string; itemId: string; data: RestockRequestInput }>({
		mutationFn: ({ vehicleId, itemId, data }) => vehicleApi.createRestockRequest(vehicleId, itemId, data),
		onSuccess: async () => {
			await invalidate.restockRequests(qc);
		},
	});
};

// ── Parts used ────────────────────────────────────────────────────────────────

export const useAddPartsUsedMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<
		{ lineItem: VisitLineItem; usage: VehicleStockUsage },
		Error,
		{ visitId: string; vehicleId: string; data: AddPartsUsedInput }
	>({
		mutationFn: ({ visitId, data }) => vehicleApi.addPartsUsed(visitId, data),
		onSuccess: (_result, { visitId, vehicleId }) => {
			queryClient.invalidateQueries({ queryKey: ["jobVisits", visitId] });
			queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			invalidate.stockData(queryClient, vehicleId);
		},
	});
};

export const useUpdatePartsUsedQtyMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<
		VisitLineItem | null,
		Error,
		{ visitId: string; lineItemId: string; vehicleId: string | null; data: { technician_id: string; quantity: number } }
	>({
		mutationFn: ({ visitId, lineItemId, data }) => vehicleApi.updatePartsUsedQty(visitId, lineItemId, data),
		onSuccess: (_result, { visitId, vehicleId }) => {
			queryClient.invalidateQueries({ queryKey: ["jobVisits", visitId] });
			queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			if (vehicleId) invalidate.stockData(queryClient, vehicleId);
		},
	});
};
