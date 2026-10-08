import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Expand } from "lucide-react";
import Card from "../../components/ui/Card";
import DynamicMap from "../../components/ui/maps/DynamicMap";
import MapPanel from "../../components/ui/maps/MapPanel";
import { useMapData } from "../../hooks/useMapData";
import { useNow } from "../../hooks/useNow";
import { useSocketConnected } from "../../hooks/useSocketConnected";
import { formatPulseAge, latestPing } from "../../lib/livePulse";
import type { Technician } from "../../types/technicians";

// Its own component so the 1s tick re-renders this row, not the map.
function PulseFooter({ technicians }: { technicians: Technician[] }) {
	const connected = useSocketConnected();
	const now = useNow(1_000);
	const last = latestPing(technicians);
	const age = formatPulseAge(last, now);
	return (
		<div className="flex items-center justify-between text-sm text-text-tertiary">
			<span className="flex items-center gap-2">
				<span
					aria-hidden="true"
					className={`h-2 w-2 rounded-full ${connected ? "bg-success" : "bg-neutral"}`}
				/>
				{connected ? "Live Tracking Active" : "Reconnecting…"}
			</span>
			<span
				className="tabular-nums"
				title={last ? new Date(last).toLocaleString() : undefined}
			>
				Last Pulse: {age ?? "none yet"}
			</span>
		</div>
	);
}

export default function MapPage() {
	const nav = useNavigate();
	const mapContainerRef = useRef<HTMLDivElement>(null);
	const {
		markers,
		techRoutes,
		allTechnicians,
		allDrivingRoutes,
		allClients,
		filters,
		setFilters,
		isLoading,
	} = useMapData();

	if (isLoading) return <p>Loading map data...</p>;

	return (
		<div className="flex flex-col lg:flex-row gap-4 lg:h-[840px]">
			<div className="flex-1 min-w-0 lg:h-full">
				<Card
					title="Map View"
					className="h-full"
					headerAction={
						<button
							className="flex items-center gap-2 px-4 py-2 bg-primary-hover hover:bg-primary-active text-on-primary rounded-md text-sm font-medium transition-colors"
							onClick={() => nav("/map")}
						>
							<Expand size={16} className="text-on-primary" />
							View Fullscreen
						</button>
					}
				>
					<div className="space-y-4">
						<div
							ref={mapContainerRef}
							className="w-full h-[700px] bg-surface rounded-lg border border-border overflow-hidden"
						>
							<DynamicMap
								containerRef={mapContainerRef}
								staticMarkers={markers}
								techRoutes={techRoutes}
								showRoutes={filters.showRoutes}
							/>
						</div>

						<PulseFooter technicians={allTechnicians} />
					</div>
				</Card>
			</div>

			<div className="lg:w-80 lg:flex-shrink-0 lg:h-full">
				<MapPanel
					allClients={allClients}
					allTechnicians={allTechnicians}
					drivingRoutes={allDrivingRoutes}
					filters={filters}
					onChange={setFilters}
				/>
			</div>
		</div>
	);
}
