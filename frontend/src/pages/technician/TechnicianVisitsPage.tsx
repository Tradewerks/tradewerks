import { useAllJobVisitsQuery, useAcceptJobVisitMutation } from "../../hooks/useJobs";
import type { VisitStatus } from "../../types/jobs";
import { useAuthStore } from "../../auth/authStore";
import { useMemo, useState, useEffect, useRef } from "react";
import { Search, MapPin, Calendar, Clock, Navigation, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import TechVisitCard from "../../components/technicianComponents/TechVisitCard";
import { addSpacesToCamelCase, formatDateTime, FALLBACK_TIMEZONE } from "../../util/util";
import TechPage from "../../components/technician/TechPage";

type TabFilter = "available" | "mine" | "past";
type SortMode = "time" | "distance";
type SlaStatus = "overdue" | "soon" | null;

const COMING_SOON_MINUTES = 90;
const PROXIMITY_MILES = 3;
const ACTIVE_STATUSES: VisitStatus[] = ["Driving", "OnSite", "InProgress", "Paused"];

const STATUS_PRIORITY: Record<VisitStatus, number> = {
	InProgress: 0,
	OnSite:     1,
	Driving:    2,
	Paused:     3,
	Delayed:    4,
	Scheduled:  5,
	Completed:  6,
	Cancelled:  7,
};

/** Haversine distance in miles between two lat/lon points. */
function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 3958.8;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) *
			Math.cos((lat2 * Math.PI) / 180) *
			Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getSlaStatus(scheduledStart: Date | string, status: VisitStatus): SlaStatus {
	if (ACTIVE_STATUSES.includes(status) || status === "Completed" || status === "Cancelled")
		return null;
	const now = Date.now();
	const start = new Date(scheduledStart).getTime();
	if (start < now) return "overdue";
	if (start - now <= COMING_SOON_MINUTES * 60_000) return "soon";
	return null;
}

function SlaBadge({ status }: { status: SlaStatus }) {
	if (!status) return null;
	if (status === "overdue") {
		return (
			<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-error/15 text-error-text border border-error/20">
				<Clock size={10} />
				OVERDUE
			</span>
		);
	}
	return (
		<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-warning/15 text-warning-text border border-warning/20">
			<Clock size={10} />
			SOON
		</span>
	);
}

