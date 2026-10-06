import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { useAuthStore } from "../auth/authStore";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	House,
	Calendar,
	Users,
	FileText,
	Wrench,
	ChartColumnDecreasing,
	Package,
	Map,
	ArrowLeft,
	Inbox,
	Briefcase,
	Receipt,
	ReceiptText,
	ShieldUser,
	Truck,
	Plus,
	Mail,
	FolderKanban,
	Bell,
	Timer,
} from "lucide-react";
import SideNavItem from "../components/nav/SideNavItem";
import GlobalSearch from "../components/nav/GlobalSearch";
import { usePermission, useAnyPermission } from "../hooks/usePermission";
import DispatcherUserMenu from "../components/nav/DispatcherUserMenu";
import CreatePanel from "../components/nav/CreatePanel";
import AssistantPanel from "../components/assistant/AssistantPanel";
import AssistantTrigger from "../components/assistant/AssistantTrigger";
import ToastViewport from "../components/ui/ToastViewport";
import { useToast } from "../components/ui/useToast";
import { useOrgSettings } from "../hooks/useOrg";
import { useSocketQuerySync } from "../hooks/useSocketQuerySync";
import { useDispatcherNotificationsQuery } from "../hooks/useNotifications";
import type { DispatcherNotification } from "../types/notifications";
import { useModule } from "../hooks/useEntitlements";
import ModuleRouteGuard from "../components/entitlements/ModuleRouteGuard";

