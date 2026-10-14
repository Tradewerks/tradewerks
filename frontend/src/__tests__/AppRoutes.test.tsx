/**
 * Route-table smoke test (review 10-F5).
 *
 * Every page module AppRoutes lazy-loads is replaced by a stub that renders the
 * module's basename, so the test only exercises the routing + guard layer. The
 * stubs are derived from AppRoutes.tsx itself (no list to keep in sync); the ROUTES
 * table below must cover every `path="…"` in AppRoutes.tsx — a test fails if a
 * route is added there without a row here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../auth/authStore";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_ROUTES_SOURCE = readFileSync(path.join(SRC_DIR, "AppRoutes.tsx"), "utf8");

// All page/layout modules AppRoutes pulls in: lazy `import("./x")` plus the eager
// TechnicianLayout. Each is stubbed with a component that prints its basename
// (layouts also render an <Outlet/> so nested routes can mount).
const MODULE_PATHS = [
	...new Set(
		[
			...APP_ROUTES_SOURCE.matchAll(/import\("(\.\/[^"]+)"\)/g),
			...APP_ROUTES_SOURCE.matchAll(/^import \w+ from "(\.\/(?:layouts|pages|components)\/[^"]+)";/gm),
		].map((m) => m[1]),
	),
];
expect(MODULE_PATHS.length).toBeGreaterThan(50);

for (const rel of MODULE_PATHS) {
	const name = path.basename(rel);
	const isLayout = rel.includes("/layouts/");
	vi.doMock(path.join(SRC_DIR, rel), () => ({
		default: () =>
			isLayout ? (
				<div>
					<span>{name}</span>
					<Outlet />
				</div>
			) : (
				<main>{name}</main>
			),
	}));
}

const { default: AppRoutes } = await import("../AppRoutes");

type RouteCase = {
	/** Exactly as written in AppRoutes.tsx (`path="…"`); null for index routes. */
	path: string | null;
	/** URL to visit (params filled in). */
	url: string;
	/** Stub text expected to render. */
	page: string;
	/** Permission(s) the guard requires (any-of when an array); undefined = ungated. */
	perm?: string | string[];
};

