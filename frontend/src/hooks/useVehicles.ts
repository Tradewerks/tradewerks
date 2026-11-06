import { useMutation, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { moduleQuery } from "./moduleQuery";
import type { Vehicle, CreateVehicleInput, UpdateVehicleInput, VehicleReadiness, VehicleMaintenanceRecord, CreateMaintenanceRecordInput, UpdateMaintenanceRecordInput, MaintenanceSourceLine, VehicleMaintenanceReminder, CreateMaintenanceReminderInput, UpdateMaintenanceReminderInput } from "../types/vehicles";
import * as vehiclesApi from "../api/vehicles";
import { qk, invalidate } from "../lib/queryKeys";

const useQuery = moduleQuery("fleet");

// ── Vehicle queries ────────────────────────────────────────────────────────────

export const useVehiclesQuery = (
	status?: string,
	options?: { enabled?: boolean },
): UseQueryResult<Vehicle[], Error> => {
	return useQuery({
		queryKey: qk.vehicles.list(status),
		queryFn: () => vehiclesApi.getVehicles(status),
		enabled: options?.enabled ?? true,
		staleTime: 30_000,
	});
};

// One vehicle off the cached list rather than a detail fetch: the list already
// carries make/model/plate and current_technicians, and every caller shares it.
export const useVehicleRecord = (id: string | null | undefined): Vehicle | null => {
	const { data } = useVehiclesQuery(undefined, { enabled: !!id });
	return data?.find((v) => v.id === id) ?? null;
};

export const useVehicleOdometer = (id: string | null | undefined): number | null =>
	useVehicleRecord(id)?.current_odometer_mi ?? null;

export const useVehicleMaintenanceQuery = (id: string | null | undefined): UseQueryResult<VehicleMaintenanceRecord[], Error> => {
	return useQuery({
		queryKey: qk.vehicles.maintenance(id ?? ""),
		queryFn: () => vehiclesApi.getMaintenanceRecords(id!),
		enabled: !!id,
		staleTime: 30_000,
	})
}

export const useVehicleMaintenanceReminderQuery = (id: string | null | undefined): UseQueryResult<VehicleMaintenanceReminder[], Error> => {
	return useQuery({
		queryKey: qk.vehicles.maintenanceReminders(id ?? ""),
		queryFn: () => vehiclesApi.getMaintenanceReminders(id!),
		enabled: !!id,
		staleTime: 30_000,
	})
}

export const useMaintenanceSourceLinesQuery = (vehicleId: string, q: string): UseQueryResult<MaintenanceSourceLine[], Error> => {
	return useQuery({
		queryKey: qk.vehicles.maintenanceSourceLines(vehicleId, q || undefined),
		queryFn: () => vehiclesApi.searchMaintenanceSourceLines(vehicleId, q || undefined),
		enabled: !!vehicleId,
		staleTime: 15_000,
	})
}

// ── Vehicle mutations ─────────────────────────────────────────────────────────

export const useCreateVehicleMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<Vehicle, Error, CreateVehicleInput>({
		mutationFn: vehiclesApi.createVehicle,
		onSuccess: () => {
			invalidate.vehicleStock(queryClient);
		},
	});
};

export const useUpdateVehicleMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<Vehicle, Error, { id: string; data: UpdateVehicleInput }>({
		mutationFn: ({ id, data }) => vehiclesApi.updateVehicle(id, data),
		onSuccess: (_result, { id }) => {
			invalidate.vehicleStock(queryClient, id);
		},
	});
};

// ── Technician vehicle assignment ─────────────────────────────────────────────

export const useSetTechnicianVehicleMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, Error, { technicianId: string; vehicleId: string | null }>({
		mutationFn: ({ technicianId, vehicleId }) => vehiclesApi.setTechnicianVehicle(technicianId, vehicleId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["technicians"] });
			invalidate.vehicleStock(queryClient);
		},
	});
};

// ── Readiness queries & mutations ─────────────────────────────────────────────

export const useVehicleReadinessQuery = (vehicleId: string | undefined, date?: string) =>
	useQuery({
		queryKey: qk.vehicles.readiness(vehicleId ?? "", date),
		queryFn: () => vehiclesApi.getVehicleReadiness(vehicleId!, date),
		enabled: !!vehicleId,
		staleTime: 30_000,
	});

export const useFleetReadinessQuery = (date: string, enabled = true) =>
	useQuery({
		queryKey: qk.fleetReadiness(date),
		queryFn: () => vehiclesApi.getFleetReadiness(date),
		enabled,
		staleTime: 30_000,
	});

