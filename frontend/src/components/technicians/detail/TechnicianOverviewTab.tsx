import { useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Briefcase, Truck, Users } from "lucide-react";
import Card from "../../ui/Card";
import DetailStatRow from "../../detail/DetailStatRow";
import BalancedOverviewGrid from "../../detail/BalancedOverviewGrid";
import DetailFieldGrid from "../../detail/DetailFieldGrid";
import RelationCard from "../../detail/RelationCard";
import DynamicMap from "../../ui/maps/DynamicMap";
import type { StatCardProps } from "../../ui/StatCard";
import { normalizeCoords } from "../../../types/location";
import type { Technician, VisitTechnician } from "../../../types/technicians";
import { TechnicianStatusDotColors } from "../../../types/technicians";
import LiveDot from "../../ui/maps/LiveDot";
import { useLiveTechnicians } from "../../../hooks/useTechnicianMarkers";
import { useNow } from "../../../hooks/useNow";
import { useSocketConnected } from "../../../hooks/useSocketConnected";
import { formatPulseAge, isPingLive } from "../../../lib/livePulse";
import { useAnyPermission, usePermission } from "../../../hooks/usePermission";
import { useTimesheetsReportQuery } from "../../../hooks/useReports";
import { useFieldPurchaseQueue } from "../../../hooks/useFieldPurchases";
import { useVehicleRecord } from "../../../hooks/useVehicles";
import { getTechnicianActivity } from "../technicianActivity";
import { weekRange } from "../technicianSchedule";
import { NAV_BUTTON } from "./navButtons";
import {
	formatAbsolute,
	formatHireDate,
	formatLastLogin,
	formatPhone,
	formatTenure,
	formatTime,
	vehicleSpec,
} from "../technicianFormat";

function VisitRelation({
	eyebrow,
	vt,
	emptyLabel,
	meta,
}: {
	eyebrow: string;
	vt: VisitTechnician | null;
	emptyLabel: string;
	meta?: string;
}) {
	return (
		<RelationCard
			eyebrow={eyebrow}
			emptyLabel={emptyLabel}
			icon={<Briefcase size={16} aria-hidden />}
			to={
				vt
					? `/dispatch/jobs/${vt.visit.job_id}/visits/${vt.visit.id}`
					: undefined
			}
			title={vt?.visit.job?.name}
			subtitle={vt?.visit.job?.client?.name}
			meta={vt ? meta : undefined}
		/>
	);
}

// Header-row stamp: a pulsing dot plus ping age, sized to sit beside the title so the
// card never grows. Ticks every second on its own so the map above doesn't re-render.
function PulseStamp({ technician }: { technician: Technician }) {
	const now = useNow(1_000);
	const connected = useSocketConnected();
	const age = formatPulseAge(technician.last_ping_at, now);
	const label = !connected
		? "Reconnecting…"
		: age === null
			? "No pings yet"
			: age === "now"
				? "just now"
				: age;
	return (
		<span
			title={
				technician.last_ping_at
					? `Last pulse ${new Date(technician.last_ping_at).toLocaleString()}`
					: undefined
			}
			className="flex items-center gap-1.5 whitespace-nowrap text-xs tabular-nums text-text-tertiary"
		>
			<LiveDot
				status={technician.status}
				lastPingAt={connected ? technician.last_ping_at : null}
				dotClassName={TechnicianStatusDotColors[technician.status]}
			/>
			<span className="sr-only">Last pulse </span>
			{label}
		</span>
	);
}

