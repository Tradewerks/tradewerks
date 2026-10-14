import type { QueryClient } from "@tanstack/react-query";
import type { InventorySortOption } from "../types/inventory";

// ============================================================================
// Query key factory
//
// Every list-style key accepts its filter arg optionally: calling it with no
// arg returns the shared prefix (used for invalidation, matches all filtered
// variants); calling it with an arg returns the full key (used by the query
// itself). This keeps "invalidate everything under X" and "this exact query"
// expressible from the same function.
// ============================================================================

const inventoryRoot = ["inventory"] as const;

interface InventoryListOpts {
	sort?: InventorySortOption;
	lowStock?: boolean;
}

export const qk = {
	inventory: {
		all: inventoryRoot,
		list: (opts?: InventoryListOpts) =>
			opts ? ([...inventoryRoot, "list", opts] as const) : ([...inventoryRoot, "list"] as const),
		detail: (id: string) => [...inventoryRoot, "detail", id] as const,
		tags: [...inventoryRoot, "tags"] as const,
		provisional: [...inventoryRoot, "provisional"] as const,
		// Filters are SERVER-side (dismissed rows and the origin filter are both
		// query params), so two filter sets are two result sets and must not
		// share a cache entry. Trailing segments keep prefix invalidation working.
		reconcile: (opts?: {
			includeDismissed?: boolean;
			origin?: string;
			search?: string;
			sort?: string;
			offset?: number;
			limit?: number;
		}) =>
			opts
				? ([...inventoryRoot, "reconcile", opts] as const)
				: ([...inventoryRoot, "reconcile"] as const),
		// Under the reconcile prefix so settling one row refetches the drill-in and
		// the queue together without touching the rest of the inventory tree.
		reconcileLines: (key: { name?: string; foldedName?: string; itemId?: string }) =>
			[...inventoryRoot, "reconcile", "lines", key] as const,
		reconcileTargets: (opts: { q?: string; excludeId?: string }) =>
			[...inventoryRoot, "reconcile", "targets", opts] as const,
		// movements/valueHistory take an opts object for the same reason
		// consumptionTrend does: the History tab's range control is a SERVER-side
		// filter, so two ranges are two different result sets and must not share
		// one cache entry. Omitting opts keeps the old key shape, and because the
		// range lands in a trailing segment, prefix invalidation still matches.
		movements: (itemId: string, opts?: { createdAfter?: string }) =>
			opts
				? ([...inventoryRoot, "detail", itemId, "movements", opts] as const)
				: ([...inventoryRoot, "detail", itemId, "movements"] as const),
		usage: (
			itemId: string,
			opts?: { limit?: number; offset?: number; createdAfter?: string },
		) =>
			opts
				? ([...inventoryRoot, "detail", itemId, "usage", opts] as const)
				: ([...inventoryRoot, "detail", itemId, "usage"] as const),
		forecast: (itemId: string) => [...inventoryRoot, "detail", itemId, "forecast"] as const,
		valueHistory: (itemId: string, opts?: { createdAfter?: string }) =>
			opts
				? ([...inventoryRoot, "detail", itemId, "value-history", opts] as const)
				: ([...inventoryRoot, "detail", itemId, "value-history"] as const),
		// Carries both range shapes because the endpoint does: createdAfter windows
		// the step series, bucket/range drive the charged-price aggregate.
		priceHistory: (
			itemId: string,
			opts?: { createdAfter?: string; bucket?: "week" | "month"; range?: number },
		) =>
			opts
				? ([...inventoryRoot, "detail", itemId, "price-history", opts] as const)
				: ([...inventoryRoot, "detail", itemId, "price-history"] as const),
		consumptionTrend: (itemId: string, opts?: { bucket?: "week" | "month"; range?: number }) =>
			opts
				? ([...inventoryRoot, "detail", itemId, "consumption-trend", opts] as const)
				: ([...inventoryRoot, "detail", itemId, "consumption-trend"] as const),
		serials: (itemId: string) => [...inventoryRoot, "detail", itemId, "serials"] as const,
		batches: (itemId: string) => [...inventoryRoot, "detail", itemId, "batches"] as const,
		trackingSummary: (itemId: string) => [...inventoryRoot, "detail", itemId, "tracking-summary"] as const,
			vehicleStock: (itemId: string) => [...inventoryRoot, "detail", itemId, "vehicle-stock"] as const,
		trackingEligibility: (itemId: string) =>
			[...inventoryRoot, "detail", itemId, "tracking-eligibility"] as const,
		labels: [...inventoryRoot, "labels"] as const,
		batchImpact: (batchId: string) => [...inventoryRoot, "batch-impact", batchId] as const,
		serialHistory: (serialId: string) => [...inventoryRoot, "serial-history", serialId] as const,
		reconciliation: () => [...inventoryRoot, "reconciliation"] as const,
	},
	inventoryImports: {
		all: ["inventory-imports"] as const,
		list: (opts?: Record<string, unknown>) => opts
			? (["inventory-imports", "list", opts] as const)
			: (["inventory-imports", "list"] as const),
		detail: (id: string) => ["inventory-imports", "detail", id] as const,
		candidates: (id: string, filters?: Record<string, unknown>) => filters
			? (["inventory-imports", "detail", id, "candidates", filters] as const)
			: (["inventory-imports", "detail", id, "candidates"] as const),
	},
	vehicles: {
		all: ["vehicles"] as const,
		list: (status?: string) =>
			status ? (["vehicles", "list", status] as const) : (["vehicles", "list"] as const),
		detail: (id: string) => ["vehicles", "detail", id] as const,
		stock: (id: string) => ["vehicles", "detail", id, "stock"] as const,
		fillPlan: (id: string) => ["vehicles", "detail", id, "fill-plan"] as const,
		usageToday: (id: string) => ["vehicles", "detail", id, "usage-today"] as const,
		restockToday: (id: string) => ["vehicles", "detail", id, "restock-today"] as const,
		restockHistory: (id: string) => ["vehicles", "detail", id, "restock-history"] as const,
		stockAdjustments: (id: string) => ["vehicles", "detail", id, "stock-adjustments"] as const,
		tomorrowRequirements: (id: string) => ["vehicles", "detail", id, "tomorrow-requirements"] as const,
		readiness: (id: string, date?: string) =>
			date
				? (["vehicles", "detail", id, "readiness", date] as const)
				: (["vehicles", "detail", id, "readiness"] as const),
		stockConflicts: ["vehicles", "stock-conflicts"] as const,
		maintenanceAlerts: ["vehicles", "maintenance-alerts"] as const,
		maintenance: (id: string) => ["vehicles", "detail", id, "maintenance"] as const,
		maintenanceSourceLines: (id: string, q?: string) =>
			q
				? (["vehicles", "detail", id, "maintenance-source-lines", q] as const)
				: (["vehicles", "detail", id, "maintenance-source-lines"] as const),
		maintenanceReminders: (id: string) => ["vehicles", "detail", id, "maintenance-reminders"] as const,
	},
	suppliers: {
		all: ["suppliers"] as const,
		list: (opts?: { search?: string; active?: string; includeUsage?: boolean }) =>
			opts ? (["suppliers", "list", opts] as const) : (["suppliers", "list"] as const),
		detail: (id: string) => ["suppliers", "detail", id] as const,
		movements: (id: string) => ["suppliers", "detail", id, "movements"] as const,
		batches: (id: string) => ["suppliers", "detail", id, "batches"] as const,
	},
	supplierItems: {
		all: ["supplier-items"] as const,
		list: (opts?: { supplierId?: string; inventoryItemId?: string }) =>
			opts
				? (["supplier-items", "list", opts] as const)
				: (["supplier-items", "list"] as const),
	},
	restockRequests: {
		all: ["restock-requests"] as const,
		list: (filter?: { status?: string; vehicleId?: string }) =>
			filter ? (["restock-requests", filter] as const) : (["restock-requests"] as const),
	},
	fleetReadiness: (date: string) => ["fleet-readiness", date] as const,
	purchases: {
		all: ["purchases"] as const,
		list: (opts?: {
			status?: string;
			kind?: string;
			supplierId?: string;
			jobId?: string;
			search?: string;
			sort?: string;
			offset?: number;
			limit?: number;
			dateFrom?: string;
			dateTo?: string;
		}) => (opts ? (["purchases", "list", opts] as const) : (["purchases", "list"] as const)),
		detail: (id: string) => ["purchases", "detail", id] as const,
	},
	arrivals: {
		all: ["arrivals"] as const,
		board: ["arrivals", "board"] as const,
		visit: (visitId: string) => ["arrivals", "visit", visitId] as const,
	},
	timesheets: {
		all: ["timesheets"] as const,
		week: (date?: string) => ["timesheets", "week", date ?? "current"] as const,
		technician: (id: string, date?: string) => ["timesheets", "technician", id, date] as const,
	},
	fieldPurchases: {
		all: ["field-purchases"] as const,
		list: (opts?: {
			status?: string;
			technicianId?: string;
			jobId?: string;
			flagged?: string;
			kind?: string;
			search?: string;
			dateFrom?: string;
			dateTo?: string;
			sort?: string;
			offset?: number;
			limit?: number;
		}) =>
			opts ? (["field-purchases", "list", opts] as const) : (["field-purchases", "list"] as const),
		summary: ["field-purchases", "summary"] as const,
		detail: (id: string) => ["field-purchases", "detail", id] as const,
		extraction: (id: string) => ["field-purchases", "extraction", id] as const,
		captureLocation: (id: string) => ["field-purchases", "capture-location", id] as const,
		grants: ["field-purchases", "grants"] as const,
		myGrant: ["field-purchases", "my-grant"] as const,
		limitCheck: (opts: {
			amount: number;
			jobs?: { job_id: string; amount: number }[];
			/** A verdict is about one purchase's spend windows; it never answers for another. */
			purchaseId?: string;
		}) => ["field-purchases", "limit-check", opts] as const,
	},
	disputes: {
		// The prefix: the dashboard list and every client banner live under it,
		// so one invalidation refreshes them all.
		open: ["disputes", "open"] as const,
		openList: (clientId?: string) => ["disputes", "open", clientId ?? "all"] as const,
	},
};