export const useConfirmReadinessMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			vehicleId,
			body,
		}: {
			vehicleId: string;
			body: { date: string; notes?: string };
		}) => vehiclesApi.confirmVehicleReadiness(vehicleId, body),
		onSuccess: (data: VehicleReadiness, { vehicleId, body }) => {
			qc.setQueryData(qk.vehicles.readiness(vehicleId, body.date), data);
			qc.invalidateQueries({ queryKey: qk.fleetReadiness(body.date) });
		},
	});
};

export const useRevokeReadinessMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ vehicleId, date }: { vehicleId: string; date: string }) =>
			vehiclesApi.revokeVehicleReadiness(vehicleId, date),
		onSuccess: (data: VehicleReadiness, { vehicleId, date }) => {
			qc.setQueryData(qk.vehicles.readiness(vehicleId, date), data);
			qc.invalidateQueries({ queryKey: qk.fleetReadiness(date) });
		},
	});
};

export const useCreateMaintenanceRecordMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({vehicleId, data} : { vehicleId: string, data: CreateMaintenanceRecordInput}) => vehiclesApi.createMaintenanceRecord(vehicleId, data),
		onSuccess: (result: VehicleMaintenanceRecord, {vehicleId}) => {
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenance(vehicleId)});
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenanceReminders(vehicleId)});
			qc.invalidateQueries({ queryKey: qk.vehicles.list() });
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenanceAlerts });
		}
	})
}

export const useUpdateMaintenanceRecordMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({vehicleId, recordId, data} : { vehicleId: string, recordId: string, data: UpdateMaintenanceRecordInput}) => vehiclesApi.updateMaintenanceRecord(vehicleId, recordId, data),
		onSuccess: (result: VehicleMaintenanceRecord, {vehicleId}) => {
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenance(vehicleId)});
			qc.invalidateQueries({ queryKey: qk.vehicles.list() });
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenanceAlerts });
		}
	})
}

export const useDeleteMaintenanceRecordMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({vehicleId, reminderId} : { vehicleId: string, reminderId: string}) => vehiclesApi.deleteMaintenanceRecord(vehicleId, reminderId),
		onSuccess: (data: void, {vehicleId}) => {
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenance(vehicleId)});
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenanceAlerts });
		}
	})
}

export const useCreateMaintenanceReminderMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({vehicleId, data} : { vehicleId: string, data: CreateMaintenanceReminderInput}) => vehiclesApi.createMaintenanceReminder(vehicleId, data),
		onSuccess: (result: VehicleMaintenanceReminder, {vehicleId}) => {
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenanceReminders(vehicleId)});
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenanceAlerts });
		}
	})
}

export const useUpdateMaintenanceReminderMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({vehicleId, reminderId, data} : { vehicleId: string, reminderId: string, data: UpdateMaintenanceReminderInput}) => vehiclesApi.updateMaintenanceReminder(vehicleId, reminderId, data),
		onSuccess: (result: VehicleMaintenanceReminder, {vehicleId}) => {
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenanceReminders(vehicleId)});
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenanceAlerts });
		}
	})
}

export const useDeleteMaintenanceReminderMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({vehicleId, reminderId} : { vehicleId: string, reminderId: string}) => vehiclesApi.deleteMaintenanceReminder(vehicleId, reminderId),
		onSuccess: (data: void, {vehicleId}) => {
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenanceReminders(vehicleId)});
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenanceAlerts });
		}
	})
}

export const useAcknowledgeMaintenanceReminderMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({vehicleId, reminderId} : { vehicleId: string, reminderId: string}) => vehiclesApi.acknowledgeMaintenanceReminder(vehicleId, reminderId),
		onSuccess: (result: VehicleMaintenanceReminder, {vehicleId}) => {
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenanceReminders(vehicleId)});
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenanceAlerts });
		}
	})
}

export const useUnacknowledgeMaintenanceReminderMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({vehicleId, reminderId} : { vehicleId: string, reminderId: string}) => vehiclesApi.unacknowledgeMaintenanceReminder(vehicleId, reminderId),
		onSuccess: (result: VehicleMaintenanceReminder, {vehicleId}) => {
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenanceReminders(vehicleId)});
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenanceAlerts });
		}
	})
}

export const useCompleteMaintenanceReminderMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({vehicleId, reminderId} : { vehicleId: string, reminderId: string}) => vehiclesApi.completeMaintenanceReminder(vehicleId, reminderId),
		onSuccess: (result: VehicleMaintenanceReminder, {vehicleId}) => {
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenanceReminders(vehicleId)});
			qc.invalidateQueries({ queryKey: qk.vehicles.maintenanceAlerts });
		}
	})
}