const ROUTES: RouteCase[] = [
	// public
	{ path: "/login", url: "/login", page: "LoginPage" },
	{ path: "/register", url: "/register", page: "RegisterPage" },
	{ path: "/verify-email", url: "/verify-email", page: "VerifyEmailPage" },
	{ path: "/reset-password", url: "/reset-password", page: "ResetPasswordPage" },
	{ path: "/accept-invite", url: "/accept-invite", page: "AcceptInvitePage" },
	{ path: "/quickbooks/callback", url: "/quickbooks/callback", page: "QBCallbackPage" },
	{ path: "/auth/sso/complete", url: "/auth/sso/complete", page: "SSOCompletePage" },
	{ path: "/platform/*", url: "/platform/login", page: "PlatformRoutes" },
	// dispatch shell
	{ path: "/dispatch/*", url: "/dispatch", page: "DispatchLayout" },
	{ path: null, url: "/dispatch", page: "DashboardPage" },
	{ path: "schedule", url: "/dispatch/schedule", page: "SchedulePage" },
	{ path: "clients", url: "/dispatch/clients", page: "ClientsPage", perm: "view_clients" },
	{ path: "clients/:clientId", url: "/dispatch/clients/c1", page: "ClientDetailPage", perm: "view_clients" },
	{ path: "jobs", url: "/dispatch/jobs", page: "JobsPage", perm: "view_jobs" },
	{ path: "jobs/:jobId", url: "/dispatch/jobs/j1", page: "JobDetailPage", perm: "view_jobs" },
	{
		path: "jobs/:jobId/visits/:visitId",
		url: "/dispatch/jobs/j1/visits/v1",
		page: "JobVisitDetailPage",
		perm: ["view_jobs", "view_visits"],
	},
	{ path: "projects", url: "/dispatch/projects", page: "ProjectsPage", perm: "view_projects" },
	{ path: "projects/:projectId", url: "/dispatch/projects/p1", page: "ProjectDetailPage", perm: "view_projects" },
	{
		path: "recurring-plans/:recurringPlanId",
		url: "/dispatch/recurring-plans/r1",
		page: "RecurringPlanDetailPage",
		perm: "view_recurring_plans",
	},
	{
		path: "dispatchers/:dispatcherId",
		url: "/dispatch/dispatchers/d1",
		page: "DispatcherDetailPage",
		perm: "view_dispatchers",
	},
	{ path: "technicians", url: "/dispatch/technicians", page: "TechniciansPage", perm: "view_technicians" },
	{
		path: "technicians/:technicianId",
		url: "/dispatch/technicians/t1",
		page: "TechnicianDetailPage",
		perm: "view_technicians",
	},
	{
		path: "technicians/:technicianId/assign",
		url: "/dispatch/technicians/t1/assign",
		page: "AssignTechnicianPage",
		perm: "manage_technicians",
	},
	{ path: "map", url: "/dispatch/map", page: "MapPage" },
	{ path: "reporting", url: "/dispatch/reporting", page: "ReportingPage", perm: "view_reports" },
	{ path: "reporting/builder", url: "/dispatch/reporting/builder", page: "ReportBuilderPage", perm: "view_reports" },
	{
		path: "reporting/aged-receivables",
		url: "/dispatch/reporting/aged-receivables",
		page: "AgedReceivablesPage",
		perm: "view_reports",
	},
	{ path: "reporting/job-backlog", url: "/dispatch/reporting/job-backlog", page: "JobBacklogPage", perm: "view_reports" },
	{
		path: "reporting/client-retention",
		url: "/dispatch/reporting/client-retention",
		page: "ClientRetentionPage",
		perm: "view_reports",
	},
	{
		path: "reporting/client-lifetime-value",
		url: "/dispatch/reporting/client-lifetime-value",
		page: "ClientLifetimeValuePage",
		perm: "view_reports",
	},
	{
		path: "reporting/client-discounts",
		url: "/dispatch/reporting/client-discounts",
		page: "ClientDiscountsPage",
		perm: "view_reports",
	},
	{
		path: "reporting/profit-and-loss",
		url: "/dispatch/reporting/profit-and-loss",
		page: "ProfitAndLossPage",
		perm: "view_reports",
	},
	{ path: "reporting/tax-liability", url: "/dispatch/reporting/tax-liability", page: "TaxLiabilityPage", perm: "view_reports" },
	{ path: "reporting/payments", url: "/dispatch/reporting/payments", page: "PaymentsReportPage", perm: "view_reports" },
	{ path: "reporting/quote-funnel", url: "/dispatch/reporting/quote-funnel", page: "QuoteFunnelPage", perm: "view_reports" },
	{
		path: "reporting/revenue-by-line-item-type",
		url: "/dispatch/reporting/revenue-by-line-item-type",
		page: "RevenueByLineItemTypePage",
		perm: "view_reports",
	},
	{
		path: "reporting/revenue-by-line-item-type/:itemType",
		url: "/dispatch/reporting/revenue-by-line-item-type/labor",
		page: "RevenueByLineItemTypeDetailPage",
		perm: "view_reports",
	},
	{
		path: "reporting/first-time-fix",
		url: "/dispatch/reporting/first-time-fix",
		page: "FirstTimeFixRatePage",
		perm: "view_reports",
	},
	{
		path: "reporting/technician-scorecard",
		url: "/dispatch/reporting/technician-scorecard",
		page: "TechnicianScorecardPage",
		perm: "view_reports",
	},
	{
		path: "reporting/field-added-revenue",
		url: "/dispatch/reporting/field-added-revenue",
		page: "FieldAddedRevenuePage",
		perm: "view_reports",
	},
	{
		path: "reporting/recurring-revenue",
		url: "/dispatch/reporting/recurring-revenue",
		page: "RecurringRevenuePage",
		perm: "view_reports",
	},
	{ path: "kpi", url: "/dispatch/kpi", page: "KPIPage", perm: "view_reports" },
	{ path: "mileage", url: "/dispatch/mileage", page: "MileageReportPage" },
	{ path: "timesheets", url: "/dispatch/timesheets", page: "TimesheetsReportPage", perm: "view_reports" },
	{
		path: "inventory/reorder-forecast",
		url: "/dispatch/inventory/reorder-forecast",
		page: "ReorderForecastPage",
		perm: "view_reports",
	},
	{ path: "inventory", url: "/dispatch/inventory", page: "InventoryPage", perm: "view_inventory" },
	{
		// Every verb on this page rewrites catalog or historical billing rows.
		path: "inventory/reconcile",
		url: "/dispatch/inventory/reconcile",
		page: "InventoryReconcilePage",
		perm: "manage_inventory",
	},
	{
		path: "inventory/items/:itemId",
		url: "/dispatch/inventory/items/i1",
		page: "InventoryItemDetailPage",
		perm: "view_inventory",
	},
	{ path: "inventory/labels/print", url: "/dispatch/inventory/labels/print", page: "LabelPrintPage", perm: "manage_inventory" },
	// legacy: redirects to the item detail page (see "legacy inventory paths" below)
	{ path: "inventory/items/:itemId/tracking", url: "/dispatch/inventory/items/i1/tracking", page: "InventoryItemDetailPage", perm: "view_inventory" },
	{ path: "inventory/serials/:serialId", url: "/dispatch/inventory/serials/s1", page: "SerialRedirectPage", perm: "view_inventory" },
	{ path: "inventory/batches/:batchId", url: "/dispatch/inventory/batches/b1", page: "BatchDetailPage", perm: "view_inventory" },
	{ path: "inventory/suppliers", url: "/dispatch/inventory/suppliers", page: "SuppliersPage", perm: "view_inventory" },
	{ path: "inventory/suppliers/:supplierId", url: "/dispatch/inventory/suppliers/s1", page: "SupplierDetailPage", perm: "view_inventory" },
	{ path: "purchases", url: "/dispatch/purchases", page: "PurchasePage", perm: ["view_field_purchases", "review_field_purchases", "view_purchases"] },
	{ path: "purchases/:purchaseId", url: "/dispatch/purchases/p1", page: "PurchaseDetailsPage", perm: "view_purchases" },
	{ path: "quotes", url: "/dispatch/quotes", page: "QuotesPage", perm: "view_quotes" },
	{ path: "quotes/:quoteId", url: "/dispatch/quotes/q1", page: "QuoteDetailPage", perm: "view_quotes" },
	{ path: "requests", url: "/dispatch/requests", page: "RequestsPage", perm: "view_requests" },
	{ path: "requests/:requestId", url: "/dispatch/requests/r1", page: "RequestDetailPage", perm: "view_requests" },
	{ path: "invoices", url: "/dispatch/invoices", page: "InvoicesPage", perm: "view_invoices" },
	{ path: "invoices/:invoiceId", url: "/dispatch/invoices/i1", page: "InvoiceDetailPage", perm: "view_invoices" },
	{ path: "profile", url: "/dispatch/profile", page: "MyProfilePage" },
	{ path: "admin", url: "/dispatch/admin", page: "AdminPage", perm: ["view_admin", "manage_organization", "manage_roles"] },
	{ path: "welcome", url: "/dispatch/welcome", page: "WelcomePage", perm: "manage_organization" },
	{ path: "followups", url: "/dispatch/followups", page: "FollowupsPage", perm: "view_followups" },
	{ path: "vehicles", url: "/dispatch/vehicles", page: "VehiclesPage", perm: ["view_inventory", "manage_technicians"] },
	{
		path: "vehicles/:id/stock",
		url: "/dispatch/vehicles/v1/stock",
		page: "VehicleStockPage",
		perm: ["view_inventory", "manage_technicians"],
	},
	// full map
	{ path: "/map", url: "/map", page: "FullMapPage" },
	// technician shell
	{ path: "/technician/*", url: "/technician", page: "TechnicianLayout" },
	{ path: null, url: "/technician", page: "TechnicianDashboardPage" },
	{ path: "visits", url: "/technician/visits", page: "TechnicianVisitsPage", perm: "view_visits" },
	{ path: "visits/:visitId", url: "/technician/visits/v1", page: "TechnicianVisitDetailPage", perm: "view_visits" },
	{ path: "notifications", url: "/technician/notifications", page: "TechnicianNotificationsPage" },
	{ path: "vehicles", url: "/technician/vehicles", page: "TechnicianVehiclePage", perm: "view_vehicles" },
	{ path: "map", url: "/technician/map", page: "TechnicianMapPage" },
	{ path: "profile", url: "/technician/profile", page: "MyProfilePage" },
	{ path: "mileage", url: "/technician/mileage", page: "TechnicianMileagePage" },
	{
		path: "purchases",
		url: "/technician/purchases",
		page: "TechnicianPurchasesPage",
		perm: "request_field_purchase",
	},
	{
		path: "purchases/:purchaseId",
		url: "/technician/purchases/fp1",
		page: "TechnicianPurchaseDetailPage",
		perm: "request_field_purchase",
	},
	// catch-all
	{ path: "*", url: "/definitely/not/a/route", page: "LoginPage" },
];