// ============================================================================
// Invalidation groups — one call site, no more hunting for which keys a
// mutation is supposed to touch.
// ============================================================================

export const invalidate = {
	// Also invalidates vendor price-list data: stockMovements.ts upserts
	// supplier_item.last_price/last_purchased_at on every priced, vendor-attributed
	// receive/adjustment, so a stock write can silently stale the price list too.
	warehouse: (qc: QueryClient) =>
		Promise.all([
			qc.invalidateQueries({ queryKey: qk.inventory.all }),
			qc.invalidateQueries({ queryKey: qk.supplierItems.all }),
			qc.invalidateQueries({ queryKey: qk.suppliers.all }),
		]),

	vehicleStock: (qc: QueryClient, vehicleId?: string) =>
		Promise.all([
			qc.invalidateQueries({ queryKey: qk.vehicles.list() }),
			vehicleId
				? qc.invalidateQueries({ queryKey: qk.vehicles.detail(vehicleId) })
				: qc.invalidateQueries({ queryKey: qk.vehicles.all }),
		]),

	restockRequests: (qc: QueryClient) => qc.invalidateQueries({ queryKey: qk.restockRequests.all }),

	// Warehouse + vehicle + conflicts — the group most stock-movement mutations need.
	stockData: (qc: QueryClient, vehicleId?: string) =>
		Promise.all([
			invalidate.warehouse(qc),
			invalidate.vehicleStock(qc, vehicleId),
			qc.invalidateQueries({ queryKey: qk.vehicles.stockConflicts }),
		]),
};
