import { useState, useMemo, useEffect, useRef } from "react";
import { startOfMonth, endOfMonth } from "date-fns";
import { ResponsiveGridLayout, useContainerWidth } from "react-grid-layout";
import type { Layout, ResponsiveLayouts } from "react-grid-layout";
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import '../../components/ui/GridLayout.css';
import PageHeader from "../../components/ui/PageHeader";
import DateRangeFilter from "../../components/ui/DateRangeFilter";
import {
    type DateRangeValue,
    type DateRangeOption,
    resolveDateRange,
} from "../../util/dateRangeUtils";
import { DEFAULT_RESPONSIVE_LAYOUTS, KPI_CATALOG } from "../../lib/KpiConfig";
import { BREAKPOINTS, resolveConstraints, getActiveCols, fitLayout, removeWidget } from "../../lib/gridLayoutEngine";
import { useAuthStore } from "../../auth/authStore";
import { useDispatcherByIdQuery, useUpdateDispatcherMutation } from "../../hooks/useDispatchers";
import AddWidgetModal from "../../components/widgets/AddWidgetModal";
import {
    AgedReceivablesColumnWidget,
    JobBacklogWidget,
    OverviewWidget,
    RevenueByJobTypeWidget,
    UnscheduledRevenueWidget,
    RevenueYTDWidget,
    LeadsBySourceWidget,
    QuotePipelineWidget,
    ArrivalPerformanceWidget,
    MileageSummaryWidget,
} from "../../components/widgets/reports";
import { Unlock, LayoutDashboard, LayoutGrid, StretchHorizontal, RotateCcw, Trash } from "lucide-react";

const KPI_PRESETS: DateRangeOption[] = [
    "today",
    "last_7_days",
    "last_30_days",
    "this_month",
    "custom",
];

function renderKPI(id: string, startDate: string, endDate: string) {
    switch (id) {
        case "report-overview":        return <OverviewWidget startDate={startDate} endDate={endDate} />;
        case "report-revenue-ytd":     return <RevenueYTDWidget />;
        // TODO: useUnscheduledRevenueQuery takes no date params — needs backend/hook support for a custom range
        case "report-unscheduled-revenue": return <UnscheduledRevenueWidget />;
        case "report-revenue-by-type": return <RevenueByJobTypeWidget startDate={startDate} endDate={endDate} />;
        case "report-leads-by-source": return <LeadsBySourceWidget startDate={startDate} endDate={endDate} />;
        case "report-quote-pipeline":  return <QuotePipelineWidget startDate={startDate} endDate={endDate} />;
        case "report-arrival":         return <ArrivalPerformanceWidget startDate={startDate} endDate={endDate} />;
        case "report-mileage":         return <MileageSummaryWidget startDate={startDate} endDate={endDate} />;
        // TODO: useAgedReceivablesQuery takes no date params — needs backend/hook support for a custom range
        case "report-aged-receivables-bar": return <AgedReceivablesColumnWidget />;
        // TODO: useJobBacklogQuery takes no date params — needs backend/hook support for a custom range
        case "report-job-backlog":     return <JobBacklogWidget />;
        default: return <div>Unknown widget: {id}</div>;
    }
}

