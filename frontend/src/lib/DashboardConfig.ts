import type { Layout, ResponsiveLayouts } from "react-grid-layout";
import { QUICKBOOKS_ENABLED } from "../config/features";
import type { ResponsiveConstraints, WidgetCatalog } from "./gridLayoutEngine";
import { DISPUTE_VIEW_PERMISSIONS } from "./permissionGates";

export const DEFAULT_LAYOUT: Layout = [
    { i: "week-strip",    x: 0, y: 0,  w: 8,  h: 5  },
    { i: "arrivals",      x: 8, y: 0,  w: 4,  h: 7  },
    { i: "technicians",   x: 8, y: 7,  w: 4,  h: 3  },
    { i: "open-disputes", x: 8, y: 10, w: 4,  h: 4  },
    { i: "pipeline",      x: 0, y: 5,  w: 3,  h: 6  },
    { i: "activity-feed", x: 3, y: 5,  w: 5,  h: 8  },
    { i: "maintenance-reminders", x: 8, y: 14, w: 4, h: 6 },
    { i: "low-stock",     x: 0, y: 11, w: 3,  h: 2  },
];


// 8-col two-column layout
const DEFAULT_MD_LAYOUT: Layout = [
    { i: "week-strip",    x: 0, y: 0,  w: 8, h: 5  },
    { i: "arrivals",      x: 0, y: 5,  w: 8, h: 7  },
    { i: "pipeline",      x: 0, y: 12, w: 4, h: 6  },
    { i: "technicians",   x: 4, y: 12, w: 4, h: 3  },
    { i: "open-disputes", x: 4, y: 15, w: 4, h: 6  },
    { i: "maintenance-reminders", x: 0, y: 18, w: 4, h: 6 },
    { i: "low-stock",     x: 4, y: 21, w: 4, h: 2  },
    { i: "activity-feed", x: 0, y: 24, w: 8, h: 12 },
];

// 4-col single-column stacked layout
const DEFAULT_SM_LAYOUT: Layout = [
    { i: "week-strip",    x: 0, y: 0,  w: 4, h: 4  },
    { i: "arrivals",      x: 0, y: 4,  w: 4, h: 7  },
    { i: "pipeline",      x: 0, y: 11, w: 4, h: 6  },
    { i: "open-disputes", x: 0, y: 17, w: 4, h: 6  },
    { i: "maintenance-reminders", x: 0, y: 23, w: 4, h: 6 },
    { i: "activity-feed", x: 0, y: 29, w: 4, h: 12 },
    { i: "technicians",   x: 0, y: 41, w: 4, h: 3  },
    { i: "low-stock",     x: 0, y: 44, w: 4, h: 2  },
];

export const DEFAULT_RESPONSIVE_LAYOUTS: ResponsiveLayouts = {
    lg: DEFAULT_LAYOUT,
    md: DEFAULT_MD_LAYOUT,
    sm: DEFAULT_SM_LAYOUT,
};

