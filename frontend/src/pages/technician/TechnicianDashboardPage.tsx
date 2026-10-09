import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Phone, X, Coffee, LogOut, LogIn, MapPin } from "lucide-react";
import { useAuthStore } from "../../auth/authStore";
import { useJobVisitsByTechIdQuery, useCreateJobNoteMutation } from "../../hooks/useJobs";
import { 
	useTechnicianByIdQuery, 
	useGoAvailableMutation, 
	useGoOfflineMutation, 
	useGoOnBreakMutation, 
	useMarkDoneMutation,
	useReturnFromJobMutation,

} from "../../hooks/useTechnicians";
import TechVisitCard from "../../components/technicianComponents/TechVisitCard";
import AddNotePhotoModal from "../../components/technicianComponents/AddNotePhotoModal";
import type { NotePhoto } from "../../components/technicianComponents/AddNotePhotoModal";
import type { JobVisit, VisitStatus } from "../../types/jobs";
import { errorMessage, formatTime, FALLBACK_TIMEZONE } from "../../util/util";
import { usePermission } from "../../hooks/usePermission";
import TechPage from "../../components/technician/TechPage";

// ─── constants ────────────────────────────────────────────────────────────────

const ACTIVE_STATUSES: VisitStatus[] = ["Driving", "OnSite", "InProgress", "Paused", "Delayed"];
const UP_NEXT_MINUTES = 30;

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatNextDayHeader(d: Date, tz: string): string {
	return d
		.toLocaleDateString("en-US", {
			weekday: "long",
			month: "short",
			day: "numeric",
			timeZone: tz,
		})
		.toUpperCase();
}

/** Compare two Dates by calendar day in the org's timezone. */
function isSameDay(a: Date, b: Date, tz: string): boolean {
	return (
		a.toLocaleDateString("en-CA", { timeZone: tz }) ===
		b.toLocaleDateString("en-CA", { timeZone: tz })
	);
}

const BREAK_REASONS = [
	{ value: "Lunch", label: "Lunch Break" },
	{ value: "Rest", label: "Rest Break" },
	{ value: "EquipmentIssue", label: "Equipment Issue" },
	{ value: "Other", label: "Other" },
];

