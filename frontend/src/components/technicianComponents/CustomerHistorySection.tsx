import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useClientVisitHistoryQuery } from "../../hooks/useJobs";
import { useAuthStore } from "../../auth/authStore";
import { FALLBACK_TIMEZONE } from "../../util/util";
import { VisitStatusColors, type VisitStatus } from "../../types/jobs";

function formatShortDate(dateStr: Date | string, tz: string, locale: string): string {
	return new Date(dateStr).toLocaleDateString(locale, {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: tz,
	});
}

export default function CustomerHistorySection({
	clientId,
	currentVisitId,
}: {
	clientId: string;
	currentVisitId: string;
}) {
	const { t, i18n } = useTranslation();
	const { user } = useAuthStore();
	const tz = user?.orgTimezone ?? FALLBACK_TIMEZONE;
	const [open, setOpen] = useState(false);
	const [visibleCount, setVisibleCount] = useState(5);

	useEffect(() => {
		if (!open) setVisibleCount(5);
	}, [open]);

	const { data: history = [], isLoading } = useClientVisitHistoryQuery(
		open ? clientId : null,
		25,
	);

	const filtered = history.filter((v) => v.id !== currentVisitId);
	const visibleVisits = filtered.slice(0, visibleCount);

	return (
		<div className="rounded-xl border border-border-subtle bg-base overflow-hidden">
			<button
				onClick={() => setOpen((p) => !p)}
				aria-expanded={open}
				aria-controls="customer-history-panel"
				className="w-full flex items-center justify-between px-4 py-3"
			>
				<span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
					{t("visitDetail.clientHistory")}
				</span>
				<div className="flex items-center gap-2">
					{filtered.length > 0 && (
						<span className="text-[11px] text-text-muted">{t("visitDetail.recentVisits", { count: filtered.length })}</span>
					)}
					{open ? (
						<ChevronUp size={14} className="text-text-muted" />
					) : (
						<ChevronDown size={14} className="text-text-muted" />
					)}
				</div>
			</button>

			{open && (
				<div id="customer-history-panel" className="border-t border-border-subtle">
					{isLoading ? (
						<div className="flex justify-center py-6">
							<div className="w-5 h-5 rounded-full border-2 border-border border-t-primary animate-spin" />
						</div>
					) : filtered.length === 0 ? (
						<p className="px-4 py-5 text-center text-sm text-text-faint">{t("visitDetail.noPriorVisits")}</p>
					) : (
						<div className="divide-y divide-border-subtle">
							{visibleVisits.map((visit) => {
								const firstNote = visit.notes?.[0];
								const techName = visit.visit_techs?.[0]?.tech?.name;
								return (
									<div key={visit.id} className="px-4 py-3">
										<div className="flex items-start justify-between gap-3">
											<div className="flex-1 min-w-0">
												<p className="text-sm font-medium text-text-primary truncate">
													{visit.name ?? t("dashboard.visit_fallback")}
												</p>
												{techName && (
													<p className="text-[11px] text-text-faint">{techName}</p>
												)}
												{firstNote && (
													<p className="text-xs text-text-muted mt-0.5 line-clamp-1">
														{firstNote.content}
													</p>
												)}
											</div>
											<div className="text-right shrink-0">
												<span
													className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${
														VisitStatusColors[visit.status as VisitStatus] ??
														"bg-surface-raised text-text-tertiary border-border-strong"
													}`}
												>
													{t(`status.visit.${visit.status as VisitStatus}`, {
														defaultValue: visit.status,
													})}
												</span>
												<p className="text-[11px] text-text-faint mt-1">
													{formatShortDate(visit.scheduled_start_at, tz, i18n.language)}
												</p>
											</div>
										</div>
									</div>
								);
							})}
							{visibleCount < filtered.length && (
								<button
									onClick={() => setVisibleCount((c) => Math.min(c + 5, filtered.length))}
									className="px-4 py-2.5 w-full flex items-center justify-center gap-1.5 text-xs text-primary-text hover:bg-surface-raised transition-colors"
								>
									<ChevronDown size={13} />
									{t("visitDetail.loadMore")}
								</button>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
