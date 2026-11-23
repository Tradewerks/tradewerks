import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { FileText, Camera, ChevronRight, MapPin, CalendarDays, FolderKanban } from "lucide-react";
import VisitActionButtons from "./VisitActionButtons";
import type { JobVisit } from "../../types/jobs";
import { formatTime, formatDateTime, FALLBACK_TIMEZONE } from "../../util/util";

interface TechVisitCardProps {
	visit: JobVisit;
	techId: string;
	tz?: string;
	showDateTime?: boolean;
	showDistance?: boolean;
	distanceMiles?: number | null;
	onAddNotePhoto?: () => void;
}

const ACTIVE_STATUSES = new Set(["Driving", "OnSite", "InProgress", "Paused"]);
const COMING_SOON_MS = 90 * 60_000;


interface CardStyle {
	gradientColor: string;
	dotColor: string;
	textColor: string;
	label: string;
	animated: boolean;
}

const GREY_INACTIVE = {
	gradientColor: "var(--color-surface-raised)",
	dotColor: "var(--color-border-strong)",
	textColor: "var(--color-text-muted)",
} as const; // zinc-700 / zinc-600 / zinc-500

const VISIT_CARD_COLORS: Record<
	"clockedIn" | "active" | "completed" | "cancelled" | "overdue" | "soon" | "scheduled" | "delayed" | "paused",
	Pick<CardStyle, "gradientColor" | "dotColor" | "textColor">
> = {
	clockedIn:  { gradientColor: "var(--color-visit-completed)",      dotColor: "var(--color-visit-completed)",      textColor: "var(--color-success-bright-text)" },
	active:     { gradientColor: "var(--color-primary)",              dotColor: "var(--color-primary)",              textColor: "var(--color-visit-driving-text)" },
	completed:  { gradientColor: "var(--color-visit-completed-dark)", dotColor: "var(--color-visit-completed-dark)", textColor: "var(--color-success-bright-text)" },
	cancelled:  GREY_INACTIVE,
	overdue:    { gradientColor: "var(--color-error)",                dotColor: "var(--color-error)",                textColor: "var(--color-error-text)" },
	soon:       { gradientColor: "var(--color-warning)",              dotColor: "var(--color-warning)",              textColor: "var(--color-warning-text)" },
	scheduled:  GREY_INACTIVE,
	delayed:    { gradientColor: "var(--color-visit-paused)",         dotColor: "var(--color-visit-paused)",         textColor: "var(--color-visit-delayed-text)" },
	paused:     { gradientColor: "var(--color-visit-delayed)",        dotColor: "var(--color-visit-delayed)",        textColor: "var(--color-visit-paused-text)" },
};

function getCardStyle(visit: JobVisit, isClockedIn: boolean, t: TFunction): CardStyle {
	const statusLabel = t(`status.visit.${visit.status}`);
	if (visit.status === "Delayed")
		return { ...VISIT_CARD_COLORS.delayed, label: statusLabel, animated: false };
	if (visit.status === "Paused")
		return { ...VISIT_CARD_COLORS.paused, label: statusLabel, animated: false };

	const isActive = ACTIVE_STATUSES.has(visit.status);

	if (isActive && isClockedIn)
		return { ...VISIT_CARD_COLORS.clockedIn, label: t("visit.clockedIn"), animated: true };
	if (isActive) return { ...VISIT_CARD_COLORS.active, label: statusLabel, animated: false };
	if (visit.status === "Completed")
		return { ...VISIT_CARD_COLORS.completed, label: statusLabel, animated: false };
	if (visit.status === "Cancelled")
		return { ...VISIT_CARD_COLORS.cancelled, label: statusLabel, animated: false };

	const now = Date.now();
	const start = new Date(visit.scheduled_start_at).getTime();
	if (start < now)
		return { ...VISIT_CARD_COLORS.overdue, label: t("dashboard.overdue"), animated: false };
	if (start - now < COMING_SOON_MS)
		return { ...VISIT_CARD_COLORS.soon, label: t("visits.soon"), animated: false };
	return { ...VISIT_CARD_COLORS.scheduled, label: statusLabel, animated: false };
}