// Coords come from the socket-fed technician list, so the marker follows pings without a
// refetch. The title only says "live" while pings are arriving; otherwise "last reported".
function LocationCard({ technician: fetched }: { technician: Technician }) {
	const ref = useRef<HTMLDivElement>(null);
	const { technicians } = useLiveTechnicians();
	const live = technicians.find((t) => t.id === fetched.id);
	const technician = live ? { ...fetched, ...live } : fetched;
	const now = useNow(10_000);
	const isLive = isPingLive(technician.status, technician.last_ping_at, now);
	const coords = normalizeCoords(technician.coords);
	const lat = coords?.lat;
	const lon = coords?.lon;
	// A fresh array each render would hand the map new markers on every parent
	// re-render (the minute clock included) and make it redraw them.
	const markers = useMemo(
		() =>
			lat != null && lon != null
				? [
						{
							id: technician.id,
							coords: { lat, lon },
							type: "TECHNICIAN" as const,
							label: technician.name,
						},
					]
				: [],
		[technician.id, technician.name, lat, lon]
	);
	return (
		<Card
			className="flex-1"
			title={isLive ? "Live Location" : "Last Reported Location"}
			headerAction={<PulseStamp technician={technician} />}
		>
			{coords ? (
				// Grows with a stretched rail so both columns end on one line.
				<div
					ref={ref}
					className="min-h-56 flex-1 overflow-hidden rounded-lg border border-border-subtle"
				>
					<DynamicMap containerRef={ref} staticMarkers={markers} />
				</div>
			) : (
				<p className="text-sm text-text-muted">No location reported yet.</p>
			)}
		</Card>
	);
}

