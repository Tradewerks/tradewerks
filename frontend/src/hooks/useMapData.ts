import { useMemo, useState } from "react";
import { useAllClientsQuery } from "./useClients";
import { useLiveTechnicians } from "./useTechnicianMarkers";
import { useTechRoutes } from "./useTechRoutes";
import type { StaticMarker, TechRouteData } from "../types/location";
import type { Technician } from "../types/technicians";
import type { Client } from "../types/clients";
import type { MapFilters } from "../components/ui/maps/MapPanel";
import { buildTechMarker, hasValidCoords } from "../lib/mapMarkers";

interface UseMapDataResult {
	markers: StaticMarker[];
	techRoutes: TechRouteData[];
	allTechnicians: Technician[];
	allDrivingRoutes: TechRouteData[];
	allClients: Client[];
	clientCount: number;
	isLoading: boolean;
	filters: MapFilters;
	setFilters: (next: MapFilters) => void;
}

export function useMapData(): UseMapDataResult {
	const { technicians, isLoading: techLoading } = useLiveTechnicians();
	const { data: clients, isLoading: clientsLoading } = useAllClientsQuery();
	const allDrivingRoutes = useTechRoutes(technicians);

	const [filters, setFilters] = useState<MapFilters>({
		showClients: true,
		hiddenClientIds: new Set<string>(),
		showRoutes: true,
		hiddenRouteIds: new Set<string>(),
		showETAs: true,
		hiddenETAIds: new Set<string>(),
		showTechs: true,
		hiddenTechIds: new Set<string>(),
	});

	const drivingRouteById = useMemo(
		() => new Map(allDrivingRoutes.map((r) => [r.techId, r])),
		[allDrivingRoutes],
	);

	const visibleRoutes = useMemo(
		() =>
			allDrivingRoutes.filter(
				(r) =>
					filters.showRoutes &&
					!filters.hiddenRouteIds.has(r.techId) &&
					filters.showTechs &&
					!filters.hiddenTechIds.has(r.techId),
			),
		[
			allDrivingRoutes,
			filters.showRoutes,
			filters.hiddenRouteIds,
			filters.showTechs,
			filters.hiddenTechIds,
		],
	);

	const markers = useMemo<StaticMarker[]>(() => {
		const out: StaticMarker[] = [];

		if (filters.showClients && clients) {
			for (const c of clients) {
				if (filters.hiddenClientIds.has(c.id)) continue;
				if (!hasValidCoords(c.coords)) continue;
				out.push({
					id: `client-${c.id}`,
					coords: c.coords,
					type: "CLIENT",
					label: c.name,
				});
			}
		}

		if (filters.showTechs) {
			for (const tech of technicians) {
				if (filters.hiddenTechIds.has(tech.id)) continue;
				if (!hasValidCoords(tech.coords)) continue;

				out.push(
					buildTechMarker(tech, {
						route: drivingRouteById.get(tech.id) ?? null,
						showEta: filters.showETAs && !filters.hiddenETAIds.has(tech.id),
					}),
				);
			}
		}

		return out;
	}, [
		clients,
		technicians,
		drivingRouteById,
		filters.showClients,
		filters.hiddenClientIds,
		filters.showTechs,
		filters.hiddenTechIds,
		filters.showETAs,
		filters.hiddenETAIds,
	]);

	return {
		markers,
		techRoutes: visibleRoutes,
		allTechnicians: technicians,
		allDrivingRoutes,
		allClients: clients ?? [],
		clientCount: clients?.length ?? 0,
		isLoading: techLoading || clientsLoading,
		filters,
		setFilters,
	};
}
