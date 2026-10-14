import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Expand } from "lucide-react";
import Card from "../ui/Card";
import DynamicMap from "../ui/maps/DynamicMap";
import { useMapData } from "../../hooks/useMapData";

export default function MapWidget() {
	const navigate = useNavigate();
	const mapContainerRef = useRef<HTMLDivElement>(null);
	const { markers, techRoutes, isLoading } = useMapData();

	if (isLoading) return <div className="bg-base border border-border-subtle rounded-xl h-full animate-pulse" />;

	return (
		<Card
			className="h-full"
			title="Live Map"
			headerAction={
				<button
					onClick={() => navigate("/dispatch/map")}
					title="Open full map"
					className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium text-text-tertiary hover:text-text-primary hover:bg-surface transition-colors"
				>
					<Expand size={12} />
					Fullscreen
				</button>
			}
		>
			<div className="flex-1 min-h-0 rounded-lg overflow-hidden border border-border-subtle">
				<div ref={mapContainerRef} className="w-full h-full">
					<DynamicMap
						containerRef={mapContainerRef}
						staticMarkers={markers}
						techRoutes={techRoutes}
						showRoutes
					/>
				</div>
			</div>
		</Card>
	);
}
