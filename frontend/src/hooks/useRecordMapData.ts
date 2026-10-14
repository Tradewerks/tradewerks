import { useMemo } from "react";
import { useLiveTechnicians } from "./useTechnicianMarkers";
import { useTechRoutes } from "./useTechRoutes";
import { useOrgSettings } from "./useOrg";
import { normalizeCoords, type Coordinates } from "../types/location";
import { buildRecordMapModel, isTechActiveOn, type RecordMapModel } from "../lib/recordMap";

export interface RecordMapScope {
	/** Raw job coords — legacy records store longitude as `lng`. */
	site: { coords: unknown; label: string };
	techIds: string[];
	focusVisitIds: string[];
	hideTechs?: boolean;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

// Callers pass fresh arrays every render; key the Set on content so the route
// queries and the model memo hold steady.
function useStableSet(ids: string[]): ReadonlySet<string> {
	const key = [...ids].sort().join("|");
	// eslint-disable-next-line react-hooks/exhaustive-deps
	return useMemo(() => new Set(ids), [key]);
}

function useStableCoords(raw: unknown): Coordinates | null {
	const c = normalizeCoords(raw);
	const lat = c?.lat;
	const lon = c?.lon;
	return useMemo(() => (lat != null && lon != null ? { lat, lon } : null), [lat, lon]);
}

export function useRecordMapData(scope: RecordMapScope): RecordMapModel & { isLoading: boolean } {
	const { technicians, isLoading } = useLiveTechnicians();
	const { data: org, isLoading: orgLoading } = useOrgSettings();
	const techIds = useStableSet(scope.techIds);
	const focusVisitIds = useStableSet(scope.focusVisitIds);
	const hideTechs = scope.hideTechs ?? false;
	const routes = useTechRoutes(technicians, hideTechs ? EMPTY_SET : techIds);
	const siteCoords = useStableCoords(scope.site.coords);
	const orgCoords = useStableCoords(org?.coords);
	const orgName = org?.name ?? "Office";

	const model = useMemo(
		() =>
			buildRecordMapModel({
				technicians,
				routes,
				site: { coords: siteCoords, label: scope.site.label },
				org: orgLoading ? null : { coords: orgCoords, name: orgName },
				techIds,
				focusVisitIds,
				hideTechs,
			}),
		[
			technicians,
			routes,
			siteCoords,
			scope.site.label,
			orgLoading,
			orgCoords,
			orgName,
			techIds,
			focusVisitIds,
			hideTechs,
		],
	);

	return { ...model, isLoading };
}

export function useActiveTechCount(visitIds: string[]): number {
	const { technicians } = useLiveTechnicians();
	const ids = useStableSet(visitIds);
	return useMemo(
		() => technicians.filter((t) => isTechActiveOn(t, ids)).length,
		[technicians, ids],
	);
}
