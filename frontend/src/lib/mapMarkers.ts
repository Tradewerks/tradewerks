import type { Coordinates, StaticMarker, TechRouteData } from "../types/location";
import type { Technician } from "../types/technicians";
import { TechnicianStatusDotColors } from "../types/technicians";

export function hasValidCoords(c: Coordinates | null | undefined): c is Coordinates {
	return (
		!!c &&
		typeof c.lat === "number" &&
		typeof c.lon === "number" &&
		Number.isFinite(c.lat) &&
		Number.isFinite(c.lon) &&
		!(c.lat === 0 && c.lon === 0)
	);
}

export function formatEtaShort(seconds: number | null): string {
	if (seconds === null) return "";
	const mins = Math.max(1, Math.round(seconds / 60));
	if (mins < 60) return `~${mins}m`;
	const hours = Math.floor(mins / 60);
	const rem = mins % 60;
	return rem === 0 ? `~${hours}h` : `~${hours}h${rem}m`;
}

export interface TechMarkerOptions {
	/** The route the tech is driving; null renders the idle, dimmed marker. */
	route: TechRouteData | null;
	showEta: boolean;
	/** Replaces the ETA suffix, e.g. "En route elsewhere". */
	note?: string;
}

export function buildTechMarker(tech: Technician, opts: TechMarkerOptions): StaticMarker {
	const { route } = opts;
	const eta =
		route && opts.showEta && route.etaSeconds !== null
			? ` · ${formatEtaShort(route.etaSeconds)}`
			: "";
	const suffix = opts.note ? ` · ${opts.note}` : eta;
	return {
		id: `tech-${tech.id}`,
		coords: route ? route.current : tech.coords,
		type: "TECHNICIAN",
		label: `${tech.name}${suffix}`,
		color: route ? route.color : undefined,
		statusDotColor: TechnicianStatusDotColors[tech.status],
		variant: route ? "default" : "dimmed",
	};
}
