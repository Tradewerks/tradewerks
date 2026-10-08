import { lazy, Suspense, useEffect, type JSX } from "react";
import { Routes, Route, Navigate, useLocation, useParams } from "react-router-dom";
import { useAuthStore, isTokenExpired } from "./auth/authStore";
import { usePermission, useAnyPermission } from "./hooks/usePermission";

// Route-level code splitting: every page component below (plus DispatchLayout,
// which itself eagerly pulls in the full Create-panel form suite) is
// dynamically imported so a technician's first load doesn't pull in
// dispatch-only dependencies (Mapbox, Recharts, FullCalendar,
// react-grid-layout, etc.) and vice versa. TechnicianLayout stays eager —
// confirmed via trace to be a genuinely thin nav shell with no heavy deps.
import TechnicianLayout from "./layouts/TechnicianLayout";
const DispatchLayout = lazy(() => import("./layouts/DispatchLayout"));

const LoginPage = lazy(() => import("./auth/LoginPage"));
const DispatcherDetailPage = lazy(() => import("./pages/dispatch/DispatcherDetailPage"));
const TechnicianDashboardPage = lazy(() => import("./pages/technician/TechnicianDashboardPage"));
const TechnicianVisitsPage = lazy(() => import("./pages/technician/TechnicianVisitsPage"));
const TechnicianVisitDetailPage = lazy(() => import("./pages/technician/TechnicianVisitDetailPage"));
const TechnicianNotificationsPage = lazy(() => import("./pages/technician/TechnicianNotificationsPage"));
const TechnicianVehiclePage = lazy(() => import("./pages/technician/TechnicianVehiclePage"));
const TechnicianMapPage = lazy(() => import("./pages/technician/TechnicianMapPage"));
const TechnicianMileagePage = lazy(() => import("./pages/technician/TechnicianMileagePage"));
const TechnicianPurchasesPage = lazy(() => import("./pages/technician/TechnicianPurchasesPage"));
const TechnicianPurchaseDetailPage = lazy(
	() => import("./pages/technician/TechnicianPurchaseDetailPage"),
);
const DashboardPage = lazy(() => import("./pages/dispatch/DashboardPage"));
const JobsPage = lazy(() => import("./pages/dispatch/JobsPage"));
const JobDetailPage = lazy(() => import("./pages/dispatch/JobDetailPage"));
const JobVisitDetailPage = lazy(() => import("./pages/dispatch/JobVisitDetailPage"));
const RecurringPlanDetailPage = lazy(() => import("./pages/dispatch/RecurringPlanDetailPage"));
const SchedulePage = lazy(() => import("./pages/dispatch/SchedulePage"));
const ClientsPage = lazy(() => import("./pages/dispatch/ClientsPage"));
const ClientDetailsPage = lazy(() => import("./pages/dispatch/ClientDetailPage"));
const TechniciansPage = lazy(() => import("./pages/dispatch/TechniciansPage"));
const TechnicianDetailsPage = lazy(() => import("./pages/dispatch/TechnicianDetailPage"));
const MapPage = lazy(() => import("./pages/dispatch/MapPage"));
const ReportingPage = lazy(() => import("./pages/dispatch/ReportingPage"));
const KpiPage = lazy(() => import("./pages/dispatch/KpiPage"));
const ReportBuilderPage = lazy(() => import("./pages/dispatch/ReportBuilderPage"));
const MileageReportPage = lazy(() => import("./pages/dispatch/MileageReportPage"));
const TimesheetsReportPage = lazy(() => import("./pages/dispatch/TimesheetsReportPage"));
const ReorderForecastPage = lazy(() => import("./pages/dispatch/ReorderForecastPage"));
const AgedReceivablesPage = lazy(() => import("./pages/dispatch/AgedReceivablesPage"));
const JobBacklogPage = lazy(() => import("./pages/dispatch/JobBacklogPage"));
const ClientRetentionPage = lazy(() => import("./pages/dispatch/ClientRetentionPage"));
const ClientLifetimeValuePage = lazy(() => import("./pages/dispatch/ClientLifetimeValuePage"));
const ClientDiscountsPage = lazy(() => import("./pages/dispatch/ClientDiscountsPage"));
const FieldAddedRevenuePage = lazy(() => import("./pages/dispatch/FieldAddedRevenuePage"));
const RecurringRevenuePage = lazy(() => import("./pages/dispatch/RecurringRevenuePage"));
const ProfitAndLossPage = lazy(() => import("./pages/dispatch/ProfitAndLossPage"));
const QBReportPage = lazy(() => import("./pages/dispatch/QBReportPage"));
const TaxLiabilityPage = lazy(() => import("./pages/dispatch/TaxLiabilityPage"));
const PaymentsReportPage = lazy(() => import("./pages/dispatch/PaymentsReportPage"));
const CogsReportPage = lazy(() => import("./pages/dispatch/CogsReportPage"));
const QuoteFunnelPage = lazy(() => import("./pages/dispatch/QuoteFunnelPage"));
const RevenueByLineItemTypePage = lazy(() => import("./pages/dispatch/RevenueByLineItemTypePage"));
const RevenueByLineItemTypeDetailPage = lazy(() => import("./pages/dispatch/RevenueByLineItemTypeDetailPage"));
const FirstTimeFixRatePage = lazy(() => import("./pages/dispatch/FirstTimeFixRatePage"));
const TechnicianScorecardPage = lazy(() => import("./pages/dispatch/TechnicianScorecardPage"));
const QuotesPage = lazy(() => import("./pages/dispatch/QuotesPage"));
const QuoteDetailPage = lazy(() => import("./pages/dispatch/QuoteDetailPage"));
const AssignTechnicianPage = lazy(() => import("./pages/dispatch/AssignTechnicianPage"));
const RequestsPage = lazy(() => import("./pages/dispatch/RequestsPage"));
const RequestDetailsPage = lazy(() => import("./pages/dispatch/RequestDetailPage"));
const InventoryPage = lazy(() => import("./pages/dispatch/InventoryPage"));
const InventoryItemDetailPage = lazy(() => import("./pages/dispatch/InventoryItemDetailPage"));
const SuppliersPage = lazy(() => import("./pages/dispatch/SuppliersPage"));
const InventoryReconcilePage = lazy(() => import("./pages/dispatch/InventoryReconcilePage"));
const SupplierDetailPage = lazy(() => import("./pages/dispatch/SupplierDetailPage"));
const LabelPrintPage = lazy(() => import("./components/inventory/labels/LabelPrintPage"));
const SerialRedirectPage = lazy(() => import("./pages/dispatch/SerialRedirectPage"));
const BatchDetailPage = lazy(() => import("./pages/dispatch/BatchDetailPage"));
const FullMapPage = lazy(() => import("./pages/dispatch/FullMapPage"));
const InvoicesPage = lazy(() => import("./pages/dispatch/InvoicesPage"));
const InvoiceDetailPage = lazy(() => import("./pages/dispatch/InvoiceDetailPage"));
const AdminPage = lazy(() => import("./pages/dispatch/AdminPage"));
const FollowupsPage = lazy(() => import("./pages/dispatch/FollowupsPage"));
const VehiclesPage = lazy(() => import("./pages/dispatch/VehiclesPage"));
const VehicleStockPage = lazy(() => import("./pages/dispatch/VehicleStockPage"));
const VerifyEmailPage = lazy(() => import("./pages/dispatch/VerifyEmailPage"));
const ResetPasswordPage = lazy(() => import("./pages/ResetPasswordPage"));
const RegisterPage = lazy(() => import("./pages/RegisterPage"));
const MyProfilePage = lazy(() => import("./pages/MyProfilePage"));
const QBCallbackPage = lazy(() => import("./pages/QBCallbackPage"));
const SSOCompletePage = lazy(() => import("./pages/SSOCompletePage"));
const ProjectsPage = lazy(() => import("./pages/dispatch/ProjectsPage"));
const ProjectDetailPage = lazy(() => import("./pages/dispatch/ProjectDetailPage"));
const JobProfitabilityPage = lazy(() => import("./pages/dispatch/JobProfitabilityPage"));
const PurchasePage = lazy(() => import("./pages/dispatch/PurchasePage"));
const PurchaseDetailsPage = lazy(() => import("./pages/dispatch/PurchaseDetailsPage"));
const DispatcherNotificationPage = lazy(() => import("./pages/dispatch/DispatcherNotificationPage"));
const TimesheetPage = lazy(() => import("./pages/dispatch/Timesheet"))
const PlatformRoutes = lazy(() => import("./platform/PlatformRoutes"));

