import type { Layout, ResponsiveLayouts } from "react-grid-layout";
import type { ResponsiveConstraints, WidgetCatalog } from "./gridLayoutEngine";

// KPI grid mirrors the dashboard's report widgets (metrics only — no
// operational widgets like week-strip/pipeline/map/quickbooks).
export const DEFAULT_LAYOUT: Layout = [
    { i: "report-overview",             x: 0, y: 0,  w: 12, h: 3 },
    { i: "report-revenue-ytd",          x: 0, y: 3,  w: 9,  h: 7 },
    { i: "report-unscheduled-revenue",  x: 9, y: 3,  w: 3,  h: 7 },
    { i: "report-revenue-by-type",      x: 0, y: 10, w: 4,  h: 7 },
    { i: "report-quote-pipeline",       x: 4, y: 10, w: 4,  h: 7 },
    { i: "report-arrival",              x: 8, y: 10, w: 4,  h: 7 },
    { i: "report-aged-receivables-bar", x: 0, y: 19, w: 4,  h: 7 },
    { i: "report-leads-by-source",      x: 4, y: 19, w: 4,  h: 6 },
];

// 8-col two-column layout
const DEFAULT_MD_LAYOUT: Layout = [
    { i: "report-overview",             x: 0, y: 0,  w: 8, h: 4 },
    { i: "report-revenue-ytd",          x: 0, y: 4,  w: 8, h: 7 },
    { i: "report-unscheduled-revenue",  x: 0, y: 11, w: 4, h: 6 },
    { i: "report-revenue-by-type",      x: 4, y: 11, w: 4, h: 9 },
    { i: "report-quote-pipeline",       x: 0, y: 17, w: 4, h: 7 },
    { i: "report-arrival",              x: 4, y: 20, w: 4, h: 8 },
    { i: "report-aged-receivables-bar", x: 0, y: 24, w: 4, h: 6 },
    { i: "report-leads-by-source",      x: 4, y: 28, w: 4, h: 9 },
];

// 4-col single-column stacked layout
const DEFAULT_SM_LAYOUT: Layout = [
    { i: "report-overview",             x: 0, y: 0,  w: 4, h: 4 },
    { i: "report-revenue-ytd",          x: 0, y: 4,  w: 4, h: 7 },
    { i: "report-unscheduled-revenue",  x: 4, y: 11, w: 4, h: 6 },
    { i: "report-revenue-by-type",      x: 4, y: 17, w: 4, h: 9 },
    { i: "report-quote-pipeline",       x: 8, y: 26, w: 4, h: 7 },
    { i: "report-arrival",              x: 8, y: 33, w: 4, h: 8 },
    { i: "report-aged-receivables-bar", x: 0, y: 41, w: 4, h: 6 },
    { i: "report-leads-by-source",      x: 4, y: 47, w: 4, h: 9 },
];

export const DEFAULT_RESPONSIVE_LAYOUTS: ResponsiveLayouts = {
    lg: DEFAULT_LAYOUT,
    md: DEFAULT_MD_LAYOUT,
    sm: DEFAULT_SM_LAYOUT,
};

// KPI widgets — the reporting/metric tiles, shared with the dashboard's
// "report-*" ids so the same widget components (DashboardPage.tsx renderWidget)
// render both places.
// TEMP for testing: trimmed to only the widgets that actually exist right now.
export const KPI_CATALOG: WidgetCatalog & Record<string, {
    label: string;
    defaultW: number;
    defaultH: number;
    minW?: number;
    minH?: number;
    maxW?: number;
    maxH?: number;
    responsiveConstraints?: ResponsiveConstraints;
    requiredPermission?: string;
}> = {
    "report-job-backlog":   {   label: "Job Backlog",
                                defaultW: 4,  defaultH: 8,  minW: 3, minH: 6, maxH: 12, maxW: 8,
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "report-overview":      {   label: "Overview Stats",
                                defaultW: 12, defaultH: 3,  minW: 6, minH: 3, maxH: 3, maxW: 12,
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12, maxH: 9, minH: 4 },
                                ]
                            },
    "report-revenue-ytd":   {   label: "Revenue YTD",
                                defaultW: 6,  defaultH: 7,  minW: 4, minH: 5, maxH: 12, maxW: 12,
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "report-unscheduled-revenue":{ label: "Unscheduled Revenue",
                                defaultW: 3,  defaultH: 5,  minW: 3, minH: 5, maxH: 7, maxW: 6,
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "report-revenue-by-type":{  label: "Revenue by Job Type",
                                defaultW: 4,  defaultH: 9,  minW: 3, minH: 6, maxH: 13, maxW: 6,
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "report-leads-by-source":{  label: "Leads by Source",
                                defaultW: 4,  defaultH: 7,  minW: 3, minH: 6, maxH: 13, maxW: 6,
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "report-quote-pipeline":{   label: "Quote Pipeline",
                                defaultW: 3,  defaultH: 7,  minW: 3, minH: 7, maxH: 13, maxW: 6,
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "report-arrival":       {   label: "Arrival Performance",
                                defaultW: 4,  defaultH: 8,  minW: 3, minH: 6, maxH: 10, maxW: 6,
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "report-mileage":       {   label: "Mileage Summary",
                                defaultW: 4,  defaultH: 4,  minW: 4, minH: 4, maxH: 4, maxW: 12,
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12, maxH: 8 },
                                ]
                            },
    "report-aged-receivables-bar":{ label: "Aged Receivables (Bars)",
                                defaultW: 3,  defaultH: 7,  minW: 3, minH: 6, maxH: 6, maxW: 6,
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
};
