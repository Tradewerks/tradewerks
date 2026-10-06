type Kind = "list" | "create" | "detail";

// First match wins, so a more specific path sits above the one it extends.
// A path with no entry is core. `/dispatch/purchases` (the list) is absent on
// purpose: it serves Purchasing and Field Purchases, and shows whichever is on.
const ROUTES: { prefix: string; module: string; kind: Kind }[] = [
	{ prefix: "/dispatch/reporting/builder", module: "advanced_reporting", kind: "create" },
	{ prefix: "/dispatch/reporting/profit-and-loss", module: "advanced_reporting", kind: "list" },
	{ prefix: "/dispatch/reporting/cogs", module: "advanced_reporting", kind: "list" },
	{ prefix: "/dispatch/reporting/job-profitability", module: "advanced_reporting", kind: "list" },
	{ prefix: "/dispatch/reporting/technician-scorecard", module: "advanced_reporting", kind: "list" },
	{ prefix: "/dispatch/reporting/qb/", module: "quickbooks", kind: "list" },
	{ prefix: "/dispatch/reporting/quote-funnel", module: "quotes", kind: "list" },
	{ prefix: "/dispatch/reporting/recurring-revenue", module: "recurring_plans", kind: "list" },
	{ prefix: "/dispatch/kpi", module: "advanced_reporting", kind: "list" },
	{ prefix: "/dispatch/quotes/", module: "quotes", kind: "detail" },
	{ prefix: "/dispatch/quotes", module: "quotes", kind: "list" },
	{ prefix: "/dispatch/recurring-plans/", module: "recurring_plans", kind: "detail" },
	{ prefix: "/dispatch/projects/", module: "projects", kind: "detail" },
	{ prefix: "/dispatch/projects", module: "projects", kind: "list" },
	{ prefix: "/dispatch/inventory/reorder-forecast", module: "inventory", kind: "list" },
	{ prefix: "/dispatch/inventory/reconcile", module: "inventory", kind: "list" },
	{ prefix: "/dispatch/inventory/labels/print", module: "inventory", kind: "create" },
	{ prefix: "/dispatch/inventory/suppliers/", module: "inventory", kind: "detail" },
	{ prefix: "/dispatch/inventory/suppliers", module: "inventory", kind: "list" },
	{ prefix: "/dispatch/inventory/", module: "inventory", kind: "detail" },
	{ prefix: "/dispatch/inventory", module: "inventory", kind: "list" },
	{ prefix: "/dispatch/purchases/", module: "purchasing", kind: "detail" },
	{ prefix: "/dispatch/vehicles/", module: "vehicle_stock", kind: "detail" },
	{ prefix: "/dispatch/vehicles", module: "fleet", kind: "list" },
	{ prefix: "/dispatch/followups", module: "followups", kind: "list" },
	{ prefix: "/technician/vehicles", module: "fleet", kind: "list" },
	{ prefix: "/technician/purchases/", module: "field_purchases", kind: "detail" },
	{ prefix: "/technician/purchases", module: "field_purchases", kind: "list" },
];

export function moduleForPath(pathname: string): { module: string; kind: Kind } | null {
	const hit = ROUTES.find((r) => pathname === r.prefix || pathname.startsWith(r.prefix));
	return hit ? { module: hit.module, kind: hit.kind } : null;
}