export default function TechnicianDashboardPage() {
	const { user } = useAuthStore();
	const navigate = useNavigate();
	const {
		data: visits = [],
		isLoading,
		error,
	} = useJobVisitsByTechIdQuery(user?.userId ?? "");
	const { data: techProfile } = useTechnicianByIdQuery(user?.userId ?? null);
	const insertNoteMutation = useCreateJobNoteMutation();
	const goAvailableMutation = useGoAvailableMutation();
	const goOfflineMutation = useGoOfflineMutation();
	const goOnBreakMutation = useGoOnBreakMutation();
	const markDoneMutation = useMarkDoneMutation();
	const returnFromJobMutation = useReturnFromJobMutation();

	const [vehicleBannerDismissed, setVehicleBannerDismissed] = useState(false);

	const [showNotePhotoModal, setShowNotePhotoModal] = useState(false);
	const [notePhotoTargetVisitId, setNotePhotoTargetVisitId] = useState<string | null>(null);
	const [showBreakPicker, setShowBreakPicker] = useState(false);
	const [breakError, setBreakError] = useState<string | null>(null);
	const [confirmingEndShift, setConfirmingEndShift] = useState(false);
	const endShiftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => { if (endShiftTimerRef.current) clearTimeout(endShiftTimerRef.current); };
	}, []);

	// ── date bucketing ──────────────────────────────────────────────────────

	const tz = user?.orgTimezone ?? FALLBACK_TIMEZONE;

	const { todayVisits, futureVisits } = useMemo(() => {
		const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });

		const today = visits
			.filter(
				(v) =>
					new Date(v.scheduled_start_at).toLocaleDateString("en-CA", {
						timeZone: tz,
					}) === todayStr
			)
			.sort(
				(a, b) =>
					new Date(a.scheduled_start_at).getTime() -
					new Date(b.scheduled_start_at).getTime()
			);

		const future = visits
			.filter(
				(v) =>
					new Date(v.scheduled_start_at).toLocaleDateString("en-CA", {
						timeZone: tz,
					}) > todayStr
			)
			.sort(
				(a, b) =>
					new Date(a.scheduled_start_at).getTime() -
					new Date(b.scheduled_start_at).getTime()
			);

		return { todayVisits: today, futureVisits: future };
	}, [visits, tz]);

	// ── derived visit state ─────────────────────────────────────────────────

	const {
		activeVisits,
		overdueVisits,
		upNextVisits,
		upcomingVisits,
		nextDayVisits,
		primaryHeroVisit,
	} = useMemo(() => {
		const now = Date.now();
		const upNextThresholdMs = UP_NEXT_MINUTES * 60_000;

		const userId = user?.userId;
		// Filter from ALL visits (not just today's) — a visit started on a previous
		// day that's still InProgress would otherwise fall into a dead zone.
		const actives = visits
			.filter((v) => ACTIVE_STATUSES.includes(v.status))
			.sort((a, b) => {
				const aIn = a.time_entries?.some((e) => e.tech_id === userId && e.clocked_out_at === null) ? 0 : 1;
				const bIn = b.time_entries?.some((e) => e.tech_id === userId && e.clocked_out_at === null) ? 0 : 1;
				return aIn - bIn;
			});
		const scheduled = todayVisits.filter((v) => v.status === "Scheduled");
		const overdue = scheduled.filter(
			(v) => new Date(v.scheduled_start_at).getTime() < now
		);
		const upNext = scheduled.filter((v) => {
			const diff = new Date(v.scheduled_start_at).getTime() - now;
			return diff >= 0 && diff < upNextThresholdMs;
		});
		const upcoming = scheduled.filter(
			(v) => new Date(v.scheduled_start_at).getTime() - now >= upNextThresholdMs
		);

		const nextToday =
			scheduled
				.filter((v) => new Date(v.scheduled_start_at).getTime() >= now)
				.sort((a, b) => new Date(a.scheduled_start_at).getTime() - new Date(b.scheduled_start_at).getTime())[0]
			?? null;

		const nextFuture = futureVisits[0] ?? null;
		const nextDayDate = nextFuture ? new Date(nextFuture.scheduled_start_at) : null;
		const nextDay = nextDayDate
			? futureVisits.filter((v) =>
					isSameDay(new Date(v.scheduled_start_at), nextDayDate, tz)
				)
			: [];

		const primaryHero = overdue[0] ?? nextToday ?? nextFuture ?? null;

		return {
			activeVisits: actives,
			overdueVisits: overdue,
			upNextVisits: upNext,
			upcomingVisits: upcoming,
			nextTodayVisit: nextToday,
			nextFutureVisit: nextFuture,
			nextDayVisits: nextDay,
			primaryHeroVisit: primaryHero,
		};
	}, [visits, todayVisits, futureVisits, tz, user?.userId]);

	const doneCount = todayVisits.filter(
		(v) => v.status === "Completed" || v.status === "Cancelled"
	).length;

	// ── actions ─────────────────────────────────────────────────────────────

	const handleAddNotePhoto = async (
		visitId: string,
		jobId: string,
		content: string,
		photos: NotePhoto[],
	) => {
		await insertNoteMutation.mutateAsync({
			jobId,
			data: {
				content,
				visit_id: visitId,
				photos: photos.map((p) => ({
					photo_url: p.photo_url,
					photo_label: p.photo_label,
				})),
			},
		});
	};

	const canUseVehicles = usePermission("use_vehicles");
	const noVehicle = canUseVehicles && techProfile && !techProfile.current_vehicle_id;
	const isClockedInAnywhere = useMemo(
		() => visits.some((v) => v.time_entries?.some((e) => !e.clocked_out_at)),
		[visits],
	);

	const handleStartBreak = async (reason: string) => {
		if (!user?.userId) return;
		setBreakError(null);
		try {
			await goOnBreakMutation.mutateAsync({ techId: user.userId, reason });
			setShowBreakPicker(false);
		} catch (err) {
			setBreakError(err instanceof Error ? err.message : "Failed to start break — try again.");
		}
	};

	// ── hero type ───────────────────────────────────────────────────────────

	type HeroType = "wrapping-up" | "heading-back" | "primary" | "empty";

	const heroType: HeroType =
		techProfile?.status === "WrappingUp" ? "wrapping-up"
		: techProfile?.status === "HeadingBack" ? "heading-back"
		: primaryHeroVisit                   ? "primary"
		: "empty";

	// ── loading / error ─────────────────────────────────────────────────────

	if (isLoading) {
		return (
			<TechPage width="wide" className="space-y-4">
				<div className="h-7 w-36 bg-surface rounded animate-pulse" />
				<div className="h-4 w-28 bg-surface rounded animate-pulse" />
				<div className="h-28 bg-surface rounded-xl animate-pulse mt-2" />
				{[1, 2, 3].map((i) => (
					<div
						key={i}
						className="h-[52px] bg-surface rounded-lg animate-pulse"
					/>
				))}
			</TechPage>
		);
	}

	if (error) {
		return (
			<TechPage>
				<div className="p-4 bg-error/10 border border-error/20 rounded-lg">
					<p className="text-sm text-error-text">
						Failed to load schedule.
					</p>
				</div>
			</TechPage>
		);
	}

	// ── render ───────────────────────────────────────────────────────────────

	// Offline → Start Shift gate
	if (techProfile?.status === "Offline") {
		return (
			<TechPage className="flex flex-col items-center justify-center min-h-[60vh] gap-6">
				<div className="text-center">
					<h1 className="text-2xl font-bold text-text-primary mb-1">
						Good {new Date().getHours() < 12 ? "morning" : new Date().getHours() < 17 ? "afternoon" : "evening"},{" "}
						{techProfile.name.split(" ")[0]}
					</h1>
					<p className="text-sm text-text-muted">Ready to start your shift?</p>
				</div>
				<button
					onClick={() => user?.userId && goAvailableMutation.mutate(user.userId)}
					disabled={goAvailableMutation.isPending}
					className="flex items-center gap-2 px-8 py-4 rounded-xl bg-primary-hover hover:bg-primary text-on-primary font-semibold text-base transition-colors disabled:opacity-50"
				>
					<LogIn size={18} />
					{goAvailableMutation.isPending ? "Starting…" : "Start Shift"}
				</button>
				{goAvailableMutation.isError && (
					<p className="max-w-xs text-center text-sm text-red-500">
						{errorMessage(goAvailableMutation.error, "Couldn't start your shift — try again.").replace(/^TIMESHEET_LOCKED: /, "")}
					</p>
				)}
			</TechPage>
		);
	}

	return (
		<TechPage width="wide" className="pb-10">
			{/* Vehicle warning banner */}
			{noVehicle && !vehicleBannerDismissed && (
				<div className="flex items-center justify-between gap-2 mb-4 px-3 py-2.5 rounded-lg bg-warning/10 border border-warning/20 text-warning-text">
					<button
						onClick={() => navigate("/technician/vehicles")}
						className="flex items-center gap-2 flex-1 text-left text-sm"
					>
						<AlertTriangle size={15} className="shrink-0" />
						No vehicle selected — tap to set up your truck
					</button>
					<button
						onClick={() => setVehicleBannerDismissed(true)}
						className="text-warning/60 hover:text-warning-text"
					>
						<X size={15} />
					</button>
				</div>
			)}

			{/* Page header */}
			<div className="flex items-center justify-between mb-4">
				<div>
					<h1 className="text-xl font-bold text-text-primary tracking-tight">
						My Dashboard
					</h1>
					<p className="text-sm text-text-muted mt-0.5">
						{new Date().toLocaleDateString("en-US", {
							weekday: "long",
							month: "long",
							day: "numeric",
							timeZone: tz,
						})}
					</p>
				</div>
				<div className="flex items-center gap-2 flex-shrink-0">
					<span className="px-2.5 py-1 rounded-md bg-surface text-text-tertiary text-xs font-medium tabular-nums">
						{todayVisits.length}{" "}
						{todayVisits.length === 1 ? "visit" : "visits"}
					</span>
					{doneCount > 0 && (
						<span className="px-2.5 py-1 rounded-md bg-surface text-success-text text-xs font-medium tabular-nums">
							{doneCount} done
						</span>
					)}
				</div>
			</div>

			{/* Quick actions row */}
			<div className="mb-5 flex flex-col gap-2">
				<a
					href="tel:"
					className="flex items-center justify-center gap-2 py-2.5 rounded-lg bg-base border border-border-subtle text-sm text-text-secondary hover:bg-surface hover:text-text-primary transition-colors w-full"
				>
					<Phone size={15} />
					Call Dispatch
				</a>
				{/* Break + End Shift row */}
				<div className="flex gap-2">
					{techProfile?.status === "Break" ? (
						<button
							onClick={() => user?.userId && goAvailableMutation.mutate(user.userId)}
							disabled={goAvailableMutation.isPending}
							className="flex-1 flex items-center justify-center gap-2 min-h-[44px] py-3 rounded-lg bg-confirm hover:bg-confirm-hover text-sm text-on-primary font-medium transition-colors disabled:opacity-50"
						>
							<Coffee size={15} />
							{goAvailableMutation.isPending ? "Returning…" : "End Break"}
						</button>
					) : !isClockedInAnywhere && (
						<button
							onClick={() => setShowBreakPicker(true)}
							disabled={goOnBreakMutation.isPending}
							className="flex-1 flex items-center justify-center gap-2 min-h-[44px] py-3 rounded-lg bg-base border border-border-subtle text-sm text-text-secondary hover:bg-surface hover:text-text-primary transition-colors disabled:opacity-50"
						>
							<Coffee size={15} />
							Take Break
						</button>
					)}
					{techProfile?.status === "Available" && (
						<button
							onClick={() => user?.userId && returnFromJobMutation.mutate(user.userId)}
							disabled={returnFromJobMutation.isPending}
							className="flex-1 flex items-center justify-center gap-2 min-h-[44px] py-3 rounded-lg bg-base border border-border-subtle text-sm text-text-secondary hover:bg-surface hover:text-text-primary transition-colors disabled:opacity-50"
						>
							<MapPin size={15} />
							Head back
						</button>
					)}
					{!isClockedInAnywhere && techProfile?.status !== "Break" && (
						<button
							onClick={() => {
								if (!user?.userId) return;
								if (!confirmingEndShift) {
									setConfirmingEndShift(true);
									if (endShiftTimerRef.current) clearTimeout(endShiftTimerRef.current);
									endShiftTimerRef.current = setTimeout(() => setConfirmingEndShift(false), 4000);
									return;
								}
								if (endShiftTimerRef.current) clearTimeout(endShiftTimerRef.current);
								setConfirmingEndShift(false);
								goOfflineMutation.mutate(user.userId);
							}}
							disabled={goOfflineMutation.isPending}
							className={`flex-1 flex items-center justify-center gap-2 min-h-[44px] py-3 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
								confirmingEndShift
									? "bg-error/10 border border-error/50 text-error-text motion-safe:animate-pulse"
									: "bg-base border border-border-subtle text-text-tertiary hover:bg-surface hover:text-text-primary"
							}`}
						>
							<LogOut size={15} />
							{goOfflineMutation.isPending ? "Ending…" : confirmingEndShift ? "Confirm End Shift" : "End Shift"}
						</button>
					)}
				</div>
			</div>

			{/* Break reason picker modal */}
			{showBreakPicker && (
				<div
					className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-overlay"
					onClick={() => { setShowBreakPicker(false); setBreakError(null); }}
				>
					<div
						role="dialog"
						aria-modal="true"
						aria-labelledby="break-picker-title"
						className="w-full max-w-sm mx-4 mb-20 sm:mb-0 bg-base border border-border-subtle rounded-2xl p-5 space-y-3 max-h-[90dvh] overflow-y-auto"
						onClick={(e) => e.stopPropagation()}
					>
						<p id="break-picker-title" className="text-sm font-semibold text-text-primary text-center">Why are you taking a break?</p>
						{breakError && (
							<p role="alert" className="text-xs text-error-text text-center px-2">{breakError}</p>
						)}
						{BREAK_REASONS.map((r) => (
							<button
								key={r.value}
								onClick={() => handleStartBreak(r.value)}
								disabled={goOnBreakMutation.isPending}
								className="w-full min-h-[44px] py-3 rounded-xl text-sm font-medium bg-surface hover:bg-surface-raised border border-border text-text-primary transition-colors disabled:opacity-40"
							>
								{r.label}
							</button>
						))}
						<button
							onClick={() => { setShowBreakPicker(false); setBreakError(null); }}
							className="w-full min-h-[44px] py-3 rounded-xl text-sm font-medium bg-surface border border-border text-text-tertiary hover:bg-surface-raised hover:text-text-primary transition-colors"
						>
							Cancel
						</button>
					</div>
				</div>
			)}

			{/* ── Responsive grid: hero left, schedule right on lg+ ── */}
			<div className="lg:grid lg:grid-cols-2 lg:gap-8 lg:items-start">
				{/* ── Hero section: all active visits ──────────────────────────────── */}
				<div className="mb-6 space-y-3 lg:mb-0">
					{heroType === "wrapping-up" && (
						<WrappingUpCard
							onAvailable={() =>
								user?.userId && markDoneMutation.mutateAsync(user.userId)
							}
							onHeadBack={() =>
								user?.userId && returnFromJobMutation.mutateAsync(user.userId)
							}
							isLoading={markDoneMutation.isPending || returnFromJobMutation.isPending}
						/>
					)}
					{heroType === "heading-back" && (
						<HeadingBackCard
							onBack={() => user?.userId && markDoneMutation.mutateAsync(user.userId)}
							isLoading={markDoneMutation.isPending}
						/>
					)}
					{activeVisits.length === 0 && (
						<>
							{primaryHeroVisit ? (
								<TechVisitCard
									visit={primaryHeroVisit}
									techId={user?.userId ?? ""}
									tz={tz}
									showDateTime={true}
								/>
							) : heroType !== "wrapping-up" && heroType !== "heading-back" && (
								<div className="rounded-xl border border-border-subtle bg-base px-4 py-6 text-center">
									<p className="text-sm text-text-faint">
										No visits scheduled. Check with dispatch.
									</p>
								</div>
							)}
						</>
					)}

					{activeVisits.map((visit) => (
						<TechVisitCard
							key={visit.id}
							visit={visit}
							techId={user?.userId ?? ""}
							tz={tz}
							onAddNotePhoto={() => {
								setNotePhotoTargetVisitId(visit.id);
								setShowNotePhotoModal(true);
							}}
						/>
					))}
				</div>

				{/* ── Right column: schedule sections ── */}
				<div className="space-y-6">
					{/* ── Today's schedule with buckets ─────────────────────────────── */}
					<div>
						<div className="flex items-center justify-between mb-3">
							<span className="text-[10px] font-bold tracking-[0.1em] uppercase text-text-muted">
								Today · {todayVisits.length}{" "}
								{todayVisits.length === 1
									? "visit"
									: "visits"}
							</span>
							{doneCount > 0 && (
								<span className="text-[10px] font-semibold text-success-text">
									{doneCount} done
								</span>
							)}
						</div>

						{todayVisits.length === 0 ? (
							<p className="text-sm text-text-faint py-2">
								Nothing scheduled today.
							</p>
						) : (
							<div className="space-y-3">
								{/* Overdue bucket */}
								{overdueVisits.length > 0 && (
									<div>
										<p className="text-[10px] font-bold uppercase tracking-widest text-error-text mb-1.5 px-0.5">
											Overdue
										</p>
										<div className="rounded-xl border border-error/20 bg-base overflow-hidden divide-y divide-border-subtle">
											{overdueVisits.map(
												(
													visit
												) => (
													<ScheduleRow
														key={
															visit.id
														}
														visit={
															visit
														}
														tz={
															tz
														}
														isOverdue
														onClick={() =>
															navigate(
																`/technician/visits/${visit.id}`
															)
														}
													/>
												)
											)}
										</div>
									</div>
								)}

								{/* Up Next bucket */}
								{upNextVisits.length > 0 && (
									<div>
										<p className="text-[10px] font-bold uppercase tracking-widest text-warning-text mb-1.5 px-0.5">
											Up Next
										</p>
										<div className="rounded-xl border border-warning/20 bg-base overflow-hidden divide-y divide-border-subtle">
											{upNextVisits.map(
												(
													visit
												) => (
													<ScheduleRow
														key={
															visit.id
														}
														visit={
															visit
														}
														tz={
															tz
														}
														isUpNext
														onClick={() =>
															navigate(
																`/technician/visits/${visit.id}`
															)
														}
													/>
												)
											)}
										</div>
									</div>
								)}

								{/* Upcoming bucket */}
								{upcomingVisits.length > 0 && (
									<div>
										<p className="text-[10px] font-bold uppercase tracking-widest text-text-faint mb-1.5 px-0.5">
											Upcoming
										</p>
										<div className="rounded-xl border border-border-subtle bg-base overflow-hidden divide-y divide-border-subtle">
											{upcomingVisits.map(
												(
													visit
												) => (
													<ScheduleRow
														key={
															visit.id
														}
														visit={
															visit
														}
														tz={
															tz
														}
														onClick={() =>
															navigate(
																`/technician/visits/${visit.id}`
															)
														}
													/>
												)
											)}
										</div>
									</div>
								)}

								{/* Completed/Cancelled */}
								{todayVisits.filter(
									(v) =>
										v.status ===
											"Completed" ||
										v.status ===
											"Cancelled"
								).length > 0 && (
									<div className="rounded-xl border border-border-subtle bg-base overflow-hidden divide-y divide-border-subtle">
										{todayVisits
											.filter(
												(
													v
												) =>
													v.status ===
														"Completed" ||
													v.status ===
														"Cancelled"
											)
											.map(
												(
													visit
												) => (
													<ScheduleRow
														key={
															visit.id
														}
														visit={
															visit
														}
														tz={
															tz
														}
														onClick={() =>
															navigate(
																`/technician/visits/${visit.id}`
															)
														}
													/>
												)
											)}
									</div>
								)}
							</div>
						)}
					</div>

					{/* ── Next scheduled day ────────────────────────────────────────── */}
					{nextDayVisits.length > 0 && (
						<div className="mb-6 lg:mb-0">
							<div className="flex items-center justify-between mb-3">
								<span className="text-[10px] font-bold tracking-[0.1em] uppercase text-text-muted">
									{formatNextDayHeader(
										new Date(
											nextDayVisits[0]
												.scheduled_start_at
										),
										tz
									)}
								</span>
								<span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-surface text-text-muted">
									{nextDayVisits.length}{" "}
									{nextDayVisits.length === 1
										? "visit"
										: "visits"}
								</span>
							</div>
							<div className="rounded-xl border border-border-subtle bg-base overflow-hidden">
								<button
									type="button"
									onClick={() =>
										navigate(
											`/technician/visits/${nextDayVisits[0].id}`
										)
									}
									className="w-full flex items-center gap-3 px-3 py-3 min-h-[52px] text-left cursor-pointer hover:bg-surface-raised transition-colors duration-150"
								>
									<div className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-surface-raised" />
									<div className="flex-1 min-w-0">
										<p className="text-sm font-semibold text-text-tertiary truncate">
											{nextDayVisits[0]
												.name ??
												"Visit"}
										</p>
										<p className="text-xs text-text-faint truncate">
											{nextDayVisits[0]
												.job
												?.client
												?.name ??
												"—"}
										</p>
									</div>
									<span className="text-xs text-text-muted tabular-nums flex-shrink-0">
										{formatTime(
											nextDayVisits[0]
												.scheduled_start_at,
											tz
										)}
									</span>
								</button>
								{nextDayVisits.length > 1 && (
									<button
										onClick={() =>
											navigate(
												"/technician/visits"
											)
										}
										className="w-full px-3 py-2 border-t border-border-subtle text-center hover:bg-surface-raised transition-colors duration-150"
									>
										<span className="text-[11px] text-text-muted">
											+
											{nextDayVisits.length -
												1}{" "}
											more
										</span>
									</button>
								)}
							</div>
						</div>
					)}
				</div>
				{/* end right column */}
			</div>
			{/* end lg grid */}

			{/* Unified Add Note/Photo modal */}
			{showNotePhotoModal && (
				<AddNotePhotoModal
					visits={
						notePhotoTargetVisitId
							? activeVisits.filter((v) => v.id === notePhotoTargetVisitId)
							: activeVisits
					}
					preselectedVisitId={notePhotoTargetVisitId}
					onClose={() => {
						setShowNotePhotoModal(false);
						setNotePhotoTargetVisitId(null);
					}}
					onSubmit={handleAddNotePhoto}
				/>
			)}
		</TechPage>
	);
}

