import { Outlet, useNavigate, useLocation, NavLink } from "react-router-dom";
import { useAuthStore } from "../auth/authStore";
import { useRef, useEffect, useCallback } from "react";
import { ClipboardList, ArrowLeft, House, Truck, Bell, AlertTriangle, Map, Gauge } from "lucide-react";
import { useTechnicianByIdQuery } from "../hooks/useTechnicians";
import { pingLocation } from "../api/technicians";
import { useNotificationsQuery } from "../hooks/useNotifications";
import { useSocketQuerySync } from "../hooks/useSocketQuerySync";
import type { TechnicianNotification } from "../types/notifications";
import { usePermission } from "../hooks/usePermission";
import TechnicianUserMenu from "../components/nav/TechnicianUserMenu";
import ToastViewport from "../components/ui/ToastViewport";
import { useToast } from "../components/ui/useToast";

export default function TechnicianLayout() {
	const { user } = useAuthStore();
	const navigate = useNavigate();
	const location = useLocation();
	const navigationCount = useRef(0);

	useSocketQuerySync();

	const toast = useToast();
	const handleNewNotification = useCallback((notif: TechnicianNotification) => {
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

	const { data: techProfile } = useTechnicianByIdQuery(user?.userId ?? null);
	const { data: notifications = [] } = useNotificationsQuery(user?.userId ?? null, false, handleNewNotification);
	const unreadCount = notifications.filter((n) => !n.read_at).length;
	const noVehicle = techProfile && !techProfile.current_vehicle_id;

	// Live location for the dispatch map while on shift: latest fix sent at most every 15s.
	// A stationary tech produces no new fixes, so the last one is re-sent as a heartbeat
	// once HEARTBEAT_MS passes — the dispatch "pulse" reads last_ping_at to tell live from gone.
	const onShift = !!techProfile && techProfile.status !== "Offline";
	useEffect(() => {
		if (!onShift || !user?.userId || !("geolocation" in navigator)) return;
		const techId = user.userId;
		const HEARTBEAT_MS = 60_000;
		type Coords = { lat: number; lon: number };
		let latest: Coords | null = null;
		let sent: Coords | null = null;
		let sentAt = 0;
		const flush = () => {
			// no token = logging out / switching user; a 401 here would refresh the old session back in
			if (!latest || !localStorage.getItem("accessToken")) return;
			if (latest === sent && Date.now() - sentAt < HEARTBEAT_MS) return;
			sent = latest;
			sentAt = Date.now();
			pingLocation(techId, latest).catch(() => {});
		};
		const watchId = navigator.geolocation.watchPosition(
			(pos) => {
				latest = { lat: pos.coords.latitude, lon: pos.coords.longitude };
				if (!sent) flush();
			},
			(err) => console.warn("Location tracking unavailable:", err.message),
			{ enableHighAccuracy: true, maximumAge: 10_000 },
		);
		const interval = setInterval(flush, 15_000);
		return () => {
			navigator.geolocation.clearWatch(watchId);
			clearInterval(interval);
		};
	}, [onShift, user?.userId]);

	useEffect(() => {
		navigationCount.current++;
	}, [location.pathname]);

	const handleBack = () => {
		const historyIdx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
		if (navigationCount.current > 1 && historyIdx > 0) {
			navigate(-1);
			return;
		}
		navigate("/technician");
	};

	return (
		<div className="flex h-screen bg-canvas text-text-primary">
			<div className="flex flex-col flex-1 overflow-hidden">
				{/* TOP NAV */}
				<header className="flex justify-between items-center px-4 sm:px-6 h-14 bg-base border-b border-border">
					<div className="flex items-center gap-3 sm:gap-6">
						<button
							onClick={handleBack}
							aria-label="Back"
							className="flex items-center gap-2 text-text-tertiary hover:text-text-primary px-2 sm:px-3 py-2 rounded-lg hover:bg-surface group"
						>
							<ArrowLeft
								size={18}
								className="group-hover:-translate-x-1 transition-transform"
							/>
							<span className="hidden sm:inline text-sm font-medium">
								Back
							</span>
						</button>
						<div className="font-semibold text-sm whitespace-nowrap">
							Tech Demo
						</div>
					</div>

					<div className="flex items-center gap-2">
						{/* Mileage icon */}
						<button
							onClick={() => navigate("/technician/mileage")}
							className="flex items-center justify-center w-9 h-9 rounded-lg hover:bg-surface transition-colors"
							title="Weekly Mileage"
						>
							<Gauge size={20} className="text-text-tertiary" />
						</button>

						{/* Truck / vehicle icon */}
						{usePermission("use_vehicles") && (
							<button
								onClick={() => navigate("/technician/vehicles")}
								className="relative flex items-center justify-center w-9 h-9 rounded-lg hover:bg-surface transition-colors"
								title={techProfile?.current_vehicle?.name ?? "No vehicle selected"}
							>
								<Truck
									size={20}
									className={noVehicle ? "text-warning-text" : "text-text-tertiary"}
								/>
								{noVehicle && (
									<AlertTriangle
										size={10}
										className="absolute top-1 right-1 text-warning-text"
									/>
								)}
							</button>
						)}

						{/* Bell / notifications icon */}
						<button
							onClick={() => navigate("/technician/notifications")}
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
						<TechnicianUserMenu />
						
					</div>
				</header>

				<main className="flex-1 overflow-y-auto overscroll-contain bg-canvas">
					<div className="p-4 pb-20 md:px-6 md:pt-6 min-h-full">
						<Outlet />
					</div>
				</main>
			</div>

			{/* BOTTOM NAV */}
			<nav className="flex fixed bottom-0 left-0 right-0 z-50 bg-base border-t border-border h-16">
				<NavLink
					to="/technician"
					end
					className={({ isActive }) =>
						`flex flex-1 flex-col items-center justify-center gap-1 text-xs transition-colors ${
							isActive ? "text-text-primary" : "text-text-muted hover:text-text-secondary"
						}`
					}
				>
					<House size={22} />
					<span>Dashboard</span>
				</NavLink>
				{usePermission("view_visits") && (
					<NavLink
						to="/technician/visits"
						className={({ isActive }) =>
							`flex flex-1 flex-col items-center justify-center gap-1 text-xs transition-colors ${
								isActive ? "text-text-primary" : "text-text-muted hover:text-text-secondary"
							}`
						}
					>
						<ClipboardList size={22} />
						<span>My Visits</span>
					</NavLink>
				)}
				<NavLink
					to="/technician/map"
					className={({ isActive }) =>
						`flex flex-1 flex-col items-center justify-center gap-1 text-xs transition-colors ${
							isActive ? "text-text-primary" : "text-text-muted hover:text-text-secondary"
						}`
					}
				>
					<Map size={22} />
					<span>Map</span>
				</NavLink>
			</nav>

			<ToastViewport inset="above-nav" />
		</div>
	);
}
