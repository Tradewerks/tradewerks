import z from "zod";
import type { Feature, LineString } from "geojson";

export interface GeocodeResult {
	address: string;
	coords: Coordinates;
}

export interface StaticMarker {
	id: string;
	coords: Coordinates;
	type: MarkerTypeValue;
	label?: string;
	onClick?: () => void;
	color?: string;
	statusDotColor?: string;
	variant?: "default" | "dimmed";
	/** Drawn, but never part of an automatic or requested fit. */
	fitIgnore?: boolean;
}

/** One camera move per new `id`; re-sending the same id is a no-op. */
export type MapViewRequest = { id: number; target: "fit" | Coordinates };

export type Coordinates = { lat: number; lon: number };

export const CoordinatesSchema = z.object({ lat: z.number(), lon: z.number() });

/**
 * Seed data and legacy records store longitude as `lng`; everything else in the
 * app — and every backend validator — uses `lon`. A record loaded with `lng` and
 * posted back unchanged fails validation, so normalize on the way in.
 */
export function normalizeCoords(raw: unknown): Coordinates | undefined {
	if (raw == null || typeof raw !== "object") return undefined;
	const c = raw as { lat?: unknown; lon?: unknown; lng?: unknown };
	const lon = typeof c.lon === "number" ? c.lon : c.lng;
	if (typeof c.lat !== "number" || typeof lon !== "number") return undefined;
	return { lat: c.lat, lon };
}

export const MarkerType = ["CLIENT", "SITE", "WAREHOUSE", "RESOURCE", "TECHNICIAN"] as const;
export type MarkerTypeValue = (typeof MarkerType)[number];

export interface DirectionsResult {
	geometry: Feature<LineString>;
	durationSeconds: number;
	distanceMeters: number;
}

export interface TechRouteData {
	techId: string;
	techName: string;
	visitId: string;
	jobId: string;
	color: string;
	current: Coordinates;
	destination: Coordinates;
	destinationLabel: string;
	routeGeoJSON: Feature<LineString> | null;
	etaSeconds: number | null;
	distanceMeters: number | null;
}