// ─── sub-components ───────────────────────────────────────────────────────────

function WrappingUpCard({ onAvailable, onHeadBack, isLoading }: { onAvailable: () => void; onHeadBack: () => void; isLoading: boolean }) {
	return (
		<div
			style={{
				padding: "1px 1px 1px 3px",
				background: "linear-gradient(to right, var(--color-gradient-tech-teal) 0%, var(--color-surface-raised) 45%, var(--color-surface-raised) 100%)",
				borderRadius: "12px",
			}}
		>
			<div className="rounded-[11px] bg-base px-4 py-4 space-y-3">
				<div className="flex items-center gap-2">
					<div className="w-2 h-2 rounded-full bg-gradient-tech-teal animate-pulse" />
					<span className="text-[10px] font-bold tracking-[0.1em] uppercase text-gradient-tech-teal">
						Wrapping Up
					</span>
				</div>
				<p className="text-sm text-text-tertiary">
					Job complete. Mark yourself available when you're ready.
				</p>
				<button
					onClick={onAvailable}
					disabled={isLoading}
					className="w-full py-2.5 rounded-lg bg-gradient-tech-teal/10 border border-gradient-tech-teal/20 text-gradient-tech-teal-text text-sm font-medium hover:bg-gradient-tech-teal/20 transition-colors disabled:opacity-40"
				>
					I'm Available
				</button>
				<button
					onClick={onHeadBack}
					disabled={isLoading}
					className="w-full py-2.5 rounded-lg border border-border-subtle text-text-primary text-sm font-medium hover:bg-surface-raised bg-surface transition-colors disabled:opacity-40"
				>
					Head back
				</button>
			</div>
		</div>
	);
}

