import { log } from "../services/appLogger.js";

export type LatLon = { lat: number; lon: number };

export interface TrafficLeg {
	durationSeconds: number;
	// Same leg under typical conditions; the difference is what live traffic is costing
	typicalSeconds: number | null;
	distanceMeters: number;
}

interface MapboxLeg {
	duration: number;
	duration_typical?: number | null;
	distance: number;
}

interface MapboxDirectionsResponse {
	code: string;
	message?: string;
	routes: Array<{ legs: MapboxLeg[] }>;
}

// driving-traffic accepts up to 25 coordinates per request
export const MAX_ROUTE_STOPS = 25;

// Stored coords are { lat, lon } but older rows carry { lat, lng }
export function toLatLon(raw: unknown): LatLon | null {
	if (!raw || typeof raw !== "object") return null;
	const c = raw as { lat?: unknown; lon?: unknown; lng?: unknown };
	const lat = typeof c.lat === "number" ? c.lat : null;
	const lon = typeof c.lon === "number" ? c.lon : typeof c.lng === "number" ? c.lng : null;
	if (lat === null || lon === null || (lat === 0 && lon === 0)) return null;
	return { lat, lon };
}

/**
 * One live-traffic route through `stops` in order, returned as per-leg times.
 * legs[i] is stops[i] → stops[i + 1]. Null when Mapbox can't route it or is down;
 * callers fall back to their last known legs.
 */
export async function fetchTrafficLegs(stops: LatLon[]): Promise<TrafficLeg[] | null> {
	const token = process.env.MAPBOX_TOKEN;
	if (!token) {
		log.error("Missing MAPBOX_TOKEN; cannot fetch traffic route.");
		return null;
	}
	if (stops.length < 2 || stops.length > MAX_ROUTE_STOPS) return null;

	const coords = stops.map((s) => `${s.lon},${s.lat}`).join(";");
	const url =
		`https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coords}` +
		`?overview=false&steps=false&access_token=${token}`;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 8_000);
	try {
		const resp = await fetch(url, { signal: controller.signal });
		if (!resp.ok) {
			log.warn({ status: resp.status }, "Mapbox traffic route request failed");
			return null;
		}
		const data = (await resp.json()) as MapboxDirectionsResponse;
		const legs = data.code === "Ok" ? data.routes[0]?.legs : undefined;
		if (!legs || legs.length !== stops.length - 1) return null;
		return legs.map((l) => ({
			durationSeconds: l.duration,
			typicalSeconds: typeof l.duration_typical === "number" ? l.duration_typical : null,
			distanceMeters: l.distance,
		}));
	} catch {
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}