// All widgets that exist, with their default size and label
export const WIDGET_CATALOG: WidgetCatalog & Record<string, {
    label: string;
    defaultW: number;
    defaultH: number;
    minW?: number;
    minH?: number;
    maxW?: number;
    maxH?: number;
    /* Row ceiling for the auto-grow pass, which ignores `maxH` — that bounds
       dragging only. Needed on widgets whose content scales with the org, or a
       big roster grows the card until it pushes the widgets below it off-screen.
       Omit for no ceiling. Inert today: auto-grow is dormant, see DashboardPage. */
    autoGrowMaxH?: number;
    responsiveConstraints?: ResponsiveConstraints;
    requiredPermission?: string;
    requiredAnyPermission?: readonly string[];
}> = {
    "week-strip":           {   label: "Week Schedule",
                                defaultW: 12, defaultH: 5,  minW: 6, minH: 4, maxH: 8, maxW: 12,
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "pipeline":             {  label: "Operations Pipeline",
                                defaultW: 3,  defaultH: 7,  minW: 3, minH: 6, maxH: 7, maxW: 6,
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12, maxH: 11 },
                                ]
                            },
    "activity-feed":        {   label: "Activity Feed",
                                defaultW: 5,  defaultH: 11, minW: 3, minH: 4, maxH: 12, maxW: 6,
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "technicians":          {   label: "Technicians",
                                /* defaultH was 4 while every preset layout ships h:3, so adding
                                   this widget from the picker gave a taller card than a fresh
                                   dashboard did. */
                                defaultW: 4,  defaultH: 3,  minW: 3, minH: 3, maxH: 6, maxW: 6,
                                autoGrowMaxH: 6,
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "low-stock":            {   label: "Low Stock",
                                defaultW: 3,  defaultH: 4,  minW: 2, minH: 2, maxH: 2, maxW: 6,
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 2, maxW: 12, maxH: 6 },
                                ]
                            },
    "open-disputes":        {   label: "Open Disputes",
                                defaultW: 4,  defaultH: 6,  minW: 3, minH: 4, maxH: 10, maxW: 6,
                                requiredAnyPermission: DISPUTE_VIEW_PERMISSIONS,
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "maintenance-reminders":{   label: "Maintenance Reminders",
                                defaultW: 4,  defaultH: 6,  minW: 3, minH: 4, maxH: 10, maxW: 6,
                                requiredAnyPermission: ["view_vehicles", "manage_vehicles"],
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "quickbooks":           {   label: "QuickBooks",
                                defaultW: 3,  defaultH: 1,  minW: 3, minH: 1, maxW: 6,  maxH: 2,
                                requiredPermission: "manage_organization",
                            },
    "arrivals":             {   label: "Arrivals",
                                defaultW: 4,  defaultH: 7,  minW: 3, minH: 4, maxH: 14, maxW: 8,
                                requiredPermission: "view_jobs",
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "map":                  {   label: "Live Map",
                                defaultW: 6,  defaultH: 8,  minW: 4, minH: 5, maxW: 12, maxH: 20,
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "report-overview":      {   label: "Overview Stats",
                                defaultW: 12, defaultH: 3,  minW: 6, minH: 3, maxH: 3, maxW: 12,
                                requiredPermission: "view_reports",
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12, maxH: 9, minH: 4 },
                                ]
                            },
    "report-revenue-ytd":   {   label: "Revenue YTD",
                                defaultW: 6,  defaultH: 7,  minW: 4, minH: 5, maxH: 12, maxW: 12,
                                requiredPermission: "view_reports",
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "report-unscheduled-revenue":{ label: "Unscheduled Revenue",
                                defaultW: 3,  defaultH: 5,  minW: 3, minH: 5, maxH: 7, maxW: 6,
                                requiredPermission: "view_reports",
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "report-revenue-by-type":{  label: "Revenue by Job Type",
                                defaultW: 4,  defaultH: 9,  minW: 3, minH: 6, maxH: 13, maxW: 6,
                                requiredPermission: "view_reports",
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "report-leads-by-source":{  label: "Leads by Source",
                                defaultW: 4,  defaultH: 9,  minW: 3, minH: 6, maxH: 13, maxW: 6,
                                requiredPermission: "view_reports",
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "report-quote-pipeline":{   label: "Quote Pipeline",
                                defaultW: 3,  defaultH: 7,  minW: 3, minH: 7, maxH: 13, maxW: 6,
                                requiredPermission: "view_reports",
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "report-arrival":       {   label: "Arrival Performance",
                                defaultW: 4,  defaultH: 8,  minW: 3, minH: 6, maxH: 10, maxW: 6,
                                requiredPermission: "view_reports",
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "report-mileage":       {   label: "Mileage Summary",
                                defaultW: 4,  defaultH: 4,  minW: 4, minH: 4, maxH: 4, maxW: 12,
                                requiredPermission: "view_reports",
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12, maxH: 8 },
                                ]
                            },
    "report-aged-receivables-bar":{ label: "Aged Receivables (Bars)",
                                defaultW: 4,  defaultH: 7,  minW: 3, minH: 6, maxH: 6, maxW: 6,
                                requiredPermission: "view_reports",
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "report-page-summary":  {   label: "Page Report",
                                defaultW: 4,  defaultH: 6,  minW: 4, minH: 6, maxH: 8, maxW: 6,
                                requiredPermission: "view_reports",
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },
    "report-job-backlog":   {   label: "Job Backlog",
                                defaultW: 4,  defaultH: 8,  minW: 3, minH: 6, maxH: 12, maxW: 8,
                                requiredPermission: "view_reports",
                                responsiveConstraints: [
                                    { atWidth: 800, minW: 4, maxW: 12 },
                                ]
                            },

};

// QuickBooks temporarily disabled — drop its widget from the catalog so it can't
// be added and any previously-placed instance stops rendering (see config/features).
if (!QUICKBOOKS_ENABLED) {
    delete WIDGET_CATALOG.quickbooks;
}