function HeadingBackCard({ onBack, isLoading }: { onBack: () => void; isLoading: boolean }) {
	return (
		<div
			style={{
				padding: "1px 1px 1px 3px",
				background: "linear-gradient(to right, var(--color-action-drive) 0%, var(--color-surface-raised) 45%, var(--color-surface-raised) 100%)",
				borderRadius: "12px",
			}}
		>
			<div className="rounded-[11px] bg-base px-4 py-4 space-y-3">
				<div className="flex items-center gap-2">
					<div className="w-2 h-2 rounded-full bg-action-drive animate-pulse" />
					<span className="text-[10px] font-bold tracking-[0.1em] uppercase text-primary-text">
						Heading Back
					</span>
				</div>
				<p className="text-sm text-text-tertiary">
					Your drive is being logged. Tap when you're back.
				</p>
				<button
					onClick={onBack}
					disabled={isLoading}
					className="w-full py-2.5 rounded-lg flex items-center justify-center gap-2 bg-action-drive hover:bg-action-drive-hover text-on-primary text-sm font-medium transition-colors disabled:opacity-40"
				>
					<MapPin size={16} />
					I'm Back
				</button>
			</div>
		</div>
	);
}


interface ScheduleRowProps {
	visit: JobVisit;
	tz: string;
	isOverdue?: boolean;
	isUpNext?: boolean;
	onClick: () => void;
}

