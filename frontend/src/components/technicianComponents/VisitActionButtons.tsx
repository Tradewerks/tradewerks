import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { Car, MapPin, Clock, Pause, CheckCircle2, Play, AlertTriangle, Info, UserCheck, Loader2 } from "lucide-react";
import { useTechVisitActions } from "../../hooks/useTechVisitActions";
import type { JobVisit } from "../../types/jobs";

interface VisitActionButtonsProps {
	visit: JobVisit;
	techId: string;
	variant?: "card" | "detail";
	onOverlayChange?: (active: boolean) => void;
}

const PAUSE_REASONS = ["AwaitingMaterials", "EquipmentIssue", "Other"] as const;

export default function VisitActionButtons({
	visit,
	techId,
	variant = "card",
	onOverlayChange,
}: VisitActionButtonsProps) {
	const { t } = useTranslation();
	const {
		isClockedIn,
		openEntries,
		uiState,
		confirmingAction,
		isLoading,
		clockError,
		myTechVisitStatus,
		pendingPauseAction,
		handleDrive,
		handleArrive,
		handleClockIn,
		handleClockOut,
		handlePause,
		handleConfirmPause,
		handleComplete,
		handleConfirmComplete,
		handleDeclineComplete,
		handleReasonSelected,
		handleHeadingOut,
		handleAvailable,
		dismiss,
		constraints,
		handleConfirmSwitch,
		optimisticStatus,
	} = useTechVisitActions(visit, techId);

	const [tooltip, setTooltip] = useState<string | null>(null);
	const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useLayoutEffect(() => {
		const needsFullWidth = uiState === "pause-reason" || uiState === "prompt-complete";
		onOverlayChange?.(needsFullWidth);
	}, [uiState]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		return () => { if (tooltipTimer.current) clearTimeout(tooltipTimer.current); };
	}, []);

	const showTooltip = useCallback((reason: string) => {
		if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
		setTooltip(reason);
		tooltipTimer.current = setTimeout(() => setTooltip(null), 2500);
	}, []);

	const iconSize = variant === "detail" ? 16 : 14;
	const btn =
		variant === "detail"
			? "flex-1 flex items-center justify-center gap-2 py-3.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all duration-150 active:scale-[0.98]"
			: "flex-1 flex items-center justify-center gap-2 py-3.5 rounded-lg text-xs font-semibold disabled:opacity-40 transition-all duration-150 active:scale-[0.98]";

	// ── Overlays ────────────────────────────────────────────────────────────────

	if (uiState === "pause-reason") {
		const isCard = variant === "card";
		const isClockOut = pendingPauseAction === "clock-out";
		return (
			<div className="space-y-2">
				<div className="flex items-center gap-2 px-1 pb-2 border-b border-border-subtle">
					<Pause size={13} className="text-warning-text shrink-0" />
					<p className="text-sm font-semibold text-text-primary">
						{isClockOut ? t("visit.wrapUpOrPause") : t("visit.whyPausing")}
					</p>
				</div>
				{isClockOut && (
					<>
						<button
							autoFocus
							onClick={handleConfirmComplete}
							disabled={isLoading}
							className={`w-full py-3 px-2.5 rounded-lg font-medium bg-success-bg hover:bg-success/25 border border-success-border text-success-text text-center transition-colors disabled:opacity-40 leading-snug ${isCard ? "text-xs" : "text-sm"}`}
						>
							{isLoading ? t("visit.completing") : t("visit.completeVisit")}
						</button>
						<p className={`text-text-faint text-center ${isCard ? "text-[10px]" : "text-xs"}`}>
							{t("visit.orPauseBecause")}
						</p>
					</>
				)}
				<div className="grid grid-cols-2 gap-1.5">
					{PAUSE_REASONS.map((r, i) => (
						<button
							key={r}
							autoFocus={!isClockOut && i === 0}
							onClick={() => handleReasonSelected(r)}
							disabled={isLoading}
							className={`py-3 px-2.5 rounded-lg font-medium bg-surface hover:bg-surface-raised border border-border text-text-primary text-center transition-colors disabled:opacity-40 leading-snug${
								i === PAUSE_REASONS.length - 1 && PAUSE_REASONS.length % 2 !== 0
									? " col-span-2"
									: ""
							} ${isCard ? "text-xs" : "text-sm"}`}
						>
							{t(`visit.pauseReasons.${r}`)}
						</button>
					))}
				</div>
				<button
					onClick={dismiss}
					className={`w-full py-3 rounded-lg font-medium bg-surface border border-border text-text-tertiary hover:bg-surface-raised hover:text-text-primary transition-colors ${isCard ? "text-xs" : "text-sm"}`}
				>
					{t("common.cancel")}
				</button>
			</div>
		);
	}

	if (uiState === "departure-prompt") {
		return (
			<div className="space-y-2">
				<p className="text-xs text-text-secondary text-center font-medium">{t("visit.stillOnSite")}</p>
				<div className="flex gap-2">
					<button
						autoFocus
						onClick={dismiss}
						className={`${btn} bg-surface border border-border text-text-primary hover:bg-surface-raised hover:text-text-primary`}
					>
						{t("visit.stayingOnSite")}
					</button>
					<button
						onClick={handleHeadingOut}
						disabled={isLoading}
						className={`${btn} bg-action-drive hover:bg-action-drive-hover text-on-primary disabled:opacity-40`}
					>
						{isLoading ? t("visit.updating") : t("visit.headingOut")}
					</button>
				</div>
			</div>
		);
	}

	if (uiState === "pause-warning") {
		const otherNames = openEntries
			.filter((e) => e.tech_id !== techId)
			.map((e) => e.tech.name)
			.join(", ");
		return (
			<div className="space-y-2.5">
				<div className="rounded-lg bg-warning/10 border border-warning/25 px-3.5 py-3 space-y-1">
					<div className="flex items-center gap-2">
						<AlertTriangle size={13} className="text-warning-text shrink-0" />
						<p className="text-sm font-semibold text-warning-text">{t("visit.otherTechsOnSite")}</p>
					</div>
					<p className="text-xs text-text-tertiary leading-relaxed">
						{t("visit.pauseClocksOut", { names: otherNames })}
					</p>
				</div>
				<div className="flex gap-2">
					<button
						autoFocus
						onClick={dismiss}
						className={`${btn} bg-surface border border-border text-text-primary hover:bg-surface-raised hover:text-text-primary`}
					>
						{t("common.cancel")}
					</button>
					<button
						onClick={handleConfirmPause}
						disabled={isLoading}
						className={`${btn} bg-action-pause hover:bg-action-pause-hover text-on-primary disabled:opacity-40`}
					>
						{isLoading ? t("visit.pausing") : t("visit.pauseAnyway")}
					</button>
				</div>
			</div>
		);
	}

	if (uiState === "force-complete") {
		const otherNames = openEntries.filter((e) => e.tech_id !== techId).map((e) => e.tech.name).join(", ");
		return (
			<div className="space-y-2.5">
				<div className="rounded-lg bg-warning/10 border border-warning/25 px-3.5 py-3 space-y-1">
					<div className="flex items-center gap-2">
						<AlertTriangle size={13} className="text-warning-text shrink-0" />
						<p className="text-sm font-semibold text-warning-text">{t("visit.otherTechsOnSite")}</p>
					</div>
					<p className="text-xs text-text-tertiary leading-relaxed">
						{t("visit.completeClocksOut", { names: otherNames })}
					</p>
				</div>
				<div className="flex gap-2">
					<button
						autoFocus
						onClick={dismiss}
						className={`${btn} bg-surface border border-border text-text-primary hover:bg-surface-raised hover:text-text-primary`}
					>
						{t("common.cancel")}
					</button>
					<button
						onClick={handleConfirmComplete}
						disabled={isLoading}
						className={`${btn} bg-action-pause hover:bg-action-pause-hover text-on-primary disabled:opacity-40`}
					>
						{isLoading ? t("visit.completing") : t("visit.forceComplete")}
					</button>
				</div>
			</div>
		);
	}

	if (uiState === "prompt-complete") {
		return (
			<div className="space-y-2">
				<p className="text-xs text-text-secondary text-center font-medium">{t("visit.completeThisVisit")}</p>
				<div className="flex gap-2">
					<button
						autoFocus
						onClick={handleDeclineComplete}
						className={`${btn} bg-surface border border-border text-text-primary hover:bg-surface-raised hover:text-text-primary`}
					>
						{t("visit.keepPaused")}
					</button>
					<button
						onClick={handleConfirmComplete}
						disabled={isLoading}
						className={`${btn} bg-confirm hover:bg-confirm-hover text-on-primary disabled:opacity-40`}
					>
						{isLoading ? t("visit.completing") : t("visit.completeCheck")}
					</button>
				</div>
			</div>
		);
	}

	if (uiState === "paused-info") {
		return (
			<div className="space-y-2">
				<div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-surface border border-border">
					<Info size={14} className="text-text-tertiary shrink-0 mt-0.5" />
					<p className="text-xs text-text-tertiary">
						{t("visit.nowPaused")}
					</p>
				</div>
				<div className="flex">
					<button
						autoFocus
						onClick={dismiss}
						className={`${btn} bg-surface border border-border text-text-secondary hover:bg-surface-raised hover:text-text-primary`}
					>
						{t("visit.dismiss")}
					</button>
				</div>
			</div>
		);
	}

	if (uiState === "switch-confirm") {
		return (
			<div className="space-y-2">
				<p className="text-xs text-text-secondary text-center font-medium">
					{t("visit.switchDestination")}
				</p>
				<div className="flex gap-2">
					<button
						autoFocus
						onClick={dismiss}
						className={`${btn} bg-surface border border-border text-text-primary hover:bg-surface-raised hover:text-text-primary`}
					>
						{t("common.cancel")}
					</button>
					<button
						onClick={handleConfirmSwitch}
						disabled={isLoading}
						className={`${btn} bg-action-drive hover:bg-action-drive-hover text-on-primary disabled:opacity-40`}
					>
						{isLoading ? t("visit.switching") : t("visit.switch")}
					</button>
				</div>
			</div>
		);
	}

	// ── Button matrix — driven by myTechVisitStatus ─────────────────────────────

	const tooltipEl = tooltip ? (
		<div role="status" className="px-2.5 py-1.5 rounded-md bg-surface border border-border text-xs text-text-primary text-center">
			{tooltip}
		</div>
	) : null;

	// Assigned → show "I'm Driving"
	if (myTechVisitStatus === "Assigned") {
		const driveDisabled = !constraints.drive.enabled;
		return (
			<div className="space-y-1.5">
				{tooltipEl}
				<div className="flex">
					<button
						onClick={
							driveDisabled
								? () => constraints.drive.reason && showTooltip(t(constraints.drive.reason))
								: handleDrive
						}
						disabled={isLoading}
						aria-label={confirmingAction === "drive" ? t("visit.confirmDriveAria") : t("visit.imDriving")}
						className={`${btn} ${
							driveDisabled
								? "bg-action-drive text-on-primary opacity-50 cursor-not-allowed"
								: confirmingAction === "drive"
								? "bg-action-drive-hover text-on-primary border border-primary-text motion-safe:animate-pulse"
								: "bg-action-drive hover:bg-action-drive-hover text-on-primary"
						}`}
					>
					<Car size={iconSize} />
					{confirmingAction === "drive" ? t("visit.confirmDriving") : t("visit.imDriving")}
					</button>
				</div>
				{clockError && (
					<p role="alert" className="text-[11px] text-error-text text-center">{clockError}</p>
				)}
			</div>
		);
	}

	// EnRoute → show "I've Arrived"
	if (myTechVisitStatus === "EnRoute") {
		const arriveDisabled = !constraints.arrive.enabled;
		return (
			<div className="space-y-1.5">
				{tooltipEl}
				<div className="flex">
					<button
						onClick={
							arriveDisabled
								? () => constraints.arrive.reason && showTooltip(t(constraints.arrive.reason))
								: handleArrive
						}
						disabled={isLoading || optimisticStatus !== null}
						aria-label={confirmingAction === "arrive" ? t("visit.confirmArriveAria") : t("visit.imArrived")}
						className={`${btn} ${
							arriveDisabled
								? "bg-action-drive text-on-primary opacity-50 cursor-not-allowed"
								: confirmingAction === "arrive"
								? "bg-action-drive-hover text-on-primary border border-primary-text motion-safe:animate-pulse"
								: "bg-action-drive hover:bg-action-drive-hover text-on-primary"
						}`}
					>
						{optimisticStatus === "EnRoute" ? (
							<>
								<Loader2 size={iconSize} className="animate-spin" />
								{t("visit.confirmDrive")}
							</>
						) : (
							<>
								<MapPin size={iconSize} />
								{confirmingAction === "arrive" ? t("visit.confirmArrived") : t("visit.imArrived")}
							</>
						)}
					</button>
				</div>
				{clockError && (
					<p role="alert" className="text-[11px] text-error-text text-center">{clockError}</p>
				)}
			</div>
		);
	}

	// OnSite — clocked in: Pause + Complete (primary), Clock Out (secondary); not clocked in: Clock In
	if (myTechVisitStatus === "OnSite") {
		if (isClockedIn) {
			return (
				<div className="space-y-2">
					{tooltipEl}
					<div className="flex gap-2">
						<button
							onClick={handlePause}
							disabled={isLoading}
							className={`${btn} bg-surface hover:bg-surface-raised border border-border text-text-secondary`}
						>
							<Pause size={iconSize} />
							{variant === "detail" ? t("visit.pauseVisit") : t("visit.pause")}
						</button>
						<button
							onClick={handleComplete}
							disabled={isLoading}
							className={`${btn} ${
								confirmingAction === "complete"
									? "bg-confirm-hover text-text-inverse motion-safe:animate-pulse"
									: "bg-confirm hover:bg-confirm-hover text-on-primary"
							}`}
						>
							{confirmingAction !== "complete" && <CheckCircle2 size={iconSize} />}
							{confirmingAction === "complete" ? t("visit.confirmComplete") : t("visit.complete")}
						</button>
					</div>
					<div className="flex">
						<button
							onClick={handleClockOut}
							disabled={isLoading}
							className={`${btn} border border-border text-text-muted hover:bg-surface hover:text-text-tertiary`}
						>
							<Clock size={iconSize} />
							{isLoading ? t("visit.clockingOut") : t("visit.clockOut")}
						</button>
					</div>
					{clockError && (
						<p role="alert" className="text-[11px] text-error-text text-center">{clockError}</p>
					)}
				</div>
			);
		}

		const clockInDisabled = !constraints.clockIn.enabled;
		const label = visit.status === "Paused" ? t("visit.clockInResume") : t("visit.clockInBegin");
		return (
			<div className="space-y-1.5">
				{tooltipEl}
				<div className="flex">
					<button
						onClick={
							clockInDisabled
								? () => constraints.clockIn.reason && showTooltip(t(constraints.clockIn.reason))
								: handleClockIn
						}
						disabled={isLoading && !clockInDisabled}
						className={`${btn} ${
							clockInDisabled
								? "bg-primary-hover text-on-primary opacity-50 cursor-not-allowed"
								: "bg-primary-hover hover:bg-primary text-on-primary"
						}`}
					>
						<Play size={iconSize} />
						{isLoading && !clockInDisabled ? t("visit.clockingIn") : label}
					</button>
				</div>
				{clockError && (
					<p role="alert" className="text-[11px] text-error-text text-center">{clockError}</p>
				)}
			</div>
		);
	}

	// Done → "I'm Available"
	if (myTechVisitStatus === "Done") {
		return (
			<div className="space-y-1.5">
				<div className="flex">
					<button
						onClick={handleAvailable}
						disabled={isLoading}
						className={`${btn} bg-confirm hover:bg-confirm-hover text-on-primary`}
					>
						<UserCheck size={iconSize} />
						{isLoading ? t("visit.updating") : t("dashboard.im_available")}
					</button>
				</div>
			</div>
		);
	}

	return null;
}
