import { useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../../auth/authStore";
import { useOwnVisitsQuery } from "../../hooks/useJobs";
import DynamicMap from "../../components/ui/maps/DynamicMap";

export default function TechnicianMapPage() {
	const { user } = useAuthStore();
	const navigate = useNavigate();
	const mapContainerRef = useRef<HTMLDivElement>(null!);

	const { data: visits = [] } = useOwnVisitsQuery(user?.userId ?? "");

	const markers = useMemo(() => {
		return visits
			.filter(
				(v) =>
					v.status !== "Completed" &&
					v.status !== "Cancelled" &&
					v.job != null
			)
			.map((v) => ({
				id: v.id,
				coords: v.job!.coords,
				type: "CLIENT" as const,
				label: v.job!.client?.name ?? "",
				onClick: () => navigate(`/technician/visits/${v.id}`),
			}));
	}, [visits, navigate]);

	return (
		<div
			ref={mapContainerRef}
			className="-mx-4 -mt-4 md:-mx-6 md:-mt-6 h-[calc(100dvh-7.5rem)] overflow-hidden"
		>
			<DynamicMap containerRef={mapContainerRef} staticMarkers={markers} />
		</div>
	);
}