function RequireAuth({ children }: { children: JSX.Element }) {
	const { user, logout } = useAuthStore();
	const location = useLocation();
	const expired = user ? isTokenExpired() : false;

	useEffect(() => {
		if (expired) logout();
	}, [expired, logout, location.pathname]);

	if (!user || expired) return <Navigate to="/login" replace />;
	return children;
}
// stops technicians from accessing dispatch routes 
function RequireDispatcher({ children }: { children: JSX.Element }) {
	const { user } = useAuthStore();
	if (!user) return <Navigate to="/login" replace />;
	if (user.role === "technician") return <Navigate to="/technician" replace />;
	return children;
}
function RequirePermission({ permission, children }: { permission: string; children: JSX.Element }) {
	const allowed = usePermission(permission);
	return allowed ? children : <Navigate to="/dispatch" replace />;
}

function RequireAnyPermission({ permissions, children }: { permissions: string[]; children: JSX.Element }) {
	const allowed = useAnyPermission(permissions);
	return allowed ? children : <Navigate to="/dispatch" replace />;
}

// Bookmark safety net for the retired standalone tracking page — the Serials &
// Batches tables now live in the item detail page's Tracking tab.
function RedirectToItemDetail() {
	const { itemId } = useParams<{ itemId: string }>();
	return <Navigate to={`/dispatch/inventory/items/${itemId}`} replace />;
}

