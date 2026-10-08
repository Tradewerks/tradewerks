import { useEffect, useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import { fetchDrivingRoute } from "../api/directions";
import { distanceMeters, getTechColor } from "../lib/techColors";
import type { Technician } from "../types/technicians";
import type { Coordinates, DirectionsResult, TechRouteData } from "../types/location";

const DRIFT_THRESHOLD_METERS = 100;
const ROUTE_STALE_MS = 30_000;

interface DrivingTarget {
	techId: string;
	techName: string;
	visitId: string;
	jobId: string;
	current: Coordinates;
	destination: Coordinates;
	destinationLabel: string;
}

function pickDrivingTarget(tech: Technician): DrivingTarget | null {
	// A 2nd tech driving to a visit already OnSite only flips their own tech_status
	const drivingVisits = (tech.visit_techs ?? [])
		.filter((vt) => vt.visit.status === "Driving" || vt.tech_status === "EnRoute")
		.map((vt) => vt.visit);

	if (drivingVisits.length === 0) return null;

	drivingVisits.sort(
		(a, b) =>
			new Date(a.scheduled_start_at).getTime() -
			new Date(b.scheduled_start_at).getTime(),
	);

	const visit = drivingVisits[0];
	const dest = visit.job.coords;
	if (!dest || typeof dest.lat !== "number" || typeof dest.lon !== "number") {
		return null;
	}

	return {
		techId: tech.id,
		techName: tech.name,
		visitId: visit.id,
		jobId: visit.job_id,
		current: tech.coords,
		destination: dest,
		destinationLabel: visit.job.client?.name || visit.job.name,
	};
}

// Snap the tech's "query origin" so we don't refetch the route on every tiny ping.
// We only move the origin forward when the tech has drifted > threshold from it,
// or when the destination changes.
function useSnappedOrigin(targets: DrivingTarget[]): Map<string, Coordinates> {
	const snappedRef = useRef<Map<string, { origin: Coordinates; dest: Coordinates }>>(
		new Map(),
	);

	const snapped = new Map<string, Coordinates>();
	const activeIds = new Set<string>();

	for (const target of targets) {
		activeIds.add(target.techId);
		const prev = snappedRef.current.get(target.techId);

		const destChanged =
			!prev ||
			prev.dest.lat !== target.destination.lat ||
			prev.dest.lon !== target.destination.lon;
		const drifted =
			!!prev && distanceMeters(prev.origin, target.current) > DRIFT_THRESHOLD_METERS;

		if (!prev || destChanged || drifted) {
			snappedRef.current.set(target.techId, {
				origin: target.current,
				dest: target.destination,
			});
			snapped.set(target.techId, target.current);
		} else {
			snapped.set(target.techId, prev.origin);
		}
	}

	// Prune stale entries for techs that are no longer driving.
	for (const id of Array.from(snappedRef.current.keys())) {
		if (!activeIds.has(id)) snappedRef.current.delete(id);
	}

	return snapped;
}

export function useTechRoutes(
	technicians: Technician[],
	scopeTechIds?: ReadonlySet<string>,
): TechRouteData[] {
	const allTargets = useMemo<DrivingTarget[]>(() => {
		return technicians
			.map(pickDrivingTarget)
			.filter((t): t is DrivingTarget => t !== null)
			.sort((a, b) => a.techId.localeCompare(b.techId));
	}, [technicians]);

	// Colors index into the org-wide driving order, so a scoped map paints a tech
	// the same color the main map does.
	const orderedIds = useMemo(() => allTargets.map((t) => t.techId), [allTargets]);

	const targets = useMemo(
		() =>
			scopeTechIds
				? allTargets.filter((t) => scopeTechIds.has(t.techId))
				: allTargets,
		[allTargets, scopeTechIds],
	);

	const snappedOrigins = useSnappedOrigin(targets);

	const queries = useQueries({
		queries: targets.map((target) => {
			const origin = snappedOrigins.get(target.techId) ?? target.current;
			return {
				queryKey: [
					"directions",
					target.techId,
					origin.lat,
					origin.lon,
					target.destination.lat,
					target.destination.lon,
				],
				queryFn: (): Promise<DirectionsResult | null> =>
					fetchDrivingRoute(origin, target.destination),
				staleTime: ROUTE_STALE_MS,
				retry: 1,
			};
		}),
	});

	// Keep the latest query result per tech so a transient refetch doesn't blank the UI.
	const lastResultRef = useRef<Map<string, DirectionsResult>>(new Map());
	useEffect(() => {
		const active = new Set(targets.map((t) => t.techId));
		for (const id of Array.from(lastResultRef.current.keys())) {
			if (!active.has(id)) lastResultRef.current.delete(id);
		}
	}, [targets]);

	const next = targets.map((target, i) => {
		const result = queries[i].data;
		if (result) lastResultRef.current.set(target.techId, result);
		const cached = lastResultRef.current.get(target.techId) ?? null;

		return {
			techId: target.techId,
			techName: target.techName,
			visitId: target.visitId,
			jobId: target.jobId,
			color: getTechColor(target.techId, orderedIds),
			current: target.current,
			destination: target.destination,
			destinationLabel: target.destinationLabel,
			routeGeoJSON: cached?.geometry ?? null,
			etaSeconds: cached?.durationSeconds ?? null,
			distanceMeters: cached?.distanceMeters ?? null,
		};
	});

	// Consumers key effects on these references; reuse unchanged elements and the array.
	const prevRef = useRef<TechRouteData[]>([]);
	const prev = prevRef.current;
	const stable = next.map((r, i) => {
		const p = prev[i];
		return p && sameRoute(p, r) ? p : r;
	});
	const unchanged = stable.length === prev.length && stable.every((r, i) => r === prev[i]);
	if (unchanged) return prev;
	prevRef.current = stable;
	return stable;
}

function sameRoute(a: TechRouteData, b: TechRouteData): boolean {
	return (
		a.techId === b.techId &&
		a.techName === b.techName &&
		a.visitId === b.visitId &&
		a.jobId === b.jobId &&
		a.color === b.color &&
		a.current.lat === b.current.lat &&
		a.current.lon === b.current.lon &&
		a.destination.lat === b.destination.lat &&
		a.destination.lon === b.destination.lon &&
		a.destinationLabel === b.destinationLabel &&
		a.routeGeoJSON === b.routeGeoJSON &&
		a.etaSeconds === b.etaSeconds &&
		a.distanceMeters === b.distanceMeters
	);
}
