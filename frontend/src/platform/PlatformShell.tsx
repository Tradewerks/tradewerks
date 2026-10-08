import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import ToastViewport from "../components/ui/ToastViewport";
import { useOpenRequestCount } from "./hooks";
import { usePlatformAuth } from "./store";

const link = ({ isActive }: { isActive: boolean }) =>
	`block whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors duration-150 ease-out ${
		isActive
			? "bg-surface-inset font-medium text-text-primary"
			: "text-text-secondary hover:bg-surface-inset hover:text-text-primary"
	}`;

export default function PlatformShell() {
	const staff = usePlatformAuth((s) => s.staff);
	const qc = useQueryClient();
	const navigate = useNavigate();
	const openCount = useOpenRequestCount().data?.count ?? 0;
	const signOut = () => {
		usePlatformAuth.getState().signOut();
		qc.removeQueries({ queryKey: ["platform"] });
		navigate("/platform/login", { replace: true });
	};
	return (
		<div className="flex min-h-svh flex-col bg-canvas text-text-primary md:flex-row">
			<aside className="border-b border-border bg-surface md:w-52 md:shrink-0 md:border-b-0 md:border-r">
				<div className="flex items-center justify-between gap-2 px-4 py-3 md:block">
					<p className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
						TradeWerks back office
					</p>
					<div className="text-right md:mt-2 md:text-left">
						<p className="truncate text-sm text-text-secondary">
							{staff?.name}
						</p>
						<button
							type="button"
							onClick={signOut}
							className="text-xs text-primary hover:underline"
						>
							Sign out
						</button>
					</div>
				</div>
				<nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:block md:space-y-0.5 md:overflow-visible">
					<NavLink to="/platform/orgs" className={link}>
						Organizations
					</NavLink>
					<NavLink to="/platform/tiers" className={link}>
						Tiers
					</NavLink>
					<NavLink to="/platform/requests" className={link}>
						Requests
						{openCount > 0 && (
							<span className="ml-2 rounded-full bg-primary/15 px-1.5 text-xs font-medium text-primary tabular-nums">
								{openCount}
							</span>
						)}
					</NavLink>
					<NavLink to="/platform/staff" className={link}>
						Staff
					</NavLink>
				</nav>
			</aside>
			<main className="min-w-0 flex-1 p-4 md:p-6">
				<Outlet />
			</main>
			<ToastViewport />
		</div>
	);
}
