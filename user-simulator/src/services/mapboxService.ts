import { Coordinates } from "../types/location.js";
import http from "./httpService.js";
import { config } from "../config.js";

export type MapboxLineString = {
	type: "LineString";
	// [lon, lat][]
	coordinates: [number, number][];
};

export type MapboxRoute = {
	distance: number;
	duration: number;
	geometry: MapboxLineString;
};

export type MapboxDirectionsResponse = {
	code: string;
	routes: MapboxRoute[];
};

export const getDirections = async (
	from: Coordinates,
	to: Coordinates,
	// driving-traffic matches what the backend arrival tracker forecasts with
	profile: "driving" | "driving-traffic" = "driving",
): Promise<MapboxRoute | null> => {
	const url =
		`https://api.mapbox.com/directions/v5/mapbox/${profile}/` +
		`${from.lon},${from.lat};${to.lon},${to.lat}` +
		`?geometries=geojson&overview=full&access_token=${config.mapboxToken}`;

	const resp = await http.get<MapboxDirectionsResponse>(url, {
		validateStatus: () => true,
	});

	if (resp.status !== 200 || resp.data?.code !== "Ok") {
		console.error(
			"[mapbox] directions failed:",
			resp.status,
			resp.data?.code,
		);
		return null;
	}

	return resp.data.routes[0] ?? null;
};
