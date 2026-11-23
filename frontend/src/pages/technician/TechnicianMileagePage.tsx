import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, MapPin, Gauge } from "lucide-react";
import { useAuthStore } from "../../auth/authStore";
import { useJobVisitsByTechIdQuery } from "../../hooks/useJobs";
import { FALLBACK_TIMEZONE, startOfWeek, addDays, formatWeekDay, formatWeekRange, isSameDay } from "../../util/util";
import TechPage from "../../components/technician/TechPage";


export default function TechnicianMileagePage() {
	const navigate = useNavigate();
	const { t } = useTranslation();
	const { user } = useAuthStore();
	const tz = user?.orgTimezone ?? FALLBACK_TIMEZONE;
	const { data: allVisits = [], isLoading } = useJobVisitsByTechIdQuery(user?.userId ?? "");

	const [weekOffset, setWeekOffset] = useState(0);

	const weekStart = addDays(startOfWeek(new Date()), weekOffset * 7);
	const weekEnd = addDays(weekStart, 6);
	weekEnd.setHours(23, 59, 59, 999);

	const weekVisits = allVisits.filter((v) => {
		if (v.estimated_drive_miles == null) return false;
		const d = new Date(v.scheduled_start_at);
		return d >= weekStart && d <= weekEnd;
	});

	const totalMiles = weekVisits.reduce((sum, v) => sum + Number(v.estimated_drive_miles ?? 0), 0);

	const days: { date: Date; visits: typeof weekVisits }[] = [];
	for (let i = 0; i < 7; i++) {
		const day = addDays(weekStart, i);
		const dayVisits = weekVisits.filter((v) =>
			isSameDay(new Date(v.scheduled_start_at), day, tz)
		);
		if (dayVisits.length > 0) days.push({ date: day, visits: dayVisits });
	}

	const isCurrentWeek = weekOffset === 0;

	return (
		<TechPage className="space-y-5">
			{/* Header */}
			<div>
				<div className="flex items-center gap-2 mb-0.5">
					<Gauge size={18} className="text-text-tertiary" />
					<h1 className="text-lg font-semibold text-text-primary">{t("mileage.mileage")}</h1>
				</div>
				<p className="text-xs text-text-muted">{t("mileage.driving_distance")}</p>
			</div>

			{/* Week navigator */}
			<div className="flex items-center justify-between bg-base border border-border-subtle rounded-xl px-4 py-3">
				<button
					onClick={() => setWeekOffset((o) => o - 1)}
					className="flex items-center justify-center w-11 h-11 rounded-lg hover:bg-surface text-text-tertiary hover:text-text-primary transition-colors"
				>
					<ChevronLeft size={18} />
				</button>
				<div className="text-center">
					<p className="text-sm font-medium text-text-primary">{formatWeekRange(weekStart, tz)}</p>
					{isCurrentWeek && (
						<p className="text-[10px] text-text-muted mt-0.5">{t("mileage.current_week")}</p>
					)}
				</div>
				<button
					onClick={() => setWeekOffset((o) => o + 1)}
					disabled={isCurrentWeek}
					className="flex items-center justify-center w-11 h-11 rounded-lg hover:bg-surface text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
				>
					<ChevronRight size={18} />
				</button>
			</div>

			{/* Total Miles */}
			<div className="bg-base border border-border-subtle rounded-xl px-6 py-5 text-center">
				{isLoading ? (
					<div className="h-10 w-24 bg-surface rounded animate-pulse mx-auto" />
				) : (
					<p className="text-5xl font-bold tabular-nums tracking-tight text-text-primary">
						{totalMiles.toFixed(1)}
					</p>
				)}
				<p className="text-xs text-text-muted mt-2 uppercase tracking-widest">{t("mileage.miles_this_week")}</p>
			</div>

			{/* Days */}
			{isLoading ? (
				<div className="space-y-3">
					{[1, 2].map((i) => (
						<div key={i} className="h-20 bg-surface rounded-xl animate-pulse" />
					))}
				</div>
			) : days.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-12 text-center">
					<Gauge size={32} className="text-text-faint mb-3" />
					<p className="text-sm text-text-muted">{t("mileage.no_mileage_recorded")}</p>
					<p className="text-xs text-text-faint mt-1">
						{t("mileage.miles_are_logged")}
					</p>
				</div>
			) : (
				<div className="space-y-4">
					{days.map(({ date, visits: dayVisits }) => (
						<div key={date.toISOString()} className="space-y-1.5">
							<p className="text-xs font-semibold text-text-muted uppercase tracking-wide px-1">
								{formatWeekDay(date, tz)}
							</p>
							<div className="bg-base border border-border-subtle rounded-xl overflow-hidden divide-y divide-border-subtle">
								{dayVisits.map((v) => (
									<button
										key={v.id}
										type="button"
										onClick={() => navigate(`/technician/visits/${v.id}`)}
										className="w-full flex items-center justify-between px-4 py-3 gap-3 text-left cursor-pointer hover:bg-surface transition-colors"
									>
										<div className="min-w-0">
											<p className="text-sm font-medium text-text-primary truncate">
												{v.job?.name ?? `${t("dashboard.visit_fallback")} ${v.id.slice(-6)}`}
											</p>
											{v.job?.address && (
												<p className="text-xs text-text-muted flex items-center gap-1 mt-0.5 truncate">
													<MapPin size={10} className="shrink-0" />
													{v.job.address}
												</p>
											)}
										</div>
										<span className="text-sm font-bold tabular-nums text-text-primary shrink-0">
											{t("mileage.miles", { miles: Number(v.estimated_drive_miles).toFixed(1) })}
										</span>
									</button>
								))}
							</div>
							<p className="text-xs text-text-muted text-right px-1">
								{t("mileage.day_total")}{" "}
								<span className="text-text-secondary font-medium">
									{t("mileage.miles", {
										miles: dayVisits
											.reduce((s, v) => s + Number(v.estimated_drive_miles ?? 0), 0)
											.toFixed(1),
									})}
								</span>
							</p>
						</div>
					))}
				</div>
			)}
		</TechPage>
	);
}