export default function TechnicianOverviewTab({ technician }: { technician: Technician }) {
	const canSeeReports = usePermission("view_reports");
	const canSeePurchases = usePermission("view_field_purchases");
	const activity = getTechnicianActivity(technician, new Date());
	const week = useMemo(() => weekRange(new Date()), []);

	// `enabled: canSeeReports` keeps a dispatcher without view_reports from
	// firing a request the backend would 403 on.
	const timesheets = useTimesheetsReportQuery(week.start, week.end, {
		enabled: canSeeReports,
	});
	const canOpenVehicle = useAnyPermission(["view_inventory", "manage_technicians"]);
	const canVehicleData = useAnyPermission(["view_vehicles", "manage_vehicles", "use_vehicles"]);
	const vehicle = technician.current_vehicle;
	// Without the vehicle gate the card falls back to the embedded type + plate.
	const vehicleRecord = useVehicleRecord(canVehicleData ? vehicle?.id : undefined);
	// Server totals, not a count over one page: "open" is the backend's
	// pending_preauth + pending_review + pending_second_signoff, and "queried"
	// completes the in-review set. limit 1 because only `total` is read.
	const openQueue = useFieldPurchaseQueue(
		{ technician_id: technician.id, status: "open", limit: 1 },
		canSeePurchases
	);
	const queriedQueue = useFieldPurchaseQueue(
		{ technician_id: technician.id, status: "queried", limit: 1 },
		canSeePurchases
	);

	const tiles: StatCardProps[] = [
		{
			label: "Today",
			value:
				activity.todayCount === 0
					? "—"
					: `${activity.todayDone} of ${activity.todayCount}`,
			hint: activity.todayCount === 0 ? "no visits today" : "visits complete",
		},
	];
	if (canSeeReports) {
		const hours = (timesheets.data ?? [])
			.filter((r) => r.technicianId === technician.id)
			.reduce((sum, r) => sum + r.payableHours, 0);
		tiles.push({
			label: "This Week",
			value: timesheets.isLoading
				? "…"
				: timesheets.isError
					? "—"
					: hours.toFixed(1).replace(/\.0$/, ""),
			hint: "hours on shift",
		});
	}
	if (canSeePurchases) {
		const loading = openQueue.isLoading || queriedQueue.isLoading;
		const failed = openQueue.isError || queriedQueue.isError;
		const n = (openQueue.data?.total ?? 0) + (queriedQueue.data?.total ?? 0);
		tiles.push({
			label: "Purchases in Review",
			// The button rides the value line so this tile stays the same height
			// as its neighbours. The queue has no technician filter of its own
			// (queueFilters.ts: stage/search/flagged/sort only), so it opens the
			// plain Field Purchases tab rather than a scoped view.
			value: (
				<span className="flex items-center justify-between gap-3">
					{loading ? "…" : failed ? "—" : n}
					<Link
						to="/dispatch/purchases?tab=field_purchases"
						className={NAV_BUTTON}
					>
						Open Queue <ArrowUpRight size={14} aria-hidden />
					</Link>
				</span>
			),
			hint: n === 1 ? "awaiting a reviewer" : "awaiting reviewers",
			tone: !failed && n > 0 ? "warning" : undefined,
		});
	}
	tiles.push({
		label: "Last Active",
		value: (
			<span title={formatAbsolute(technician.last_login)}>
				{formatLastLogin(technician.last_login)}
			</span>
		),
	});

	const phone = formatPhone(technician.phone);
	const hired = formatHireDate(technician.hire_date);
	const plate = vehicleRecord?.license_plate ?? vehicle?.license_plate;
	const odometer = vehicleRecord?.current_odometer_mi;
	const vehicleMeta = [plate, odometer != null ? `${odometer.toLocaleString()} mi` : null]
		.filter(Boolean)
		.join(" · ");
	const coDrivers = (vehicleRecord?.current_technicians ?? []).filter(
		(t) => t.id !== technician.id
	);

	const infoCard = (
		<Card className="flex-1" title="Technician Information">
			<DetailFieldGrid
				fill
				lead={
					technician.description ? (
						<p className="text-sm leading-relaxed text-text-secondary">
							{technician.description}
						</p>
					) : undefined
				}
				fields={[
					{
						label: "Email",
						value: (
							<a
								href={`mailto:${technician.email}`}
								title={technician.email}
								className="block truncate text-primary-text hover:underline"
							>
								{technician.email}
							</a>
						),
					},
					{
						label: "Phone",
						value: phone ? (
							<a
								href={`tel:${(technician.phone ?? "").replace(/[^\d+]/g, "")}`}
								className="text-primary-text hover:underline"
							>
								{phone}
							</a>
						) : (
							<span className="text-text-muted">
								Not recorded
							</span>
						),
					},
					{
						label: "Hired",
						value: `${hired} · ${formatTenure(technician.hire_date)}`,
					},
					{
						label: "Role",
						value: technician.organization_role?.name ?? "—",
					},
					{
						label: "Last Login",
						value: formatAbsolute(technician.last_login),
					},
				]}
			/>
		</Card>
	);

	const block = (
		<>
			<VisitRelation
				eyebrow="Current Visit"
				vt={activity.current}
				emptyLabel="Not on a visit"
				meta={
					activity.current?.visit.actual_start_at
						? `Started ${formatTime(activity.current.visit.actual_start_at)}`
						: undefined
				}
			/>
			<VisitRelation
				eyebrow="Next Visit"
				vt={activity.next}
				emptyLabel="Nothing else scheduled today"
				meta={
					activity.next
						? formatTime(activity.next.visit.scheduled_start_at)
						: undefined
				}
			/>
			<RelationCard
				eyebrow="Vehicle"
				emptyLabel="No vehicle assigned"
				icon={<Truck size={16} aria-hidden />}
				// The stock page is inventory-gated; without that, the Vehicle tab is
				// the most this viewer can open.
				to={
					!vehicle
						? undefined
						: canOpenVehicle
							? `/dispatch/vehicles/${vehicle.id}/stock`
							: `/dispatch/technicians/${technician.id}?tab=vehicle`
				}
				title={vehicle?.name}
				subtitle={vehicle ? vehicleSpec(vehicleRecord ?? vehicle) || undefined : undefined}
				meta={vehicleMeta ? <span className="tabular-nums">{vehicleMeta}</span> : undefined}
				trailing={
					coDrivers.length > 0 ? (
						<span
							title={`Also assigned: ${coDrivers.map((t) => t.name).join(", ")}`}
							className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-xs font-medium text-text-secondary"
						>
							<Users size={12} aria-hidden />
							Shared
							<span className="sr-only">
								{" "}
								with {coDrivers.map((t) => t.name).join(", ")}
							</span>
						</span>
					) : undefined
				}
			/>
		</>
	);

	return (
		<div
			role="tabpanel"
			id="tabpanel-overview"
			aria-labelledby="tab-overview"
			className="mt-6 space-y-4"
		>
			<h2 className="sr-only">Overview</h2>
			<DetailStatRow tiles={tiles} />
			<BalancedOverviewGrid
				recordId={technician.id}
				infoCard={infoCard}
				block={block}
				railCard={<LocationCard technician={technician} />}
			/>
		</div>
	);
}