export default function TechnicianVisitsPage() {
	const { user } = useAuthStore();
	const navigate = useNavigate();
	const tz = user?.orgTimezone ?? FALLBACK_TIMEZONE;

	const [tab, setTab] = useState<TabFilter>("mine");
	const [searchInput, setSearchInput] = useState("");
	const [sortMode, setSortMode] = useState<SortMode>("time");
	const [acceptError, setAcceptError] = useState<string | null>(null);
	const [acceptConfirm, setAcceptConfirm] = useState<string | null>(null);
	const [showAllPast, setShowAllPast] = useState(false);
	const [userPosition, setUserPosition] = useState<{ lat: number; lon: number } | null>(null);
	const [geoSupported, setGeoSupported] = useState(false);

	const pillRef = useRef<HTMLDivElement>(null);
	const trackRef = useRef<HTMLDivElement>(null);
	const drag = useRef({
		active: false,
		startX: 0,
		startTranslate: 0,
		lastX: 0,
		lastTime: 0,
		velocity: 0,
	});

	const tabIndex = tab === "mine" ? 0 : tab === "available" ? 1 : 2;

	const setPillSnap = (idx: number) => {
		const pill = pillRef.current;
		const track = trackRef.current;
		if (!pill || !track) return;
		const step = (track.clientWidth - 8) / 3;
		pill.style.transition = "transform 0.22s cubic-bezier(0.4,0,0.2,1)";
		pill.style.transform = `translateX(${idx * step}px)`;
	};

	const onDragStart = (clientX: number) => {
		const track = trackRef.current;
		const pill = pillRef.current;
		if (!track || !pill) return;
		pill.style.transition = "none";
		const step = (track.clientWidth - 8) / 3;
		drag.current = {
			active: true,
			startX: clientX,
			startTranslate: tabIndex * step,
			lastX: clientX,
			lastTime: Date.now(),
			velocity: 0,
		};
	};

	const onDragMove = (clientX: number) => {
		if (!drag.current.active) return;
		const track = trackRef.current;
		const pill = pillRef.current;
		if (!track || !pill) return;

		const now = Date.now();
		const dt = now - drag.current.lastTime;
		if (dt > 0) drag.current.velocity = (clientX - drag.current.lastX) / dt;
		drag.current.lastX = clientX;
		drag.current.lastTime = now;

		const step = (track.clientWidth - 8) / 3;
		const raw = drag.current.startTranslate + (clientX - drag.current.startX);
		const clamped = Math.max(0, Math.min(step * 2, raw));
		pill.style.transform = `translateX(${clamped}px)`;
	};

	const onDragEnd = () => {
		if (!drag.current.active) return;
		drag.current.active = false;

		const track = trackRef.current;
		const pill = pillRef.current;
		if (!track || !pill) return;

		const step = (track.clientWidth - 8) / 3;
		const velocityThreshold = 0.3;
		let targetIdx: number;

		const currentTranslate = parseFloat(
			pill.style.transform.replace("translateX(", "").replace("px)", "") || "0"
		);
		const currentIdx = Math.max(0, Math.min(2, Math.round(currentTranslate / step)));

		if (drag.current.velocity < -velocityThreshold) {
			targetIdx = Math.min(currentIdx + 1, 2);
		} else if (drag.current.velocity > velocityThreshold) {
			targetIdx = Math.max(currentIdx - 1, 0);
		} else {
			targetIdx = currentIdx;
		}

		setPillSnap(targetIdx);

		const tabMap: TabFilter[] = ["mine", "available", "past"];
		if (tabMap[targetIdx] === "past") {
			handlePastTab();
		} else {
			setTab(tabMap[targetIdx]);
		}
	};

	const { data: visits, isLoading, error } = useAllJobVisitsQuery();
	const acceptMutation = useAcceptJobVisitMutation();

	// Geolocation — request once on mount when switching to "mine" tab
	useEffect(() => {
		if (!("geolocation" in navigator)) return;
		setGeoSupported(true);
	}, []);

	useEffect(() => {
		if (!geoSupported || sortMode !== "distance") return;
		navigator.geolocation.getCurrentPosition(
			(pos) =>
				setUserPosition({
					lat: pos.coords.latitude,
					lon: pos.coords.longitude,
				}),
			() => setSortMode("time")
		);
	}, [geoSupported, sortMode]);

	useEffect(() => {
		if (!drag.current.active) setPillSnap(tabIndex);
	}, [tabIndex]);

	useEffect(() => {
		const el = trackRef.current;
		if (!el) return;
		const handler = (e: TouchEvent) => {
			if (drag.current.active) e.preventDefault();
		};
		el.addEventListener("touchmove", handler, { passive: false });
		return () => el.removeEventListener("touchmove", handler);
	}, []);

	const display = useMemo(() => {
		if (!visits) return [];

		let filtered = visits;

		if (tab === "past") {
			filtered = filtered
				.filter((v) => v.status === "Completed" || v.status === "Cancelled")
				.filter((v) =>
					v.visit_techs?.some((vt) => vt.tech_id === user?.userId)
				);
		} else if (tab === "available") {
			filtered = filtered
				.filter((v) => v.status !== "Completed" && v.status !== "Cancelled")
				.filter((v) => (v.visit_techs?.length ?? 0) === 0);
		} else {
			filtered = filtered
				.filter((v) => v.status !== "Completed" && v.status !== "Cancelled")
				.filter((v) =>
					v.visit_techs?.some((vt) => vt.tech_id === user?.userId)
				);
		}

		if (searchInput.trim()) {
			const lower = searchInput.toLowerCase();
			filtered = filtered.filter(
				(v) =>
					(v.name ?? "").toLowerCase().includes(lower) ||
					(v.job?.client?.name ?? "").toLowerCase().includes(lower) ||
					(v.job?.address ?? "").toLowerCase().includes(lower) ||
					v.status.toLowerCase().includes(lower)
			);
		}

		return filtered
			.map((v) => {
				const distanceMiles =
					userPosition && v.job?.coords
						? haversineMiles(
								userPosition.lat,
								userPosition.lon,
								v.job.coords.lat,
								v.job.coords.lon
							)
						: null;

				const isClockedIn = v.time_entries?.some(
					(e) => e.tech_id === user?.userId && e.clocked_out_at === null
				) ?? false;

				return {
					id: v.id,
					visitName: v.name || "Unnamed Visit",
					client: v.job?.client?.name ?? "—",
					address: v.job?.address ?? "—",
					scheduled: formatDateTime(v.scheduled_start_at, tz),
					status: addSpacesToCamelCase(v.status),
					rawStatus: v.status as VisitStatus,
					slaStatus: getSlaStatus(
						v.scheduled_start_at,
						v.status as VisitStatus
					),
					distanceMiles,
					_isClockedIn: isClockedIn,
					_scheduleDate: new Date(v.scheduled_start_at),
				};
			})
			.sort((a, b) => {
				// Clocked-in visit always first
				const clockedDiff = (b._isClockedIn ? 1 : 0) - (a._isClockedIn ? 1 : 0);
				if (clockedDiff !== 0) return clockedDiff;
				const statusDiff =
					STATUS_PRIORITY[a.rawStatus] - STATUS_PRIORITY[b.rawStatus];
				if (statusDiff !== 0) return statusDiff;
				if (
					sortMode === "distance" &&
					a.distanceMiles !== null &&
					b.distanceMiles !== null
				) {
					return a.distanceMiles - b.distanceMiles;
				}
				// Past tab: most recent first; all others: soonest first
				const timeDiff = a._scheduleDate.getTime() - b._scheduleDate.getTime();
				return tab === "past" ? -timeDiff : timeDiff;
			})
			.map(({ _scheduleDate, _isClockedIn, ...rest }) => rest);
	}, [visits, tab, searchInput, user?.userId, sortMode, userPosition, tz]);

	const cardData = tab === "past" && !showAllPast ? display.slice(0, 5) : display;

	const visitsById = useMemo(() => new Map(visits?.map((v) => [v.id, v]) ?? []), [visits]);

	// Proximity awareness — count "mine" visits within threshold
	const nearbyCount = useMemo(() => {
		if (!userPosition || tab !== "mine") return 0;
		return display.filter(
			(v) => v.distanceMiles !== null && v.distanceMiles <= PROXIMITY_MILES
		).length;
	}, [display, userPosition, tab]);

	const handlePastTab = () => {
		setTab("past");
		setAcceptConfirm(null);
		setAcceptError(null);
		setShowAllPast(false);
	};

	const handleAccept = async (e: React.MouseEvent, visitId: string) => {
		e.stopPropagation();
		setAcceptError(null);
		if (acceptConfirm !== visitId) {
			setAcceptConfirm(visitId);
			return;
		}
		try {
			await acceptMutation.mutateAsync({ visitId, techId: user?.userId ?? "" });
			setAcceptConfirm(null);
			setTab("mine");
		} catch (err) {
			setAcceptError(
				err instanceof Error ? err.message : "Failed to accept visit."
			);
		}
	};

	return (
		<TechPage className="text-text-primary">
			{/* Header */}
			<div className="flex flex-col gap-3 mb-4">
				<h2 className="text-2xl font-semibold">My Visits</h2>
				<form
					onSubmit={(e) => e.preventDefault()}
					className="relative w-full"
				>
					<Search
						size={18}
						className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
					/>
					<input
						type="text"
						placeholder="Search visits..."
						value={searchInput}
						onChange={(e) => setSearchInput(e.target.value)}
						className="w-full pl-11 pr-3 py-2.5 rounded-md bg-surface border border-border text-sm text-text-primary placeholder:text-faint focus:outline-none focus:ring-1 focus:ring-primary-border"
					/>
				</form>
			</div>

			{/* Tab slider */}
			<div className="mb-3 w-full">
				<div
					ref={trackRef}
					className="relative bg-surface rounded-xl p-1 flex w-full touch-none select-none"
					onMouseDown={(e) => {
						onDragStart(e.clientX);
						const onMove = (ev: MouseEvent) => onDragMove(ev.clientX);
						const onUp = () => {
							onDragEnd();
							window.removeEventListener("mousemove", onMove);
							window.removeEventListener("mouseup", onUp);
						};
						window.addEventListener("mousemove", onMove);
						window.addEventListener("mouseup", onUp);
					}}
					onTouchStart={(e) => onDragStart(e.touches[0].clientX)}
					onTouchMove={(e) => {
						onDragMove(e.touches[0].clientX);
					}}
					onTouchEnd={onDragEnd}
					onTouchCancel={onDragEnd}
				>
					{/* Sliding pill */}
					<div
						ref={pillRef}
						className="absolute top-1 bottom-1 left-1 rounded-lg bg-primary-hover shadow-sm pointer-events-none"
						style={{ width: "calc(33.333% - 2.67px)" }}
					/>
					{/* Mine */}
					<button
						type="button"
						onClick={() => { if (!drag.current.active) { setTab("mine"); setPillSnap(0); } }}
						className={`relative z-10 flex-1 py-2.5 min-h-[44px] text-sm font-medium transition-colors rounded-lg ${
							tab === "mine" ? "text-on-primary font-semibold" : "text-text-tertiary"
						}`}
					>
						Mine
					</button>
					{/* Available */}
					<button
						type="button"
						onClick={() => { if (!drag.current.active) { setTab("available"); setPillSnap(1); } }}
						className={`relative z-10 flex-1 py-2.5 min-h-[44px] text-sm font-medium transition-colors rounded-lg ${
							tab === "available" ? "text-on-primary font-semibold" : "text-text-tertiary"
						}`}
					>
						Available
					</button>
					{/* Past */}
					<button
						type="button"
						onClick={() => { if (!drag.current.active) { handlePastTab(); setPillSnap(2); } }}
						className={`relative z-10 flex-1 py-2.5 min-h-[44px] text-sm font-medium transition-colors rounded-lg ${
							tab === "past" ? "text-on-primary font-semibold" : "text-text-tertiary"
						}`}
					>
						Past
					</button>
				</div>
			</div>

			{/* Sort toggle — show on "mine" when geo is supported */}
			{tab === "mine" && geoSupported && (
				<div className="flex items-center gap-2 mb-3">
					<span className="text-[11px] text-text-muted uppercase tracking-wide font-medium">
						Sort:
					</span>
					<div className="flex rounded-lg overflow-hidden border border-border">
						<button
							onClick={() => setSortMode("time")}
							className={`px-3 py-1.5 text-xs font-medium transition-colors ${
								sortMode === "time"
									? "bg-surface-raised text-text-primary"
									: "bg-surface text-text-tertiary hover:bg-surface-raised"
							}`}
						>
							By Time
						</button>
						<button
							onClick={() => setSortMode("distance")}
							className={`flex items-center gap-1 px-3 py-1.5 text-xs font-medium transition-colors ${
								sortMode === "distance"
									? "bg-surface-raised text-text-primary"
									: "bg-surface text-text-tertiary hover:bg-surface-raised"
							}`}
						>
							<Navigation size={11} />
							By Distance
						</button>
					</div>
				</div>
			)}

			{/* Proximity awareness banner */}
			{tab === "mine" && nearbyCount > 0 && (
				<div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg bg-success-bg border border-success/20 text-success-text">
					<Navigation size={13} className="shrink-0" />
					<span className="text-xs font-medium">
						{nearbyCount} visit{nearbyCount > 1 ? "s" : ""}{" "}
						within {PROXIMITY_MILES} miles of your location
					</span>
				</div>
			)}

			{acceptError && (
				<div className="mb-3 px-4 py-3 bg-error/10 border border-error/40 rounded-lg text-error-text text-sm">
					{acceptError}
				</div>
			)}

			{/* Card list */}
			{isLoading && (
				<p className="text-text-tertiary text-sm text-center py-8">
					Loading visits...
				</p>
			)}
			{error && (
				<p className="text-error-text text-sm text-center py-8">
					Failed to load visits.
				</p>
			)}
			{!isLoading && !error && cardData.length === 0 && (
				<p className="text-text-muted text-sm text-center py-8">
					No visits found.
				</p>
			)}

			<div className="space-y-3">
				{cardData.map((row) => {
					// ── Available tab: existing flat card + Accept + Details ──────────────
					if (tab === "available") {
						return (
							<div
								key={row.id}
								className={`bg-base border rounded-xl p-4 shadow-sm ${
									row.slaStatus === "overdue"
										? "border-error/30"
										: row.slaStatus ===
											  "soon"
											? "border-warning/30"
											: "border-border"
								}`}
							>
								<div className="mb-0.5 overflow-hidden">
									{row.slaStatus && (
										<div className="float-right ml-2">
											<SlaBadge
												status={
													row.slaStatus
												}
											/>
										</div>
									)}
									<h3 className="text-lg font-bold text-text-primary leading-snug">
										{row.visitName}
									</h3>
								</div>
								<p className="text-sm text-text-tertiary mb-3">
									{row.client}
								</p>
								<div className="space-y-1.5 mb-4">
									<div className="flex items-start gap-2 text-sm text-text-secondary">
										<MapPin
											size={15}
											className="text-text-muted mt-0.5 shrink-0"
										/>
										<span className="flex-1">
											{
												row.address
											}
										</span>
										{row.distanceMiles !==
											null && (
											<span className="text-xs text-text-muted shrink-0 tabular-nums">
												{row.distanceMiles <
												0.1
													? "< 0.1 mi"
													: `${row.distanceMiles.toFixed(1)} mi`}
											</span>
										)}
									</div>
									<div className="flex items-center gap-2 text-sm text-text-secondary">
										<Calendar
											size={15}
											className="text-text-muted shrink-0"
										/>
										<span>
											{
												row.scheduled
											}
										</span>
									</div>
								</div>
								<div className="flex gap-2 items-stretch">
									<button
										onClick={(e) =>
											handleAccept(
												e,
												row.id
											)
										}
										onMouseLeave={() =>
											setAcceptConfirm(
												null
											)
										}
										disabled={
											acceptMutation.isPending
										}
										className={`flex-[3] py-3 min-h-[44px] rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 ${
											acceptConfirm ===
											row.id
												? "bg-confirm-hover text-on-primary animate-pulse"
												: "bg-confirm hover:bg-confirm-hover text-on-primary"
										}`}
									>
										{acceptMutation.isPending
											? "Accepting..."
											: acceptConfirm ===
												  row.id
												? "Tap Again to Confirm"
												: "Accept"}
									</button>
									<button
										onClick={() =>
											navigate(
												`/technician/visits/${row.id}`
											)
										}
										className="flex-[1] flex flex-col items-center justify-center gap-1 rounded-lg border border-border bg-surface text-text-tertiary hover:bg-surface-raised hover:text-text-primary hover:border-border-strong transition-all duration-150 active:scale-[0.97] px-2 py-2.5 min-w-[52px]"
										aria-label="View visit details"
									>
										<ChevronRight
											size={15}
										/>
										<span className="text-[10px] font-medium leading-none">
											Details
										</span>
									</button>
								</div>
							</div>
						);
					}

					// ── Mine + Past tabs: unified TechVisitCard ───────────────────────────
					const rawVisit = visitsById.get(row.id);
					if (!rawVisit) return null;
					return (
						<TechVisitCard
							key={row.id}
							visit={rawVisit}
							techId={user?.userId ?? ""}
							tz={tz}
							showDateTime
							showDistance={
								tab === "mine" &&
								row.distanceMiles !== null
							}
							distanceMiles={row.distanceMiles}
						/>
					);
				})}
			</div>

			{tab === "past" && display.length > 5 && (
				<button
					onClick={() => setShowAllPast((prev) => !prev)}
					className="mt-3 w-full py-3 min-h-[44px] text-sm text-primary-text hover:text-primary-text transition-colors"
				>
					{showAllPast
						? "Show less"
						: `View all ${display.length} past visits`}
				</button>
			)}
		</TechPage>
	);
}