export default function TechVisitCard({
	visit,
	techId,
	tz = FALLBACK_TIMEZONE,
	showDateTime = false,
	showDistance = false,
	distanceMiles,
	onAddNotePhoto,
}: TechVisitCardProps) {
	const navigate = useNavigate();
	const { t } = useTranslation();
	const [isOverlay, setIsOverlay] = useState(false);

	const myOpenEntry = visit.time_entries?.find(
		(e) => e.tech_id === techId && e.clocked_out_at === null,
	);
	const isClockedIn = myOpenEntry != null;
	const style = getCardStyle(visit, isClockedIn, t);
	const openEntries =
		visit.time_entries?.filter((e) => e.clocked_out_at === null) ?? [];
	const isDone =
		visit.status === "Completed" || visit.status === "Cancelled";
	const showNotePhoto = Boolean(onAddNotePhoto && isClockedIn);

	return (
		<div
			style={{
				padding: "1px 1px 1px 3px",
				background: `linear-gradient(to right, ${style.gradientColor} 0%, var(--color-surface-raised) 45%, var(--color-surface-raised) 100%)`,
				borderRadius: "12px",
			}}
		>
			<div className="rounded-[11px] bg-base px-4 py-4">
				{/* Header: title with badge on the right */}
				<div className="flex items-start justify-between gap-2 mb-0.5">
					<p
						className={`flex-1 min-w-0 text-[15px] font-bold leading-snug ${
							isDone ? "text-text-muted line-through" : "text-text-primary"
						}`}
						title={visit.name ?? t("dashboard.visit_fallback")}
					>
						{visit.name ?? t("dashboard.visit_fallback")}
					</p>
					<div className="shrink-0 flex items-center gap-1.5">
						{style.animated ? (
							<span className="relative flex h-[7px] w-[7px] flex-shrink-0">
								<span
									className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full opacity-60"
									style={{ backgroundColor: style.dotColor }}
								/>
								<span
									className="relative inline-flex h-[7px] w-[7px] rounded-full"
									style={{ backgroundColor: style.dotColor }}
								/>
							</span>
						) : (
							<span
								className="h-[7px] w-[7px] rounded-full flex-shrink-0"
								style={{ backgroundColor: style.dotColor }}
							/>
						)}
						<span
							className="text-[10px] font-bold tracking-[0.08em] uppercase leading-none"
							style={{ color: style.textColor }}
						>
							{style.label}
						</span>
					</div>
				</div>

				{/* Client */}
				{visit.job?.client?.name && (
					<p className="text-xs text-text-muted mb-0.5">
						{visit.job.client.name}
					</p>
				)}

				{/* Project */}
				{visit.job?.project && (
					<p className="text-xs text-text-tertiary mb-0.5 flex items-center gap-1">
						<FolderKanban size={11} className="text-text-faint shrink-0" aria-hidden="true" />
						{visit.job.project.project_number}  ·  {visit.job.project.name}
					</p>
				)}

				{/* Address + optional distance */}
				{visit.job?.address && (
					<p className="text-xs text-text-tertiary mb-0.5 flex items-center gap-1">
						<MapPin size={11} className="text-text-faint shrink-0" aria-hidden="true" />
						{visit.job.address}
						{showDistance && distanceMiles != null && (
							<span className="text-text-faint ml-2 tabular-nums">
								{distanceMiles < 0.1
									? t("mileage.miles", { miles: "< 0.1" })
									: t("mileage.miles", { miles: distanceMiles.toFixed(1) })}
							</span>
						)}
					</p>
				)}

				{/* Date/time — visits page only */}
				{showDateTime && (
					<p className="text-xs text-text-muted mb-0.5 flex items-center gap-1">
						<CalendarDays size={11} className="text-text-faint shrink-0" aria-hidden="true" />
						{formatDateTime(visit.scheduled_start_at, tz)}
					</p>
				)}

				{/* Clock-in elapsed + on-site names — dashboard only (no showDateTime) */}
				{!showDateTime && isClockedIn && myOpenEntry && (
					<p className="text-xs text-text-tertiary mb-0.5">
						<span className="text-text-faint mr-1">{t("visit.since")}</span>
						{formatTime(myOpenEntry.clocked_in_at, tz)}
					</p>
				)}
				{!showDateTime && openEntries.length > 0 && (
					<p className="text-[11px] text-text-muted mb-0.5">
						{t("visit.onSite", { names: openEntries.map((e) => e.tech.name).join(", ") })}
					</p>
				)}

				{/* Action row */}
				<div className="mt-2">
					{isDone ? (
						<button
							onClick={() => navigate(`/technician/visits/${visit.id}`)}
							className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg border border-border-subtle bg-surface text-text-muted hover:text-text-secondary hover:bg-surface-raised transition-colors text-[12px] font-medium"
						>
							{t("visit.viewDetails")} <ChevronRight size={13} />
						</button>
					) : (
						<div className={`transition-all duration-200 ${isOverlay ? "" : "flex gap-2 items-stretch"}`}>
							<div className={isOverlay ? "" : "flex-[3] min-w-0"}>
								<VisitActionButtons
									visit={visit}
									techId={techId}
									variant="card"
									onOverlayChange={setIsOverlay}
								/>
							</div>
							{!isOverlay && (
								<>
									<div className="w-px bg-border-subtle self-stretch mx-0.5" />
									<button
										onClick={() =>
											navigate(`/technician/visits/${visit.id}`)
										}
										className="flex-[1] flex items-center justify-center gap-1 rounded-lg border border-border bg-surface text-text-tertiary hover:bg-surface-raised hover:text-text-primary hover:border-border-strong transition-all duration-150 active:scale-[0.97] px-2 py-2.5 min-w-[48px]"
										aria-label={t("visits.view_details")}
									>
										{visit.status === "InProgress" ? (
											<>
												<span className="flex flex-col items-center leading-tight">
													<span className="text-[13px] font-semibold">{t("visit.visitDetailsTop")}</span>
													<span className="text-[13px] font-semibold">{t("visit.visitDetailsBottom")}</span>
												</span>
												<ChevronRight size={14} />
											</>
										) : (
											<>
												<span className="text-[11px] font-semibold">{t("visit.view")}</span>
												<ChevronRight size={13} />
											</>
										)}
									</button>
								</>
							)}
						</div>
					)}
				</div>

				{/* Note / Photo quick action — dashboard only, when clocked in and no overlay active */}
				{showNotePhoto && !isOverlay && (
					<div className="mt-2">
						<button
							onClick={onAddNotePhoto}
							className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg border border-border text-xs text-text-tertiary hover:bg-surface hover:text-text-primary transition-colors"
						>
							<FileText size={12} />
							<Camera size={12} />
							{t("visit.addNotePhoto")}
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