export default function DispatchLayout() {
	const navigate = useNavigate();
	const location = useLocation();
	const toast = useToast();
	const { data: orgSettings } = useOrgSettings();
	const [expanded, setExpanded] = useState(false);
	const [isCreatePanelOpen, setIsCreatePanelOpen] = useState(false);
	const [navOverflows, setNavOverflows] = useState(false);
	const navRef = useRef<HTMLElement>(null);
	const [isAssistantOpen, setIsAssistantOpen] = useState(false);
	const { user } = useAuthStore();

	const handleNewNotification = useCallback((notif: DispatcherNotification) => {
		toast.info(
			<>
				<div className="font-semibold">{notif.title}</div>
				{notif.body && <div className="text-xs text-text-muted mt-0.5">{notif.body}</div>}
			</>,
			{
				durationMs: 20_000,
				action: notif.action_url
					? { label: "View", onClick: () => navigate(notif.action_url!) }
					: undefined,
			},
		);
	}, [toast, navigate]);

	const { data: notifications = [] } = useDispatcherNotificationsQuery(user?.userId ?? null, false, handleNewNotification);
	const unreadCount = notifications.filter((n) => !n.read_at).length;

	// A view permission still passes while its module is switched off (records stay
	// readable), so the menu needs the module state as well.
	const quotesOn = useModule("quotes") === "on";
	const inventoryOn = useModule("inventory") === "on";
	const fleetOn = useModule("fleet") === "on";
	const fieldPurchasesOn = useModule("field_purchases") === "on";
	const purchasingOn = useModule("purchasing") === "on";
	const followupsOn = useModule("followups") === "on";
	const projectsOn = useModule("projects") === "on";
	const advancedReportingOn = useModule("advanced_reporting") === "on";
	const canViewRequests = usePermission("view_requests");
	const canViewQuotes = usePermission("view_quotes") && quotesOn;
	const canViewJobs = usePermission("view_jobs");
	const canViewInvoices = usePermission("view_invoices");
	const canViewClients = usePermission("view_clients");
	const canViewInventory = usePermission("view_inventory") && inventoryOn;
	const canViewVehicles =
		useAnyPermission(["view_vehicles", "manage_vehicles"]) && fleetOn;
	// One page serves both modules: it is listed while either is on.
	const canViewFieldPurchases =
		useAnyPermission(["view_field_purchases", "review_field_purchases"]) &&
		fieldPurchasesOn;
	const canViewPurchaseOrders =
		usePermission("view_purchases") && purchasingOn;
	const canViewPurchases = canViewFieldPurchases || canViewPurchaseOrders;
	const canViewTechnicians = usePermission("view_technicians");
	const canViewReports = usePermission("view_reports");
	const canViewTimesheet = usePermission("view_timesheet");
	const canViewAdmin = useAnyPermission([
		"view_admin",
		"manage_organization",
		"manage_roles",
	]);
	const canViewFollowups = usePermission("view_followups") && followupsOn;
	const canViewProjects = usePermission("view_projects") && projectsOn;

	useSocketQuerySync();

	// The nav's scrollbar is hidden by design (.sidebar-nav), so overflow past the
	// fold needs its own cue. Two observers: the nav's own box changes with the
	// viewport, while its row count changes later as permission checks resolve.
	useEffect(() => {
		const el = navRef.current;
		if (!el) return;
		const update = () =>
			setNavOverflows(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
		update();
		el.addEventListener("scroll", update, { passive: true });
		const resize = new ResizeObserver(update);
		resize.observe(el);
		const mutation = new MutationObserver(update);
		mutation.observe(el, { childList: true });
		return () => {
			el.removeEventListener("scroll", update);
			resize.disconnect();
			mutation.disconnect();
		};
	}, []);

	const handleBack = () => {
		const path = location.pathname;
		const historyIdx = (window.history.state as { idx?: number } | null)?.idx ?? 0;

		if (historyIdx > 0) {
			navigate(-1);
			return;
		}

		if (path.includes("/technicians/")) navigate("/dispatch/technicians");
		else if (path.includes("/clients/")) navigate("/dispatch/clients");
		else if (path.includes("/jobs/")) navigate("/dispatch/jobs");
		else if (path.includes("/quotes/")) navigate("/dispatch/quotes");
		else if (path.includes("/inventory/")) navigate("/dispatch/inventory");
		else if (path.includes("/admin/")) navigate("/dispatch/admin");
		else navigate("/dispatch");
	};

	const ICON_SIZE = 20;

	return (
		<div className="flex h-screen bg-canvas text-text-primary">
			{/* SIDEBAR — fixed w-16 in flex layout, inner div overlays on hover (no sibling reflow) */}
			<aside
				onMouseEnter={() => {
					if (!isCreatePanelOpen) setExpanded(true);
				}}
				onMouseLeave={() => setExpanded(false)}
				className="relative w-16 flex-shrink-0 z-40"
			>
				<div
					className={`absolute inset-y-0 left-0 flex flex-col bg-base border-r border-border overflow-hidden transition-[width] duration-200 ease-in-out ${expanded ? "w-40 lg:w-44" : "w-16"}`}
				>
					<nav
						ref={navRef}
						className="flex-1 py-2 space-y-1 overflow-y-auto overflow-x-hidden sidebar-nav"
					>
						<button
							onClick={() => {
								setIsCreatePanelOpen((o) => !o);
								setExpanded(false);
							}}
							className={`group relative flex items-center h-10 rounded-md mx-2 transition-colors duration-200 w-[calc(100%-16px)] hover:cursor-pointer ${
								isCreatePanelOpen
									? "bg-primary-bg text-primary-text"
									: "text-text-tertiary hover:text-text-primary hover:bg-surface-raised"
							}`}
						>
							<div className="w-12 flex items-center justify-center flex-shrink-0">
								<Plus size={ICON_SIZE} />
							</div>
							<div
								className={`flex-1 min-w-0 flex items-center overflow-hidden transition-[opacity,transform] duration-200 ease-in-out ${
									expanded
										? "opacity-100 translate-x-0"
										: "opacity-0 -translate-x-2 pointer-events-none"
								}`}
							>
								<span className="text-sm whitespace-nowrap truncate pr-2">
									Create
								</span>
							</div>
						</button>
						<SideNavItem
							expanded={expanded}
							to="/dispatch"
							icon={<House size={ICON_SIZE} />}
							label="Dashboard"
						/>
						<SideNavItem
							expanded={expanded}
							to="/dispatch/schedule"
							icon={<Calendar size={ICON_SIZE} />}
							label="Schedule"
						/>
						{canViewRequests && (
							<SideNavItem
								expanded={expanded}
								to="/dispatch/requests"
								icon={<Inbox size={ICON_SIZE} />}
								label="Requests"
							/>
						)}
						{canViewQuotes && (
							<SideNavItem
								expanded={expanded}
								to="/dispatch/quotes"
								icon={<FileText size={ICON_SIZE} />}
								label="Quotes"
							/>
						)}
						{canViewJobs && (
							<SideNavItem
								expanded={expanded}
								to="/dispatch/jobs"
								icon={
									<Briefcase
										size={ICON_SIZE}
									/>
								}
								label="Jobs"
							/>
						)}
						{canViewProjects && (
							<SideNavItem
								expanded={expanded}
								to="/dispatch/projects"
								icon={
									<FolderKanban
										size={ICON_SIZE}
									/>
								}
								label="Projects"
							/>
						)}
						{canViewInvoices && (
							<SideNavItem
								expanded={expanded}
								to="/dispatch/invoices"
								icon={
									<ReceiptText
										size={ICON_SIZE}
									/>
								}
								label="Invoices"
							/>
						)}
						{canViewClients && (
							<SideNavItem
								expanded={expanded}
								to="/dispatch/clients"
								icon={<Users size={ICON_SIZE} />}
								label="Clients"
							/>
						)}
						{canViewInventory && (
							<SideNavItem
								expanded={expanded}
								to="/dispatch/inventory"
								icon={<Package size={ICON_SIZE} />}
								label="Inventory"
							/>
						)}
						{canViewPurchases && (
							<SideNavItem
								expanded={expanded}
								to="/dispatch/purchases"
								icon={<Receipt size={ICON_SIZE} />}
								label="Purchases"
							/>
						)}
						{canViewVehicles && (
							<SideNavItem
								expanded={expanded}
								to="/dispatch/vehicles"
								icon={<Truck size={ICON_SIZE} />}
								label="Vehicles"
							/>
						)}
						{canViewTechnicians && (
							<SideNavItem
								expanded={expanded}
								to="/dispatch/technicians"
								icon={<Wrench size={ICON_SIZE} />}
								label="Technicians"
							/>
						)}
						<SideNavItem
							expanded={expanded}
							to="/dispatch/map"
							icon={<Map size={ICON_SIZE} />}
							label="Map"
						/>
						{canViewReports && advancedReportingOn && (
							<SideNavItem
								expanded={expanded}
								to="/dispatch/kpi"
								icon={<ChartColumnDecreasing
										size={ICON_SIZE}
									/>}
								label="KPIs"
							/>
						)}
						{canViewReports && (
							<SideNavItem
								expanded={expanded}
								to="/dispatch/reporting"
								icon={<FileText size={ICON_SIZE} />}
								label="Reporting"
							/>
						)}
						{canViewTimesheet && (
							<SideNavItem
								expanded={expanded}
								to="/dispatch/timesheet"
								icon={
									<Timer size={ICON_SIZE} />
								}
								label="Timesheet"
							/>
						)}
						{canViewFollowups && (
							<SideNavItem
								expanded={expanded}
								to="/dispatch/followups"
								icon={<Mail size={ICON_SIZE} />}
								label="Followups"
							/>
						)}
						{(user?.role === "admin" || canViewAdmin) && (
							<SideNavItem
								expanded={expanded}
								to="/dispatch/admin"
								icon={
									<ShieldUser
										size={ICON_SIZE}
									/>
								}
								label="Admin"
							/>
						)}
					</nav>
					<div
						aria-hidden="true"
						className={`pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-base to-transparent transition-opacity duration-200 ${
							navOverflows ? "opacity-100" : "opacity-0"
						}`}
					/>
				</div>
			</aside>

			<div className="flex flex-col flex-1 overflow-hidden">
				{/* TOP NAV */}
				<header
					className="flex justify-between items-center px-6 h-14 bg-base border-b border-border"
					style={{
						paddingLeft: expanded ? 120 : 24,
						transition: "padding-left 200ms ease-in-out",
					}}
				>
					<div className="flex items-center gap-6">
						<div className="font-semibold text-sm whitespace-nowrap text-text-primary">
							{orgSettings?.name ?? "Dispatch"}
						</div>
						<button
							onClick={handleBack}
							className="flex items-center gap-2 text-text-tertiary hover:text-text-primary px-3 py-2 rounded-lg hover:bg-surface-raised group"
						>
							<ArrowLeft
								size={18}
								className="group-hover:-translate-x-1 transition-transform"
							/>
							<span className="text-sm font-medium">
								Back
							</span>
						</button>
					</div>

					{/* RIGHT SIDE */}
					<div className="flex items-center gap-3">
						<GlobalSearch />
						{/* Bell / notifications icon */}
						<button
							onClick={() => navigate("/dispatch/notifications")}
							className="relative flex items-center justify-center w-9 h-9 rounded-lg hover:bg-surface-raised transition-colors hover:cursor-pointer"
							title="Notifications"
						>
							<Bell size={20} className="text-text-tertiary" />
							{unreadCount > 0 && (
								<span className="absolute top-1 right-1 flex items-center justify-center w-4 h-4 rounded-full bg-error text-on-primary text-[9px] font-bold leading-none">
									{unreadCount > 9 ? "9+" : unreadCount}
								</span>
							)}
						</button>
						<AssistantTrigger
							onClick={() => setIsAssistantOpen(true)}
						/>
						<DispatcherUserMenu />
					</div>
				</header>

				<main className="flex-1 overflow-hidden bg-canvas">
					<div className="pt-4 px-4 md:pt-6 md:px-6 h-full overflow-y-auto">
						<ModuleRouteGuard home="/dispatch">
							<Outlet />
						</ModuleRouteGuard>
					</div>
				</main>
			</div>
			<CreatePanel
				isOpen={isCreatePanelOpen}
				onClose={() => setIsCreatePanelOpen(false)}
			/>
			<AssistantPanel
				isOpen={isAssistantOpen}
				onClose={() => setIsAssistantOpen(false)}
			/>

			<ToastViewport />
		</div>
	);
}
