import React, { useRef, useLayoutEffect, useMemo, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
	Briefcase,
	Inbox,
	FileText,
	ReceiptText,
	Repeat,
	User,
	Activity,
	AlertCircle,
	ChevronRight,
	Loader2,
} from "lucide-react";
import Card from "../ui/Card";
import { useActivityFeed } from "../../hooks/useActivityFeed";
import { formatActivity, resolveRoute, timeAgo } from "./activityFormat";
import { useAuthStore } from "../../auth/authStore";
import { FALLBACK_TIMEZONE } from "../../util/util";

const FEED_FILTERS = [
	{
		key: "technicians",
		icon: User,
		label: "Technicians",
		color: "text-reviewing-text",
		bg: "bg-reviewing-bg",
		eventTypes: new Set(["technician.updated"]),
	},
	{
		key: "requests",
		icon: Inbox,
		label: "Requests",
		color: "text-orange-text",
		bg: "bg-orange-bg",
		eventTypes: new Set(["request.created", "request.updated"]),
	},
	{
		key: "quotes",
		icon: FileText,
		label: "Quotes",
		color: "text-primary-text",
		bg: "bg-primary/10",
		eventTypes: new Set(["quote.created", "quote.updated", "quote.dispute_opened", "quote.dispute_resolved"]),
	},
	{
		key: "jobs",
		icon: Briefcase,
		label: "Jobs",
		color: "text-warning-text",
		bg: "bg-warning/10",
		eventTypes: new Set([
			"job.created",
			"job_visit.created",
			"job_visit.updated",
			"job_visit.technicians_assigned",
		]),
	},
	{
		key: "recurring",
		icon: Repeat,
		label: "Recurring",
		color: "text-plan-text",
		bg: "bg-plan/10",
		eventTypes: new Set(["recurring_plan.created", "recurring_occurrence.generated"]),
	},
	{
		key: "invoices",
		icon: ReceiptText,
		label: "Invoices",
		color: "text-success-text",
		bg: "bg-success/10",
		eventTypes: new Set(["invoice.created", "invoice.updated", "invoice.dispute_opened", "invoice.dispute_resolved", "invoice_payment.created"]),
	},
] as const;

const ITEM_HEIGHT_ESTIMATE = 60;

