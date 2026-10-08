import type { Coordinates, StaticMarker, TechRouteData } from "../types/location";
import type { Technician, TechnicianStatus, VisitTechnician } from "../types/technicians";
import { buildTechMarker, hasValidCoords } from "./mapMarkers";

export type VisitTechStatus = "Assigned" | "EnRoute" | "OnSite" | "Done";

export const SITE_MARKER_ID = "site";
export const ORG_MARKER_ID = "org";

// Travelling to the visit or at it. Assigned-but-not-started and Done don't count.
const ACTIVE_VISIT_TECH: ReadonlySet<string> = new Set(["EnRoute", "OnSite"]);

const CLOSED_VISIT_STATUS: ReadonlySet<string> = new Set(["Completed", "Cancelled"]);

export interface RecordMapSite {
	coords: Coordinates | null;
	label: string;
}

export interface RecordMapOrg {
	coords: Coordinates | null;
	name: string;
}

export interface RecordMapInput {
	technicians: Technician[];
	routes: TechRouteData[];
	site: RecordMapSite;
	/** Null while org settings are still loading. */
	org: RecordMapOrg | null;
	techIds: ReadonlySet<string>;
	focusVisitIds: ReadonlySet<string>;
	hideTechs: boolean;
}

export interface RecordMapTechRow {
	techId: string;
	name: string;
	status: TechnicianStatus;
	visitId: string | null;
	visitTechStatus: VisitTechStatus | null;
	activeHere: boolean;
	drivingElsewhere: boolean;
	etaSeconds: number | null;
	distanceMeters: number | null;
	coords: Coordinates | null;
	color: string | null;
	/** Closed visit: the tech's whereabouts are withheld, not unknown. */
	positionHidden: boolean;
	/** ISO time of the tech's last device ping; null when hidden or never pinged. */
	lastPingAt?: string | null;
}

export interface RecordMapModel {
	markers: StaticMarker[];
	routes: TechRouteData[];
	techRows: RecordMapTechRow[];
	siteCoords: Coordinates | null;
	orgCoords: Coordinates | null;
	orgName: string | null;
	siteMissing: boolean;
	orgMissing: boolean;
	activeCount: number;
}

export function isTechActiveOn(tech: Technician, visitIds: ReadonlySet<string>): boolean {
	return (tech.visit_techs ?? []).some(
		(vt) => visitIds.has(vt.visit_id) && ACTIVE_VISIT_TECH.has(vt.tech_status ?? ""),
	);
}

function startMs(vt: VisitTechnician): number {
	const t = new Date(vt.visit?.scheduled_start_at ?? NaN).getTime();
	return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

// Which of a multi-visit tech's assignments they are listed under: the visit they are driving
// to, then one they are active on, then the earliest scheduled. Never depends on payload order.
export function focusAssignment(
	tech: Technician,
	focusVisitIds: ReadonlySet<string>,
	routeVisitId?: string | null,
): VisitTechnician | null {
	const mine = (tech.visit_techs ?? []).filter((vt) => focusVisitIds.has(vt.visit_id));
	const routed = routeVisitId ? mine.find((vt) => vt.visit_id === routeVisitId) : undefined;
	if (routed) return routed;
	const earliest = (list: VisitTechnician[]) =>
		[...list].sort(
			(a, b) => startMs(a) - startMs(b) || a.visit_id.localeCompare(b.visit_id),
		)[0] ?? null;
	const active = mine.filter((vt) => ACTIVE_VISIT_TECH.has(vt.tech_status ?? ""));
	if (active.length > 0) return earliest(active);
	// A finished visit must not outrank the one the tech still has to work.
	const open = mine.filter((vt) => !CLOSED_VISIT_STATUS.has(vt.visit?.status ?? ""));
	return earliest(open.length > 0 ? open : mine);
}

function onlyClosedFocusVisits(tech: Technician, focusVisitIds: ReadonlySet<string>): boolean {
	const mine = (tech.visit_techs ?? []).filter((vt) => focusVisitIds.has(vt.visit_id));
	return (
		mine.length > 0 && mine.every((vt) => CLOSED_VISIT_STATUS.has(vt.visit?.status ?? ""))
	);
}

export function buildRecordMapModel(input: RecordMapInput): RecordMapModel {
	const { technicians, routes, site, org, techIds, focusVisitIds, hideTechs } = input;
	const markers: StaticMarker[] = [];

	const siteCoords = hasValidCoords(site.coords) ? site.coords : null;
	if (siteCoords) {
		markers.push({ id: SITE_MARKER_ID, type: "SITE", coords: siteCoords, label: site.label });
	}

	const orgCoords = org && hasValidCoords(org.coords) ? org.coords : null;
	if (org && orgCoords) {
		markers.push({
			id: ORG_MARKER_ID,
			type: "WAREHOUSE",
			coords: orgCoords,
			label: org.name,
			fitIgnore: true,
		});
	}

	const routeByTech = new Map(routes.map((r) => [r.techId, r]));
	const focusRoutes: TechRouteData[] = [];

	const techRows = technicians
		.filter((t) => techIds.has(t.id))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((tech): RecordMapTechRow => {
			const route = routeByTech.get(tech.id) ?? null;
			const routeHere = route && focusVisitIds.has(route.visitId) ? route : null;
			const drivingElsewhere = !!route && !routeHere;
			const activeHere = isTechActiveOn(tech, focusVisitIds);
			const coords = hasValidCoords(tech.coords) ? tech.coords : null;
			const assignment = focusAssignment(tech, focusVisitIds, routeHere?.visitId);
			const hidden = hideTechs || onlyClosedFocusVisits(tech, focusVisitIds);

			if (!hidden) {
				if (routeHere) focusRoutes.push(routeHere);
				if (coords) {
					const marker = buildTechMarker(tech, {
						route: routeHere,
						showEta: true,
						note: drivingElsewhere ? "En route elsewhere" : undefined,
					});
					// An idle tech parked at home would zoom the site out to a dot.
					markers.push(activeHere || routeHere ? marker : { ...marker, fitIgnore: true });
				}
			}

			return {
				techId: tech.id,
				name: tech.name,
				status: tech.status,
				visitId: assignment?.visit_id ?? null,
				visitTechStatus: (assignment?.tech_status as VisitTechStatus | undefined) ?? null,
				activeHere,
				drivingElsewhere,
				etaSeconds: hidden ? null : (routeHere?.etaSeconds ?? null),
				distanceMeters: hidden ? null : (routeHere?.distanceMeters ?? null),
				coords: hidden ? null : coords,
				color: routeHere?.color ?? null,
				positionHidden: hidden,
				lastPingAt: hidden ? null : (tech.last_ping_at ?? null),
			};
		});

	return {
		markers,
		routes: focusRoutes,
		techRows,
		siteCoords,
		orgCoords,
		orgName: org?.name ?? null,
		siteMissing: !siteCoords,
		orgMissing: org !== null && !orgCoords,
		activeCount: techRows.filter((r) => r.activeHere).length,
	};
}