function ScheduleRow({ visit, tz, isOverdue, isUpNext, onClick }: ScheduleRowProps) {
	const isActive = ACTIVE_STATUSES.includes(visit.status);
	const isDone = visit.status === "Completed" || visit.status === "Cancelled";
	const diffMin = isUpNext
		? Math.max(
				0,
				Math.round(
					(new Date(visit.scheduled_start_at).getTime() -
						Date.now()) /
						60_000
				)
			)
		: 0;

	return (
		<button
			type="button"
			onClick={onClick}
			className={`w-full flex items-center gap-3 min-h-[52px] text-left cursor-pointer transition-colors duration-150 ${
				isActive
					? "bg-primary-bg-dim border-l-[3px] border-l-primary pl-[9px] pr-3 py-3"
					: isOverdue
						? "border-l-[3px] border-l-error pl-[9px] pr-3 py-3 hover:bg-surface-raised"
						: isUpNext
							? "border-l-[3px] border-l-warning/50 pl-[9px] pr-3 py-3 hover:bg-surface-raised"
							: "px-3 py-3 hover:bg-surface-raised"
			}`}
		>
			<div
				className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
					isDone
						? "bg-visit-completed/60"
						: isActive
							? "bg-visit-driving"
							: isOverdue
								? "bg-visit-cancelled"
								: isUpNext
									? "bg-visit-onsite"
									: "bg-visit-scheduled"
				}`}
			/>
			<div className="flex-1 min-w-0">
				<p
					className={`text-sm font-semibold truncate leading-snug ${
						isDone
							? "text-text-faint line-through"
							: "text-text-primary"
					}`}
				>
					{visit.name ?? "Visit"}
				</p>
				<p className="text-xs text-text-faint truncate">
					{visit.job?.client?.name ?? "—"}
				</p>
			</div>
			<div className="flex-shrink-0 text-right">
				{isDone ? (
					<span className="text-[11px] text-success-text font-medium">
						Done
					</span>
				) : isActive ? (
					<span className="text-[11px] text-primary-text font-medium">
						Active
					</span>
				) : isOverdue ? (
					<span className="text-[11px] text-error-text font-medium">
						Overdue · {formatTime(visit.scheduled_start_at, tz)}
					</span>
				) : isUpNext ? (
					<span className="text-[11px] text-warning-text font-medium tabular-nums">
						In {diffMin} min
					</span>
				) : (
					<span className="text-xs text-text-muted tabular-nums">
						{formatTime(visit.scheduled_start_at, tz)}
					</span>
				)}
			</div>
		</button>
	);
}
