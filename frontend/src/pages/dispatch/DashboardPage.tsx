import React, { useState, useMemo, useRef, useEffect } from "react";
import { ResponsiveGridLayout, useContainerWidth } from "react-grid-layout";
import type { Layout, ResponsiveLayouts } from "react-grid-layout";
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import '../../components/ui/GridLayout.css';
import { useNavigate } from "react-router-dom";
import {
	AlertCircle,
	ChevronRight,
	Clock,
	LayoutDashboard,
	LayoutGrid,
	RotateCcw,
	StretchHorizontal,
	Shuffle,
	Trash,
	Unlock,
} from "lucide-react";
import Card from "../../components/ui/Card";
import WeekStrip from "../../components/ui/schedule/WeekStrip";
import { useAuthStore } from "../../auth/authStore";
import { FALLBACK_TIMEZONE } from "../../util/util";
import { useAllJobsQuery } from "../../hooks/useJobs";
import { useActiveTechniciansQuery } from "../../hooks/useTechnicians";
import { useAllRequestsQuery } from "../../hooks/useRequests";
import { useAllQuotesQuery } from "../../hooks/useQuotes";
import { useAllRecurringPlansQuery } from "../../hooks/useRecurringPlans";
import type { JobVisit } from "../../types/jobs";
import type { TechnicianStatus } from "../../types/technicians";
import CreateRecurringPlan from "../../components/recurringPlans/CreateRecurringPlan";
import LowStockWidget from "../../components/widgets/LowStockWidget";
import OpenDisputesWidget from "../../components/widgets/OpenDisputesWidget";
import MaintenanceRemindersWidget from "../../components/widgets/MaintenanceRemindersWidget";
import { canSeeWidget } from "../../lib/permissionGates";
import ActivityFeed from "../../components/dashboard/ActivityFeed";
import { useDispatcherByIdQuery, useUpdateDispatcherMutation } from "../../hooks/useDispatchers";
import { DEFAULT_RESPONSIVE_LAYOUTS, WIDGET_CATALOG } from "../../lib/DashboardConfig";
import { BREAKPOINTS, resolveConstraints, getActiveCols, fitLayout, randomizeLayout, removeWidget, stackLayout } from "../../lib/gridLayoutEngine";
import { QUICKBOOKS_ENABLED } from "../../config/features";
import AddWidgetModal from "../../components/widgets/AddWidgetModal";
import MapWidget from "../../components/widgets/MapWidget";
import LiveArrivalsWidget from "../../components/widgets/LiveArrivalsWidget";
import QBWidget from "../../components/widgets/QBWidget";
import {
	OverviewWidget,
	RevenueYTDWidget,
	UnscheduledRevenueWidget,
	RevenueByJobTypeWidget,
	LeadsBySourceWidget,
	QuotePipelineWidget,
	ArrivalPerformanceWidget,
	MileageSummaryWidget,
	AgedReceivablesColumnWidget,
	JobBacklogWidget,
	PageReportWidget,
} from "../../components/widgets/reports";
import OverdueInvoicesWidget from "../../components/widgets/OverdueInvoicesWidget";
import VehicleReadinessWidget from "../../components/widgets/VehicleReadinessWidget";


/* Status underline on the technician badge. Eight statuses collapse to three
   signals because the panel is scanned, not read — and the corner pip already
   carries the per-tech "on a live visit" bit, so per-state granularity here
   would be a second encoding of the same thing.

   Typed against TechnicianStatus so adding an enum member fails the build. The
   previous map keyed off `string` and listed "Busy", which has never been a
   status — it silently never matched, and the five real working statuses
   (Working/OnSite/EnRoute/WrappingUp/Paused) all fell through to a neutral
   fallback that resolved to the same grey as the badge fill. */
const TECH_STATUS_BORDER: Record<TechnicianStatus, string> = {
	Available:  "border-success",
	Working:    "border-warning",
	OnSite:     "border-warning",
	EnRoute:    "border-warning",
	WrappingUp: "border-warning",
	HeadingBack: "border-warning",
	Paused:     "border-reviewing",
	Break:      "border-reviewing",
	// Filtered out of this widget, but a square with no signal stays a square.
	Offline:    "border-transparent",
};