const ALL_PERMISSIONS = [
	...new Set(ROUTES.flatMap((r) => (Array.isArray(r.perm) ? r.perm : r.perm ? [r.perm] : []))),
];

function LocationSpy() {
	const { pathname } = useLocation();
	return <output data-testid="pathname">{pathname}</output>;
}

const fakeJwt = (expSecondsFromNow: number) => {
	const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "");
	return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
};

function signIn(role: "dispatcher" | "technician" | "admin", permissions: string[]) {
	localStorage.setItem("accessToken", fakeJwt(3600));
	useAuthStore.getState().login(role, "Test User", "u1", "org1", "America/Chicago", permissions);
}

function signOut() {
	localStorage.removeItem("accessToken");
	useAuthStore.setState({ user: null });
}

function renderAt(url: string) {
	return render(
		<MemoryRouter initialEntries={[url]}>
			<AppRoutes />
			<LocationSpy />
		</MemoryRouter>,
	);
}

const expectPage = async (page: string) => {
	expect(await screen.findByText(page, {}, { timeout: 3000 })).toBeInTheDocument();
};

// React throttles Suspense fallback→content commits (~300ms each). Resolve every
// lazy page once, all at the same time, so the per-route tests below render
// synchronously instead of each paying that wait.
beforeAll(async () => {
	useAuthStore.setState({ _hasHydrated: true });
	signIn("dispatcher", ALL_PERMISSIONS);
	render(
		<>
			{ROUTES.map((r) => (
				<MemoryRouter key={r.url + r.page} initialEntries={[r.url]}>
					<AppRoutes />
				</MemoryRouter>
			))}
		</>,
	);
	await waitFor(
		() => expect(document.querySelectorAll("main").length).toBeGreaterThanOrEqual(ROUTES.length - 2),
		{ timeout: 5000 },
	);
	cleanup();
});