export default function AppRoutes() {
	// Wait for auth store to hydrate before rendering routes to prevent flicker of protected pages on load
	const hasHydrated = useAuthStore((s) => s._hasHydrated);
	if (!hasHydrated) return null;

	return (
		<Suspense fallback={<div className="fixed inset-0 flex items-center justify-center bg-canvas" />}>
			<Routes>
				<Route path="/login" element={<LoginPage />} />
			<Route path="/register" element={<RegisterPage />} />
			<Route path="/verify-email" element={<VerifyEmailPage />} />
			<Route path="/reset-password" element={<ResetPasswordPage />} />
			<Route path="/quickbooks/callback" element={<QBCallbackPage />} />
			<Route path="/auth/sso/complete" element={<SSOCompletePage />} />
			<Route
				path="/dispatch/*"
				element={
					<RequireDispatcher>
						<DispatchLayout />
					</RequireDispatcher>
				}
			>
				<Route index element={<DashboardPage />} />
				<Route path="schedule" element={<SchedulePage />} />
				<Route path="clients" element={<RequirePermission permission="view_clients"><ClientsPage /></RequirePermission>} />
				<Route path="clients/:clientId" element={<RequirePermission permission="view_clients"><ClientDetailsPage /></RequirePermission>} />
				<Route path="jobs" element={<RequirePermission permission="view_jobs"><JobsPage /></RequirePermission>} />
				<Route path="jobs/:jobId" element={<RequirePermission permission="view_jobs"><JobDetailPage /></RequirePermission>} />
				<Route
					path="jobs/:jobId/visits/:visitId"
					element={<RequireAnyPermission permissions={["view_jobs", "view_visits"]}><JobVisitDetailPage /></RequireAnyPermission>}
				/>
				<Route path="projects" element={<RequirePermission permission="view_projects"><ProjectsPage /></RequirePermission>} />
				<Route path="projects/:projectId" element={<RequirePermission permission="view_projects"><ProjectDetailPage /></RequirePermission>} />
				<Route
					path="recurring-plans/:recurringPlanId"
					element={<RequirePermission permission="view_recurring_plans"><RecurringPlanDetailPage /></RequirePermission>}
				/>
				<Route path="dispatchers/:dispatcherId" element={<RequirePermission permission="view_dispatchers"><DispatcherDetailPage /></RequirePermission>} />
				<Route path="technicians" element={<RequirePermission permission="view_technicians"><TechniciansPage /></RequirePermission>} />
				<Route
					path="technicians/:technicianId"
					element={<RequirePermission permission="view_technicians"><TechnicianDetailsPage /></RequirePermission>}
				/>
				<Route
					path="technicians/:technicianId/assign"
					element={<RequirePermission permission="manage_technicians"><AssignTechnicianPage /></RequirePermission>}
				/>
				<Route path="map" element={<MapPage />} />
				<Route path="kpi" element={<RequirePermission permission="view_reports"><KpiPage /></RequirePermission>} />
				<Route path="reporting" element={<RequirePermission permission="view_reports"><ReportingPage /></RequirePermission>} />
				<Route path="reporting/builder" element={<RequirePermission permission="view_reports"><ReportBuilderPage /></RequirePermission>} />
				<Route path="reporting/aged-receivables" element={<RequirePermission permission="view_reports"><AgedReceivablesPage /></RequirePermission>} />
				<Route path="reporting/job-backlog" element={<RequirePermission permission="view_reports"><JobBacklogPage /></RequirePermission>} />
				<Route path="reporting/client-retention" element={<RequirePermission permission="view_reports"><ClientRetentionPage /></RequirePermission>} />
				<Route path="reporting/client-lifetime-value" element={<RequirePermission permission="view_reports"><ClientLifetimeValuePage /></RequirePermission>} />
				<Route path="reporting/client-discounts" element={<RequirePermission permission="view_reports"><ClientDiscountsPage /></RequirePermission>} />
				<Route path="reporting/profit-and-loss" element={<RequirePermission permission="view_reports"><ProfitAndLossPage /></RequirePermission>} />
				<Route path="reporting/job-profitability" element={<RequirePermission permission="view_reports"><JobProfitabilityPage /></RequirePermission>} />
				<Route path="reporting/qb/:reportType" element={<RequirePermission permission="view_reports"><QBReportPage /></RequirePermission>} />
				<Route path="reporting/tax-liability" element={<RequirePermission permission="view_reports"><TaxLiabilityPage /></RequirePermission>} />
				<Route path="reporting/payments" element={<RequirePermission permission="view_reports"><PaymentsReportPage /></RequirePermission>} />
				<Route path="reporting/cogs" element={<RequirePermission permission="view_reports"><CogsReportPage /></RequirePermission>} />
				<Route path="reporting/quote-funnel" element={<RequirePermission permission="view_reports"><QuoteFunnelPage /></RequirePermission>} />
				<Route path="reporting/revenue-by-line-item-type" element={<RequirePermission permission="view_reports"><RevenueByLineItemTypePage /></RequirePermission>} />
				<Route path="reporting/revenue-by-line-item-type/:itemType" element={<RequirePermission permission="view_reports"><RevenueByLineItemTypeDetailPage /></RequirePermission>} />
				<Route path="reporting/first-time-fix" element={<RequirePermission permission="view_reports"><FirstTimeFixRatePage /></RequirePermission>} />
				<Route path="reporting/technician-scorecard" element={<RequirePermission permission="view_reports"><TechnicianScorecardPage /></RequirePermission>} />
				<Route path="reporting/field-added-revenue" element={<RequirePermission permission="view_reports"><FieldAddedRevenuePage /></RequirePermission>} />
				<Route path="reporting/recurring-revenue" element={<RequirePermission permission="view_reports"><RecurringRevenuePage /></RequirePermission>} />
				<Route path="mileage" element={<MileageReportPage />} />
				<Route path="timesheets" element={<RequirePermission permission="view_reports"><TimesheetsReportPage /></RequirePermission>} />
				<Route path="inventory/reorder-forecast" element={<RequirePermission permission="view_reports"><ReorderForecastPage /></RequirePermission>} />
				<Route path="inventory" element={<RequirePermission permission="view_inventory"><InventoryPage /></RequirePermission>} />
				{/* Reading the vendor list is view_inventory (the capture typeahead needs it
				    on every intake path); the page gates its own writes on manage_inventory. */}
				<Route path="inventory/suppliers" element={<RequirePermission permission="view_inventory"><SuppliersPage /></RequirePermission>} />
				{/* Every verb here rewrites catalog or historical billing rows, so
				    it is manage_inventory rather than view_inventory. */}
				<Route path="inventory/reconcile" element={<RequirePermission permission="manage_inventory"><InventoryReconcilePage /></RequirePermission>} />
				{/* Reviewing is the control on field spend, so reading the queue is its
				    own permission rather than view_inventory — the page gates the
				    decisions and the grants tab separately. */}
				<Route path="purchases" element={<RequireAnyPermission permissions={["view_field_purchases", "review_field_purchases", "view_purchases"]}><PurchasePage /></RequireAnyPermission>} />
				<Route path="purchases/:purchaseId" element={<RequirePermission permission="view_purchases" ><PurchaseDetailsPage /></RequirePermission>} />
				<Route path="inventory/suppliers/:supplierId" element={<RequirePermission permission="view_inventory"><SupplierDetailPage /></RequirePermission>} />
				<Route path="inventory/items/:itemId" element={<RequirePermission permission="view_inventory"><InventoryItemDetailPage /></RequirePermission>} />
				<Route path="inventory/labels/print" element={<RequirePermission permission="manage_inventory"><LabelPrintPage /></RequirePermission>} />
				<Route path="inventory/items/:itemId/tracking" element={<RedirectToItemDetail />} />
				<Route path="inventory/serials/:serialId" element={<RequirePermission permission="view_inventory"><SerialRedirectPage /></RequirePermission>} />
				<Route path="inventory/batches/:batchId" element={<RequirePermission permission="view_inventory"><BatchDetailPage /></RequirePermission>} />
				<Route path="quotes" element={<RequirePermission permission="view_quotes"><QuotesPage /></RequirePermission>} />
				<Route path="quotes/:quoteId" element={<RequirePermission permission="view_quotes"><QuoteDetailPage /></RequirePermission>} />
				<Route path="requests" element={<RequirePermission permission="view_requests"><RequestsPage /></RequirePermission>} />
				<Route
					path="requests/:requestId"
					element={<RequirePermission permission="view_requests"><RequestDetailsPage /></RequirePermission>}
				/>
				<Route path="invoices" element={<RequirePermission permission="view_invoices"><InvoicesPage /></RequirePermission>} />
				<Route path="invoices/:invoiceId" element={<RequirePermission permission="view_invoices"><InvoiceDetailPage /></RequirePermission>} />
				<Route path="profile" element={<RequireAuth><MyProfilePage /></RequireAuth>} />
				<Route path="admin" element={<RequireAnyPermission permissions={["view_admin", "manage_organization", "manage_roles"]}><AdminPage /></RequireAnyPermission>} />
				<Route path="followups" element={<RequirePermission permission="view_followups"><FollowupsPage /></RequirePermission>} />
				<Route path="vehicles" element={<RequireAnyPermission permissions={["view_inventory", "manage_technicians"]}><VehiclesPage /></RequireAnyPermission>} />
				<Route path="vehicles/:id/stock" element={<RequireAnyPermission permissions={["view_inventory", "manage_technicians"]}><VehicleStockPage /></RequireAnyPermission>} />
				<Route path="notifications" element={<DispatcherNotificationPage />} />
				<Route path="timesheet" element={<RequirePermission permission="view_timesheet"><TimesheetPage /></RequirePermission>} />
			</Route>

			<Route
				path="/map"
				element={
					<RequireAuth>
						<FullMapPage />
					</RequireAuth>
				}
			></Route>

			<Route
				path="/technician/*"
				element={
					<RequireAuth>
						<TechnicianLayout />
					</RequireAuth>
				}
			>
				<Route index element={<TechnicianDashboardPage />} />
				<Route path="visits" element={<RequirePermission permission="view_visits"><TechnicianVisitsPage /></RequirePermission>} />
				<Route path="visits/:visitId" element={<RequirePermission permission="view_visits"><TechnicianVisitDetailPage /></RequirePermission>} />
				<Route path="notifications" element={<TechnicianNotificationsPage />} />
				<Route path="vehicles" element={<RequirePermission permission="view_vehicles"><TechnicianVehiclePage /></RequirePermission>} />
				<Route path="map" element={<TechnicianMapPage />} />
				<Route path="profile" element={<MyProfilePage />} />
				<Route path="mileage" element={<TechnicianMileagePage />} />
				<Route path="purchases" element={<RequirePermission permission="request_field_purchase"><TechnicianPurchasesPage /></RequirePermission>} />
				<Route path="purchases/:purchaseId" element={<RequirePermission permission="request_field_purchase"><TechnicianPurchaseDetailPage /></RequirePermission>} />
			</Route>

				<Route path="/platform/*" element={<PlatformRoutes />} />
				<Route path="*" element={<Navigate to="/login" replace />} />
			</Routes>
		</Suspense>
	);
}