export default function ActivityFeed(
	{title = "Live Activity Feed", userId = undefined}: {title?: string, userId?: string}
) {
	const navigate = useNavigate();
	const { user } = useAuthStore();
	const tz = user?.orgTimezone ?? FALLBACK_TIMEZONE;

	const {
		logs,
		activeFilters,
		toggleFilter,
		isLoading,
		isError,
		isFetchingMore,
		hasMore,
		loadMore,
		newItemSignal,
		socketConnected,
	} = useActivityFeed({userId});

	const scrollRef = useRef<HTMLDivElement>(null);
	const [flashIds, setFlashIds] = useState<Set<string>>(new Set());

	// Scroll anchor: adjust scrollTop when new item prepended and user isn't at top
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el || el.scrollTop === 0) return;
		el.scrollTop += ITEM_HEIGHT_ESTIMATE;
	}, [newItemSignal]);

	// Flash newest item when signal fires
	useEffect(() => {
		if (newItemSignal === 0 || logs.length === 0) return;
		const id = logs[0].id;
		setFlashIds((prev) => new Set(prev).add(id));
		const t = setTimeout(() => {
			setFlashIds((prev) => {
				const next = new Set(prev);
				next.delete(id);
				return next;
			});
		}, 600);
		return () => clearTimeout(t);
	}, [newItemSignal]); // eslint-disable-line react-hooks/exhaustive-deps

	const activeEventTypes = useMemo<Set<string>>(
		() =>
			new Set(
				FEED_FILTERS.filter((f) => activeFilters.has(f.key)).flatMap((f) => [
					...f.eventTypes,
				])
			),
		[activeFilters]
	);

	const statusIndicator = (
		<div className="flex items-center gap-1.5 flex-shrink-0">
			<div
				aria-hidden="true"
				className={`w-1.5 h-1.5 rounded-full ${
					socketConnected ? "bg-success" : "bg-warning"
				}`}
			/>
			<span className={`text-xs font-medium ${socketConnected ? "text-success-text" : "text-warning-text"}`}>
				{socketConnected ? "Live" : "Reconnecting…"}
			</span>
		</div>
	);

	return (
		<Card title={title} className="h-full" headerAction={statusIndicator}>
			{/* Filter strip — full card width, always visible */}
			<div className="flex flex-wrap items-center gap-1 -mx-4 px-4 pb-3 mb-1 border-b border-border-subtle/60">
				{FEED_FILTERS.map((f) => {
					const active = activeFilters.has(f.key);
					const Icon = f.icon;
					return (
						<button
							key={f.key}
							onClick={() => toggleFilter(f.key)}
							aria-pressed={active}
							className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
								active
									? `${f.bg} ${f.color}`
									: "text-text-muted hover:text-text-secondary hover:bg-surface/60"
							}`}
						>
							<Icon size={11} aria-hidden="true" />
							{f.label}
						</button>
					);
				})}
			</div>

			{isLoading ? (
				<div className="space-y-1">
					{Array.from({ length: 6 }).map((_, i) => (
						<div key={i} className="flex items-start gap-3 p-3">
							<div className="flex-shrink-0 w-8 h-8 rounded-lg bg-surface-raised animate-pulse" />
							<div className="flex-1 space-y-2 pt-0.5">
								<div
									className="h-3.5 bg-surface-raised rounded animate-pulse"
									style={{ width: `${55 + (i % 4) * 10}%` }}
								/>
								<div className="h-2.5 bg-surface-raised rounded animate-pulse w-14" />
							</div>
						</div>
					))}
				</div>
			) : isError ? (
				<div className="flex flex-col items-center justify-center py-10 gap-2">
					<AlertCircle size={20} className="text-error-text/60" />
					<p className="text-sm text-error-text">Failed to load activity</p>
				</div>
			) : (
				<>
					<div
						ref={scrollRef}
						className="space-y-0.5 overflow-y-auto max-h-[510px] scrollbar-on-hover"
					>
						{(() => {
							const visible = logs
								.filter((log) => activeEventTypes.has(log.event_type))
								.map((log) => ({
									log,
									entry: formatActivity(log, tz),
									route: resolveRoute(log),
								}))
								.filter(({ entry }) => entry !== null);

							if (visible.length === 0) {
								return (
									<div className="flex flex-col items-center justify-center py-10 gap-2">
										<Activity size={20} className="text-text-faint" />
										<p className="text-sm text-text-muted">
											{logs.length === 0 ? "No recent activity" : "No matching activity"}
										</p>
									</div>
								);
							}

							return visible.map(({ log, entry, route }) => {
								const Icon = entry!.icon;
								const isFlashing = flashIds.has(log.id);
								const showActor = log.actor_name && log.actor_type !== "system";
								return (
									<div
										key={log.id}
										onClick={route ? () => navigate(route) : undefined}
										className={`flex items-center gap-3 p-3 rounded-lg hover:bg-surface-raised transition-colors group${route ? " cursor-pointer" : ""}`}
										style={
											isFlashing
												? { animation: "feedFlash 600ms ease-out forwards" }
												: undefined
										}
									>
										<div
											className={`flex-shrink-0 w-8 h-8 rounded-lg ${entry!.bg} flex items-center justify-center`}
										>
											<Icon size={14} className={entry!.color} />
										</div>
										<div className="flex-1 min-w-0">
											<div className="flex items-start justify-between gap-2">
												<p className="text-sm text-text-primary transition-colors leading-snug truncate">
													{entry!.message}
												</p>
												<span className="text-xs text-text-faint flex-shrink-0 pt-px">
													{timeAgo(log.timestamp)}
												</span>
											</div>
											{entry!.subtitle ? (
												<p className="text-xs text-text-muted mt-0.5 truncate">
													{entry!.subtitle}
												</p>
											) : showActor ? (
												<p className="text-xs text-text-muted mt-0.5 truncate">
													{log.actor_name}
												</p>
											) : null}
										</div>
										{route && (
											<ChevronRight
												size={13}
												className="flex-shrink-0 text-secondary group-hover:text-text-tertiary transition-colors"
											/>
										)}
									</div>
								);
							});
						})()}
					</div>

					{hasMore && (
						<button
							onClick={loadMore}
							disabled={isFetchingMore}
							className="mt-2 w-full bg-surface-raised hover:bg-surface-inset disabled:opacity-50 disabled:cursor-not-allowed text-sm text-text-tertiary rounded-lg py-2 flex items-center justify-center gap-2 transition-colors"
						>
							{isFetchingMore ? (
								<>
									<Loader2 size={14} className="animate-spin" />
									Loading…
								</>
							) : (
								"Load older activity"
							)}
						</button>
					)}
				</>
			)}
		</Card>
	);
}