beforeEach(() => {
	useAuthStore.setState({ _hasHydrated: true });
	signOut();
});

afterEach(() => {
	cleanup();
});

describe("AppRoutes — table covers the route file", () => {
	it("every path=\"…\" in AppRoutes.tsx has a row in ROUTES (and vice versa)", () => {
		const declared = new Set([...APP_ROUTES_SOURCE.matchAll(/\bpath="([^"]+)"/g)].map((m) => m[1]));
		const tabled = new Set(ROUTES.map((r) => r.path).filter((p): p is string => p !== null));
		expect([...tabled].sort()).toEqual([...declared].sort());
	});

	it("every lazy page module has a stub (no real page is imported)", () => {
		expect(MODULE_PATHS.every((p) => p.startsWith("./"))).toBe(true);
		expect(new Set(ROUTES.map((r) => r.page)).size).toBeGreaterThan(60);
	});
});

describe("AppRoutes — signed-in dispatcher with every permission", () => {
	beforeEach(() => signIn("dispatcher", ALL_PERMISSIONS));

	it.each(ROUTES.filter((r) => !r.url.startsWith("/technician") && r.path !== "*"))(
		"$url renders $page",
		async ({ url, page }) => {
			renderAt(url);
			await expectPage(page);
		},
	);

	it("does not gate on hydration forever: renders nothing until the store has hydrated", () => {
		useAuthStore.setState({ _hasHydrated: false });
		const { container } = renderAt("/dispatch/jobs");
		expect(container.querySelector("main")).toBeNull();
		expect(screen.queryByText("JobsPage")).toBeNull();
	});
});

describe("AppRoutes — permission guards", () => {
	const gated = ROUTES.filter((r) => r.perm && r.url.startsWith("/dispatch"));

	it.each(gated)("$url without its permission falls back to the dashboard", async ({ url, perm }) => {
		const required = Array.isArray(perm) ? perm : [perm!];
		signIn(
			"dispatcher",
			ALL_PERMISSIONS.filter((p) => !required.includes(p)),
		);
		renderAt(url);
		await expectPage("DashboardPage");
		expect(screen.getByTestId("pathname")).toHaveTextContent("/dispatch");
	});

	it("any-of guards accept each alternative permission", async () => {
		signIn("dispatcher", ["manage_technicians"]);
		renderAt("/dispatch/vehicles");
		await expectPage("VehiclesPage");
		cleanup();
		signIn("dispatcher", ["view_inventory"]);
		renderAt("/dispatch/vehicles/v1/stock");
		await expectPage("VehicleStockPage");
	});
});

describe("AppRoutes — role and auth redirects", () => {
	it("sends anonymous visitors of protected routes to /login", async () => {
		renderAt("/dispatch/jobs");
		await expectPage("LoginPage");
		expect(screen.getByTestId("pathname")).toHaveTextContent("/login");
		cleanup();
		renderAt("/technician/visits");
		await expectPage("LoginPage");
		cleanup();
		renderAt("/map");
		await expectPage("LoginPage");
	});

	it("sends technicians who hit /dispatch to /technician", async () => {
		signIn("technician", ["view_visits"]);
		renderAt("/dispatch/jobs");
		await expectPage("TechnicianDashboardPage");
		expect(screen.getByTestId("pathname")).toHaveTextContent("/technician");
	});

	it.each(ROUTES.filter((r) => r.url.startsWith("/technician")))(
		"technician: $url renders $page",
		async ({ url, page }) => {
			signIn("technician", ["view_visits", "view_vehicles", "request_field_purchase"]);
			renderAt(url);
			await expectPage(page);
		},
	);

	it("treats an expired token as signed out", async () => {
		signIn("dispatcher", ALL_PERMISSIONS);
		localStorage.setItem("accessToken", fakeJwt(-60));
		renderAt("/map");
		await expectPage("LoginPage");
	});

	it("unknown paths go to /login", async () => {
		signIn("dispatcher", ALL_PERMISSIONS);
		renderAt("/definitely/not/a/route");
		await expectPage("LoginPage");
	});
});

describe("AppRoutes — legacy inventory paths", () => {
	beforeEach(() => signIn("dispatcher", ALL_PERMISSIONS));

	it("/dispatch/inventory/items/:id/tracking redirects to the item detail page", async () => {
		renderAt("/dispatch/inventory/items/item-42/tracking");
		await expectPage("InventoryItemDetailPage");
		expect(screen.getByTestId("pathname")).toHaveTextContent("/dispatch/inventory/items/item-42");
		expect(screen.getByTestId("pathname")).not.toHaveTextContent("/tracking");
	});

	it("/dispatch/inventory/serials/:id renders the serial redirect component (view_inventory)", async () => {
		renderAt("/dispatch/inventory/serials/ser-7");
		await expectPage("SerialRedirectPage");
		expect(screen.getByTestId("pathname")).toHaveTextContent("/dispatch/inventory/serials/ser-7");
	});
});