export default function KpiPage() {
    const { user } = useAuthStore();
    const { data: dispatcher } = useDispatcherByIdQuery(user?.userId);
    
    const [layouts, setLayouts] = useState<ResponsiveLayouts>(DEFAULT_RESPONSIVE_LAYOUTS);
    const [displayLayouts, setDisplayLayouts] = useState<ResponsiveLayouts>(DEFAULT_RESPONSIVE_LAYOUTS);
    const [isEditMode, setIsEditMode] = useState(false);
    const [isAddWidgetModalOpen, setIsAddWidgetModalOpen] = useState(false);
    const justDraggedRef = useRef(false);
    const [autoExtra, setAutoExtra] = useState<Record<string, number>>({});
    const widgetRefs = useRef<Map<string, HTMLDivElement>>(new Map());
    
    // Seed saved layout when dispatcher data loads
    useEffect(() => {
        if (dispatcher?.kpi_layout) {
            setLayouts(prev => ({ ...prev, lg: dispatcher.kpi_layout as Layout }));
        }
    }, [dispatcher?.kpi_layout]);

    const updateDispatcher = useUpdateDispatcherMutation();

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

    useEffect(() => { setAutoExtra({}); }, [layouts.lg, settledWidth, isEditMode]);
    useEffect(() => {
        if (isEditMode || displayWidth <= 0) return;
        const ROW_PX = 45 + 16; 
        const SAFETY_MAX_EXTRA = 40; 

        const measure = () => {
            setAutoExtra(prev => {
                const next = { ...prev };
                let changed = false;
                widgetRefs.current.forEach((wrapper, id) => {
                    const body = wrapper.firstElementChild?.lastElementChild as HTMLElement | undefined;
                    if (!body) return;
                    const overflow = body.scrollHeight - body.clientHeight;
                    const prevExtra = prev[id] ?? 0;
                    const wantExtra = Math.min(prevExtra + Math.ceil(overflow / ROW_PX), SAFETY_MAX_EXTRA);
                    if (overflow > 2 && wantExtra !== prevExtra) {
                        next[id] = wantExtra;
                        changed = true;
                    }
                });
                return changed ? next : prev;
            });
        };

        const ro = new ResizeObserver(measure);
        widgetRefs.current.forEach(el => ro.observe(el));
        measure();
        return () => ro.disconnect();
    }, [isEditMode, displayWidth, settledWidth, displayLayouts.lg, autoExtra]);


    const activeCols = useMemo(() => {
        const c = getActiveCols(settledWidth || displayWidth);
        return { lg: c, md: c, sm: c };
    }, [settledWidth, displayWidth]);

    // Sync displayLayouts when layouts changes (drag/resize/reset/fit/widget add)
    useEffect(() => { setDisplayLayouts(layouts); }, [layouts]);

    const saveKpiLayout = async (id: string, newLayout: Layout) => {
        try {
            await updateDispatcher.mutateAsync({
                id,
                data: { kpi_layout: newLayout },
            });
        } catch (error) {
            console.error("Failed to save kpi layout:", error);
        }
    }

    const handleLayoutSave = (newLayout: Layout) => {
        setLayouts(prev => ({ ...prev, lg: newLayout }));
        if (dispatcher?.id) {
            saveKpiLayout(dispatcher.id, newLayout);
        }
    };

    const constrainedLayouts = useMemo(() => {
        const w = settledWidth || displayWidth;
        const cols = activeCols.lg;
        const display = (displayLayouts.lg ?? []).map(item => {
            const c = resolveConstraints(KPI_CATALOG, item.i, w);

            const minW = Math.min(c.minW ?? 1, cols);
            const maxW = Math.min(c.maxW ?? cols, cols);
            
            const baseH = Math.min(Math.max(item.h, c.minH ?? 1), c.maxH ?? 20);
            const h = baseH + (autoExtra[item.i] ?? 0);
            return {
                ...item,
                ...c,
                minW,
                maxW,
                maxH: Math.max(c.maxH ?? 20, h),
                w: Math.min(Math.max(item.w, minW), maxW),
                h,
            };
        });
        return { lg: display, md: display, sm: display };
    }, [displayLayouts.lg, settledWidth, displayWidth, activeCols.lg, autoExtra]);
    
    const prevColsRef = useRef(activeCols.lg);
    useEffect(() => {
        if (prevColsRef.current === activeCols.lg) return;
        prevColsRef.current = activeCols.lg;
        setDisplayLayouts(prev => ({
            ...prev,
            lg: activeCols.lg === 12 ? (layouts.lg ?? []) : fitLayout(KPI_CATALOG, layouts.lg ?? [], activeCols.lg),
        }));
    }, [activeCols.lg, layouts.lg]);

    const [range, setRange] = useState<DateRangeValue>({ option: "this_month" });

    const { startDateStr, endDateStr } = useMemo(() => {
        const now = new Date();
        const resolved =
            resolveDateRange(range) ?? {
                start: startOfMonth(now),
                end: endOfMonth(now),
            };
        return {
            startDate: resolved.start,
            endDate: resolved.end,
            startDateStr: resolved.start.toISOString(),
            endDateStr: resolved.end.toISOString(),
        };
    }, [range]);

    return (
        <div className="min-h-0 bg-canvas text-text-primary w-full">
            <div className="w-full px-4 sm:px-5 lg:px-6 py-4">
                {/* Header Section */}
                <PageHeader title="Key Performance Indicators">
                    <DateRangeFilter value={range} onChange={setRange} presets={KPI_PRESETS} />
                    <div className="w-px self-stretch bg-border-subtle" />
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
                </PageHeader>
            </div>

            <div className="w-full px-3 lg:px-4" ref={containerRef} >
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
                                    if (dispatcher?.id) saveKpiLayout(dispatcher.id, DEFAULT_RESPONSIVE_LAYOUTS.lg ?? []);
                                }}
                                title="Reset to default layout"
                                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-surface hover:bg-error/10 border border-border hover:border-error/40 text-xs font-medium text-text-secondary hover:text-error-text transition-colors"
                            >
                                <RotateCcw size={13} />
                                Reset
                            </button>
                            <button
                                onClick={() => {
                                    const fitted = fitLayout(KPI_CATALOG, layouts.lg ?? [], activeCols.lg);
                                    if (activeCols.lg === 12) handleLayoutSave(fitted);
                                    else setDisplayLayouts(prev => ({ ...prev, lg: fitted }));
                                }}
                                title="Distribute widgets evenly across each row"
                                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-surface hover:bg-surface-raised border border-border text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
                            >
                                <StretchHorizontal size={13} />
                                Fit
                            </button>
                        </div>
                    </div>
                </div>

                <div className={`rgl-grid ${isEditMode ? "show-grid" : ""} ${isResizing ? "no-transitions" : ""} px-2 py-2`} style={{ '--grid-width': `${displayWidth}px` } as React.CSSProperties}>
                    {displayWidth > 0 && dispatcher && <ResponsiveGridLayout
                        key={`grid-${dispatcher.id}-${dispatcher.kpi_layout ? 'saved' : 'default'}`}
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
                        {Object.keys(KPI_CATALOG).filter(id => layouts.lg?.some(l => l.i === id)).map((id) => (
                            <div key={id}
                                ref={(el) => {
                                    if (el) widgetRefs.current.set(id, el);
                                    else widgetRefs.current.delete(id);
                                }}
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
                                        <Trash size={14}/>
                                    </button>
                                )}
                                
                                {renderKPI(id, startDateStr, endDateStr)}
                            </div>
                        ))}
                    </ResponsiveGridLayout>}
                </div>
            </div>

            <AddWidgetModal
                isOpen={isAddWidgetModalOpen}
                onClose={() => setIsAddWidgetModalOpen(false)}
                currentLayout={layouts.lg ?? []}
                catalog={KPI_CATALOG}
                onLayoutChange={(newLayout) => {
                setLayouts(prev => ({ ...prev, lg: newLayout }));
                    if (dispatcher?.id) saveKpiLayout(dispatcher.id, newLayout);
                }}
            />
        </div>
    );
}