const getStatusBorderClass = (status: TechnicianStatus) =>
	TECH_STATUS_BORDER[status] ?? "border-transparent";

export default function DashboardPage() {
	const navigate = useNavigate();
	const { user } = useAuthStore();
	const { data: dispatcher } = useDispatcherByIdQuery(user?.userId);
	const tz = user?.orgTimezone ?? FALLBACK_TIMEZONE;

	const [isCreatePlanModalOpen, setIsCreatePlanModalOpen] = useState(false);
	const justDraggedRef = useRef(false); // to prevent click events immediately after dragging
	
	const [layouts, setLayouts] = useState<ResponsiveLayouts>(DEFAULT_RESPONSIVE_LAYOUTS);
	const [displayLayouts, setDisplayLayouts] = useState<ResponsiveLayouts>(DEFAULT_RESPONSIVE_LAYOUTS);
	const [isEditMode, setIsEditMode] = useState(false);
	const [isAddWidgetModalOpen, setIsAddWidgetModalOpen] = useState(false);

	// Seed saved layout when dispatcher data loads
	useEffect(() => {
		if (dispatcher?.dashboard_layout) {
			setLayouts(prev => ({ ...prev, lg: dispatcher.dashboard_layout as Layout }));
		}
	}, [dispatcher?.dashboard_layout]);

	const updateDispatcher = useUpdateDispatcherMutation();

	const { data: jobs = [], error: jobsError } = useAllJobsQuery();
	const { data: requests = [] } = useAllRequestsQuery();
	const { data: quotes = [] } = useAllQuotesQuery();
	const { data: recurringPlans = [] } = useAllRecurringPlansQuery();
	const { data: allTechnicians = [], error: techsError } = useActiveTechniciansQuery();

	const saveDashboardLayout = async (id: string, newLayout: Layout) => {
		try {
			await updateDispatcher.mutateAsync({
				id,
				data: { dashboard_layout: newLayout },
			});
		} catch (error) {
			console.error("Failed to save dashboard layout:", error);
		}
	}

	const handleLayoutSave = (newLayout: Layout) => {
		setLayouts(prev => ({ ...prev, lg: newLayout }));
		if (dispatcher?.id) {
			saveDashboardLayout(dispatcher.id, newLayout);
		}
	};

	const technicianStats = useMemo(() => ({
		total: allTechnicians.length,
		online: allTechnicians.filter((t) => t.status !== "Offline").length,
	}), [allTechnicians]);

	const pipelineCounts = useMemo(
		() => ({
			newRequests: requests.filter((r) => r.status === "New").length,
			reviewing: requests.filter((r) => r.status === "Reviewing").length,
			pendingApproval: quotes.filter(
				(q) => q.status === "Sent" || q.status === "Viewed"
			).length,
			approved: quotes.filter((q) => q.status === "Approved").length,
			unscheduled: jobs.filter((j) => j.status === "Unscheduled").length,
			inProgress: jobs
				.flatMap((j) => j.visits || [])
				.filter((v) => v.status === "InProgress").length,
			completedToday: jobs
				.flatMap((j) => j.visits || [])
				.filter(
					(v) =>
						v.status === "Completed" &&
						new Date(v.actual_end_at || "").toLocaleDateString("en-CA", { timeZone: tz }) ===
							new Date().toLocaleDateString("en-CA", { timeZone: tz })
				).length,
		}),
		[requests, quotes, jobs, tz]
	);

	const activeTechnicians = useMemo(() => {
		return allTechnicians
			.filter((t) => t.status !== "Offline")
			.map((tech) => {
				const allVisits = jobs.flatMap((j) => j.visits || []);
				const activeVisits = allVisits.filter(
					(v) =>
						["InProgress", "Driving", "OnSite", "Paused"].includes(v.status) &&
						v.visit_techs?.some((vt) => vt.tech_id === tech.id)
				) as JobVisit[];

				const upcomingVisits = allVisits
					.filter(
						(v) =>
							v.status === "Scheduled" &&
							v.visit_techs?.some((vt) => vt.tech_id === tech.id) &&
							new Date(v.scheduled_start_at) > new Date()
					)
					.sort(
						(a, b) =>
							new Date(a.scheduled_start_at).getTime() -
							new Date(b.scheduled_start_at).getTime()
					) as JobVisit[];

				return {
					...tech,
					currentVisit: activeVisits[0] || null,
					nextVisit: upcomingVisits[0] || null,
				};
			})
			// Techs on a live visit first. Takes both operands — the previous
			// comparator ignored `b`, which is not a valid comparator and left
			// the order up to the engine's sort implementation.
			.sort((a, b) => Number(!!b.currentVisit) - Number(!!a.currentVisit));
	}, [allTechnicians, jobs]);


	const formatNextVisit = (visit: JobVisit): string => {
		const d = new Date(visit.scheduled_start_at);
		const isToday =
			d.toLocaleDateString("en-CA", { timeZone: tz }) ===
			new Date().toLocaleDateString("en-CA", { timeZone: tz });
		const time = d.toLocaleTimeString("en-US", {
			hour: "numeric",
			minute: "2-digit",
			timeZone: tz,
		});
		if (isToday) return time;
		const weekday = d.toLocaleDateString("en-US", { weekday: "short", timeZone: tz });
		return `${weekday} ${time}`;
	};

	const pipelineItems = useMemo(() => [
		{
			label: "New Requests",
			count: pipelineCounts.newRequests,
			topBorder: "border-primary",
			text: "text-primary-text",
			path: "/dispatch/requests?status=New",
		},
		{
			label: "Needs Quote",
			count: pipelineCounts.reviewing,
			topBorder: "border-warning",
			text: "text-warning-text",
			path: "/dispatch/requests?status=Reviewing",
		},
		{
			label: "Pending Approval",
			count: pipelineCounts.pendingApproval,
			topBorder: "border-reviewing",
			text: "text-reviewing-text",
			path: "/dispatch/quotes?status=Sent",
		},
		{
			label: "Approved Quotes",
			count: pipelineCounts.approved,
			topBorder: "border-success",
			text: "text-success-text",
			path: "/dispatch/quotes?status=Approved",
		},
		{
			label: "Unscheduled Jobs",
			count: pipelineCounts.unscheduled,
			topBorder: "border-orange",
			text: "text-orange-text",
			path: "/dispatch/jobs?status=Unscheduled",
		},
	], [pipelineCounts]);

	const activePlansCount = recurringPlans.filter((p) => p.status === "Active").length;
	const pausedPlansCount = recurringPlans.filter((p) => p.status === "Paused").length;

	const { containerRef, width: rawContainerWidth } = useContainerWidth();
	
	const [displayWidth, setDisplayWidth] = useState(0);
	const [settledWidth, setSettledWidth] = useState(0);
	const [isResizing, setIsResizing] = useState(false);
	useEffect(() => {
		if (rawContainerWidth <= 0) return;
		setIsResizing(true);
		setDisplayWidth(rawContainerWidth);
		const t = setTimeout(() => {
			setSettledWidth(rawContainerWidth);
			setIsResizing(false);
		}, 400);
		return () => clearTimeout(t);
	}, [rawContainerWidth]);

	const activeCols = useMemo(() => {
		const c = getActiveCols(settledWidth || displayWidth);
		return { lg: c, md: c, sm: c };
	}, [settledWidth, displayWidth]);

	// Sync displayLayouts when layouts or col count change; below 12 cols every widget stacks full width
	useEffect(() => {
		setDisplayLayouts({
			...layouts,
			lg: activeCols.lg === 12 ? (layouts.lg ?? []) : stackLayout(layouts.lg ?? [], activeCols.lg),
		});
	}, [layouts, activeCols.lg]);

	const constrainedLayouts = useMemo(() => {
		const w = settledWidth || displayWidth;
		const cols = activeCols.lg;
		// The grid must never be handed a layout entry it has no child for.
		const display = (displayLayouts.lg ?? []).filter(item => canSeeWidget(user, WIDGET_CATALOG[item.i])).map(item => {
			const c = resolveConstraints(WIDGET_CATALOG, item.i, w);

			const minW = Math.min(c.minW ?? 1, cols);
			const maxW = Math.min(c.maxW ?? cols, cols);

			return {
				...item,
				...c,
				minW,
				maxW,
				maxH: c.maxH ?? 20,
				w: Math.min(Math.max(item.w, minW), maxW),
				h: Math.min(Math.max(item.h, c.minH ?? 1), c.maxH ?? 20),
			};
		});
		return { lg: display, md: display, sm: display };
	}, [displayLayouts.lg, settledWidth, displayWidth, activeCols.lg, user]);

	function renderWidget(id: string) {
		switch (id) {
			case "week-strip": return <Card className="mb-5 !p-0 h-full">
					{jobsError ? (
						<div className="flex items-center justify-center h-full">
							<div className="flex items-center gap-2 p-4 bg-error/10 border border-error/20 rounded-lg">
								<AlertCircle size={16} className="text-error-text" />
								<p className="text-sm text-error-text">Failed to load calendar data</p>
							</div>
						</div>
					) : (
						<WeekStrip jobs={jobs} technicians={allTechnicians} />
					)}
				</Card>;
			case "pipeline": return <Card title="Operations Pipeline" className="h-full">
							{/* 2-col stat grid for first 4 items */}
							<div className="grid grid-cols-2 gap-x-5 gap-y-4">
								{pipelineItems.slice(0, 4).map((item) => (
									<div
										key={item.label}
										onClick={() => navigate(item.path)}
										className={`cursor-pointer group border-t-2 ${item.topBorder} pt-2.5`}
									>
										<div className={`text-2xl font-bold tabular-nums ${item.text} group-hover:opacity-75 transition-opacity`}>
											{item.count}
										</div>
										<div className="text-[10px] uppercase tracking-wider text-text-muted mt-1 leading-tight">
											{item.label}
										</div>
									</div>
								))}
							</div>

							{/* Unscheduled — full-width, inline count + label */}
							<div
								onClick={() => navigate(pipelineItems[4].path)}
								className={`cursor-pointer group border-t-2 ${pipelineItems[4].topBorder} pt-2.5 mt-4 flex items-baseline gap-3`}
							>
								<div className={`text-2xl font-bold tabular-nums ${pipelineItems[4].text} group-hover:opacity-75 transition-opacity`}>
									{pipelineItems[4].count}
								</div>
								<div className="text-[10px] uppercase tracking-wider text-text-muted">
									{pipelineItems[4].label}
								</div>
							</div>

							{/* Recurring Plans — folded in below pipeline */}
							<div className="mt-4 pt-4 border-t border-border-subtle">
								<button
									onClick={(e) => {
										e.stopPropagation();
										navigate("/dispatch/jobs?view=templates");
									}}
									className="w-full flex items-center justify-between -mx-1 px-1 py-1 rounded hover:bg-surface/40 transition-colors group"
								>
									<span className="text-xs font-medium text-text-tertiary group-hover:text-text-primary transition-colors">
										Recurring Plans
									</span>
									<div className="flex items-center gap-2">
										<span className="text-xs text-text-muted">
											<span className="font-semibold text-text-secondary">{activePlansCount}</span> active
										</span>
										<span className="w-px h-3 bg-border" />
										<span className="text-xs text-text-muted">
											<span className="font-semibold text-text-secondary">{pausedPlansCount}</span> paused
										</span>
										<ChevronRight size={12} className="text-text-faint group-hover:text-text-tertiary transition-colors" />
									</div>
								</button>
							</div>
						</Card>;
			case "activity-feed": return <ActivityFeed />;
			case "technicians": return <Card
							className="h-full"
							scrollable
							quietScroll
							title="Technicians"
							headerAction={
								<div className="flex items-center gap-2">
									<span className="text-xs text-text-muted hidden xl:inline">
										{technicianStats.online} of {technicianStats.total} online
									</span>
									<button
										onClick={() => navigate("/dispatch/technicians")}
										className="text-xs font-medium text-text-tertiary hover:text-text-primary px-2 py-1 rounded hover:bg-surface transition-colors"
									>
										View All
									</button>
								</div>
							}
						>
							{techsError ? (
								<div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg">
									<AlertCircle size={14} className="text-error-text" />
									<p className="text-xs text-error-text">Failed to load technicians</p>
								</div>
							) : activeTechnicians.length === 0 ? (
								/* Laid out on one row. Stacked, this state was ~144px tall against the
								   ~78px a minH:3 card leaves for content, so "nobody is online" — the
								   emptiest the panel ever gets — was the case that scrolled hardest. */
								<div className="flex items-center gap-2 py-2">
									<span className="inline-flex items-center justify-center w-9 h-9 shrink-0 rounded-lg bg-surface">
										<Clock size={16} className="text-text-muted" />
									</span>
									<p className="text-sm text-text-tertiary">No technicians online</p>
								</div>
							) : (
								/* Tile height budget, measured: a minH:3 card leaves 108px of body,
								   and a tile is 74px (p-1.5 12 + avatar 36 + gap-0.5 2 + name ~12.5
								   + sub ~11.25). One row fits with 34px to spare, which is the case
								   that was scrolling for no reason.

								   Past one row this scrolls, and should: the dashboard's
								   fit-to-content pass is dormant (see the note on that effect), so a
								   widget cannot grow itself. The Card body is the scroller rather
								   than a nested div so the scrollbar is the card's own, and
								   quietScroll keeps the thumb hidden until hover. */
								<div
									className="grid gap-1.5 content-start"
									style={{ gridTemplateColumns: "repeat(auto-fill, minmax(4.5rem, 1fr))" }}
								>
									{activeTechnicians.map((tech) => (
										<div
											key={tech.id}
											onClick={() => navigate(`/dispatch/technicians/${tech.id}`)}
											className="flex flex-col items-center gap-0.5 p-1.5 rounded-lg hover:bg-surface/40 cursor-pointer transition-colors group w-full max-w-[5rem] mx-auto"
										>
											{/* pt-[3px] offsets the 3px bottom border, which eats its width
											    from the content box and otherwise sits the initial 1.5px
											    above true centre — a top-heaviness that read as the square
											    being slightly rectangular even once the border was visible. */}
											<div className={`relative w-9 h-9 rounded-lg bg-avatar-bg flex items-center justify-center pt-[3px] text-avatar-fg font-semibold text-sm border-b-[3px] ${getStatusBorderClass(tech.status)}`}>
												{tech.name.charAt(0).toUpperCase()}
												{tech.currentVisit && (
													<span className="absolute -top-1 -right-1 w-2 h-2 bg-warning rounded-full border border-base" />
												)}
											</div>
											<div className="w-full text-center">
												<div className="text-[10px] font-medium text-text-secondary group-hover:text-text-primary truncate transition-colors leading-tight">
													{tech.name.split(" ")[0]}
												</div>
												<div className="text-[9px] leading-tight truncate">
													{tech.currentVisit ? (
														<span className="text-warning-text">On Job</span>
													) : tech.nextVisit ? (
														<span className="text-text-muted">{formatNextVisit(tech.nextVisit)}</span>
													) : (
														<span className="invisible">·</span>
													)}
												</div>
											</div>
										</div>
									))}
								</div>
							)}
						</Card>;
			case "low-stock": 			   return <LowStockWidget className="h-full" />;
			case "open-disputes":          return <OpenDisputesWidget />;
			case "maintenance-reminders":  return <MaintenanceRemindersWidget />;
			case "map":  				   return <MapWidget />;
			case "arrivals":               return <LiveArrivalsWidget />;
			case "quickbooks": 			   return QUICKBOOKS_ENABLED ? <QBWidget /> : null;
			case "report-overview":        return <OverviewWidget />;
			case "report-revenue-ytd":     return <RevenueYTDWidget />;
			case "report-unscheduled-revenue": return <UnscheduledRevenueWidget />;
			case "report-revenue-by-type": return <RevenueByJobTypeWidget />;
			case "report-leads-by-source": return <LeadsBySourceWidget />;
			case "report-quote-pipeline":  return <QuotePipelineWidget />;
			case "report-arrival":         return <ArrivalPerformanceWidget />;
			case "report-mileage":         return <MileageSummaryWidget />;
			case "report-aged-receivables-bar": return <AgedReceivablesColumnWidget />;
			case "report-page-summary":    return <PageReportWidget />;
			case "report-job-backlog":     return <JobBacklogWidget />;
			case "overdue-invoices": 	   return <OverdueInvoicesWidget />;
			case "vehicle-readiness": 	   return <VehicleReadinessWidget />;
			default: return <div>Unknown widget: {id}</div>;
		}
	}

	return (
		<div className="min-h-0 bg-canvas text-text-primary w-full">
			<div className="w-full px-3 sm:px-5 lg:px-6" ref={containerRef}>
				{/* Header */}
				<div className="mb-3 flex items-end justify-between gap-4">
					<div>
						<div className="flex items-baseline gap-2">
							<h1 className="text-xl sm:text-2xl font-bold text-text-primary tracking-tight">
								Dispatch Dashboard
							</h1>
							<span className="hidden sm:inline text-text-faint text-sm">·</span>
							<p className="hidden sm:block text-sm text-text-tertiary">
								{new Date().toLocaleDateString("en-US", {
									weekday: "long",
									month: "long",
									day: "numeric",
									timeZone: tz,
								})}
							</p>
						</div>
						{/* Situation bar */}
						<div className="flex items-center gap-2 mt-1.5 flex-wrap">
							<span className="text-xs text-text-muted">
								<span className="text-text-secondary font-medium">{technicianStats.online}</span>
								{" "}of {technicianStats.total} online
							</span>
							<span className="w-px h-3 bg-border" />
							<span className="text-xs text-text-muted">
								<span className="text-warning-text font-medium">{pipelineCounts.inProgress}</span>
								{" "}in progress
							</span>
							<span className="w-px h-3 bg-border" />
							<span className="text-xs text-text-muted">
								<span className="text-orange-text font-medium">{pipelineCounts.unscheduled}</span>
								{" "}unscheduled
							</span>
							<span className="w-px h-3 bg-border" />
							<span className="text-xs text-text-muted">
								<span className="text-success-text font-medium">{pipelineCounts.completedToday}</span>
								{" "}done today
							</span>
						</div>
					</div>

					{/* Widgets / Edit layout */}
					<div className="flex items-center gap-2 shrink-0">
						<button
							onClick={() => setIsAddWidgetModalOpen(true)}
							title="Add or remove widgets"
							className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-surface hover:bg-surface-raised border border-border text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
						>
							<LayoutGrid size={13} />
							Widgets
						</button>
						<button
							onClick={() => setIsEditMode((e) => !e)}
							title={isEditMode ? "Lock layout" : "Edit layout"}
							aria-pressed={isEditMode}
							className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md border text-xs font-medium transition-colors ${
								isEditMode
									? "bg-primary/15 border-primary/40 text-primary hover:bg-primary/20"
									: "bg-surface hover:bg-surface-raised border-border text-text-secondary hover:text-text-primary"
							}`}
						>
							{isEditMode ? <Unlock size={13} /> : <LayoutDashboard size={13} />}
							{isEditMode ? "Done" : "Edit"}
						</button>
					</div>
				</div>

				{/* Layout controls — contextual toolbar for edit mode, height-animated so it never jumps the grid */}
				<div
					className={`grid transition-[grid-template-rows] duration-200 ease-out ${isEditMode ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
				>
					<div className="overflow-hidden">
						<div
							inert={!isEditMode}
							className={`flex items-center justify-end gap-2 pb-3 transition-opacity duration-150 ${isEditMode ? "opacity-100 delay-75" : "opacity-0"}`}
						>
							<span className="text-[10px] uppercase tracking-wider text-text-faint mr-auto">
								Drag or resize widgets to rearrange
							</span>
							<button
								onClick={() => {
									setLayouts(DEFAULT_RESPONSIVE_LAYOUTS);
									if (dispatcher?.id) saveDashboardLayout(dispatcher.id, DEFAULT_RESPONSIVE_LAYOUTS.lg ?? []);
								}}
								title="Reset to default layout"
								className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-surface hover:bg-error/10 border border-border hover:border-error/40 text-xs font-medium text-text-secondary hover:text-error-text transition-colors"
							>
								<RotateCcw size={13} />
								Reset
							</button>
							<button
								onClick={() => handleLayoutSave(fitLayout(WIDGET_CATALOG, layouts.lg ?? [], activeCols.lg))}
								disabled={activeCols.lg < 12}
								title={activeCols.lg < 12 ? "Widgets stack full width on narrow screens" : "Distribute widgets evenly across each row"}
								className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-surface hover:bg-surface-raised border border-border text-xs font-medium text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50 disabled:pointer-events-none"
							>
								<StretchHorizontal size={13} />
								Fit
							</button>
							<button
								onClick={() => setLayouts(prev => ({ ...prev, lg: randomizeLayout(WIDGET_CATALOG, prev.lg ?? []) }))}
								title="Scramble widgets into a messy layout (for testing Fit)"
								className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-surface hover:bg-surface-raised border border-border text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
							>
								<Shuffle size={13} />
								Randomize
							</button>
						</div>
					</div>
				</div>

				{/* Dashboard grid */}
				<div 
					className={`rgl-grid ${isEditMode ? "show-grid" : ""} ${isResizing ? "no-transitions" : ""} px-2 py-2`} 
					style={{ '--grid-width': `${displayWidth}px` } as React.CSSProperties}
				>
					{displayWidth > 0 && dispatcher && <ResponsiveGridLayout
						key={`grid-${dispatcher.id}-${dispatcher.dashboard_layout ? 'saved' : 'default'}`}
						width={displayWidth}
						layouts={constrainedLayouts}
						breakpoints={BREAKPOINTS}
						cols={activeCols}
						rowHeight={45}
						margin={[16, 16]}
						dragConfig={{ enabled: isEditMode, bounded: false, threshold: 3, cancel: "button, a, input, select, textarea" }}
						resizeConfig={{ enabled: isEditMode, handles: ["se"] }}
						onDragStart={() => {
							justDraggedRef.current = false;
						}}
						onDrag={() => {
							justDraggedRef.current = true;
						}}
						onDragStop={(layout) => {
							if (activeCols.lg === 12) {
								handleLayoutSave(layout);
							} else {
								setDisplayLayouts(prev => ({ ...prev, lg: layout }));
							}
							setTimeout(() => {
								justDraggedRef.current = false;
							}, 100);
						}}
						onResizeStop={(layout) => {
							if (activeCols.lg === 12) {
								handleLayoutSave(layout);
							} else {
								setDisplayLayouts(prev => ({ ...prev, lg: layout }));
							}
						}}					
					>
						{Object.keys(WIDGET_CATALOG).filter(id => layouts.lg?.some(l => l.i === id) && canSeeWidget(user, WIDGET_CATALOG[id])).map((id) => (
							<div key={id}
								className={isEditMode ?
									"group relative cursor-grab active:cursor-grabbing h-full hover:border hover:border-border-strong hover:border-primary hover:rounded-xl hover:shadow hover:shadow-primary"
									: "relative h-full"}
								onClickCapture={(e) => {
									if (justDraggedRef.current) {
										e.preventDefault();
										e.stopPropagation();
										e.nativeEvent.stopImmediatePropagation?.();
									}
								}}
							>
								{isEditMode && (
									<button
										title="Remove widget"
										className="absolute top-2 right-2 z-10 w-7 h-7 rounded-md bg-error text-on-primary flex items-center justify-center shadow-md ring-2 ring-base opacity-0 group-hover:opacity-100 hover:bg-error-strong hover:cursor-pointer transition-opacity"
										onClick={() => handleLayoutSave(removeWidget(id, layouts.lg ?? []))}
									>
										<Trash size={12}/>
									</button>
								)}

								<div inert={isEditMode} className="h-full">
									{renderWidget(id)}
								</div>
							</div>
						))}
					</ResponsiveGridLayout>}
				</div>
			</div>

			<CreateRecurringPlan
				isModalOpen={isCreatePlanModalOpen}
				setIsModalOpen={setIsCreatePlanModalOpen}
			/>
			<AddWidgetModal
				isOpen={isAddWidgetModalOpen}
				onClose={() => setIsAddWidgetModalOpen(false)}
				currentLayout={layouts.lg ?? []}
				catalog={WIDGET_CATALOG}
				onLayoutChange={(newLayout) => {
					setLayouts(prev => ({ ...prev, lg: newLayout }));
					if (dispatcher?.id) saveDashboardLayout(dispatcher.id, newLayout);
				}}
			/>
		</div>
	);
}
