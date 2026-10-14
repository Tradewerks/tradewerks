import { useMemo, useRef } from "react";
import DynamicMap from "../ui/maps/DynamicMap";
import type { StaticMarker } from "../../types/location";
import { TechnicianStatusDotColors, type TechnicianStatus } from "../../types/technicians";
import type { VisitStatus } from "./visitDemo";

// The dispatcher map exactly as the app renders it (DynamicMap + MarkerFactory),
// fed with the demo's records instead of live queries, and locked in place.
// Loaded lazily by MapFeed so Mapbox stays out of the landing page's first load.

const CLIENTS: { id: string; name: string; lat: number; lon: number }[] = [
	{ id: "anderson", name: "Anderson Office Complex", lat: 43.8357, lon: -91.2318 },
	{ id: "riverside", name: "Riverside Apartments LLC", lat: 43.8139, lon: -91.2552 },
	{ id: "williams", name: "Williams Property Management", lat: 43.7985, lon: -91.2174 },
	{ id: "smith", name: "Smith Commercial Bldg 2", lat: 43.7862, lon: -91.2436 },
	{ id: "johnson", name: "Johnson Residence", lat: 43.8228, lon: -91.2049 },
];

// Kevin Park's own status as the hero phone moves the visit along.
const KEVIN_STATUS: Record<VisitStatus, TechnicianStatus> = {
	Driving: "EnRoute",
	OnSite: "OnSite",
	InProgress: "Working",
	Paused: "Paused",
	Completed: "WrappingUp",
};

// Technicians sit just off the site they're working, as they would on the real map.
function buildMarkers(visitStatus: VisitStatus): StaticMarker[] {
	const clients: StaticMarker[] = CLIENTS.map((c) => ({
		id: `client-${c.id}`,
		coords: { lat: c.lat, lon: c.lon },
		type: "CLIENT",
		label: c.name,
	}));
	const techs: [string, string, TechnicianStatus, number, number][] = [
		["maria", "Maria Rodriguez", "Working", 43.8421, -91.2192],
		["john", "John Smith", "OnSite", 43.8204, -91.2428],
		["kevin", "Kevin Park", KEVIN_STATUS[visitStatus], 43.8296, -91.1928],
	];
	return [
		...clients,
		...techs.map(
			([id, name, status, lat, lon]): StaticMarker => ({
				id: `tech-${id}`,
				coords: { lat, lon },
				type: "TECHNICIAN",
				label: name,
				statusDotColor: TechnicianStatusDotColors[status],
				variant: "dimmed",
			}),
		),
	];
}

export default function LandingMap({ visitStatus }: { visitStatus: VisitStatus }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const markers = useMemo(() => buildMarkers(visitStatus), [visitStatus]);

	return (
		<div
			ref={containerRef}
			role="img"
			aria-label="The dispatcher map: today's five client sites in La Crosse, with Maria Rodriguez, John Smith and Kevin Park beside the visits they're working"
			className="landing-map h-full w-full"
		>
			<DynamicMap containerRef={containerRef} staticMarkers={markers} interactive={false} />
		</div>
	);
}
