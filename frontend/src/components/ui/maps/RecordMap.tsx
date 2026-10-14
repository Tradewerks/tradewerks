import { useEffect, useRef, useState } from "react";
import { Crosshair } from "lucide-react";
import Card from "../Card";
import DynamicMap from "./DynamicMap";
import RecordMapRail, { type RailVisit } from "./RecordMapRail";
import { useRecordMapData, type RecordMapScope } from "../../../hooks/useRecordMapData";
import type { MapViewRequest } from "../../../types/location";

interface RecordMapProps extends RecordMapScope {
	address: string;
	hiddenNote?: string;
	/** Replaces the default empty-crew copy. */
	emptyTechText?: string;
	/** Job tab: visits the rail lists as checkboxes. Absent on the visit page. */
	visits?: RailVisit[];
	onToggleVisit?: (id: string) => void;
	tz?: string;
}

export default function RecordMap({
	address,
	hiddenNote,
	emptyTechText,
	visits,
	onToggleVisit,
	tz,
	...scope
}: RecordMapProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [view, setView] = useState<MapViewRequest | null>(null);
	const model = useRecordMapData(scope);

	const request = (target: MapViewRequest["target"]) =>
		setView((prev) => ({ id: (prev?.id ?? 0) + 1, target }));

	// Picker changes reframe; the first mount is autoFit's job.
	const focusKey = [...scope.focusVisitIds].sort().join(",");
	const lastFocusKey = useRef(focusKey);
	useEffect(() => {
		if (lastFocusKey.current === focusKey) return;
		lastFocusKey.current = focusKey;
		setView((prev) => ({ id: (prev?.id ?? 0) + 1, target: "fit" }));
	}, [focusKey]);

	// No title: the selected "Map" tab already names this card.
	return (
		<Card>
			<div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
				<div
					ref={containerRef}
					className="relative h-[420px] overflow-hidden rounded-lg border border-border-subtle bg-surface lg:h-[560px]"
				>
					{model.isLoading ? (
						<div className="h-full w-full animate-pulse bg-base" />
					) : model.siteMissing ? (
						<div className="flex h-full items-center justify-center px-6 text-center text-sm text-text-muted">
							This job's address has no map location.
						</div>
					) : (
						<>
							<DynamicMap
								containerRef={containerRef}
								staticMarkers={model.markers}
								techRoutes={model.routes}
								showRoutes
								viewRequest={view}
								autoFit="untilInteraction"
							/>
							<button
								type="button"
								onClick={() => request("fit")}
								className="absolute top-3 right-3 z-10 flex h-8 items-center gap-1.5 rounded-md border border-border-subtle bg-base/90 px-2.5 text-xs font-medium text-text-secondary shadow-sm transition-colors duration-150 ease-out hover:bg-surface hover:text-text-primary"
							>
								<Crosshair size={12} />
								Recenter
							</button>
						</>
					)}
				</div>

				<RecordMapRail
					siteLabel={scope.site.label}
					address={address}
					siteCoords={model.siteCoords}
					techRows={model.techRows}
					isLoading={model.isLoading}
					orgName={model.orgName}
					orgCoords={model.orgCoords}
					orgMissing={model.orgMissing}
					onLocate={request}
					hiddenNote={hiddenNote}
					emptyTechText={emptyTechText}
					visits={visits}
					onToggleVisit={onToggleVisit}
					tz={tz}
				/>
			</div>
		</Card>
	);
}
